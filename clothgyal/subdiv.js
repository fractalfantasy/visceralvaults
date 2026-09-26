// Shared subdivision for the spring-skin solvers.
// Builds `levels` of 1->4 triangle subdivision on a welded triangle mesh and returns, per level,
// Loop-subdivision stencils (each new vertex = weighted sum of previous-level vertices).
// Stencils depend only on topology, so they're built once and applied every frame to the
// animated base positions -> smooth (C2 away from extraordinary vertices) target surface.
// Vertex indexing: level l keeps all level l-1 vertices (same indices) and appends one vertex per
// edge in first-encounter order -- the same order the solvers use for their sim mesh.
// Also returns linear barycentric parents (3 base verts + weights) for pins / flat fallback.
export function buildSubdivision(baseTris, nB, levels) {
  let tris = baseTris;
  let n = nB;
  let pi = new Int32Array(nB * 3), pw = new Float32Array(nB * 3);
  for (let u = 0; u < nB; u++) { pi[3 * u] = pi[3 * u + 1] = pi[3 * u + 2] = u; pw[3 * u] = 1; }
  const stencils = [];

  for (let l = 0; l < levels; l++) {
    // ---- edges of current mesh: key -> slot; record endpoints, opposite vertices, face count
    const edgeSlot = new Map();
    const ea = [], eb = [], eo1 = [], eo2 = [], ecnt = [];
    const edgeOf = (a, b, opp) => {
      const lo = a < b ? a : b, hi = a < b ? b : a, k = lo * 16777216 + hi;
      let s = edgeSlot.get(k);
      if (s === undefined) { s = ea.length; edgeSlot.set(k, s); ea.push(lo); eb.push(hi); eo1.push(opp); eo2.push(-1); ecnt.push(1); }
      else { if (ecnt[s] === 1) eo2[s] = opp; ecnt[s]++; }
      return s;
    };
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      edgeOf(a, b, c); edgeOf(b, c, a); edgeOf(c, a, b);
    }
    // ---- neighbours of each old vertex (+ boundary neighbours)
    const nbrCnt = new Int32Array(n), bndCnt = new Int32Array(n);
    for (let e = 0; e < ea.length; e++) {
      nbrCnt[ea[e]]++; nbrCnt[eb[e]]++;
      if (ecnt[e] === 1) { bndCnt[ea[e]]++; bndCnt[eb[e]]++; }
    }
    const nbrOff = new Int32Array(n + 1);
    for (let v = 0; v < n; v++) nbrOff[v + 1] = nbrOff[v] + nbrCnt[v];
    const nbr = new Int32Array(nbrOff[n]), nbrBnd = new Uint8Array(nbrOff[n]), fill = new Int32Array(n);
    for (let e = 0; e < ea.length; e++) {
      const a = ea[e], b = eb[e], bd = ecnt[e] === 1 ? 1 : 0;
      nbr[nbrOff[a] + fill[a]] = b; nbrBnd[nbrOff[a] + fill[a]++] = bd;
      nbr[nbrOff[b] + fill[b]] = a; nbrBnd[nbrOff[b] + fill[b]++] = bd;
    }

    // ---- new triangles + midpoint indices (first-encounter order, as the solvers expect)
    const midIdx = new Int32Array(ea.length).fill(-1);
    let next = n;
    const out = new Uint32Array(tris.length * 4); let o = 0;
    const mid = (a, b) => {
      const lo = a < b ? a : b, hi = a < b ? b : a, s = edgeSlot.get(lo * 16777216 + hi);
      if (midIdx[s] < 0) midIdx[s] = next++;
      return midIdx[s];
    };
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      out[o++] = a; out[o++] = ab; out[o++] = ca; out[o++] = ab; out[o++] = b; out[o++] = bc;
      out[o++] = ca; out[o++] = bc; out[o++] = c; out[o++] = ab; out[o++] = bc; out[o++] = ca;
    }
    const nNew = next;

    // ---- stencils: CSR over new vertices
    const cnt = new Int32Array(nNew);
    for (let v = 0; v < n; v++) cnt[v] = bndCnt[v] === 2 ? 3 : bndCnt[v] > 0 ? 1 : 1 + nbrCnt[v];
    for (let e = 0; e < ea.length; e++) cnt[midIdx[e]] = ecnt[e] === 2 ? 4 : 2;
    const off = new Uint32Array(nNew + 1);
    for (let v = 0; v < nNew; v++) off[v + 1] = off[v] + cnt[v];
    const sIdx = new Uint32Array(off[nNew]), sW = new Float32Array(off[nNew]);
    for (let v = 0; v < n; v++) {
      let k = off[v];
      if (bndCnt[v] === 2) {                          // boundary vertex: 3/4 self + 1/8 each boundary neighbour
        sIdx[k] = v; sW[k++] = 0.75;
        for (let j = nbrOff[v]; j < nbrOff[v + 1]; j++) if (nbrBnd[j]) { sIdx[k] = nbr[j]; sW[k++] = 0.125; }
      } else if (bndCnt[v] > 0) {                    // non-manifold corner: keep in place
        sIdx[k] = v; sW[k] = 1;
      } else {                                       // interior: Loop even rule
        const val = nbrCnt[v], beta = val === 3 ? 3 / 16 : 3 / (8 * val);
        sIdx[k] = v; sW[k++] = 1 - val * beta;
        for (let j = nbrOff[v]; j < nbrOff[v + 1]; j++) { sIdx[k] = nbr[j]; sW[k++] = beta; }
      }
    }
    for (let e = 0; e < ea.length; e++) {
      let k = off[midIdx[e]];
      if (ecnt[e] === 2) {                            // interior edge: 3/8 endpoints + 1/8 opposites
        sIdx[k] = ea[e]; sW[k++] = 0.375; sIdx[k] = eb[e]; sW[k++] = 0.375;
        sIdx[k] = eo1[e]; sW[k++] = 0.125; sIdx[k] = eo2[e]; sW[k++] = 0.125;
      } else {                                        // boundary / non-manifold edge: midpoint
        sIdx[k] = ea[e]; sW[k++] = 0.5; sIdx[k] = eb[e]; sW[k++] = 0.5;
      }
    }
    stencils.push({ nPrev: n, n: nNew, off, idx: sIdx, w: sW });

    // ---- linear barycentric parents (for pins / flat fallback)
    const npi = new Int32Array(nNew * 3), npw = new Float32Array(nNew * 3);
    npi.set(pi); npw.set(pw);
    for (let e = 0; e < ea.length; e++) {
      const m = midIdx[e], acc = new Map();
      for (const v of [ea[e], eb[e]]) for (let j = 0; j < 3; j++) {
        const w = pw[3 * v + j] * 0.5; if (!w) continue;
        acc.set(pi[3 * v + j], (acc.get(pi[3 * v + j]) || 0) + w);
      }
      const ent = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
      const s = ent.reduce((z, q) => z + q[1], 0);
      for (let j = 0; j < 3; j++) { const q = ent[j] || [ent[0][0], 0]; npi[3 * m + j] = q[0]; npw[3 * m + j] = q[1] / s; }
    }
    pi = npi; pw = npw; tris = out; n = nNew;
  }
  return { tris, nU: n, pi, pw, stencils };
}
