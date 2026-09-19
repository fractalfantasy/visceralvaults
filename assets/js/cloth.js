import * as THREE from "three/webgpu";

// Interactive cloth surface driven by a discrete wave/spring height field.
// The grid stays fixed in X/Y and only the Z (depth) of each vertex
// animates, which keeps the simulation cheap and numerically stable while
// still reading as fabric rippling under a touch.
//
// Ported from a reference cloth-physics demo (same tuning constants), with
// the webcam-depth-tracking bits trimmed since we only ever set depthTarget
// once (from a logo image) rather than continuously from a live model.
export class Cloth {
  constructor({ width, height, segmentsX, segmentsY }) {
    this.width = width;
    this.height = height;
    this.segmentsX = segmentsX;
    this.segmentsY = segmentsY;
    this.cols = segmentsX + 1;
    this.rows = segmentsY + 1;
    this.count = this.cols * this.rows;

    this.geometry = new THREE.PlaneGeometry(width, height, segmentsX, segmentsY);
    this.positions = this.geometry.attributes.position.array;

    this.h = new Float32Array(this.count); // current z displacement per vertex
    this.v = new Float32Array(this.count); // velocity of that displacement
    this._accel = new Float32Array(this.count);

    this.waveSpeed = 200; // how fast disturbances propagate to neighbors
    this.restoring = 56; // spring pulling each point back toward the flat rest plane
    this.damping = 3; // velocity damping (settles the ripple down)
    this.displacementScale = 9.45; // multiplier applied to the simulated height when writing to the mesh
    this.maxVelocity = 500; // per-vertex velocity clamp

    // Static target shape (baked from the logo image) that the surface
    // relaxes toward — see the depthGain comment below.
    this.depthTarget = new Float32Array(this.count);
    this.depthOffset = new Float32Array(this.count);
    this.depthGain = 10; // convergence rate toward depthTarget, in 1/sec
  }

  index(x, y) {
    return y * this.cols + x;
  }

  // localX/localY are in the same unit space as width/height (i.e.
  // -width/2..width/2), radius is in that same unit space.
  applyForce(localX, localY, radius, strength) {
    const gx = ((localX + this.width / 2) / this.width) * this.segmentsX;
    const gy = ((this.height / 2 - localY) / this.height) * this.segmentsY;
    const rgx = (radius / this.width) * this.segmentsX;
    const rgy = (radius / this.height) * this.segmentsY;
    const rg = Math.max(rgx, rgy);

    const minX = Math.max(0, Math.floor(gx - rg));
    const maxX = Math.min(this.segmentsX, Math.ceil(gx + rg));
    const minY = Math.max(0, Math.floor(gy - rg));
    const maxY = Math.min(this.segmentsY, Math.ceil(gy + rg));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = (x - gx) / rgx;
        const dy = (y - gy) / rgy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) {
          const falloff = 1 - d;
          const smooth = falloff * falloff * (3 - 2 * falloff);
          this.v[this.index(x, y)] += strength * smooth;
        }
      }
    }
  }

  update(dt) {
    dt = Math.min(dt, 1 / 30);
    const { cols, rows, h, v, _accel: accel } = this;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = this.index(x, y);
        const hi = h[i];
        const left = x > 0 ? h[i - 1] : hi;
        const right = x < cols - 1 ? h[i + 1] : hi;
        const up = y > 0 ? h[i - cols] : hi;
        const down = y < rows - 1 ? h[i + cols] : hi;
        const laplacian = left + right + up + down - 4 * hi;
        const restoringForce = hi * this.restoring;
        accel[i] = laplacian * this.waveSpeed - restoringForce - v[i] * this.damping;
      }
    }

    const maxV = this.maxVelocity;
    const depthTarget = this.depthTarget;
    const depthOffset = this.depthOffset;
    const depthLerp = Math.min(1, this.depthGain * dt);
    for (let i = 0; i < this.count; i++) {
      let vi = v[i] + accel[i] * dt;
      if (vi > maxV) vi = maxV;
      else if (vi < -maxV) vi = -maxV;
      v[i] = vi;
      h[i] += vi * dt;

      depthOffset[i] += (depthTarget[i] - depthOffset[i]) * depthLerp;

      this.positions[i * 3 + 2] = (h[i] + depthOffset[i]) * this.displacementScale;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}
