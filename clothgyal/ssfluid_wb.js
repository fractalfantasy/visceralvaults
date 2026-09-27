// Liquid 2 surface: WaterBall-style screen-space fluid meshing (fractalfantasy/waterball/render, after
// matsuoka-601's webgpu-ocean), ported to three.js TSL. Shading is the shared FluidSurface.shade(), so Liquid 1
// and Liquid 2 differ only in how the particle cloud becomes a surface:
//   sprites   : sized by particle density (sparse spray shrinks away), stretched along screen-space velocity
//               (area preserved)
//   smooth    : separable bilateral filter, per-pixel kernel = projected particle size / depth (up to maxFilter
//               px), N iterations, depth threshold = radius * depthScale
//   thickness : wide separable gaussian
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, float, int, vec4, uniform, texture, uv, instanceIndex, positionGeometry, cameraViewMatrix,
  sqrt, exp, max, min, dot, clamp, ceil } from 'three/tsl';
import { FluidSurface } from './ssfluid.js?v=f3eb47adb6';

const MAX_TAPS = 100;                // hard cap on filter half-widths (px)

export class WaterballFluid extends FluidSurface {
  constructor(renderer, liquid, studioEnv) {
    super(renderer, liquid, studioEnv, 'l2');
    const U = Object.assign(this.U, {
      radius: uniform(0.012), densityScale: uniform(4), restDensity: uniform(25), stretch: uniform(0.4),
      projConst: uniform(20), maxFilter: uniform(40, 'int'), depthThr: uniform(0.12), thickBlur: uniform(30, 'int'),
    });
    // sprites: diameter = 2r x clamp(density / restDensity x densityScale), stretched along view-plane velocity
    const part = liquid.particles.element(instanceIndex);
    const halfSize = U.radius.mul(clamp(liquid.density.element(instanceIndex).div(U.restDensity).mul(U.densityScale), 0.0, 1.0));
    const velView = cameraViewMatrix.mul(vec4(part.get('velocity').mul(liquid.U.velToMs), 0.0)).xy;   // m/s
    const c = positionGeometry.xy.mul(halfSize);
    const areaFix = float(1).div(sqrt(float(1).add(U.stretch.mul(dot(velView, velView)))));
    this.makeSprites(halfSize, c.add(velView.mul(dot(velView, c)).mul(U.stretch)).mul(areaFix));

    this.rtA = this.target(THREE.FloatType); this.rtB = this.target(THREE.FloatType);
    this.rtThickA = this.target(THREE.HalfFloatType); this.rtThickB = this.target(THREE.HalfFloatType);

    // bilateral depth filter (WaterBall bilateral.wgsl): 1 px steps, per-pixel kernel size
    this.src = texture(this.rtDepth.texture);
    const bilMat = new THREE.MeshBasicNodeMaterial();
    bilMat.colorNode = Fn(() => {
      const st = uv();
      const d0 = this.src.sample(st).r.toVar();
      const out = vec4(d0, 0, 0, 1).toVar();
      If(d0.greaterThan(0), () => {
        const fs = min(U.maxFilter, int(ceil(U.projConst.div(d0)))).toVar();
        const sig = max(float(fs).div(3.0), 0.5);
        const twoSig = sig.mul(sig).mul(2);
        const sigD = U.depthThr.div(3.0);
        const twoSigD = sigD.mul(sigD).mul(2);
        const sum = float(0).toVar(), wsum = float(0).toVar();
        Loop({ start: fs.negate(), end: fs, type: 'int', condition: '<=' }, ({ i }) => {
          const x = float(i);
          const d = this.src.sample(st.add(U.dir.mul(U.texel).mul(x))).r;
          If(d.greaterThan(0), () => {
            const dz = d.sub(d0);
            const w = exp(x.mul(x).div(twoSig).negate()).mul(exp(dz.mul(dz).div(twoSigD).negate()));
            sum.addAssign(d.mul(w)); wsum.addAssign(w);
          });
        });
        out.assign(vec4(sum.div(max(wsum, 1e-8)), 0, 0, 1));
      });
      return out;
    })();
    this.bilQuad = new THREE.QuadMesh(bilMat);

    // thickness gaussian (WaterBall gaussian.wgsl)
    this.tsrc = texture(this.rtThick.texture);
    const gMat = new THREE.MeshBasicNodeMaterial();
    gMat.colorNode = Fn(() => {
      const st = uv();
      const n = min(U.thickBlur, MAX_TAPS);
      const sig = max(float(n).div(3.0), 0.5);
      const twoSig = sig.mul(sig).mul(2);
      const sum = float(0).toVar(), wsum = float(0).toVar();
      Loop({ start: n.negate(), end: n, type: 'int', condition: '<=' }, ({ i }) => {
        const x = float(i);
        const w = exp(x.mul(x).div(twoSig).negate());
        sum.addAssign(this.tsrc.sample(st.add(U.dir.mul(U.texel).mul(x))).r.mul(w)); wsum.addAssign(w);
      });
      return vec4(sum.div(wsum), 0, 0, 1);
    })();
    this.gQuad = new THREE.QuadMesh(gMat);

    this.depthTex = texture(this.rtA.texture);
    this.thickTex = texture(this.rtThickA.texture);
  }

  render(camera, Q, pixelW, pixelH) {
    const U = this.U, radius = Q.fluidRadius / 100;
    U.radius.value = radius;
    U.densityScale.value = Q.wbDensitySize; U.restDensity.value = Q.liquidDensity; U.stretch.value = Q.wbStretch;
    U.maxFilter.value = Math.min(MAX_TAPS, Q.wbMaxFilter | 0);
    U.depthThr.value = radius * Q.wbDepthScale;
    U.thickBlur.value = Math.min(MAX_TAPS, Q.wbThickBlur | 0);
    const h = this.begin(camera, Q, pixelW, pixelH);
    // WaterBall: projected_particle_constant = blurFilterSize * diameter * 0.05 * (H/2) / tan(fov/2)
    U.projConst.value = Q.wbFilterSize * 2 * radius * 0.05 * (h / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    let src = this.rtDepth;
    for (let it = 0; it < Math.max(1, Q.wbIterations | 0); it++) {
      this.pass(this.bilQuad, this.src, src, 1, 0, this.rtB);
      this.pass(this.bilQuad, this.src, this.rtB, 0, 1, this.rtA);
      src = this.rtA;
    }
    this.pass(this.gQuad, this.tsrc, this.rtThick, 1, 0, this.rtThickB);
    this.pass(this.gQuad, this.tsrc, this.rtThickB, 0, 1, this.rtThickA);
    this.end();
  }
}
