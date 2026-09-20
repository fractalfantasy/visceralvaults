import * as THREE from "three/webgpu";

// Cheap mass-spring cloth via Verlet integration + iterative distance-
// constraint relaxation (a "PBD-lite" — position-based dynamics without the
// extra bookkeeping a full PBD solver adds). Vertices move freely in X/Y/Z,
// unlike cloth.js's height-field, which is what actually lets this fold and
// sway like fabric instead of just rippling in place.
//
// Only structural (edge) and shear (diagonal) constraints are built — bend
// constraints (connecting every-other vertex to resist folding) are the
// most expensive part of a full cloth solver for the least visual payoff
// on a background effect, so they're skipped entirely.
export class VerletCloth {
  constructor({ width, height, segmentsX, segmentsY }) {
    this.segmentsX = segmentsX;
    this.segmentsY = segmentsY;
    this.cols = segmentsX + 1;
    this.rows = segmentsY + 1;
    this.count = this.cols * this.rows;

    this.geometry = new THREE.PlaneGeometry(width, height, segmentsX, segmentsY);
    const initial = this.geometry.attributes.position.array;
    this.pos = Float32Array.from(initial);
    this.prev = Float32Array.from(initial);
    this.pinned = new Uint8Array(this.count);

    // PlaneGeometry's first row is the top edge (+height/2); pinning it
    // makes the sheet hang like a curtain rather than free-falling.
    for (let x = 0; x < this.cols; x++) this.pinned[x] = 1;

    this.constraints = []; // { a, b, restLength }
    const addConstraint = (a, b) => {
      const ai = a * 3, bi = b * 3;
      const restLength = Math.hypot(
        this.pos[bi] - this.pos[ai],
        this.pos[bi + 1] - this.pos[ai + 1],
        this.pos[bi + 2] - this.pos[ai + 2],
      );
      this.constraints.push({ a, b, restLength });
    };
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = this.index(x, y);
        if (x < this.cols - 1) addConstraint(i, this.index(x + 1, y)); // structural
        if (y < this.rows - 1) addConstraint(i, this.index(x, y + 1)); // structural
        if (x < this.cols - 1 && y < this.rows - 1) {
          addConstraint(i, this.index(x + 1, y + 1)); // shear
          addConstraint(this.index(x + 1, y), this.index(x, y + 1)); // shear
        }
      }
    }

    this.gravity = -0.35;
    this.wind = 0.25;
    this.damping = 0.98; // velocity retained per step, implicit in Verlet's (pos - prev)
    this.iterations = 3; // constraint-relaxation passes per frame

    // Static logo relief, embossed on top of the physics rather than fed
    // into it — depthOffset converges toward depthTarget and gets added to
    // each vertex's z only when writing to the geometry, so it doesn't
    // fight (or get overwritten by) the constraint solver above.
    this.depthTarget = new Float32Array(this.count);
    this.depthOffset = new Float32Array(this.count);
    this.depthGain = 10; // convergence rate toward depthTarget, in 1/sec
  }

  index(x, y) {
    return y * this.cols + x;
  }

  // Pulls whichever unpinned vertex is nearest (localX, localY) toward
  // (targetX, targetY, targetZ) — a drag/tug rather than a physics impulse,
  // since Verlet integration has no explicit velocity to push. `strength`
  // (0-1) is how much of the way there it moves in one call: 1 snaps it
  // straight to the target, lower values give a softer, laggier feel.
  grabAt(localX, localY, targetX, targetY, targetZ, radius, strength = 1) {
    let closest = -1;
    let closestDist = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue;
      const dx = this.pos[i * 3] - localX;
      const dy = this.pos[i * 3 + 1] - localY;
      const d = dx * dx + dy * dy;
      if (d < closestDist) {
        closestDist = d;
        closest = i;
      }
    }
    if (closest >= 0 && closestDist < radius * radius) {
      const i = closest * 3;
      this.pos[i] += (targetX - this.pos[i]) * strength;
      this.pos[i + 1] += (targetY - this.pos[i + 1]) * strength;
      this.pos[i + 2] += (targetZ - this.pos[i + 2]) * strength;
    }
  }

  // `floorAt(x, y)`, if given, returns a z the cloth can't sink below at
  // that local (x, y) — applied after constraint relaxation, once per
  // vertex, and clamps both pos and prev together so contact kills the
  // vertex's z-velocity instead of leaving it to spring back through the
  // floor next frame.
  simulate(dt, time, floorAt) {
    dt = Math.min(dt, 1 / 30);
    const { pos, prev, count } = this;

    for (let i = 0; i < count; i++) {
      if (this.pinned[i]) continue;
      const ix = i * 3, iy = ix + 1, iz = ix + 2;
      const vx = (pos[ix] - prev[ix]) * this.damping;
      const vy = (pos[iy] - prev[iy]) * this.damping;
      const vz = (pos[iz] - prev[iz]) * this.damping;

      // Cheap per-vertex "wind": a travelling sine wave in Z, phase offset
      // by each vertex's own position, standing in for real per-triangle
      // aerodynamic force (which would need face normals recomputed live).
      const windZ = Math.sin(time * 1.3 + pos[ix] * 6 + pos[iy] * 3) * this.wind;

      const nx = pos[ix] + vx;
      const ny = pos[iy] + vy + this.gravity * dt * dt;
      const nz = pos[iz] + vz + windZ * dt * dt;

      prev[ix] = pos[ix];
      prev[iy] = pos[iy];
      prev[iz] = pos[iz];
      pos[ix] = nx;
      pos[iy] = ny;
      pos[iz] = nz;
    }

    for (let iter = 0; iter < this.iterations; iter++) {
      for (const { a, b, restLength } of this.constraints) {
        const ai = a * 3, bi = b * 3;
        const dx = pos[bi] - pos[ai];
        const dy = pos[bi + 1] - pos[ai + 1];
        const dz = pos[bi + 2] - pos[ai + 2];
        const dist = Math.hypot(dx, dy, dz) || 0.0001;
        const diff = (dist - restLength) / dist;
        const pinnedA = this.pinned[a];
        const pinnedB = this.pinned[b];
        if (pinnedA && pinnedB) continue;
        if (pinnedA) {
          pos[bi] -= dx * diff;
          pos[bi + 1] -= dy * diff;
          pos[bi + 2] -= dz * diff;
        } else if (pinnedB) {
          pos[ai] += dx * diff;
          pos[ai + 1] += dy * diff;
          pos[ai + 2] += dz * diff;
        } else {
          pos[ai] += dx * diff * 0.5;
          pos[ai + 1] += dy * diff * 0.5;
          pos[ai + 2] += dz * diff * 0.5;
          pos[bi] -= dx * diff * 0.5;
          pos[bi + 1] -= dy * diff * 0.5;
          pos[bi + 2] -= dz * diff * 0.5;
        }
      }
    }

    if (floorAt) {
      for (let i = 0; i < count; i++) {
        if (this.pinned[i]) continue;
        const ix = i * 3;
        const floorZ = floorAt(pos[ix], pos[ix + 1]);
        if (pos[ix + 2] < floorZ) {
          pos[ix + 2] = floorZ;
          prev[ix + 2] = floorZ;
        }
      }
    }

    const { depthTarget, depthOffset } = this;
    const depthLerp = Math.min(1, this.depthGain * dt);
    const output = this.geometry.attributes.position.array;
    for (let i = 0; i < count; i++) {
      depthOffset[i] += (depthTarget[i] - depthOffset[i]) * depthLerp;
      const ix = i * 3;
      output[ix] = pos[ix];
      output[ix + 1] = pos[ix + 1];
      output[ix + 2] = pos[ix + 2] + depthOffset[i];
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}
