import * as THREE from 'three';
import { buildSubdivision } from './subdiv.js?v=c562c3ea19';

// Real-time "spring skin": every vertex is attracted to its skinned+morphed target position,
// with gravity, wind noise, damping, fold slack (edge rest lengths longer than the body),
// a one-sided "stay outside the body" constraint and hard-locking of fully pinned areas.
//
// `level` subdivides the simulated skin (each triangle -> 4, per level). New vertices get their
// target as a barycentric blend of the base mesh's skinned vertices, so only the base mesh is
// skinned on the CPU while the simulation runs at the higher resolution.
export class SpringSkin {
  constructor(skinned, material, P, level = 0) {
    this.src = skinned;
    this.P = P;
    const g = skinned.geometry;
    const pos = g.attributes.position;
    const n = pos.count;
    const pinAttr = g.attributes._pin || g.attributes._PIN;

    // --- weld split (UV seam) vertices of the base mesh
    const key = new Map(); const map = new Int32Array(n); const rep = [];
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
      let u = key.get(k);
      if (u === undefined) { u = rep.length; key.set(k, u); rep.push(i); }
      map[i] = u;
    }
    const nB = rep.length;
    this.nB = nB; this.rep = Int32Array.from(rep);
    const basePin = new Float32Array(nB), baseHead = new Float32Array(nB);
    const headBone = skinned.skeleton.bones.findIndex((b) => /Head$/.test(b.name));
    const sIdx = g.attributes.skinIndex, sW = g.attributes.skinWeight;
    for (let u = 0; u < nB; u++) {
      basePin[u] = pinAttr ? pinAttr.getX(rep[u]) : 0.5;
      if (sIdx) for (let c = 0; c < 4; c++) if (sIdx.getComponent(rep[u], c) === headBone) baseHead[u] += sW.getComponent(rep[u], c);
    }

    // --- base triangles in welded indices
    const idx = g.index.array;
    let tris = new Uint32Array(idx.length);
    for (let t = 0; t < idx.length; t++) tris[t] = map[idx[t]];

    // --- subdivision with barycentric parents (3 base indices + 3 weights per vertex)
    const sub = buildSubdivision(tris, nB, level);
    tris = sub.tris;
    const pi = sub.pi, pw = sub.pw;
    this.stencils = sub.stencils;
    this.work = this.stencils.length ? [new Float32Array(sub.nU * 3), new Float32Array(sub.nU * 3)] : null;
    const nU = (this.nU = sub.nU);
    this.pi = pi; this.pw = pw;
    this.tris = tris;

    this.pin = new Float32Array(nU);
    for (let u = 0; u < nU; u++) this.pin[u] = pw[3 * u] * basePin[pi[3 * u]] + pw[3 * u + 1] * basePin[pi[3 * u + 1]] + pw[3 * u + 2] * basePin[pi[3 * u + 2]];
    this.head = new Float32Array(nU);
    for (let u = 0; u < nU; u++) this.head[u] = pw[3 * u] * baseHead[pi[3 * u]] + pw[3 * u + 1] * baseHead[pi[3 * u + 1]] + pw[3 * u + 2] * baseHead[pi[3 * u + 2]];
    this.basePinU = this.pin.slice();
    this.hard = new Float32Array(nU);

    // --- unique edges
    const eset = new Set(); const edges = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const lo = Math.min(x, y), hi = Math.max(x, y); const k = lo * 1e7 + hi;
        if (lo !== hi && !eset.has(k)) { eset.add(k); edges.push(lo, hi); }
      }
    }
    this.edges = Int32Array.from(edges);
    this.edgeSlack = new Float32Array(this.edges.length / 2);
    for (let e = 0; e < this.edgeSlack.length; e++) this.edgeSlack[e] = 1 - 0.5 * (this.pin[this.edges[2 * e]] + this.pin[this.edges[2 * e + 1]]);

    this.baseT = new Float32Array(nB * 3);
    this.baseN = new Float32Array(nB * 3);
    this.baseTris = new Uint32Array(idx.length); for (let t = 0; t < idx.length; t++) this.baseTris[t] = map[idx[t]];
    this.tgt = new Float32Array(nU * 3);
    this.tn = new Float32Array(nU * 3);
    this.p = new Float32Array(nU * 3);
    this.pp = new Float32Array(nU * 3);
    this.v = new Float32Array(nU * 3);
    this.corr = new Float32Array(nU * 3);
    this.cnt = new Float32Array(nU);

    // --- display mesh: one vertex per simulated point, smooth normals
    const dg = new THREE.BufferGeometry();
    dg.setIndex(new THREE.BufferAttribute(tris, 1));
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nU * 3), 3));
    dg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nU * 3), 3));
    this.mesh = new THREE.Mesh(dg, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;

    this._v = new THREE.Vector3();
    this.initialized = false;
  }

  dispose() { this.mesh.geometry.dispose(); }
  reset() { this.initialized = false; }

  sampleTargets() {
    const s = this.src, v = this._v, rep = this.rep, B = this.baseT, mw = s.matrixWorld;
    s.skeleton.update();
    for (let u = 0; u < this.nB; u++) {
      s.getVertexPosition(rep[u], v).applyMatrix4(mw);
      B[3 * u] = v.x; B[3 * u + 1] = v.y; B[3 * u + 2] = v.z;
    }
    // base normals (for Phong-smoothed targets)
    const BN = this.baseN; BN.fill(0);
    const bt = this.baseTris;
    for (let t = 0; t < bt.length; t += 3) {
      const a = 3 * bt[t], b = 3 * bt[t + 1], c = 3 * bt[t + 2];
      const e1x = B[b] - B[a], e1y = B[b + 1] - B[a + 1], e1z = B[b + 2] - B[a + 2];
      const e2x = B[c] - B[a], e2y = B[c + 1] - B[a + 1], e2z = B[c + 2] - B[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      BN[a] += nx; BN[a + 1] += ny; BN[a + 2] += nz; BN[b] += nx; BN[b + 1] += ny; BN[b + 2] += nz; BN[c] += nx; BN[c + 1] += ny; BN[c + 2] += nz;
    }
    for (let i = 0; i < BN.length; i += 3) { const l = Math.hypot(BN[i], BN[i + 1], BN[i + 2]) || 1; BN[i] /= l; BN[i + 1] /= l; BN[i + 2] /= l; }
    const T = this.tgt, pi = this.pi, pw = this.pw, ph = this.P.smoothBase ?? 1;
    // smooth target surface: apply Loop-subdivision stencils level by level (topology-only weights)
    let src = B, smooth = null;
    if (this.stencils.length && ph > 0) {
      this.stencils.forEach((st, l) => {
        const dst = this.work[l % 2];
        for (let v = 0; v < st.n; v++) {
          let x = 0, y = 0, z = 0;
          for (let k = st.off[v]; k < st.off[v + 1]; k++) { const i = 3 * st.idx[k], w = st.w[k]; x += src[i] * w; y += src[i + 1] * w; z += src[i + 2] * w; }
          dst[3 * v] = x; dst[3 * v + 1] = y; dst[3 * v + 2] = z;
        }
        src = dst;
      });
      smooth = src;
    }
    for (let u = 0; u < this.nU; u++) {
      const j = 3 * u, a = 3 * pi[j], b = 3 * pi[j + 1], c = 3 * pi[j + 2], wa = pw[j], wb = pw[j + 1], wc = pw[j + 2];
      const lx = B[a] * wa + B[b] * wb + B[c] * wc, ly = B[a + 1] * wa + B[b + 1] * wb + B[c + 1] * wc, lz = B[a + 2] * wa + B[b + 2] * wb + B[c + 2] * wc;
      if (smooth) { T[j] = lx + (smooth[j] - lx) * ph; T[j + 1] = ly + (smooth[j + 1] - ly) * ph; T[j + 2] = lz + (smooth[j + 2] - lz) * ph; }
      else { T[j] = lx; T[j + 1] = ly; T[j + 2] = lz; }
    }
    // target normals from triangles
    const N = this.tn; N.fill(0);
    const tr = this.tris;
    for (let t = 0; t < tr.length; t += 3) {
      const a = 3 * tr[t], b = 3 * tr[t + 1], c = 3 * tr[t + 2];
      const e1x = T[b] - T[a], e1y = T[b + 1] - T[a + 1], e1z = T[b + 2] - T[a + 2];
      const e2x = T[c] - T[a], e2y = T[c + 1] - T[a + 1], e2z = T[c + 2] - T[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz; N[b] += nx; N[b + 1] += ny; N[b + 2] += nz; N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let u = 0; u < this.nU; u++) {
      const i = 3 * u; const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
      N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
    }
  }

  updateHolds() {
    const P = this.P, hs = P.holdScale ?? 1, hh = P.headHold ?? 0.55, thr = P.lockThreshold ?? 0.75;
    const key = hs + '|' + hh + '|' + thr;
    if (key === this._holdKey) return;
    this._holdKey = key;
    for (let u = 0; u < this.nU; u++) {
      const pn = this.basePinU[u], hm = this.head[u];
      const headScaled = pn > 0.56 ? pn : pn * hh / 0.55;
      const e = Math.min(Math.max((pn + (headScaled - pn) * hm) * hs, 0), 1);
      this.pin[u] = e;
      const x = Math.min(Math.max((e - thr) / 0.23, 0), 1); this.hard[u] = x * x * (3 - 2 * x);
    }
  }

  step(dtFrame, time) {
    const P = this.P;
    this.updateHolds();
    const carry = this.carryNext && this.initialized; this.carryNext = false;
    if (carry) (this.prevT || (this.prevT = new Float32Array(this.tgt.length))).set(this.tgt);
    this.sampleTargets();
    const T = this.tgt, N = this.tn, p = this.p, v = this.v, pp = this.pp, nU = this.nU;
    if (carry) {   // teleport-safe: shift skin by each target's jump (no spring shock on loop wraps)
      const PT = this.prevT;
      for (let i = 0; i < T.length; i++) { const d = T[i] - PT[i]; p[i] += d; pp[i] += d; }
      v.fill(0);   // drop world-space momentum: skin holds its shape relative to the body
    }
    if (!this.initialized || !P.simulate) { p.set(T); v.fill(0); this.initialized = true; this.write(); return; }

    const sub = dtFrame > 1 / 45 ? 2 : 1, dt = dtFrame / sub;
    const k0 = P.stiffness, c = P.damping, g = P.gravity * 0.01, ws = P.windStrength, sc = P.windScale, sp = P.windSpeed;
    const wdx = P.windX, wdy = P.windY, wdz = P.windZ;
    for (let s = 0; s < sub; s++) {
      const tt = time + s * dt;
      for (let u = 0; u < nU; u++) {
        const i = 3 * u, pin = this.pin[u], free = 1 - pin, k = k0 * (0.25 + 0.75 * pin);
        const px = p[i], py = p[i + 1], pz = p[i + 2];
        let ax = k * (T[i] - px) - c * v[i];
        let ay = k * (T[i + 1] - py) - c * v[i + 1] - k * g * free;   // g = hang distance (m) for fully free skin
        let az = k * (T[i + 2] - pz) - c * v[i + 2];
        if (ws > 0 && free > 0) {
          const nx = noise3(px * sc, py * sc, pz * sc + tt * sp), ny = noise3(px * sc + 31.7, py * sc, pz * sc - tt * sp), nz = noise3(px * sc, py * sc + 17.3, pz * sc + tt * sp * 0.7);
          const gust = noise3(tt * sp * 0.5, 3.1, 7.7) * 1.5 + 0.5;
          const w = ws * free;
          ax += w * (nx * 4 + wdx * gust); ay += w * (ny * 4 + wdy * gust); az += w * (nz * 4 + wdz * gust);
        }
        pp[i] = px; pp[i + 1] = py; pp[i + 2] = pz;
        v[i] += ax * dt; v[i + 1] += ay * dt; v[i + 2] += az * dt;
        p[i] += v[i] * dt; p[i + 1] += v[i + 1] * dt; p[i + 2] += v[i + 2] * dt;
      }
      const E = this.edges, slack = P.slack, stiff = P.stretch;
      for (let it = 0; it < P.iterations; it++) {
        this.corr.fill(0); this.cnt.fill(0);
        for (let e = 0; e < E.length; e += 2) {
          const a = E[e], b = E[e + 1], ia = 3 * a, ib = 3 * b;
          const rest = Math.hypot(T[ib] - T[ia], T[ib + 1] - T[ia + 1], T[ib + 2] - T[ia + 2]) * (1 + slack * this.edgeSlack[e >> 1]);
          const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
          const len = Math.hypot(dx, dy, dz) || 1e-9;
          const f = 0.5 * (1 - rest / len);
          this.corr[ia] += dx * f; this.corr[ia + 1] += dy * f; this.corr[ia + 2] += dz * f;
          this.corr[ib] -= dx * f; this.corr[ib + 1] -= dy * f; this.corr[ib + 2] -= dz * f;
          this.cnt[a]++; this.cnt[b]++;
        }
        const off = P.offset;
        if (P.bending > 0) {
          // bending: pull each point's displacement (p - T) toward its neighbours' average -> larger, softer folds
          const bc = this.bend || (this.bend = new Float32Array(nU * 3)), bn = this.bendN || (this.bendN = new Float32Array(nU));
          bc.fill(0); bn.fill(0);
          for (let e = 0; e < E.length; e += 2) {
            const ia = 3 * E[e], ib = 3 * E[e + 1];
            for (let k = 0; k < 3; k++) { const da = p[ia + k] - T[ia + k], db = p[ib + k] - T[ib + k]; bc[ia + k] += db; bc[ib + k] += da; }
            bn[E[e]]++; bn[E[e + 1]]++;
          }
          for (let u = 0; u < nU; u++) {
            const i = 3 * u, n2 = bn[u] || 1, bw = P.bending;
            for (let k = 0; k < 3; k++) this.corr[i + k] += (bc[i + k] / n2 - (p[i + k] - T[i + k])) * bw * (this.cnt[u] || 1) / Math.max(stiff, 1e-6);
          }
        }
        for (let u = 0; u < nU; u++) {
          const i = 3 * u, cn = this.cnt[u] || 1;
          p[i] += stiff * this.corr[i] / cn; p[i + 1] += stiff * this.corr[i + 1] / cn; p[i + 2] += stiff * this.corr[i + 2] / cn;
          const d = (p[i] - T[i]) * N[i] + (p[i + 1] - T[i + 1]) * N[i + 1] + (p[i + 2] - T[i + 2]) * N[i + 2];
          if (d < off) { const push = off - d; p[i] += N[i] * push; p[i + 1] += N[i + 1] * push; p[i + 2] += N[i + 2] * push; }
        }
      }
      for (let u = 0; u < nU; u++) {
        const i = 3 * u, h = this.hard[u];
        if (h > 0) { p[i] += (T[i] - p[i]) * h; p[i + 1] += (T[i + 1] - p[i + 1]) * h; p[i + 2] += (T[i + 2] - p[i + 2]) * h; }
        v[i] = (p[i] - pp[i]) / dt; v[i + 1] = (p[i + 1] - pp[i + 1]) / dt; v[i + 2] = (p[i + 2] - pp[i + 2]) / dt;
      }
    }
    this.write();
  }

  write() {
    const attr = this.mesh.geometry.attributes.position;
    attr.array.set(this.P.showTarget ? this.tgt : this.p);
    attr.needsUpdate = true;
    const geo = this.mesh.geometry;
    geo.computeVertexNormals();
    // degenerate (collapsed) triangles give zero-length normals -> NaN in sheen/clearcoat shading.
    // Fall back to the body's target normal for those vertices.
    const nrm = geo.attributes.normal.array, T = this.tn;
    for (let i = 0; i < nrm.length; i += 3) {
      const x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
      if (!(x * x + y * y + z * z > 1e-12)) { nrm[i] = T[i]; nrm[i + 1] = T[i + 1]; nrm[i + 2] = T[i + 2]; }
    }
  }
}

// small, fast value-noise in [-1,1]
function h3(x, y, z) { let n = x * 374761393 + y * 668265263 + z * 1274126177; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967295 * 2 - 1; }
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h3(xi, yi, zi), h3(xi + 1, yi, zi), u), l(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u), v),
    l(l(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u), l(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u), v), w);
}
