// Liquid 3: Hector Arellano's fluid method, ported to three.js r186 TSL and adapted to fill a skinned, dancing body.
//   Source: github.com/HectorArellanoDev/WebGPUFluidsBasic (Codrops, 2025) - his PBF_applyForces /
//   PBF_calculateDisplacements / PBF_integrateVelocity, Blur3D and marching cubes.
//
// Simulation (per substep):
//   predict   : every particle has its OWN target point inside her body (a bind-pose interior lattice point,
//               skinned by linear blend skinning each frame) and is pulled to it by a spring; Hector's analytic
//               curl noise stirs it (2 octaves); gravity; then  p* = p + dt (v + dt a)   and p* is binned into a
//               spatial hash (12 particles per bucket)
//   separate  : position-based separation: any two particles closer than the spacing are pushed apart
//               (27 neighbour cells, Jacobi, N iterations) -> the volume fills evenly and stays incompressible
//   velocity  : v = (p_new - p) / dt, capped; damping
// Splash & drips (added for a dancing body): surface particles break off where her body accelerates hard
//   (splashes, flung off with their momentum) or at a small random rate (drips); detached particles lose their
//   spring, fall under gravity with light drag, then respawn inside her after a lifetime or on hitting the floor.
//   Cohesion (averaged over neighbours) pulls near particles together so drops and strands hold.
// Surface (per frame), in a voxel grid over the bounds box:
//   splat particles (smooth spheres, or Hector's solid blocks) -> separable 3D blur (X, Y, Z) -> marching cubes:
//   classify every voxel + compact the surface voxels (with their triangle offsets) -> write indirect dispatch /
//   draw counts -> one thread per surface voxel writes its triangles (normals = density gradient, winding
//   fixed so front faces point outwards) -> drawn with an indirect draw and a regular MeshPhysicalNodeMaterial.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, Loop, hash, instancedArray, instanceIndex, vertexIndex, uniform, storage, attribute,
  float, int, uint, ivec3, vec3, vec4, mat4, array, cos, normalize, length, max, min, clamp, mix, cross, dot, exp, floor,
  atomicAdd, atomicLoad, atomicStore, atomicMax, transformNormalToView,
} from 'three/tsl';
import { addMaterialControls, applyPhysical } from './liquids.js?v=f3eb47adb6';

const MAX_P = 250000;          // particle buffers
const MAX_T = 800000;          // marching-cubes triangles
const MAX_A = 400000;          // active (surface) voxels
const MAX_V = 32e6;            // voxels per grid buffer (WebGPU's default 128 MB storage binding / 4 bytes)
export const MC_RES = { 'low (2 cm)': 2, 'medium (1.5 cm)': 1.5, 'high (1 cm)': 1, 'very high (0.75 cm)': 0.75, 'ultra (0.5 cm)': 0.5 };
const HB = 1 << 19;            // spatial-hash buckets
const SLOTS = 12;              // particles per bucket
const WG = 64;

// marching cubes triangle table (Paul Bourke; same table Hector's demo uses): edges per case
const TRI = [[],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],[2,8,3,2,10,8,10,9,8],[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],[1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],[3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],[4,7,8],[4,3,0,7,3,4],[0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],[9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],[8,4,7,3,11,2],[11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],[3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],[4,7,8,9,0,11,9,11,10,11,0,3],[4,7,11,4,11,9,9,11,10],[9,5,4],[9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],[1,2,10,9,5,4],[3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],[9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],[2,1,5,2,5,8,2,8,11,4,8,5],[10,3,11,10,1,3,9,5,4],[4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],[5,4,8,5,8,10,10,8,11],[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],[0,7,8,0,1,7,1,5,7],[1,5,3,3,5,7],[9,7,8,9,5,7,10,1,2],[10,1,2,9,5,0,5,3,0,5,7,3],[8,0,2,8,2,5,8,5,7,10,5,2],[2,10,5,2,5,3,3,5,7],[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],[2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],[9,5,8,8,5,7,10,1,3,10,3,11],[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],[11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],[11,10,5,7,11,5],[10,6,5],[0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],[1,6,5,2,6,1],[1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,5,2,6,3,2,8],[2,3,11,10,6,5],[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],[5,10,6,1,9,2,9,11,2,9,8,11],[6,3,11,6,5,3,5,1,3],[0,8,11,0,11,5,0,5,1,5,11,6],[3,11,6,0,3,6,0,6,5,0,5,9],[6,5,9,6,9,11,11,9,8],[5,10,6,4,7,8],[4,3,0,4,7,3,6,5,10],[1,9,0,5,10,6,8,4,7],[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],[1,2,5,5,2,6,3,0,4,3,4,7],[8,4,7,9,0,5,0,6,5,0,2,6],[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],[3,11,2,7,8,4,10,6,5],[5,10,6,4,7,2,4,2,0,2,7,11],[0,1,9,4,7,8,2,3,11,5,10,6],[9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],[8,4,7,3,11,5,3,5,1,5,11,6],[5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],[0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],[6,5,9,6,9,11,4,7,9,7,11,9],[10,4,9,6,4,10],[4,10,6,4,9,10,0,8,3],[10,0,1,10,6,0,6,4,0],[8,3,1,8,1,6,8,6,4,6,1,10],[1,4,9,1,2,4,2,6,4],[3,0,8,1,2,9,2,4,9,2,6,4],[0,2,4,4,2,6],[8,3,2,8,2,4,4,2,6],[10,4,9,10,6,4,11,2,3],[0,8,2,2,8,11,4,9,10,4,10,6],[3,11,2,0,1,6,0,6,4,6,1,10],[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],[9,6,4,9,3,6,9,1,3,11,6,3],[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],[3,11,6,3,6,0,0,6,4],[6,4,8,11,6,8],[7,10,6,7,8,10,8,9,10],[0,7,3,0,10,7,0,9,10,6,7,10],[10,6,7,1,10,7,1,7,8,1,8,0],[10,6,7,10,7,1,1,7,3],[1,2,6,1,6,8,1,8,9,8,6,7],[2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],[7,8,0,7,0,6,6,0,2],[7,3,2,6,7,2],[2,3,11,10,6,8,10,8,9,8,6,7],[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],[1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],[11,2,1,11,1,7,10,6,1,6,7,1],[8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],[0,9,1,11,6,7],[7,8,0,7,0,6,3,11,0,11,6,0],[7,11,6],[7,6,11],[3,0,8,11,7,6],[0,1,9,11,7,6],[8,1,9,8,3,1,11,7,6],[10,1,2,6,11,7],[1,2,10,3,0,8,6,11,7],[2,9,0,2,10,9,6,11,7],[6,11,7,2,10,3,10,8,3,10,9,8],[7,2,3,6,2,7],[7,0,8,7,6,0,6,2,0],[2,7,6,2,3,7,0,1,9],[1,6,2,1,8,6,1,9,8,8,7,6],[10,7,6,10,1,7,1,3,7],[10,7,6,1,7,10,1,8,7,1,0,8],[0,3,7,0,7,10,0,10,9,6,10,7],[7,6,10,7,10,8,8,10,9],[6,8,4,11,8,6],[3,6,11,3,0,6,0,4,6],[8,6,11,8,4,6,9,0,1],[9,4,6,9,6,3,9,3,1,11,3,6],[6,8,4,6,11,8,2,10,1],[1,2,10,3,0,11,0,6,11,0,4,6],[4,11,8,4,6,11,0,2,9,2,10,9],[10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],[8,2,3,8,4,2,4,6,2],[0,4,2,4,6,2],[1,9,0,2,3,4,2,4,6,4,3,8],[1,9,4,1,4,2,2,4,6],[8,1,3,8,6,1,8,4,6,6,10,1],[10,1,0,10,0,6,6,0,4],[4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],[10,9,4,6,10,4],[4,9,5,7,6,11],[0,8,3,4,9,5,11,7,6],[5,0,1,5,4,0,7,6,11],[11,7,6,8,3,4,3,5,4,3,1,5],[9,5,4,10,1,2,7,6,11],[6,11,7,1,2,10,0,8,3,4,9,5],[7,6,11,5,4,10,4,2,10,4,0,2],[3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],[7,2,3,7,6,2,5,4,9],[9,5,4,0,8,6,0,6,2,6,8,7],[3,6,2,3,7,6,1,5,0,5,4,0],[6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],[9,5,4,10,1,6,1,7,6,1,3,7],[1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],[4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],[7,6,10,7,10,8,5,4,10,4,8,10],[6,9,5,6,11,9,11,8,9],[3,6,11,0,6,3,0,5,6,0,9,5],[0,11,8,0,5,11,0,1,5,5,6,11],[6,11,3,6,3,5,5,3,1],[1,2,10,9,5,11,9,11,8,11,5,6],[0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],[11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],[6,11,3,6,3,5,2,10,3,10,5,3],[5,8,9,5,2,8,5,6,2,3,8,2],[9,5,6,9,6,0,0,6,2],[1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],[1,5,6,2,1,6],[1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],[10,1,0,10,0,6,9,5,0,5,6,0],[0,3,8,5,6,10],[10,5,6],[11,5,10,7,5,11],[11,5,10,11,7,5,8,3,0],[5,11,7,5,10,11,1,9,0],[10,7,5,10,11,7,9,8,1,8,3,1],[11,1,2,11,7,1,7,5,1],[0,8,3,1,2,7,1,7,5,7,2,11],[9,7,5,9,2,7,9,0,2,2,11,7],[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],[2,5,10,2,3,5,3,7,5],[8,2,0,8,5,2,8,7,5,10,2,5],[9,0,1,5,10,3,5,3,7,3,10,2],[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],[1,3,5,3,7,5],[0,8,7,0,7,1,1,7,5],[9,0,3,9,3,5,5,3,7],[9,8,7,5,9,7],[5,8,4,5,10,8,10,11,8],[5,0,4,5,11,0,5,10,11,11,3,0],[0,1,9,8,4,10,8,10,11,10,4,5],[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],[2,5,1,2,8,5,2,11,8,4,5,8],[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],[0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],[9,4,5,2,11,3],[2,5,10,3,5,2,3,4,5,3,8,4],[5,10,2,5,2,4,4,2,0],[3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],[5,10,2,5,2,4,1,9,2,9,4,2],[8,4,5,8,5,3,3,5,1],[0,4,5,1,0,5],[8,4,5,8,5,3,9,0,5,0,3,5],[9,4,5],[4,11,7,4,9,11,9,10,11],[0,8,3,4,9,7,9,11,7,9,10,11],[1,10,11,1,11,4,1,4,0,7,4,11],[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],[4,11,7,9,11,4,9,2,11,9,1,2],[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],[11,7,4,11,4,2,2,4,0],[11,7,4,11,4,2,8,3,4,3,2,4],[2,9,10,2,7,9,2,3,7,7,4,9],[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],[3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],[1,10,2,8,7,4],[4,9,1,4,1,7,7,1,3],[4,9,1,4,1,7,0,8,1,8,7,1],[4,0,3,7,4,3],[4,8,7],[9,10,8,10,11,8],[3,0,9,3,9,11,11,9,10],[0,1,10,0,10,8,8,10,11],[3,1,10,11,3,10],[1,2,11,1,11,9,9,11,8],[3,0,9,3,9,11,1,2,9,2,11,9],[0,2,11,8,0,11],[3,2,11],[2,3,8,2,8,10,10,8,9],[9,10,2,0,9,2],[2,3,8,2,8,10,0,1,8,1,10,8],[1,10,2],[1,3,8,9,1,8],[0,9,1],[0,3,8],[]];
const TRI_TABLE = new Int32Array(256 * 16).fill(-1), TRI_COUNT = new Uint32Array(256);
TRI.forEach((l, c) => { TRI_TABLE.set(l, c * 16); TRI_COUNT[c] = l.length / 3; });
const CORNER = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGE_A = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3], EDGE_B = [1, 2, 3, 0, 5, 6, 7, 4, 4, 5, 6, 7];

// ---- settings (flat keys on the app's P)
// fixed internals (were sliders; these are the values that worked in 'liquid hector test 3')
const FIXED = { inset: 0.4, substeps: 2, separation: 0.05, iterations: 4, dripDrag: 0.3, cohesionRange: 1.35, iso: 0.5 };
const DEFAULTS = {
  l3_enabled: false, l3_render: 'mesh (marching cubes)',
  l3_spring: 200, l3_damping: 1.5, l3_maxSpeed: 4, l3_gravity: 0,
  l3_spacing: 1.2, l3_relax: 1, l3_noise: 4, l3_noiseFreq: 0.8,
  l3_splashAccel: 12, l3_fling: 1.3, l3_surfDepth: 2, l3_dripRate: 0.01, l3_dripLife: 1.5, l3_dripGravity: 1, l3_cohesion: 0.3,
  l3_showBounds: false, l3_boundsX: 1.8, l3_boundsY: 2.3, l3_boundsZ: 1.4, l3_floor: 0, l3_boundsLag: 0.5,
  l3_mcRes: 'high (1 cm)', l3_surfStyle: 'spheres', l3_threshold: 0.6, l3_dropRadius: 1.6, l3_blurSize: 0.7, l3_particleSize: 0.5,
  l3_liqColor: '#d8f2ff', l3_liqRoughness: 0.05, l3_liqMetalness: 0.0, l3_liqClearcoat: 1.0, l3_liqSheen: 0.0,
  l3_liqTransmission: 0.9, l3_liqIor: 1.33, l3_liqThickness: 0.1, l3_liqDispersion: 0.0, l3_liqEnvIntensity: 1.0,
};
export function hectorDefaults(P) { Object.assign(P, DEFAULTS); return Object.keys(DEFAULTS); }

// ---- interior targets: lattice points inside her bind-pose body (majority vote of ray parity along x, y, z,
// robust to small holes like the eye sockets), >= inset from the skin, each with bone weights blended from its
// 4 nearest skin vertices (inverse distance). Output per point: [bind xyz, depth below skin | 4 bone indices | 4 weights].
function sampleInterior(skinned, spacing, inset) {
  const g = skinned.geometry, pos = g.attributes.position, tri = g.index.array, nV = pos.count;
  const sI = g.attributes.skinIndex, sW = g.attributes.skinWeight, bind = skinned.bindMatrix, v = new THREE.Vector3();
  const V = new Float32Array(nV * 3), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < nV; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(bind);
    V[3 * i] = v.x; V[3 * i + 1] = v.y; V[3 * i + 2] = v.z;
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], V[3 * i + a]); hi[a] = Math.max(hi[a], V[3 * i + a]); }
  }
  const s = spacing, N = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / s)));
  const at = (a, i) => lo[a] + (i + 0.5) * s;
  const votes = new Uint8Array(N[0] * N[1] * N[2]);
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, c = (a + 2) % 3, cols = new Array(N[b] * N[c]);
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = 3 * tri[t], i1 = 3 * tri[t + 1], i2 = 3 * tri[t + 2];
      const b0 = V[i0 + b], c0 = V[i0 + c], b1 = V[i1 + b], c1 = V[i1 + c], b2 = V[i2 + b], c2 = V[i2 + c];
      const den = (b1 - b0) * (c2 - c0) - (b2 - b0) * (c1 - c0);
      if (Math.abs(den) < 1e-14) continue;
      const jb0 = Math.max(0, Math.ceil((Math.min(b0, b1, b2) - lo[b]) / s - 0.5)), jb1 = Math.min(N[b] - 1, Math.floor((Math.max(b0, b1, b2) - lo[b]) / s - 0.5));
      const jc0 = Math.max(0, Math.ceil((Math.min(c0, c1, c2) - lo[c]) / s - 0.5)), jc1 = Math.min(N[c] - 1, Math.floor((Math.max(c0, c1, c2) - lo[c]) / s - 0.5));
      for (let jb = jb0; jb <= jb1; jb++) for (let jc = jc0; jc <= jc1; jc++) {
        const pb = at(b, jb), pc = at(c, jc);
        const w1 = ((pb - b0) * (c2 - c0) - (b2 - b0) * (pc - c0)) / den, w2 = ((b1 - b0) * (pc - c0) - (pb - b0) * (c1 - c0)) / den;
        if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
        (cols[jb + N[b] * jc] ||= []).push(V[i0 + a] + w1 * (V[i1 + a] - V[i0 + a]) + w2 * (V[i2 + a] - V[i0 + a]));
      }
    }
    const idx = [0, 0, 0];
    for (let jb = 0; jb < N[b]; jb++) for (let jc = 0; jc < N[c]; jc++) {
      const hits = cols[jb + N[b] * jc]; if (!hits) continue;
      hits.sort((x, y) => x - y);
      let h = 0;
      idx[b] = jb; idx[c] = jc;
      for (let ia = 0; ia < N[a]; ia++) {
        const pa = at(a, ia);
        while (h < hits.length && hits[h] < pa) h++;
        if (h & 1) { idx[a] = ia; votes[idx[0] + N[0] * (idx[1] + N[1] * idx[2])]++; }
      }
    }
  }
  // spatial hash of skin vertices for nearest-vertex queries
  const HC = 0.03, key = (x, y, z) => `${x},${y},${z}`, grid = new Map();
  for (let i = 0; i < nV; i++) {
    const k = key(Math.floor(V[3 * i] / HC), Math.floor(V[3 * i + 1] / HC), Math.floor(V[3 * i + 2] / HC));
    let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
  }
  const out = [], best = [], K = 4;
  for (let k = 0; k < N[2]; k++) for (let j = 0; j < N[1]; j++) for (let i = 0; i < N[0]; i++) {
    if (votes[i + N[0] * (j + N[1] * k)] < 2) continue;
    const x = at(0, i) + (Math.random() - 0.5) * 0.3 * s, y = at(1, j) + (Math.random() - 0.5) * 0.3 * s, z = at(2, k) + (Math.random() - 0.5) * 0.3 * s;
    const cx = Math.floor(x / HC), cy = Math.floor(y / HC), cz = Math.floor(z / HC);
    best.length = 0;
    for (let r = 1; r <= 10; r++) {                  // grow the search ring until the K nearest are certain
      best.length = 0;
      for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const l = grid.get(key(cx + dx, cy + dy, cz + dz)); if (!l) continue;
        for (const vi of l) { const ex = V[3 * vi] - x, ey = V[3 * vi + 1] - y, ez = V[3 * vi + 2] - z; best.push([ex * ex + ey * ey + ez * ez, vi]); }
      }
      if (best.length >= K) { best.sort((p, q) => p[0] - q[0]); if (Math.sqrt(best[K - 1][0]) <= r * HC) break; }
    }
    if (best.length < K || Math.sqrt(best[0][0]) < inset) continue;
    const bw = new Map();
    let tw = 0;
    for (let n = 0; n < K; n++) {
      const [d2, vi] = best[n], w = 1 / (d2 + 2.5e-5); tw += w;
      for (let q = 0; q < 4; q++) { const bi = sI.getComponent(vi, q), ww = sW.getComponent(vi, q) * w; if (ww > 0) bw.set(bi, (bw.get(bi) || 0) + ww); }
    }
    const top = [...bw.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
    const sum = top.reduce((acc, e) => acc + e[1], 0) || 1;
    while (top.length < 4) top.push([top[0][0], 0]);
    out.push(x, y, z, Math.sqrt(best[0][0]), top[0][0], top[1][0], top[2][0], top[3][0], top[0][1] / sum, top[1][1] / sum, top[2][1] / sum, top[3][1] / sum);
  }
  return new Float32Array(out);
}

// Hector's analytic curl noise (Bridson 2007 style). tph = 8 phase uniforms (his t1()..t8(), advanced per frame).
function curlNoise(p, tph) {
  const sum = (terms) => terms.map(([a, u, cu, w, cw, ph, k]) => cos(u.mul(cu).add(w.mul(cw)).add(ph).add(tph[k])).mul(a)).reduce((x, y) => x.add(y));
  const { x, y, z } = p;
  const dP3dY = sum([[3, z, 1.8, y, 3, -194.58, 0], [4.5, z, 4.8, y, 4.5, -83.13, 1], [1.2, z, -7, y, 1.2, -845.2, 2], [2.13, z, -5, y, 2.13, -762.185, 3],
    [5.4, x, -0.48, y, 5.4, -707.916, 4], [5.4, x, 2.56, y, 5.4, -482.348, 5], [2.4, x, 4.16, y, 2.4, 9.872, 6], [1.35, x, -4.16, y, 1.35, -476.747, 7]]);
  const dP2dZ = sum([[-0.48, z, -0.48, x, 5.4, -125.796, 4], [2.56, z, 2.56, x, 5.4, 17.692, 5], [4.16, z, 4.16, x, 2.4, 150.512, 6], [-4.16, z, -4.16, x, 1.35, -222.137, 7]]);
  const dP1dZ = sum([[3, x, 1.8, z, 3, 0, 0], [4.5, x, 4.8, z, 4.5, 0, 1], [1.2, x, -7, z, 1.2, 0, 2], [2.13, x, -5, z, 2.13, 0, 3],
    [5.4, y, -0.48, z, 5.4, 0, 4], [5.4, y, 2.56, z, 5.4, 0, 5], [2.4, y, 4.16, z, 2.4, 0, 6], [1.35, y, -4.16, z, 1.35, 0, 7]]);
  const dP3dX = sum([[-0.48, x, -0.48, y, 5.4, -707.916, 4], [2.56, x, 2.56, y, 5.4, -482.348, 5], [4.16, x, 4.16, y, 2.4, 9.872, 6], [-4.16, x, -4.16, y, 1.35, -476.747, 7]]);
  const dP2dX = sum([[3, y, 1.8, x, 3, -2.82, 0], [4.5, y, 4.8, x, 4.5, 74.37, 1], [1.2, y, -7, x, 1.2, -256.72, 2], [2.13, y, -5, x, 2.13, -207.683, 3],
    [5.4, z, -0.48, x, 5.4, -125.796, 4], [5.4, z, 2.56, x, 5.4, 17.692, 5], [2.4, z, 4.16, x, 2.4, 150.512, 6], [1.35, z, -4.16, x, 1.35, -222.137, 7]]);
  const dP1dY = sum([[-0.48, y, -0.48, z, 5.4, 0, 4], [2.56, y, 2.56, z, 5.4, 0, 5], [4.16, y, 4.16, z, 2.4, 0, 6], [-4.16, y, -4.16, z, 1.35, 0, 7]]);
  return normalize(vec3(dP3dY.sub(dP2dZ), dP1dZ.sub(dP3dX), dP2dX.sub(dP1dY)));
}
const PHASE_RATES = [10.5432895, 20.5432895, 5.535463, -13.534534, 54.42345, -23.53450, -45.5345354313, 23.4234521243];

export class HectorLiquid {
  constructor(app, title) {
    this.app = app; this.P = app.P; this.title = title; this.n = 0; this.frame = 0; this.cache = new Map();
    const U = this.U = {
      count: uniform(0, 'uint'), dt: uniform(1 / 120), spring: uniform(200), damp: uniform(1.5), noise: uniform(4), noiseFreq: uniform(0.8),
      grav: uniform(new THREE.Vector3()), sep: uniform(0.012), cell: uniform(0.012), relax: uniform(1), maxSpeed: uniform(4),
      lo: uniform(new THREE.Vector3()), hi: uniform(new THREE.Vector3(1, 1, 1)),
      gridMin: uniform(new THREE.Vector3()), voxel: uniform(0.012), iso: uniform(0.5), blurR: uniform(1), blurTaps: uniform(1, 'int'), dropR: uniform(1.6), fill: uniform(0), span: uniform(4, 'int'),
      splashAccel: uniform(25), frameDt: uniform(1 / 60), noAccel: uniform(1), surfDepth: uniform(0.03), fling: uniform(1.3), dripRate: uniform(0.03), dripLife: uniform(1.5),
      dripGrav: uniform(new THREE.Vector3(0, -9.81, 0)), dripDrag: uniform(0.3), cohesion: uniform(0.3), cohR: uniform(0.02), frame: uniform(0, 'uint'),
      psize: uniform(0.005),
    };
    this.tph = PHASE_RATES.map(() => uniform(0));
    // particle buffers (fixed capacity, so the render materials never need rebuilding)
    this.tdata = instancedArray(new Float32Array(MAX_P * 12), 'vec4');   // per particle: bind pos | bone idx | weights
    for (const k of ['tgt', 'tgtV', 'pos', 'vel', 'posP', 'posQ']) this[k] = instancedArray(MAX_P, 'vec4');   // tgt.w = depth below skin, tgtV = target velocity | acceleration
    this.counters = instancedArray(new Uint32Array(HB), 'uint').toAtomic();
    this.slots = instancedArray(new Uint32Array(HB * SLOTS), 'uint');
    // marching cubes buffers
    this.triTable = instancedArray(TRI_TABLE, 'int');
    this.triCount = instancedArray(TRI_COUNT, 'uint');
    this.active = instancedArray(new Uint32Array(MAX_A * 4), 'uint');        // voxel, case, triangle offset, count
    this.mcCounts = instancedArray(new Uint32Array(4), 'uint').toAtomic();    // active, triangles, active (frozen), -
    this.vtxPos = instancedArray(MAX_T * 3, 'vec4');
    this.vtxNor = instancedArray(MAX_T * 3, 'vec4');
    this.dispatchArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
    this.drawArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 0, 0]), 1);

    // the liquid surface: marching-cubes triangles straight from the storage buffers, real three.js material
    const phys = () => new THREE.MeshPhysicalNodeMaterial({ clearcoatRoughness: 0.03, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.3 });
    this.matMesh = phys();
    this.matMesh.positionNode = this.vtxPos.element(vertexIndex).xyz;
    this.matMesh.normalNode = transformNormalToView(this.vtxNor.element(vertexIndex).xyz.toVarying('l3Normal'));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));   // count comes from the indirect draw
    geo.setIndirect(this.drawArgs);
    this.mesh = new THREE.Mesh(geo, this.matMesh);
    // debug view: the particles as small spheres
    this.matPts = phys();
    this.matPts.positionNode = attribute('position').mul(U.psize).add(this.pos.element(instanceIndex).xyz);
    const sphere = new THREE.IcosahedronGeometry(1, 1); sphere.deleteAttribute('uv');
    this.points = new THREE.Mesh(sphere, this.matPts);
    this.bounds = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicNodeMaterial({ color: 0x55ffcc }));
    for (const o of [this.mesh, this.points, this.bounds]) { o.frustumCulled = false; o.matrixAutoUpdate = false; o.visible = false; }
    this.bounds.matrixAutoUpdate = true;
    app.scene.add(this.mesh, this.points, this.bounds);
    this.applyMaterial();
  }

  get enabled() { return !!this.P.l3_enabled; }
  get built() { return !!this.kPredict; }
  get count() { return this.n; }
  get info() { return `${this.n.toLocaleString()}${this.voxel ? ` · mesh ${(this.voxel * 100).toFixed(2)} cm` : ''}`; }
  get buildKey() { return `${this.P.l3_spacing}|${FIXED.inset}`; }
  composite(sceneColor) { return sceneColor; }          // a real mesh in the scene: nothing to composite
  render() {}
  idle() {}

  applyMaterial() {
    for (const m of [this.matMesh, this.matPts]) applyPhysical(m, this.P, (f) => 'l3_liq' + f);
    this.updateEnv(this.P.master);
  }
  updateEnv(master) { for (const m of [this.matMesh, this.matPts]) m.envMapIntensity = this.P.l3_liqEnvIntensity * master; }
  setEnv(tex) { for (const m of [this.matMesh, this.matPts]) { m.envMap = tex; m.needsUpdate = true; } }
  reset() { this.needInit = true; this.boxC = null; }
  carry() { if (this.enabled && this.built) { this.app.renderer.compute(this.kCarry); this.carried = true; } }
  sync(skin) { if (this.enabled && skin && (!this.built || this.builtKey !== this.buildKey)) this.build(skin); }

  // interior targets for this spacing/inset + all simulation kernels for this skin
  build(skin) {
    if (!skin) return;
    const P = this.P, key = this.buildKey;
    let data = this.cache.get(key);
    if (!data) this.cache.set(key, (data = sampleInterior(skin.src, P.l3_spacing / 100, FIXED.inset / 100)));
    const n = this.n = Math.min(MAX_P, data.length / 12);
    this.tdata.value.array.set(data.subarray(0, n * 12)); this.tdata.value.needsUpdate = true;
    this.builtKey = key; this.U.count.value = n; this.points.count = n;
    const U = this.U, S = skin.S, pre = skin.U.pre, T = this.tdata, tph = this.tph;
    const { tgt, tgtV, pos, vel, posP, posQ, counters, slots } = this;
    const guard = () => If(instanceIndex.greaterThanEqual(U.count), () => { Return(); });
    const boneMat = (k) => { const b = k.mul(4); return mat4(S.bones.element(b), S.bones.element(b.add(1)), S.bones.element(b.add(2)), S.bones.element(b.add(3))); };
    const skinned = (i) => {                              // linear blend skinning of the particle's interior point
      const bp = T.element(i.mul(3)), bi = T.element(i.mul(3).add(1)), bw = T.element(i.mul(3).add(2));
      const M = boneMat(uint(bi.x)).mul(bw.x).add(boneMat(uint(bi.y)).mul(bw.y)).add(boneMat(uint(bi.z)).mul(bw.z)).add(boneMat(uint(bi.w)).mul(bw.w));
      return pre.mul(M.mul(vec4(bp.xyz, 1.0))).xyz;
    };
    const cellOf = (p) => ivec3(floor(p.div(U.cell))).add(10000);
    const cellHash = (c) => uint(c.x).mul(73856093).bitXor(uint(c.y).mul(19349663)).bitXor(uint(c.z).mul(83492791)).bitAnd(uint(HB - 1));

    // skinned targets + how fast / how hard her body moves there (splashes key off the acceleration)
    this.kTarget = Fn(() => {
      guard();
      const i = instanceIndex, np = skinned(i).toConst();
      const v = np.sub(tgt.element(i).xyz).div(U.frameDt).mul(float(1).sub(U.noAccel)).toConst();
      const a = length(v.sub(tgtV.element(i).xyz)).div(U.frameDt).mul(float(1).sub(U.noAccel));
      tgtV.element(i).assign(vec4(v, a));
      tgt.element(i).assign(vec4(np, T.element(i.mul(3)).w));
    })().compute(n, [WG, 1, 1]);
    // loop wrap / teleport: move every particle by exactly how far its target jumped
    this.kCarry = Fn(() => {
      guard();
      const i = instanceIndex, d = skinned(i).sub(tgt.element(i).xyz);
      pos.element(i).assign(vec4(pos.element(i).xyz.add(d), 1));
    })().compute(n, [WG, 1, 1]);
    this.kInit = Fn(() => {
      guard();
      pos.element(instanceIndex).assign(tgt.element(instanceIndex)); vel.element(instanceIndex).assign(vec4(0));
    })().compute(n, [WG, 1, 1]);
    this.kClearBins = Fn(() => { atomicStore(counters.element(instanceIndex), uint(0)); })().compute(HB, [WG, 1, 1]);

    // forces + prediction + hash binning (Hector's PBF_applyForces), plus break-off / drips.
    // vel.w = drip timer (seconds detached, 0 = attached); posP.w carries it on (-1 = respawned: zero velocity)
    this.kPredict = Fn(() => {
      guard();
      const i = instanceIndex, p = pos.element(i).xyz, t = tgt.element(i).xyz, v0 = vel.element(i);
      const timer = v0.w.toVar(), det = timer.greaterThan(0);
      const acc = vec3(0).toVar();
      If(det, () => { acc.assign(U.dripGrav); }).Else(() => { acc.assign(t.sub(p).mul(U.spring).add(U.grav)); });
      const q = p.mul(U.noiseFreq);
      const nz = curlNoise(q, tph).mul(U.noise).add(curlNoise(q.mul(2), tph).mul(U.noise.mul(0.5)));
      acc.addAssign(nz.mul(det.select(0.25, 1.0)));
      const v = v0.xyz.add(acc.mul(U.dt)).mul(exp(det.select(U.dripDrag, U.damp).mul(U.dt).negate())).toVar();
      const pp = p.add(v.mul(U.dt)).toVar();
      const w = float(0).toVar();
      If(det, () => {
        timer.addAssign(U.dt); w.assign(timer);
        // drip finished or hit the floor: back to its target, inside her (hidden in the liquid mass)
        If(timer.greaterThan(U.dripLife).or(pp.y.lessThanEqual(U.lo.y.add(0.003))), () => { pp.assign(t); w.assign(-1); });
      }).Else(() => {
        // only surface particles can leave: her body accelerating hard there = splash (flung off with its momentum),
        // random rate = drip. Per-particle thresholds so it breaks up gradually.
        If(tgt.element(i).w.lessThan(U.surfDepth), () => {
          const rnd = hash(i.add(uint(7919))).add(0.5);
          const splash = tgtV.element(i).w.greaterThan(U.splashAccel.mul(rnd));
          const drip = hash(i.mul(uint(13)).add(U.frame.mul(uint(7477)))).lessThan(U.dripRate.mul(U.dt));
          If(splash.or(drip), () => { w.assign(1e-4); pp.assign(p.add(v.mul(U.fling).mul(U.dt))); });
        });
      });
      posP.element(i).assign(vec4(pp, w));
      const h = cellHash(cellOf(pp)).toConst();
      const slot = atomicAdd(counters.element(h), uint(1));
      If(slot.lessThan(uint(SLOTS)), () => { slots.element(h.mul(uint(SLOTS)).add(slot)).assign(i.add(uint(1))); });
    })().compute(n, [WG, 1, 1]);

    // separation constraint over the 27 neighbour cells (Hector's PBF_calculateDisplacements), Jacobi
    const separate = (src, dst) => Fn(() => {
      guard();
      const i = instanceIndex, self = src.element(i), p = self.xyz.toConst();
      const c0 = cellOf(p).toConst(), dp = vec3(0).toVar(), coh = vec3(0).toVar(), cohN = float(0).toVar();
      Loop({ start: -1, end: 2, type: 'int', name: 'oz', condition: '<' }, ({ oz }) => {
        Loop({ start: -1, end: 2, type: 'int', name: 'oy', condition: '<' }, ({ oy }) => {
          Loop({ start: -1, end: 2, type: 'int', name: 'ox', condition: '<' }, ({ ox }) => {
            const h = cellHash(c0.add(ivec3(ox, oy, oz))).toConst();
            const cnt = uint(0).toVar(); cnt.assign(min(atomicLoad(counters.element(h)), uint(SLOTS)));   // loop bound must be a plain variable
            Loop({ start: uint(0), end: cnt, type: 'uint', name: 's', condition: '<' }, ({ s }) => {
              const j = slots.element(h.mul(uint(SLOTS)).add(s)).sub(uint(1)).toConst();
              If(j.notEqual(i), () => {
                const d = p.sub(src.element(j).xyz), r = length(d);
                If(r.greaterThan(1e-7).and(r.lessThan(U.sep)), () => { dp.addAssign(d.div(r).mul(U.sep.sub(r).mul(0.5))); })
                  .ElseIf(r.lessThan(U.cohR), () => {          // cohesion: near neighbours pull together (drops, strands)
                    const fall = float(1).sub(r.sub(U.sep).div(U.cohR.sub(U.sep)));
                    coh.subAssign(d.div(r).mul(r.sub(U.sep).mul(0.5).mul(fall))); cohN.addAssign(1);
                  });
              });
            });
          });
        });
      });
      // cohesion is AVERAGED over the neighbours (summed, 20+ pulls overshoot and pump energy in): it cancels in the
      // bulk and leaves a net inward pull at the surface = surface tension
      dp.addAssign(coh.div(max(cohN, 1)).mul(U.cohesion));
      dst.element(i).assign(vec4(clamp(p.add(dp.mul(U.relax)), U.lo, U.hi), self.w));
    })().compute(n, [WG, 1, 1]);
    this.kSepPQ = separate(posP, posQ); this.kSepQP = separate(posQ, posP);

    // velocity from the displacement (Hector's PBF_integrateVelocity): capped, then commit the position
    const integrate = (src) => Fn(() => {
      guard();
      const i = instanceIndex, s4 = src.element(i), np = s4.xyz;
      const v = np.sub(pos.element(i).xyz).div(U.dt).toVar(), w = s4.w.toVar();
      const sp = length(v);
      If(sp.greaterThan(U.maxSpeed), () => { v.mulAssign(U.maxSpeed.div(sp)); });
      If(w.lessThan(0), () => { v.assign(vec3(0)); w.assign(0); });   // respawned
      vel.element(i).assign(vec4(v, w)); pos.element(i).assign(vec4(np, 1));
    })().compute(n, [WG, 1, 1]);
    this.kIntP = integrate(posP); this.kIntQ = integrate(posQ);
    this.needInit = true;
  }

  // voxel grid (dims from bounds + voxel size) and the surface kernels
  buildSurface(dims) {
    const [NX, NY, NZ] = dims, NV = NX * NY * NZ, U = this.U;
    for (const b of [this.occ, this.dA, this.dB]) b?.value?.dispose?.();
    const occ = this.occ = instancedArray(NV, 'uint').toAtomic(), A = this.dA = instancedArray(NV, 'float'), B = this.dB = instancedArray(NV, 'float');
    const { pos, active, mcCounts, triTable, triCount, vtxPos, vtxNor } = this;
    const lin = (q) => q.x.add(q.y.mul(NX)).add(q.z.mul(NX * NY));
    const coord = () => { const i = int(instanceIndex); return ivec3(i.mod(NX), i.div(NX).mod(NY), i.div(NX * NY)); };
    const inGrid = (q) => q.x.greaterThanEqual(0).and(q.y.greaterThanEqual(0)).and(q.z.greaterThanEqual(0)).and(q.x.lessThan(NX)).and(q.y.lessThan(NY)).and(q.z.lessThan(NZ));
    const guardV = () => If(instanceIndex.greaterThanEqual(NV), () => { Return(); });

    // splat, two styles (U.fill):
    //  spheres: each particle writes a smooth sphere (1 - d^2/R^2, radius dropR voxels) by atomic max, so a lone
    //           droplet still reaches the iso level
    //  hector:  each particle marks a solid block of voxels = 1 (half-width dropR; Hector marks 2x2x2), all the
    //           roundness comes from the blur, and a high threshold drops lone particles / thin threads
    this.kSplat = Fn(() => {
      If(instanceIndex.greaterThanEqual(U.count), () => { Return(); });
      const g = pos.element(instanceIndex).xyz.sub(U.gridMin).div(U.voxel).sub(0.5).toConst();   // voxel-centre space
      const base = ivec3(floor(g.sub(U.dropR))).toConst(), span = U.span;
      const invR2 = float(1).div(U.dropR.mul(U.dropR));
      Loop({ start: 0, end: span, type: 'int', name: 'sz', condition: '<' }, ({ sz }) => {
        Loop({ start: 0, end: span, type: 'int', name: 'sy', condition: '<' }, ({ sy }) => {
          Loop({ start: 0, end: span, type: 'int', name: 'sx', condition: '<' }, ({ sx }) => {
            const q = base.add(ivec3(sx, sy, sz)).toConst();
            If(inGrid(q), () => {
              const d = vec3(q).sub(g), ad = d.abs();
              const f = U.fill.greaterThan(0.5).select(max(max(ad.x, ad.y), ad.z).lessThanEqual(U.dropR).select(1.0, 0.0), float(1).sub(dot(d, d).mul(invR2)));
              If(f.greaterThan(0), () => { atomicMax(occ.element(lin(q)), uint(f.mul(65535))); });
            });
          });
        });
      });
    })().compute(MAX_P, [WG, 1, 1]);
    // decode the occupancy to floats (into B) and clear it for the next frame
    this.kDecode = Fn(() => {
      guardV();
      const raw = uint(0).toVar(); raw.assign(atomicLoad(occ.element(instanceIndex)));
      B.element(instanceIndex).assign(float(raw).div(65535));
      atomicStore(occ.element(instanceIndex), uint(0));
    })().compute(NV, [WG, 1, 1]);

    // separable 3D gaussian (Hector's Blur3D) along one axis
    const blur = (src, dst, axis) => Fn(() => {
      guardV();
      const q = coord().toConst(), len = [NX, NY, NZ][axis], stride = [1, NX, NX * NY][axis], along = [q.x, q.y, q.z][axis];
      const sig = max(U.blurR.mul(0.6), 0.35), acc = float(0).toVar(), wsum = float(0).toVar();
      Loop({ start: -8, end: 9, type: 'int', condition: '<' }, ({ i }) => {
        const k = along.add(i);
        If(i.abs().lessThanEqual(U.blurTaps).and(k.greaterThanEqual(0)).and(k.lessThan(len)), () => {
          const w = exp(float(i).mul(float(i)).div(sig.mul(sig).mul(-2)));
          acc.addAssign(src.element(int(instanceIndex).add(i.mul(stride))).mul(w)); wsum.addAssign(w);
        });
      });
      dst.element(instanceIndex).assign(acc.div(wsum));
    })().compute(NV, [WG, 1, 1]);
    this.kBlur = [blur(B, A, 0), blur(A, B, 1), blur(B, A, 2)];        // final density in A

    // classify + compact surface voxels
    const cornerOff = CORNER.map(([x, y, z]) => x + y * NX + z * NX * NY);
    this.kMarch = Fn(() => {
      guardV();
      const q = coord();
      If(q.x.greaterThanEqual(NX - 1).or(q.y.greaterThanEqual(NY - 1)).or(q.z.greaterThanEqual(NZ - 1)), () => { Return(); });
      const c = uint(0).toVar();
      cornerOff.forEach((o, k) => { If(A.element(instanceIndex.add(o)).lessThan(U.iso), () => { c.assign(c.bitOr(uint(1 << k))); }); });
      const nt = triCount.element(c).toConst();
      If(nt.greaterThan(0), () => {
        const off = atomicAdd(mcCounts.element(1), nt);
        const a = atomicAdd(mcCounts.element(0), uint(1));
        If(a.lessThan(MAX_A), () => {
          const b = a.mul(4);
          active.element(b).assign(instanceIndex); active.element(b.add(1)).assign(c); active.element(b.add(2)).assign(off);
          active.element(b.add(3)).assign(off.add(nt).lessThanEqual(MAX_T).select(nt, uint(0)));
        });
      });
    })().compute(NV, [WG, 1, 1]);

    // indirect dispatch (1 thread per active voxel) + indirect draw (3 vertices per triangle); reset counters
    const dArgs = storage(this.dispatchArgs, 'uint', 3), drArgs = storage(this.drawArgs, 'uint', 4);
    this.kArgs = Fn(() => {
      const na = min(atomicLoad(mcCounts.element(0)), uint(MAX_A)), nt = min(atomicLoad(mcCounts.element(1)), uint(MAX_T));
      dArgs.element(0).assign(na.add(uint(WG - 1)).div(uint(WG))); dArgs.element(1).assign(uint(1)); dArgs.element(2).assign(uint(1));
      drArgs.element(0).assign(nt.mul(uint(3))); drArgs.element(1).assign(uint(1)); drArgs.element(2).assign(uint(0)); drArgs.element(3).assign(uint(0));
      atomicStore(mcCounts.element(2), na); atomicStore(mcCounts.element(0), uint(0)); atomicStore(mcCounts.element(1), uint(0));
    })().compute(1);

    // triangles: interpolate each edge vertex, normal from the density gradient, winding with the normal
    const CA = array(EDGE_A.map((v) => int(v))), CB = array(EDGE_B.map((v) => int(v)));
    const CO = array(CORNER.map(([x, y, z]) => ivec3(x, y, z)));
    const D = (q) => A.element(lin(clamp(q, ivec3(0), ivec3(NX - 1, NY - 1, NZ - 1))));
    const grad = (q) => vec3(D(q.add(ivec3(1, 0, 0))).sub(D(q.sub(ivec3(1, 0, 0)))), D(q.add(ivec3(0, 1, 0))).sub(D(q.sub(ivec3(0, 1, 0)))), D(q.add(ivec3(0, 0, 1))).sub(D(q.sub(ivec3(0, 0, 1)))));
    this.kTris = Fn(() => {
      If(instanceIndex.greaterThanEqual(atomicLoad(mcCounts.element(2))), () => { Return(); });
      const b = instanceIndex.mul(4);
      const vox = int(active.element(b)), c = int(active.element(b.add(1))), off = active.element(b.add(2)), nt = active.element(b.add(3));
      const base = ivec3(vox.mod(NX), vox.div(NX).mod(NY), vox.div(NX * NY)).toConst();
      const vert = (e) => {                    // -> [world position, outward normal]
        const qa = base.add(CO.element(CA.element(e))).toConst(), qb = base.add(CO.element(CB.element(e))).toConst();
        const da = D(qa), db = D(qb), den = db.sub(da);
        const t = clamp(U.iso.sub(da).div(den.abs().lessThan(1e-6).select(1e-6, den)), 0.0, 1.0).toConst();
        const p = mix(vec3(qa), vec3(qb), t).add(0.5).mul(U.voxel).add(U.gridMin);
        const nrm = normalize(mix(grad(qa), grad(qb), t).negate().add(vec3(0, 1e-6, 0)));
        return [p.toVar(), nrm.toVar()];
      };
      Loop({ start: uint(0), end: nt, type: 'uint', name: 't', condition: '<' }, ({ t }) => {
        const e = c.mul(16).add(int(t).mul(3));
        const [p0, n0] = vert(triTable.element(e)), [p1, n1] = vert(triTable.element(e.add(1))), [p2, n2] = vert(triTable.element(e.add(2)));
        const gn = cross(p1.sub(p0), p2.sub(p0)).toVar();
        If(dot(gn, n0.add(n1).add(n2)).lessThan(0), () => {                // front faces point outwards
          const tp = p1.toVar(), tn = n1.toVar(); p1.assign(p2); n1.assign(n2); p2.assign(tp); n2.assign(tn); gn.assign(gn.negate());
        });
        const o = off.add(t).mul(3);
        vtxPos.element(o).assign(vec4(p0, 1)); vtxPos.element(o.add(1)).assign(vec4(p1, 1)); vtxPos.element(o.add(2)).assign(vec4(p2, 1));
        vtxNor.element(o).assign(vec4(n0, 0)); vtxNor.element(o.add(1)).assign(vec4(n1, 0)); vtxNor.element(o.add(2)).assign(vec4(n2, 0));
      });
    })().compute(MAX_A, [WG, 1, 1]);
    this.dims = dims;
  }

  step(dtFrame, center) {
    const P = this.P, U = this.U, r = this.app.renderer, on = this.enabled && this.built;
    const asMesh = P.l3_render !== 'particles';
    this.mesh.visible = on && asMesh; this.points.visible = on && !asMesh; this.bounds.visible = this.enabled && P.l3_showBounds;
    if (!on) return;
    // bounds: W x H x D box following her hips (floor at y = l3_floor)
    const W = P.l3_boundsX, H = P.l3_boundsY, Dp = P.l3_boundsZ;
    const F = P.l3_floor;
    const top = Math.max(H, F + 0.1);                               // floor moves only the bottom; height = top of the box
    // the box trails her smoothly (a snapping box swings the liquid on every turn), but never so far that she'd
    // leave it: it stays within (half size - 35 cm) of her hips
    const lag = P.l3_boundsLag;
    if (!this.boxC || this.carried) this.boxC = new THREE.Vector3(center.x, 0, center.z);
    else if (dtFrame > 0) {
      const a = lag <= 0 ? 1 : 1 - Math.exp(-dtFrame / lag);
      this.boxC.x += (center.x - this.boxC.x) * a; this.boxC.z += (center.z - this.boxC.z) * a;
    }
    const mx = Math.max(0, W / 2 - 0.35), mz = Math.max(0, Dp / 2 - 0.35);
    this.boxC.x = THREE.MathUtils.clamp(this.boxC.x, center.x - mx, center.x + mx);
    this.boxC.z = THREE.MathUtils.clamp(this.boxC.z, center.z - mz, center.z + mz);
    const bx = this.boxC.x, bz = this.boxC.z;
    U.lo.value.set(bx - W / 2, F, bz - Dp / 2); U.hi.value.set(bx + W / 2, top, bz + Dp / 2);
    this.bounds.position.set(bx, (F + top) / 2, bz); this.bounds.scale.set(W, top - F, Dp);
    const sp = P.l3_spacing / 100;
    U.sep.value = sp * (1 + FIXED.separation);
    U.cohR.value = U.sep.value * FIXED.cohesionRange; U.cell.value = U.cohR.value;   // 27 cells cover the cohesion range
    U.splashAccel.value = P.l3_splashAccel; U.surfDepth.value = P.l3_surfDepth / 100; U.fling.value = P.l3_fling;
    U.dripRate.value = P.l3_dripRate; U.dripLife.value = P.l3_dripLife; U.dripDrag.value = FIXED.dripDrag;
    U.dripGrav.value.set(0, -9.81 * P.l3_dripGravity, 0); U.cohesion.value = P.l3_cohesion;
    U.spring.value = P.l3_spring; U.damp.value = P.l3_damping; U.noise.value = P.l3_noise; U.noiseFreq.value = P.l3_noiseFreq;
    U.grav.value.set(0, -9.81 * P.l3_gravity, 0); U.relax.value = P.l3_relax; U.maxSpeed.value = P.l3_maxSpeed;
    U.psize.value = P.l3_particleSize / 100;
    // Hector's noise phases advance per frame (t_k = frame * rate_k), kept in [0, 2pi) on the CPU
    this.frame += 1;
    this.tph.forEach((u, k) => { u.value = (this.frame * PHASE_RATES[k]) % (2 * Math.PI); });

    U.frameDt.value = Math.max(dtFrame, 1e-4);
    if (this.needInit || this.carried) this.quiet = 2;             // no fake acceleration from a reset / loop jump (2 frames:
    U.noAccel.value = this.quiet > 0 ? 1 : 0; this.quiet = Math.max(0, (this.quiet || 0) - 1); this.carried = false;   //  velocity, then accel)
    r.compute(this.kTarget);
    if (this.needInit) { r.compute(this.kInit); this.needInit = false; }
    if (dtFrame > 1e-4) {
      const sub = FIXED.substeps;
      U.dt.value = Math.min(dtFrame, 1 / 30) / sub;
      const it = FIXED.iterations;
      for (let s = 0; s < sub; s++) {
        U.frame.value = (U.frame.value + 1) % 1000000;
        r.compute(this.kClearBins);
        r.compute(this.kPredict);
        for (let k = 0; k < it; k++) r.compute(k % 2 ? this.kSepQP : this.kSepPQ);
        r.compute(it % 2 ? this.kIntQ : this.kIntP);
      }
    }
    if (!asMesh) return;
    // surface: voxel grid snapped to voxel multiples (so it doesn't swim as she moves)
    // mesh resolution (voxel size) from the dropdown; if the grid over the bounds would exceed one buffer, use the
    // finest voxel that fits (shrink the bounds to go finer). Droplet radius + blur are in particle-spacing units, so
    // a finer grid adds surface detail instead of changing the shape.
    let v = (MC_RES[P.l3_mcRes] ?? 1) / 100;
    const gridFor = (vv) => [W, top - F, Dp].map((e) => Math.ceil((e + 6 * vv) / vv));   // the box, incl. a lowered floor
    let dims = gridFor(v);
    if (dims[0] * dims[1] * dims[2] > MAX_V) { v *= Math.cbrt(dims[0] * dims[1] * dims[2] / MAX_V) * 1.02; dims = gridFor(v); }
    const pad = 3 * v;
    this.voxel = v;
    if (!this.dims || dims.join() !== this.dims.join()) this.buildSurface(dims);
    const hector = P.l3_surfStyle === 'hector (fill + blur)';
    // hector: block about one particle spacing wide (at least 2x2x2 voxels, like his); spheres: blob size slider
    const dropR = hector ? Math.max(1, 0.5 * sp / v) : Math.max(0.4, P.l3_dropRadius) * sp / v;   // in voxels
    U.fill.value = hector ? 1 : 0;
    U.voxel.value = v; U.iso.value = hector ? P.l3_threshold : FIXED.iso; U.dropR.value = dropR; U.span.value = Math.min(40, Math.floor(2 * dropR) + 2);
    const blurR = Math.max(0, P.l3_blurSize) * sp / v;
    U.blurR.value = blurR; U.blurTaps.value = Math.min(8, Math.ceil(blurR));
    U.gridMin.value.set(Math.floor((U.lo.value.x - pad) / v) * v, Math.floor((U.lo.value.y - pad) / v) * v, Math.floor((U.lo.value.z - pad) / v) * v);
    r.compute(this.kSplat);
    r.compute(this.kDecode);
    for (const k of this.kBlur) r.compute(k);
    r.compute(this.kMarch);
    r.compute(this.kArgs);
    r.compute(this.kTris, this.dispatchArgs);
  }

  gui(parent, { skin, matchCloth, refresh }) {
    const P = this.P, lm = () => this.applyMaterial(), rebuild = () => { if (this.enabled) this.build(skin()); };
    const f = parent.addFolder(this.title);
    f.add(P, 'l3_enabled').name('enabled').onChange((v) => { if (v) this.sync(skin()); this.reset(); });
    f.add({ reset: () => this.reset() }, 'reset').name('reset liquid');
    f.add(P, 'l3_render', ['mesh (marching cubes)', 'particles']).name('render as');
    const fp = f.addFolder('Pull into body');
    fp.add(P, 'l3_spring', 0, 2000, 1).name('pull strength');
    fp.add(P, 'l3_damping', 0, 20, 0.05).name('damping (calmness)');
    fp.add(P, 'l3_maxSpeed', 0.1, 10, 0.05).name('max velocity (m/s)');
    fp.add(P, 'l3_gravity', -2, 3, 0.01).name('gravity (× earth)');
    const fl = f.addFolder('Flow');
    fl.add(P, 'l3_spacing', 0.6, 3, 0.05).name('particle spacing (cm)').onFinishChange(rebuild);
    fl.add(P, 'l3_relax', 0, 1, 0.01).name('push apart');
    fl.add(P, 'l3_noise', 0, 60, 0.1).name('swirl');
    fl.add(P, 'l3_noiseFreq', 0.05, 6, 0.01).name('swirl detail');
    const fd = f.addFolder('Splash & drips');
    fd.add(P, 'l3_splashAccel', 1, 200, 0.5).name('splash threshold (m/s²)');
    fd.add(P, 'l3_fling', 0.5, 3, 0.01).name('fling');
    fd.add(P, 'l3_surfDepth', 0, 20, 0.1).name('splash depth (cm)');
    fd.add(P, 'l3_dripRate', 0, 1, 0.001).name('drip rate');
    fd.add(P, 'l3_dripLife', 0.1, 6, 0.05).name('drop lifetime (s)');
    fd.add(P, 'l3_dripGravity', 0, 3, 0.01).name('drop gravity');
    fd.add(P, 'l3_cohesion', 0, 1, 0.01).name('stickiness');
    const fb = f.addFolder('Bounds');
    fb.add(P, 'l3_showBounds').name('show');
    fb.add(P, 'l3_boundsX', 0.5, 4, 0.01).name('width (m)');
    fb.add(P, 'l3_boundsY', 0.5, 4, 0.01).name('height (m)');
    fb.add(P, 'l3_boundsZ', 0.5, 4, 0.01).name('depth (m)');
    fb.add(P, 'l3_floor', -1, 1, 0.01).name('floor (m)');
    fb.add(P, 'l3_boundsLag', 0, 3, 0.01).name('follow smoothing (s)');
    const fr = f.addFolder('Surface');
    fr.add(P, 'l3_mcRes', Object.keys(MC_RES)).name('mesh resolution');
    const style = () => { const h = P.l3_surfStyle === 'hector (fill + blur)'; cBlob.__li.style.display = h ? 'none' : ''; cThr.__li.style.display = h ? '' : 'none'; };
    fr.add(P, 'l3_surfStyle', ['spheres', 'hector (fill + blur)']).name('surface style').onChange(style);
    const cBlob = fr.add(P, 'l3_dropRadius', 0.4, 3, 0.05).name('blob size');
    const cThr = fr.add(P, 'l3_threshold', 0.05, 0.95, 0.01).name('threshold');
    this.guiStyle = style; style();
    fr.add(P, 'l3_blurSize', 0, 3, 0.05).name('smoothness');
    fr.add(P, 'l3_particleSize', 0.05, 3, 0.01).name('particle size (particles view)');
    const fm = f.addFolder('Material');
    fm.add({ match: () => { matchCloth(P, (k) => 'l3_liq' + k); lm(); refresh(); } }, 'match').name('⇆ copy cloth material');
    addMaterialControls(fm, P, (k) => 'l3_liq' + k, lm);
    fm.add(P, 'l3_liqEnvIntensity', 0, 4, 0.01).name('env intensity').onChange(lm);
    return f;
  }
}
