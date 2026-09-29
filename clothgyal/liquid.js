// WebGPU liquid attracted to the body (three.js r186, TSL compute).
// MLS-MPM fluid, following three.js' webgpu_compute_particles_fluid example (itself after
// matsuoka-601/WebGPU-Ocean). Particles live in world space; the G^3 grid (64/96/128) is a box that follows her hips.
// Per substep: P2G1 (momentum) -> P2G2 (pressure/viscosity) -> grid update (which also clears the atomic grid for
// the next substep, so there is no separate clear pass) -> G2P (+ body forces).
//
// Attraction is to the NEAREST point of her skin, not a fixed tether (Zibra-style "liquid attract"):
//   1. each skin vertex seeds the grid cells around it (atomicMin of distance|index)
//   2. jump flooding spreads "nearest skin vertex" to every cell within ~15 cells
//   3. each particle looks up its cell's nearest vertex and is pulled along that vertex's normal toward
//      a thin shell just above the skin -> it can slide freely along her, sag, drip and pass through
//      (no collision), and it can't collapse into the middle of thin limbs.
// "Stickiness" drags liquid toward the skin's own velocity near the surface, so she carries it around.
// Grid velocities are in cells/s (like the example); positions are metres.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, instancedArray, instanceIndex, uniform, attribute, float, int, uint, ivec3, vec3, vec4, mat3,
  array, struct, atomicAdd, atomicStore, atomicLoad, atomicMin, Loop, max, min, pow, clamp, hash, length, exp, smoothstep,
} from 'three/tsl';

const GRIDS = [64, 96, 128];     // grid cells per axis (P.liquidGrid picks one; changing it reallocates the grid)
const FIXED = 1e7;              // WebGPU only has int atomics -> fixed point
const WG = 64;
const NONE = 0xffffffff;
// jump-flood passes: reach ~15 cells (~30 cm at any grid size, enough for the attraction range); 64: 4,2,1,1  128: 8,4,2,1,1
const jfaSteps = (G) => { const s = []; for (let k = G >> 4; k >= 1; k >>= 1) s.push(k); s.push(1); return s; };
export const LIQUID_MAX = 400000;

export class Liquid {
  // mode 'ours'      : forces in world units (spring to the nearest skin point, stickiness), real-time dt
  // mode 'waterball' : WaterBall's g2p (fractalfantasy/waterball/mls-mpm): grid-time dt (0.2) x speed, velocity
  //                    drag multiplier, constant-strength meshAttract toward the nearest skin point, meshRepulse
  //                    pushing out of the body by penetration depth, per-step gravity, lookahead soft walls
  constructor(renderer, material, P, mode = 'ours') {
    this.renderer = renderer; this.P = P; this.material = material; this.mode = mode;
    this.count = 0; this.skin = null; this.needInit = true; this.frame = 0;

    const particleStruct = struct({ position: { type: 'vec3' }, velocity: { type: 'vec3' }, C: { type: 'mat3' } });
    this.particles = instancedArray(new Float32Array(LIQUID_MAX * 20), particleStruct);   // vec3 = 4 floats, mat3 = 12
    const cellStruct = struct({
      x: { type: 'int', atomic: true }, y: { type: 'int', atomic: true }, z: { type: 'int', atomic: true }, mass: { type: 'int', atomic: true },
    });
    this.cellStruct = cellStruct;
    this.allocGrid(GRIDS.includes(P.liquidGrid | 0) ? P.liquidGrid | 0 : 64);
    this.density = instancedArray(LIQUID_MAX, 'float');   // per-particle density (renderers shrink sparse spray)

    this.U = {
      count: uniform(0, 'uint'), nU: uniform(1, 'uint'), frame: uniform(0, 'uint'),
      boxMin: uniform(new THREE.Vector3()), lo: uniform(new THREE.Vector3()), hi: uniform(new THREE.Vector3(1, 1, 1)), h: uniform(0.0375), invH: uniform(1 / 0.0375),
      dt: uniform(1 / 120), frameDt: uniform(1 / 60), hasPrev: uniform(0), grav: uniform(new THREE.Vector3(0, -260, 0)),
      stiffness: uniform(20), restDensity: uniform(8), viscosity: uniform(0.1),
      attract: uniform(300), range: uniform(0.15), stick: uniform(4),
      offset: uniform(0.004), respawnRate: uniform(0.5), maxV: uniform(100), maxSpeed: uniform(3), size: uniform(0.006),
      // unit conversions (internal velocity <-> m/s, position step, real seconds per sim step)
      velScale: uniform(1 / 0.0375), velToMs: uniform(0.0375), posScale: uniform(0.0375 / 120), stepSec: uniform(1 / 120),
      center: uniform(new THREE.Vector3()),
      // waterball mode
      wbDrag: uniform(1), meshAttract: uniform(1), meshRepulse: uniform(1), wbGravity: uniform(0),
      wallStiffness: uniform(1), bottomWall: uniform(0), fill: uniform(0), fillBand: uniform(0.02), overflow: uniform(0),
    };

    // render: one small icosphere per particle, instanced straight from the particle buffer
    const geo = new THREE.IcosahedronGeometry(1, 1);
    geo.deleteAttribute('uv');
    material.positionNode = attribute('position').mul(this.U.size).add(this.particles.element(instanceIndex).get('position'));
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    // wireframe of the liquid bounds (toggle: P.liquidShowBounds)
    this.boundsHelper = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicNodeMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.8 }));
    this.boundsHelper.matrixAutoUpdate = false; this.boundsHelper.frustumCulled = false; this.boundsHelper.visible = false;
  }

  // (re)allocate the G^3 grid buffers + grid kernels
  allocGrid(G) {
    for (const b of [this.cells, this.cellsF, this.seed, this.nearA, this.nearB]) b?.value?.dispose?.();
    const CELLS = G * G * G;
    this.G = G;
    this.cells = instancedArray(CELLS, this.cellStruct);
    this.cellsF = instancedArray(CELLS, 'vec4');
    this.seed = instancedArray(new Uint32Array(CELLS).fill(NONE), 'uint').toAtomic();   // (dist 12 bit | vertex 20 bit)
    this.nearA = instancedArray(new Uint32Array(CELLS).fill(NONE), 'uint');             // nearest skin vertex per cell
    this.nearB = instancedArray(new Uint32Array(CELLS).fill(NONE), 'uint');
    this.buildGrid();
  }

  buildGrid() {
    const cells = this.cells, cellsF = this.cellsF, G = this.G, CELLS = G * G * G;
    const dec = (i) => float(i).div(FIXED);
    // grid update: momentum -> velocity (walls zeroed) into cellsF, and reset the atomic cell for the next substep
    this.kGrid = Fn(() => {
      const c = cells.element(instanceIndex);
      const mass = dec(atomicLoad(c.get('mass'))).toConst();
      const vx = dec(atomicLoad(c.get('x'))).div(max(mass, 1e-9)).toVar();
      const vy = dec(atomicLoad(c.get('y'))).div(max(mass, 1e-9)).toVar();
      const vz = dec(atomicLoad(c.get('z'))).div(max(mass, 1e-9)).toVar();
      atomicStore(c.get('x'), 0); atomicStore(c.get('y'), 0); atomicStore(c.get('z'), 0); atomicStore(c.get('mass'), 0);
      If(mass.lessThanEqual(0), () => { cellsF.element(instanceIndex).assign(vec4(0)); Return(); });
      const x = int(instanceIndex).div(int(G * G));
      const y = int(instanceIndex).div(int(G)).mod(int(G));
      const z = int(instanceIndex).mod(int(G));
      If(x.lessThan(1).or(x.greaterThan(G - 2)), () => { vx.assign(0); });
      If(y.lessThan(1).or(y.greaterThan(G - 2)), () => { vy.assign(0); });
      If(z.lessThan(1).or(z.greaterThan(G - 2)), () => { vz.assign(0); });
      cellsF.element(instanceIndex).assign(vec4(vx, vy, vz, mass));
    })().compute(CELLS);
  }

  // (re)build the particle + skin kernels; needed when the particle count or the skin changes
  build(skin, count) {
    this.skin = skin; this.count = count;
    const S = skin.S, U = this.U, parts = this.particles, cells = this.cells, cellsF = this.cellsF, densityBuf = this.density;
    const seed = this.seed, nearA = this.nearA, nearB = this.nearB, G = this.G, CELLS = G * G * G, JFA_STEPS = jfaSteps(G);
    U.count.value = count; U.nU.value = skin.nU;
    this.mesh.count = count;
    // per-vertex previous position + velocity: body velocity from how the skin actually moved this frame
    for (const b of [this.prev, this.velV]) b?.value?.dispose?.();
    const prev = this.prev = instancedArray(skin.nU, 'vec4');
    const velV = this.velV = instancedArray(skin.nU, 'vec4');
    U.hasPrev.value = 0;

    const enc = (f) => int(f.mul(FIXED));
    const dec = (i) => float(i).div(FIXED);
    const cellPtr = (c) => c.x.mul(G * G).add(c.y.mul(G)).add(c.z);
    const cellCoord = () => ivec3(int(instanceIndex).div(int(G * G)), int(instanceIndex).div(int(G)).mod(int(G)), int(instanceIndex).mod(int(G)));
    const inGrid = (c) => c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.z.greaterThanEqual(0))
      .and(c.x.lessThan(G)).and(c.y.lessThan(G)).and(c.z.lessThan(G));
    const gridPos = (p) => clamp(p.sub(U.boxMin).mul(U.invH), 1.0, G - 2.001);
    const shellPoint = (v) => S.p.element(v).xyz.add(S.dn.element(v).xyz.mul(U.offset));
    const weightsOf = (gp) => {
      const d = gp.fract().sub(0.5).toConst();
      const w0 = float(0.5).mul(float(0.5).sub(d)).mul(float(0.5).sub(d));
      const w1 = float(0.75).sub(d.mul(d));
      const w2 = float(0.5).mul(float(0.5).add(d)).mul(float(0.5).add(d));
      return array([w0, w1, w2]).toConst();
    };
    const each = (fn) => Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => fn(gx, gy, gz));
      });
    });
    const anchorOf = (i) => min(uint(hash(i).mul(float(U.nU))), U.nU.sub(1));
    const guard = () => If(instanceIndex.greaterThanEqual(U.count), () => { Return(); });
    const spawnPos = (i, a) => {
      const n = S.dn.element(a).xyz;
      const jit = vec3(hash(i.add(uint(17)).add(U.frame)), hash(i.add(uint(29)).add(U.frame)), hash(i.add(uint(41)).add(U.frame))).sub(0.5).mul(U.h);
      // fill mode spawns inside her: below the skin by the container band plus a random depth (up to 3 cm)
      const depth = U.fill.mul(U.fillBand.mul(0.5).add(hash(i.add(uint(53)).add(U.frame)).mul(0.03)));
      return shellPoint(a).add(jit.sub(n.mul(jit.dot(n)))).sub(n.mul(depth));
    };

    // ---- nearest-skin grid
    this.kSkinVel = Fn(() => {
      const u = instanceIndex, sp = S.p.element(u).xyz;
      velV.element(u).assign(vec4(sp.sub(prev.element(u).xyz).div(U.frameDt).mul(U.hasPrev), 0));
      prev.element(u).assign(vec4(sp, 1));
    })().compute(skin.nU, [WG, 1, 1]);

    this.kSeed = Fn(() => {
      const u = instanceIndex;
      const gp = shellPoint(u).sub(U.boxMin).mul(U.invH).toConst();
      const base = ivec3(gp.floor()).toConst();
      each((gx, gy, gz) => {
        const c = base.add(ivec3(gx.sub(1), gy.sub(1), gz.sub(1))).toConst();
        If(inGrid(c), () => {
          const dist = length(gp.sub(vec3(c).add(0.5)));                  // < ~2.6 cells
          const q = uint(clamp(dist.div(3.0), 0.0, 1.0).mul(4095.0));
          atomicMin(seed.element(cellPtr(c)), q.shiftLeft(uint(20)).bitOr(u));
        });
      });
    })().compute(skin.nU, [WG, 1, 1]);

    this.kSeedDecode = Fn(() => {
      const key = atomicLoad(seed.element(instanceIndex)).toConst();
      nearA.element(instanceIndex).assign(key.equal(uint(NONE)).select(uint(NONE), key.bitAnd(uint(0xfffff))));
      atomicStore(seed.element(instanceIndex), uint(NONE));
    })().compute(CELLS);

    const jfa = (src, dst, k) => Fn(() => {
      const q = cellCoord().toConst();
      const center = U.boxMin.add(vec3(q).add(0.5).mul(U.h)).toConst();
      const best = src.element(instanceIndex).toVar();
      const bestD = float(1e9).toVar();
      If(best.notEqual(uint(NONE)), () => { bestD.assign(length(shellPoint(best).sub(center))); });
      each((gx, gy, gz) => {
        const c = q.add(ivec3(gx.sub(1), gy.sub(1), gz.sub(1)).mul(k)).toConst();
        If(inGrid(c), () => {
          const v = src.element(cellPtr(c)).toConst();
          If(v.notEqual(uint(NONE)), () => {
            const d = length(shellPoint(v).sub(center));
            If(d.lessThan(bestD), () => { bestD.assign(d); best.assign(v); });
          });
        });
      });
      dst.element(instanceIndex).assign(best);
    })().compute(CELLS);
    // ping-pong A->B->A->... : the result is in nearB after an odd number of passes, nearA after an even one
    this.kJfa = JFA_STEPS.map((k, i) => (i % 2 === 0 ? jfa(nearA, nearB, k) : jfa(nearB, nearA, k)));
    const nearest = JFA_STEPS.length % 2 ? nearB : nearA;

    this.kInit = Fn(() => {
      guard();
      const i = instanceIndex, a = anchorOf(i);
      const P_ = parts.element(i);
      P_.get('position').assign(spawnPos(i, a));
      P_.get('velocity').assign(velV.element(a).xyz.mul(U.velScale));
      P_.get('C').assign(mat3(0, 0, 0, 0, 0, 0, 0, 0, 0));
    })().compute(count, [WG, 1, 1]);

    // loop wrap / teleport: shift every particle by how far its spawn vertex jumped
    this.kCarry = Fn(() => {
      guard();
      const i = instanceIndex, a = anchorOf(i);
      const d = S.T.element(a).xyz.sub(S.corr.element(a).xyz);
      parts.element(i).get('position').addAssign(d);
    })().compute(count, [WG, 1, 1]);

    this.kP2G1 = Fn(() => {
      guard();
      const Pi = parts.element(instanceIndex);
      const vel = Pi.get('velocity').toConst(), C = Pi.get('C').toConst();
      const gp = gridPos(Pi.get('position')).toConst();
      const base = ivec3(gp).sub(1).toConst();
      const w = weightsOf(gp);
      each((gx, gy, gz) => {
        const wt = w.element(gx).x.mul(w.element(gy).y).mul(w.element(gz).z);
        const cx = base.add(ivec3(gx, gy, gz)).toConst();
        const dist = vec3(cx).add(0.5).sub(gp);
        const mv = wt.mul(vel.add(C.mul(dist))).toConst();
        const c = cells.element(cellPtr(cx));
        atomicAdd(c.get('x'), enc(mv.x)); atomicAdd(c.get('y'), enc(mv.y)); atomicAdd(c.get('z'), enc(mv.z));
        atomicAdd(c.get('mass'), enc(wt));
      });
    })().compute(count, [WG, 1, 1]);

    this.kP2G2 = Fn(() => {
      guard();
      const Pi = parts.element(instanceIndex);
      const gp = gridPos(Pi.get('position')).toConst();
      const base = ivec3(gp).sub(1).toConst();
      const w = weightsOf(gp);
      const density = float(0).toVar();
      each((gx, gy, gz) => {
        const wt = w.element(gx).x.mul(w.element(gy).y).mul(w.element(gz).z);
        const cx = base.add(ivec3(gx, gy, gz)).toConst();
        density.addAssign(dec(atomicLoad(cells.element(cellPtr(cx)).get('mass'))).mul(wt));
      });
      densityBuf.element(instanceIndex).assign(density);
      const volume = float(1).div(max(density, 1e-4));
      const pressure = max(0.0, pow(density.div(U.restDensity), 5.0).sub(1).mul(U.stiffness)).toConst();
      const stress = mat3(pressure.negate(), 0, 0, 0, pressure.negate(), 0, 0, 0, pressure.negate()).toVar();
      const C = Pi.get('C').toConst();
      stress.addAssign(C.add(C.transpose()).mul(U.viscosity));
      const term = volume.mul(-4).mul(stress).mul(U.dt).toConst();
      each((gx, gy, gz) => {
        const wt = w.element(gx).x.mul(w.element(gy).y).mul(w.element(gz).z);
        const cx = base.add(ivec3(gx, gy, gz)).toConst();
        const dist = vec3(cx).add(0.5).sub(gp);
        const mom = term.mul(wt).mul(dist).toConst();
        const c = cells.element(cellPtr(cx));
        atomicAdd(c.get('x'), enc(mom.x)); atomicAdd(c.get('y'), enc(mom.y)); atomicAdd(c.get('z'), enc(mom.z));
      });
    })().compute(count, [WG, 1, 1]);

    this.kG2P = Fn(() => {
      guard();
      const i = instanceIndex, Pi = parts.element(i);
      const pos = Pi.get('position').toVar();
      const gp = gridPos(pos).toConst();
      const base = ivec3(gp).sub(1).toConst();
      const w = weightsOf(gp);
      const vel = vec3(0).toVar();
      const B = mat3(0, 0, 0, 0, 0, 0, 0, 0, 0).toVar();
      each((gx, gy, gz) => {
        const wt = w.element(gx).x.mul(w.element(gy).y).mul(w.element(gz).z);
        const cx = base.add(ivec3(gx, gy, gz)).toConst();
        const dist = vec3(cx).add(0.5).sub(gp).toConst();
        const wv = cellsF.element(cellPtr(cx)).xyz.mul(wt).toConst();
        B.addAssign(mat3(wv.mul(dist.x), wv.mul(dist.y), wv.mul(dist.z)));
        vel.addAssign(wv);
      });
      Pi.get('C').assign(B.mul(4));
      const v = nearest.element(cellPtr(ivec3(gp))).toConst();
      const onBody = float(0).toVar();
      if (this.mode === 'waterball') {
        // --- WaterBall g2p: drag, move, then forces for the next step (sphere -> her mesh)
        vel.mulAssign(U.wbDrag);
        const vmax = U.maxV;                                   // speed cap / 1 cell per step
        const sp = length(vel);
        If(sp.greaterThan(vmax), () => { vel.mulAssign(vmax.div(sp)); });
        pos.addAssign(vel.mul(U.posScale));
        pos.assign(clamp(pos, U.lo, U.hi));
        const toT = vec3(0).toVar();
        If(v.notEqual(uint(NONE)), () => {
          const q = shellPoint(v).toConst(), n = S.dn.element(v).xyz.toConst();
          const sd = pos.sub(q).dot(n).toConst();                 // signed distance: + outside her, - inside
          const vw = velV.element(v).xyz.mul(U.velScale).toConst(); // skin (wall) velocity
          If(U.fill.greaterThan(0.5), () => {
            // --- FILL: her body is a moving container (a kinematic wall, no spring forces, so it can't pump energy in).
            // At/near the skin: no outward motion relative to the moving skin, friction toward its velocity
            // (stickiness). Through the skin: snapped back onto it. Overflow lets a fraction leak; leaked liquid
            // (outside) is pulled back in by meshAttract.
            onBody.assign(sd.lessThan(U.range).select(1.0, 0.0));
            const hold = float(1).sub(U.overflow);
            If(sd.greaterThan(U.fillBand.negate()), () => {
              const vnRel = vel.sub(vw).dot(n);
              If(vnRel.greaterThan(0), () => { vel.subAssign(n.mul(vnRel.mul(hold))); });
              const drag = float(1).sub(exp(U.stick.mul(U.stepSec).negate()));
              vel.addAssign(vw.sub(vel).mul(drag));
            });
            If(sd.greaterThan(0), () => {
              pos.subAssign(n.mul(sd.mul(hold)));
              const tgt = q.sub(n.mul(U.fillBand)).sub(pos);
              vel.addAssign(tgt.div(max(length(tgt), 1e-6)).mul(0.1).mul(U.meshAttract).mul(U.overflow));
            });
          }).Else(() => {
            // --- SURFACE (coat)
            toT.assign(q.sub(pos));
            onBody.assign(smoothstep(U.range, U.range.mul(0.6), length(toT)));
            // meshRepulse: inside her (behind the skin), push out along the normal by the penetration (cells) x 3
            If(sd.lessThan(0), () => { vel.addAssign(n.mul(sd.negate().mul(U.invH)).mul(3).mul(U.meshRepulse)); });
            // stickiness (not in WaterBall; 0 by default): drift toward the skin's velocity near the surface
            const x = length(toT).div(U.range.mul(0.35));
            const drag = float(1).sub(exp(U.stick.mul(U.stepSec).negate())).mul(exp(x.mul(x).negate()));
            vel.addAssign(vw.sub(vel).mul(drag));
            // meshAttract: constant-strength pull toward the nearest skin point (WaterBall: 0.1 x sphereAttract)
            vel.addAssign(toT.div(max(length(toT), 1e-6)).mul(0.1).mul(U.meshAttract));
          });
        }).Else(() => {
          toT.assign(U.center.sub(pos));                            // skin out of reach: head for her hips
          vel.addAssign(toT.div(max(length(toT), 1e-6)).mul(0.1).mul(U.meshAttract));
        });
        vel.subAssign(vec3(0, U.wbGravity, 0));
        // soft walls with lookahead (k = 3), floor raised by bottomWall
        const xN = pos.sub(U.lo).mul(U.invH).add(vel.mul(U.dt).mul(3)).toConst();          // cells from the min corner
        const wMin = vec3(0, U.bottomWall.mul(U.hi.y.sub(U.lo.y)).mul(0.5).mul(U.invH), 0);
        const wMax = U.hi.sub(U.lo).mul(U.invH);
        vel.addAssign(wMin.sub(xN).max(0.0).mul(U.wallStiffness));
        vel.addAssign(wMax.sub(xN).min(0.0).mul(U.wallStiffness));
      } else {
        vel.addAssign(U.grav.mul(U.dt));

        // attraction to the nearest skin point: a spring along that point's normal toward the shell
        // (tangential motion is free, so the liquid slides; it pulls from inside too, no hard collision)
        If(v.notEqual(uint(NONE)), () => {
          const n = S.dn.element(v).xyz.toConst();
          const d = pos.sub(shellPoint(v)).toConst();
          const dist = length(d).toConst();
          const fade = smoothstep(U.range, U.range.mul(0.6), dist);
          onBody.assign(fade);
          const sd = d.dot(n);
          vel.subAssign(n.mul(sd.mul(U.attract).mul(fade)).mul(U.invH).mul(U.dt));
          // stickiness: near the skin, drift toward the skin's own velocity so she carries the liquid
          const x = dist.div(U.range.mul(0.35));
          const drag = float(1).sub(exp(U.stick.mul(U.dt).negate())).mul(exp(x.mul(x).negate()));
          vel.addAssign(velV.element(v).xyz.mul(U.velScale).sub(vel).mul(drag));
        });

        // speed limit (keeps the sim stable when she whips around)
        const vmax = min(U.maxV, U.maxSpeed.mul(U.invH));        // user max speed (m/s) or 1 cell/substep
        const sp = length(vel);
        If(sp.greaterThan(vmax), () => { vel.mulAssign(vmax.div(sp)); });
        pos.addAssign(vel.mul(U.dt).mul(U.h));

        // soft walls at the liquid bounds (a box around her; floor at world y = 0)
        const xN = pos.add(vel.mul(U.dt).mul(U.h).mul(2)).toConst();
        vel.addAssign(U.lo.sub(xN).max(0.0).mul(U.invH));
        vel.addAssign(U.hi.sub(xN).min(0.0).mul(U.invH));
        pos.assign(clamp(pos, U.lo, U.hi));
      }

      // respawn on the skin: constantly (each particle at `respawnRate` per second, so the liquid keeps
      // renewing), straight away when it reaches the bounds, and faster once it has left the body
      const e = U.h.mul(0.5);
      const atBounds = pos.x.lessThan(U.lo.x.add(e)).or(pos.y.lessThan(U.lo.y.add(e))).or(pos.z.lessThan(U.lo.z.add(e)))
        .or(pos.x.greaterThan(U.hi.x.sub(e))).or(pos.y.greaterThan(U.hi.y.sub(e))).or(pos.z.greaterThan(U.hi.z.sub(e)));
      const rate = U.respawnRate.mul(onBody.lessThan(0.01).select(4.0, 1.0));
      If(atBounds.or(hash(i.mul(uint(7)).add(U.frame.mul(uint(7919)))).lessThan(rate.mul(U.stepSec))), () => {
        const a = anchorOf(i);
        pos.assign(spawnPos(i, a));
        vel.assign(velV.element(a).xyz.mul(U.velScale));
        Pi.get('C').assign(mat3(0, 0, 0, 0, 0, 0, 0, 0, 0));
      });
      Pi.get('position').assign(pos);
      Pi.get('velocity').assign(vel);
    })().compute(count, [WG, 1, 1]);
    this.needInit = true;
  }

  reset() { this.needInit = true; }

  // called by the skin solver on loop wraps (skin.S.corr holds the previous targets at that moment)
  carry() { if (this.P.liquidEnabled && this.kCarry) { this.renderer.compute(this.kCarry); this.U.hasPrev.value = 0; } }

  step(dtFrame, center) {
    const P = this.P, U = this.U, r = this.renderer;
    // grid resolution change -> reallocate the grid and rebuild the kernels
    const wantG = GRIDS.includes(P.liquidGrid | 0) ? P.liquidGrid | 0 : 64;
    if (wantG !== this.G && P.liquidEnabled) { this.allocGrid(wantG); if (this.skin) this.build(this.skin, this.count); }
    const G = this.G;
    this.mesh.visible = !!P.liquidEnabled && P.liquidRender === 'droplets';
    this.boundsHelper.visible = !!P.liquidEnabled && !!P.liquidShowBounds;
    if (!P.liquidEnabled || !this.kG2P) return;
    // liquid bounds: a W x H x D box following her hips (floor at y = 0); the cubic sim grid is sized to contain it
    const W = P.liquidBoundsX, H = P.liquidBoundsY, D = P.liquidBoundsZ;
    const h = Math.max(W, H, D) / (G - 6);
    U.h.value = h; U.invH.value = 1 / h;
    U.boxMin.value.set(center.x - G * h / 2, -3 * h, center.z - G * h / 2);
    U.lo.value.set(center.x - W / 2, 0, center.z - D / 2);
    U.hi.value.set(center.x + W / 2, H, center.z + D / 2);
    this.boundsHelper.position.set(center.x, H / 2, center.z);
    this.boundsHelper.scale.set(W, H, D);
    this.boundsHelper.updateMatrix();
    U.grav.value.set(0, -9.81 * P.liquidGravity / h, 0);
    U.stiffness.value = P.liquidStiffness; U.restDensity.value = P.liquidDensity; U.viscosity.value = P.liquidViscosity;
    U.attract.value = P.liquidAttract; U.range.value = P.liquidRange / 100; U.stick.value = P.liquidStick;
    U.offset.value = P.liquidOffset / 100; U.respawnRate.value = P.liquidRespawn; U.maxSpeed.value = P.liquidMaxSpeed;
    U.size.value = P.liquidSize / 100;
    U.frame.value = (this.frame = (this.frame + 1) % 1000000);
    if (!P.liquidSimulate || dtFrame <= 1e-4) { if (this.needInit) { r.compute(this.kInit); this.needInit = false; } return; }

    // skin velocity + nearest-skin grid for this frame
    U.frameDt.value = Math.max(dtFrame, 1e-4);
    r.compute(this.kSkinVel);
    U.hasPrev.value = 1;
    r.compute(this.kSeed);
    r.compute(this.kSeedDecode);
    for (const k of this.kJfa) r.compute(k);
    if (this.needInit) { r.compute(this.kInit); this.needInit = false; }

    const sub = Math.max(1, P.liquidSubsteps | 0), stepSec = Math.min(dtFrame, 1 / 30) / sub;
    U.stepSec.value = stepSec; U.center.value.copy(center);
    if (this.mode === 'waterball') {
      const dt = P.liquidWbDt, speed = P.liquidWbSpeed;
      U.dt.value = dt;                                   // grid time, like WaterBall (dt = 0.2 per step)
      U.posScale.value = dt * speed * h;                 // pos += v * dt * speed (cells -> metres)
      U.velToMs.value = dt * speed * h / stepSec; U.velScale.value = 1 / U.velToMs.value;
      U.maxV.value = Math.min(0.9 / (dt * speed), P.liquidMaxSpeed * U.velScale.value);
      U.wbDrag.value = 1 - P.liquidWbDrag;
      U.meshAttract.value = P.liquidMeshAttract; U.meshRepulse.value = P.liquidMeshRepulse;
      U.wbGravity.value = P.liquidWbGravity; U.wallStiffness.value = P.liquidWallStiffness; U.bottomWall.value = P.liquidBottomWall;
      U.fill.value = P.liquidAttractMode === 'fill inside' ? 1 : 0;
      U.fillBand.value = P.liquidFillBand / 100; U.overflow.value = P.liquidOverflow;
    } else {
      U.dt.value = stepSec;
      U.posScale.value = stepSec * h;
      U.velScale.value = 1 / h; U.velToMs.value = h;
      U.maxV.value = 0.9 / stepSec;                      // at most ~1 cell per substep
    }
    for (let s = 0; s < sub; s++) {
      r.compute(this.kP2G1);
      r.compute(this.kP2G2);
      r.compute(this.kGrid);
      r.compute(this.kG2P);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    for (const b of [this.particles, this.cells, this.cellsF, this.seed, this.nearA, this.nearB, this.prev, this.velV]) b?.value?.dispose?.();
  }
}
