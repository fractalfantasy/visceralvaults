// WebGPU spring-skin solver (three.js r186, TSL compute).
// Same model as spring.js, but everything runs on the GPU:
//   skin   : base mesh morphs (ARKit/visemes) + linear-blend skinning   -> baseT / baseN
//   expand : barycentric upsample to the subdivided sim mesh            -> T / N (targets)
//   force  : spring-to-target, damping, gravity-sag, wind noise         -> p, v
//   corr/apply (xN): Jacobi edge-length constraints via neighbour lists + stay-outside-body
//   final  : hard lock of fully pinned areas, velocity from positions
//   normal : per-vertex normals from incident triangles (for rendering)
// The render mesh reads positions/normals straight from the storage buffers (no CPU readback).
import * as THREE from 'three/webgpu';
import { buildSubdivision } from './subdiv.js?v=c562c3ea19';
import {
  Fn, If, Loop, uint, float, vec3, vec4, mat4, uniform, storage, instanceIndex,
  normalize, cross, length, max, min, clamp, mix, smoothstep, mx_noise_vec3, mx_noise_float, transformNormalToView,
} from 'three/tsl';

function sbuf(array, itemSize, type) {
  const attr = new THREE.StorageBufferAttribute(array, itemSize);
  return storage(attr, type, attr.count);
}

export class GpuSkin {
  constructor(renderer, skinned, material, P, level = 0) {
    this.renderer = renderer; this.src = skinned; this.P = P;
    const t0 = performance.now();
    const g = skinned.geometry, pos = g.attributes.position, nrm = g.attributes.normal;
    const n = pos.count;
    const pinAttr = g.attributes._pin || g.attributes._PIN;
    const sIdx = g.attributes.skinIndex, sW = g.attributes.skinWeight;
    const morphs = (g.morphAttributes.position || []);
    this.nMorph = morphs.length;

    // ---- weld UV seams
    const key = new Map(), map = new Int32Array(n), rep = [];
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
      let u = key.get(k); if (u === undefined) { u = rep.length; key.set(k, u); rep.push(i); } map[i] = u;
    }
    const nB = (this.nB = rep.length);

    // ---- base data in bind space (bindMatrix applied once on the CPU)
    const bind = skinned.bindMatrix, bind3 = new THREE.Matrix3().setFromMatrix4(bind), bindN = new THREE.Matrix3().getNormalMatrix(bind);
    const v = new THREE.Vector3();
    const geomB = new Float32Array(nB * 8), skinB = new Float32Array(nB * 8);   // [pos,1][nrm,0]  /  [indices][weights]
    const basePin = new Float32Array(nB), baseHead = new Float32Array(nB);
    const headBone = skinned.skeleton.bones.findIndex((b) => /Head$/.test(b.name));
    for (let u = 0; u < nB; u++) {
      const i = rep[u];
      v.fromBufferAttribute(pos, i).applyMatrix4(bind); geomB.set([v.x, v.y, v.z, 1], 8 * u);
      v.fromBufferAttribute(nrm, i).applyMatrix3(bindN).normalize(); geomB.set([v.x, v.y, v.z, 0], 8 * u + 4);
      skinB.set([sIdx.getX(i), sIdx.getY(i), sIdx.getZ(i), sIdx.getW(i)], 8 * u);
      skinB.set([sW.getX(i), sW.getY(i), sW.getZ(i), sW.getW(i)], 8 * u + 4);
      basePin[u] = pinAttr ? pinAttr.getX(i) : 0.5;
      for (let c = 0; c < 4; c++) if (sIdx.getComponent(i, c) === headBone) baseHead[u] += sW.getComponent(i, c);
    }
    const morphB = new Float32Array(Math.max(1, this.nMorph) * nB * 4);
    for (let m = 0; m < this.nMorph; m++) {
      const a = morphs[m];
      for (let u = 0; u < nB; u++) {
        v.fromBufferAttribute(a, rep[u]).applyMatrix3(bind3);
        const o = 4 * (m * nB + u); morphB[o] = v.x; morphB[o + 1] = v.y; morphB[o + 2] = v.z;
      }
    }

    // ---- triangles + barycentric subdivision
    const idx = g.index.array;
    let tris = new Uint32Array(idx.length);
    for (let t = 0; t < idx.length; t++) tris[t] = map[idx[t]];
    const sub = buildSubdivision(tris, nB, level);
    tris = sub.tris;
    let pi = sub.pi, pw = sub.pw;
    this.stencils = sub.stencils;
    const nU = (this.nU = sub.nU);
    const par = new Float32Array(nU * 8), pin = new Float32Array(nU), pinH = new Float32Array(nU * 2);
    for (let u = 0; u < nU; u++) {
      for (let j = 0; j < 3; j++) { par[8 * u + j] = pi[3 * u + j]; par[8 * u + 4 + j] = pw[3 * u + j]; }
      pin[u] = pw[3 * u] * basePin[pi[3 * u]] + pw[3 * u + 1] * basePin[pi[3 * u + 1]] + pw[3 * u + 2] * basePin[pi[3 * u + 2]];
      pinH[2 * u] = pin[u];
      pinH[2 * u + 1] = pw[3 * u] * baseHead[pi[3 * u]] + pw[3 * u + 1] * baseHead[pi[3 * u + 1]] + pw[3 * u + 2] * baseHead[pi[3 * u + 2]];
    }
    pi = pw = null;

    // ---- neighbour CSR (unique edges) + incident-triangle CSR
    const nCnt = new Uint32Array(nU), tCnt = new Uint32Array(nU);
    const eKey = new Set(); const eA = [], eB = [];
    for (let t = 0; t < tris.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k], b = tris[t + (k + 1) % 3];
        const lo = a < b ? a : b, hi = a < b ? b : a, kk = lo * 16777216 + hi;
        if (lo !== hi && !eKey.has(kk)) { eKey.add(kk); eA.push(lo); eB.push(hi); nCnt[lo]++; nCnt[hi]++; }
        tCnt[tris[t + k]]++;
      }
    }
    const nOff = new Uint32Array(nU), tOff = new Uint32Array(nU);
    let acc = 0; for (let u = 0; u < nU; u++) { nOff[u] = acc; acc += nCnt[u]; }
    const nIdx = new Uint32Array(acc), nSlack = new Float32Array(acc);
    let acc2 = 0; for (let u = 0; u < nU; u++) { tOff[u] = acc2; acc2 += tCnt[u]; }
    const tIdx = new Uint32Array(acc2);
    const fillN = new Uint32Array(nU), fillT = new Uint32Array(nU);
    for (let e = 0; e < eA.length; e++) {
      const a = eA[e], b = eB[e], s = 1 - 0.5 * (pin[a] + pin[b]);
      nIdx[nOff[a] + fillN[a]] = b; nSlack[nOff[a] + fillN[a]++] = s;
      nIdx[nOff[b] + fillN[b]] = a; nSlack[nOff[b] + fillN[b]++] = s;
    }
    for (let t = 0; t < tris.length / 3; t++) for (let k = 0; k < 3; k++) { const u = tris[3 * t + k]; tIdx[tOff[u] + fillT[u]++] = t; }
    this.nEdges = eA.length; this.nTris = tris.length / 3;
    this.buildMs = performance.now() - t0;

    // ---- GPU buffers
    const S = this.S = {
      geomB: sbuf(geomB, 4, 'vec4'), skinB: sbuf(skinB, 4, 'vec4'),
      morphB: sbuf(morphB, 4, 'vec4'),
      infl: sbuf(new Float32Array(Math.max(1, this.nMorph)), 1, 'float'),
      bones: sbuf(new Float32Array(skinned.skeleton.bones.length * 16), 4, 'vec4'),
      baseT: sbuf(new Float32Array(nB * 4), 4, 'vec4'), baseN: sbuf(new Float32Array(nB * 4), 4, 'vec4'),
      par: sbuf(par, 4, 'vec4'),
      pinH: sbuf(pinH, 2, 'vec2'),
      T: sbuf(new Float32Array(nU * 4), 4, 'vec4'), N: sbuf(new Float32Array(nU * 4), 4, 'vec4'),
      p: sbuf(new Float32Array(nU * 4), 4, 'vec4'), pp: sbuf(new Float32Array(nU * 4), 4, 'vec4'),
      v: sbuf(new Float32Array(nU * 4), 4, 'vec4'), corr: sbuf(new Float32Array(nU * 4), 4, 'vec4'),
      dn: sbuf(new Float32Array(nU * 4), 4, 'vec4'),
      nOff: sbuf(nOff, 1, 'uint'), nCnt: sbuf(nCnt, 1, 'uint'), nIdx: sbuf(nIdx, 1, 'uint'), nSlack: sbuf(nSlack, 1, 'float'),
      tOff: sbuf(tOff, 1, 'uint'), tCnt: sbuf(tCnt, 1, 'uint'), tIdx: sbuf(tIdx, 1, 'uint'), tris: sbuf(tris, 1, 'uint'),
    };
    // Loop-subdivision stencil buffers (one set per level) + ping-pong work buffers
    this.lv = this.stencils.map((st) => ({
      n: st.n, off: sbuf(st.off, 1, 'uint'), idx: sbuf(st.idx, 1, 'uint'), w: sbuf(st.w, 1, 'float'),
    }));
    if (this.lv.length) { S.W0 = sbuf(new Float32Array(nU * 4), 4, 'vec4'); S.W1 = sbuf(new Float32Array(nU * 4), 4, 'vec4'); }
    this.S = S;
    const U = (this.U = {
      pre: uniform(new THREE.Matrix4()), dt: uniform(1 / 60), time: uniform(0), reset: uniform(1),
      k0: uniform(350), damp: uniform(9), grav: uniform(0.02), slack: uniform(0.15), stretch: uniform(0.9), offset: uniform(0.002), phong: uniform(0.75), bend: uniform(0.3), holdScale: uniform(1), headHold: uniform(0.55), lockThr: uniform(0.75),
      ws: uniform(1), wsc: uniform(12), wsp: uniform(0.6), wdir: uniform(new THREE.Vector3(0.6, 0.1, -0.6)),
    });

    const NB = uint(nB), NM = this.nMorph;
    // live hold: skull hold rescaled by headHold (face features > 0.56 untouched), then global scale
    const effPin = (u) => {
      const ph = S.pinH.element(u), pn = ph.x, hm = ph.y;
      const headScaled = pn.greaterThan(0.56).select(pn, pn.mul(U.headHold.div(0.55)));
      return clamp(mix(pn, headScaled, hm).mul(U.holdScale), 0.0, 1.0);
    };
    const boneMat = (k) => { const b = k.mul(4); return mat4(S.bones.element(b), S.bones.element(b.add(1)), S.bones.element(b.add(2)), S.bones.element(b.add(3))); };

    this.kSkin = Fn(() => {
      const b = instanceIndex;
      const b2 = b.mul(2);
      const p = S.geomB.element(b2).xyz.toVar();
      if (NM > 0) Loop(NM, ({ i }) => {
        const w = S.infl.element(i);
        If(w.notEqual(0.0), () => { p.addAssign(S.morphB.element(uint(i).mul(NB).add(b)).xyz.mul(w)); });
      });
      const si = S.skinB.element(b2), sw = S.skinB.element(b2.add(1));
      const M = boneMat(uint(si.x)).mul(sw.x).add(boneMat(uint(si.y)).mul(sw.y)).add(boneMat(uint(si.z)).mul(sw.z)).add(boneMat(uint(si.w)).mul(sw.w)).toVar();
      const wp = U.pre.mul(M.mul(vec4(p, 1.0)));
      const wn = normalize(U.pre.mul(M.mul(vec4(S.geomB.element(b2.add(1)).xyz, 0.0))).xyz);
      S.baseT.element(b).assign(vec4(wp.xyz, 1.0));
      S.baseN.element(b).assign(vec4(wn, 0.0));
    })().compute(nB);

    this.kStencil = this.lv.map((L, l) => {
      const src = l === 0 ? S.baseT : (l % 2 === 1 ? S.W0 : S.W1);
      const dst = l % 2 === 0 ? S.W0 : S.W1;
      return Fn(() => {
        const v = instanceIndex;
        const o0 = L.off.element(v), o1 = L.off.element(v.add(1));
        const acc = vec3(0.0).toVar();
        Loop({ start: o0, end: o1, type: 'uint', condition: '<' }, ({ i }) => {
          acc.addAssign(src.element(L.idx.element(i)).xyz.mul(L.w.element(i)));
        });
        dst.element(v).assign(vec4(acc, 1.0));
      })().compute(L.n);
    });
    const smoothSrc = this.lv.length ? ((this.lv.length - 1) % 2 === 0 ? S.W0 : S.W1) : null;

    this.kExpand = Fn(() => {
      const u = instanceIndex;
      const af = S.par.element(u.mul(2)), w = S.par.element(u.mul(2).add(1));
      const a = { x: uint(af.x), y: uint(af.y), z: uint(af.z) };
      const pa = S.baseT.element(a.x).xyz, pb = S.baseT.element(a.y).xyz, pc = S.baseT.element(a.z).xyz;
      const na = S.baseN.element(a.x).xyz, nb = S.baseN.element(a.y).xyz, nc = S.baseN.element(a.z).xyz;
      const lin = pa.mul(w.x).add(pb.mul(w.y)).add(pc.mul(w.z));
      // smooth target: Loop-subdivided surface (topology stencils), blended with the flat position
      const t = smoothSrc ? lin.add(smoothSrc.element(u).xyz.sub(lin).mul(U.phong)) : lin;
      const nn = normalize(na.mul(w.x).add(nb.mul(w.y)).add(nc.mul(w.z)));
      S.T.element(u).assign(vec4(t, 1.0)); S.N.element(u).assign(vec4(nn, 0.0));
    })().compute(nU);

    this.kTNormal = Fn(() => {
      const u = instanceIndex;
      const off = S.tOff.element(u), cnt = S.tCnt.element(u);
      const acc = vec3(0.0).toVar();
      Loop({ start: uint(0), end: cnt, type: 'uint', condition: '<' }, ({ i }) => {
        const tri = S.tIdx.element(off.add(i)).mul(3);
        const a = S.T.element(S.tris.element(tri)).xyz;
        const b = S.T.element(S.tris.element(tri.add(1))).xyz;
        const c = S.T.element(S.tris.element(tri.add(2))).xyz;
        acc.addAssign(cross(b.sub(a), c.sub(a)));
      });
      const l = length(acc);
      If(l.greaterThan(1e-12), () => { S.N.element(u).assign(vec4(acc.div(l), 0.0)); });
    })().compute(nU);

    // teleport-safe: remember targets before this frame's update, then shift the skin by exactly
    // how far each target moved (keeps shape, folds and wobble; no spring shock on loop wraps)
    this.kSaveT = Fn(() => { const u = instanceIndex; S.corr.element(u).assign(S.T.element(u)); })().compute(nU);
    this.kCarry = Fn(() => {
      const u = instanceIndex;
      const d = S.T.element(u).xyz.sub(S.corr.element(u).xyz);
      S.p.element(u).assign(vec4(S.p.element(u).xyz.add(d), 1.0));
      S.pp.element(u).assign(vec4(S.pp.element(u).xyz.add(d), 1.0));
      S.v.element(u).assign(vec4(0.0));          // drop world-space momentum: skin holds its shape relative to the body
    })().compute(nU);

    this.kReset = Fn(() => {
      const u = instanceIndex, t = S.T.element(u);
      S.p.element(u).assign(t); S.pp.element(u).assign(t); S.v.element(u).assign(vec4(0.0));
    })().compute(nU);

    this.kForce = Fn(() => {
      const u = instanceIndex;
      const pinv = effPin(u).toVar(), free = float(1.0).sub(pinv);
      const k = U.k0.mul(pinv.mul(0.75).add(0.25));
      const p = S.p.element(u).xyz, vel = S.v.element(u).xyz, t = S.T.element(u).xyz;
      const acc = t.sub(p).mul(k).sub(vel.mul(U.damp)).sub(vec3(0.0, k.mul(U.grav).mul(free), 0.0)).toVar();
      If(U.ws.greaterThan(0.0), () => {
        const q = p.mul(U.wsc);
        const nz = mx_noise_vec3(q.add(vec3(0.0, 0.0, U.time.mul(U.wsp))));
        const gust = mx_noise_float(vec3(U.time.mul(U.wsp).mul(0.5), 3.1, 7.7)).mul(1.5).add(0.5);
        acc.addAssign(nz.mul(4.0).add(U.wdir.mul(gust)).mul(U.ws.mul(free)));
      });
      S.pp.element(u).assign(vec4(p, 1.0));
      const v1 = vel.add(acc.mul(U.dt));
      S.v.element(u).assign(vec4(v1, 0.0));
      S.p.element(u).assign(vec4(p.add(v1.mul(U.dt)), 1.0));
    })().compute(nU);

    this.kCorr = Fn(() => {
      const u = instanceIndex;
      const off = S.nOff.element(u), cnt = S.nCnt.element(u);
      const pu = S.p.element(u).xyz, tu = S.T.element(u).xyz;
      const c = vec3(0.0).toVar();
      Loop({ start: uint(0), end: cnt, type: 'uint', condition: '<' }, ({ i }) => {
        const j = S.nIdx.element(off.add(i));
        const rest = length(S.T.element(j).xyz.sub(tu)).mul(float(1.0).add(U.slack.mul(S.nSlack.element(off.add(i)))));
        const d = S.p.element(j).xyz.sub(pu);
        const len = max(length(d), 1e-9);
        c.addAssign(d.mul(float(1.0).sub(rest.div(len)).mul(0.5)));
      });
      S.corr.element(u).assign(vec4(c.div(max(float(cnt), 1.0)), 0.0));
    })().compute(nU);

    this.kApply = Fn(() => {
      const u = instanceIndex;
      const p = S.p.element(u).xyz.add(S.corr.element(u).xyz.mul(U.stretch)).toVar();
      const t = S.T.element(u).xyz, nn = S.N.element(u).xyz;
      const d = p.sub(t).dot(nn);
      If(d.lessThan(U.offset), () => { p.addAssign(nn.mul(U.offset.sub(d))); });
      S.p.element(u).assign(vec4(p, 1.0));
    })().compute(nU);

    this.kBendCorr = Fn(() => {
      const u = instanceIndex;
      const off = S.nOff.element(u), cnt = S.nCnt.element(u);
      const du = S.p.element(u).xyz.sub(S.T.element(u).xyz);
      const avg = vec3(0.0).toVar();
      Loop({ start: uint(0), end: cnt, type: 'uint', condition: '<' }, ({ i }) => {
        const j = S.nIdx.element(off.add(i));
        avg.addAssign(S.p.element(j).xyz.sub(S.T.element(j).xyz));
      });
      avg.divAssign(max(float(cnt), 1.0));
      S.corr.element(u).assign(vec4(avg.sub(du).mul(U.bend), 0.0));
    })().compute(nU);

    this.kBendApply = Fn(() => {
      const u = instanceIndex;
      const p = S.p.element(u).xyz.add(S.corr.element(u).xyz).toVar();
      const t = S.T.element(u).xyz, nn = S.N.element(u).xyz;
      const d = p.sub(t).dot(nn);
      If(d.lessThan(U.offset), () => { p.addAssign(nn.mul(U.offset.sub(d))); });
      S.p.element(u).assign(vec4(p, 1.0));
    })().compute(nU);

    this.kFinal = Fn(() => {
      const u = instanceIndex;
      const h = smoothstep(U.lockThr, U.lockThr.add(0.23), effPin(u));
      const t = S.T.element(u).xyz;
      const p = S.p.element(u).xyz.toVar();
      p.addAssign(t.sub(p).mul(h));
      S.p.element(u).assign(vec4(p, 1.0));
      S.v.element(u).assign(vec4(p.sub(S.pp.element(u).xyz).div(U.dt), 0.0));
    })().compute(nU);

    this.kNormal = Fn(() => {
      const u = instanceIndex;
      const off = S.tOff.element(u), cnt = S.tCnt.element(u);
      const acc = vec3(0.0).toVar();
      Loop({ start: uint(0), end: cnt, type: 'uint', condition: '<' }, ({ i }) => {
        const tri = S.tIdx.element(off.add(i)).mul(3);
        const a = S.p.element(S.tris.element(tri)).xyz;
        const b = S.p.element(S.tris.element(tri.add(1))).xyz;
        const c = S.p.element(S.tris.element(tri.add(2))).xyz;
        acc.addAssign(cross(b.sub(a), c.sub(a)));
      });
      const l = length(acc);
      const nn = l.greaterThan(1e-12).select(acc.div(l), S.N.element(u).xyz);
      S.dn.element(u).assign(vec4(nn, 0.0));
    })().compute(nU);

    // ---- render mesh: positions & normals come straight from storage buffers
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(tris, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nU * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.material = material;
    material.positionNode = S.p.toAttribute().xyz;
    material.normalNode = transformNormalToView(S.dn.toAttribute().xyz);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  reset() { this.U.reset.value = 1; }

  dispose() {
    this.mesh.geometry.dispose();
    for (const k in this.S) { const a = this.S[k].value; if (a && a.dispose) a.dispose(); }
  }

  step(dtFrame, time) {
    const P = this.P, U = this.U, S = this.S, r = this.renderer, s = this.src;
    // CPU -> GPU per frame: bone matrices, morph influences, pre-transform, parameters
    s.skeleton.update();
    const bones = S.bones.value; bones.array.set(s.skeleton.boneMatrices); bones.needsUpdate = true;
    if (this.nMorph) { const inf = S.infl.value; inf.array.set(s.morphTargetInfluences); inf.needsUpdate = true; }
    U.pre.value.multiplyMatrices(s.matrixWorld, s.bindMatrixInverse);
    U.k0.value = P.stiffness; U.damp.value = P.damping; U.grav.value = P.gravity * 0.01; U.slack.value = P.slack;
    U.stretch.value = P.stretch; U.offset.value = P.offset; U.phong.value = P.smoothBase; U.bend.value = P.bending;
    U.holdScale.value = P.holdScale ?? 1; U.headHold.value = P.headHold ?? 0.55; U.lockThr.value = P.lockThreshold ?? 0.75;
    U.ws.value = P.windStrength; U.wsc.value = P.windScale; U.wsp.value = P.windSpeed; U.wdir.value.set(P.windX, P.windY, P.windZ);
    if (!P.simulate) U.reset.value = 1;

    r.compute(this.kSkin);
    const carry = this.carryNext && U.reset.value < 0.5; this.carryNext = false;
    if (carry) r.compute(this.kSaveT);
    for (const k of this.kStencil) r.compute(k);
    r.compute(this.kExpand);
    if (this.lv.length) r.compute(this.kTNormal);
    if (U.reset.value > 0.5) { r.compute(this.kReset); U.reset.value = 0; }
    else if (carry) { if (this.lv.length) r.compute(this.kTNormal); r.compute(this.kCarry); }
    if (P.simulate && dtFrame > 1e-4) {
      const sub = dtFrame > 1 / 45 ? 2 : 1, dt = dtFrame / sub;
      U.dt.value = dt;
      for (let s2 = 0; s2 < sub; s2++) {
        U.time.value = time + s2 * dt;
        r.compute(this.kForce);
        for (let it = 0; it < P.iterations; it++) {
          r.compute(this.kCorr); r.compute(this.kApply);
          if (P.bending > 0) { r.compute(this.kBendCorr); r.compute(this.kBendApply); }
        }
        r.compute(this.kFinal);
      }
    }
    r.compute(this.kNormal);
  }
}
