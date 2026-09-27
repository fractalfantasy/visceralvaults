// Screen-space liquid surfaces (three.js r186 WebGPU, TSL). Classic SSF (van der Laan et al., GDC 2010):
//   depth     : every particle drawn as a sphere impostor into a float target (linear view depth)
//   thickness : the same sprites added up -> how much liquid each pixel looks through (metres)
//   smooth    : the depth is filtered into a surface (method-specific, see the subclasses)
//   composite : shade() -> normals from the smoothed depth, then the same three.js MeshPhysicalMaterial model the
//               cloth uses: transmission (refract by IOR, travel `thickness`, per-channel dispersion, roughness
//               blur, colour tint), fresnel env reflection, clearcoat, sheen and every scene light.
// FluidSurface is the shared part; ScreenSpaceFluid (Liquid 1) and WaterballFluid (./ssfluid_wb.js, Liquid 2)
// only differ in how they build and smooth the sprites. All targets are single-channel (R32F / R16F).
import * as THREE from 'three/webgpu';
import {
  Fn, If, Discard, Loop, float, vec2, vec3, vec4, uniform, texture, uv, instanceIndex, positionGeometry,
  cameraViewMatrix, cameraProjectionMatrix, cameraNear, cameraFar, cameraWorldMatrix, viewZToPerspectiveDepth,
  sqrt, exp, max, length, abs, normalize, cross, dot, reflect, pow, mix, clamp, smoothstep, select, screenUV, pmremTexture,
} from 'three/tsl';

export class FluidSurface {
  constructor(renderer, liquid, studioEnv, tag) {
    this.renderer = renderer; this.liquid = liquid; this.tag = tag;
    this.targets = [];
    this.U = { texel: uniform(new THREE.Vector2(1, 1)), dir: uniform(new THREE.Vector2(1, 0)), on: uniform(0) };
    this.studioEnv = studioEnv; this.envTex = studioEnv; this.envNodes = [];   // pmrem lookups created by shade()
    this.clear = new THREE.Color();
    this.rtDepth = this.target(THREE.FloatType, true);
    this.rtThick = this.target(THREE.HalfFloatType);
  }

  // single-channel render target (nearest sampling; R32F is not filterable)
  target(type, depthBuffer = false) {
    const rt = new THREE.RenderTarget(1, 1, { type, format: THREE.RedFormat, depthBuffer, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
    rt.texture.generateMipmaps = false;
    this.targets.push(rt);
    return rt;
  }

  // particle sprites for the depth + thickness passes. halfSize: sphere radius (m); corner: view-plane offset of
  // the quad corner (positionGeometry.xy is in [-1, 1]).
  makeSprites(halfSize, corner) {
    const geo = new THREE.PlaneGeometry(2, 2);
    const center = cameraViewMatrix.mul(vec4(this.liquid.particles.element(instanceIndex).get('position'), 1.0)).xyz;
    const vertexNode = cameraProjectionMatrix.mul(vec4(center.add(vec3(corner, 0.0)), 1.0));
    const centerZ = center.z.toVarying(`${this.tag}CenterZ`);
    const radius = halfSize.toVarying(`${this.tag}Radius`);
    const sphere = () => {                         // height of the sphere above the sprite plane (0..1)
      const c = uv().mul(2).sub(1);
      const r2 = dot(c, c);
      If(r2.greaterThan(1.0), () => { Discard(); });
      return sqrt(float(1).sub(r2));
    };
    const depthMat = new THREE.MeshBasicNodeMaterial();
    depthMat.vertexNode = vertexNode;
    const zFront = Fn(() => centerZ.add(sphere().mul(radius)))();
    depthMat.colorNode = vec4(zFront.negate(), 0, 0, 1);
    depthMat.depthNode = viewZToPerspectiveDepth(zFront, cameraNear, cameraFar);
    // pure add (a red-only target has no alpha to blend with)
    const thickMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
    thickMat.vertexNode = vertexNode;
    thickMat.colorNode = Fn(() => vec4(sphere().mul(radius).mul(2), 0, 0, 1))();
    this.depthMesh = new THREE.Mesh(geo, depthMat);
    this.thickMesh = new THREE.Mesh(geo, thickMat);
    for (const m of [this.depthMesh, this.thickMesh]) { m.frustumCulled = false; m.matrixAutoUpdate = false; }
    this.depthScene = new THREE.Scene(); this.depthScene.add(this.depthMesh);
    this.thickScene = new THREE.Scene(); this.thickScene.add(this.thickMesh);
  }

  setEnv(tex) { this.envTex = tex || this.studioEnv; for (const e of this.envNodes) e.value = this.envTex; }
  env(dir, rough) { const e = pmremTexture(this.envTex, dir, rough); this.envNodes.push(e); return e; }

  // size targets, draw the depth + thickness sprites; returns the target height in pixels
  begin(camera, Q, pixelW, pixelH) {
    const r = this.renderer, s = Q.fluidResolution;
    const w = Math.max(1, Math.round(pixelW * s)), h = Math.max(1, Math.round(pixelH * s));
    if (w !== this.w || h !== this.h) {
      for (const rt of this.targets) rt.setSize(w, h);
      this.U.texel.value.set(1 / w, 1 / h); this.w = w; this.h = h;
    }
    this.depthMesh.count = this.thickMesh.count = this.liquid.count;
    this.prevRT = r.getRenderTarget(); this.prevAlpha = r.getClearAlpha(); r.getClearColor(this.clear);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.rtDepth); r.clear(); r.render(this.depthScene, camera);
    r.setRenderTarget(this.rtThick); r.clear(); r.render(this.thickScene, camera);
    return h;
  }
  end() { const r = this.renderer; r.setRenderTarget(this.prevRT); r.setClearColor(this.clear, this.prevAlpha); }

  // one separable filter pass: src texture node <- target, direction (x, y), into dst
  pass(quad, srcNode, srcRT, dx, dy, dst) {
    srcNode.value = srcRT.texture; this.U.dir.value.set(dx, dy);
    this.renderer.setRenderTarget(dst); quad.render(this.renderer);
  }

  // TSL: composite the liquid over sceneColor. S = this liquid's shading uniforms (material + lights).
  // Needs this.depthTex (smoothed depth) and this.thickTex (thickness) from the subclass.
  shade(sceneColor, sceneViewZ, S) {
    const U = this.U, depthTex = this.depthTex, thickTex = this.thickTex;
    return Fn(() => {
      const col = sceneColor.rgb.toVar();
      const st = screenUV;
      const d = depthTex.sample(st).r.toVar();
      If(U.on.greaterThan(0.5).and(d.greaterThan(0)).and(d.lessThan(sceneViewZ.negate().add(0.01))), () => {
        // view-space position from the smoothed depth
        const P00 = cameraProjectionMatrix.element(0).x, P11 = cameraProjectionMatrix.element(1).y;
        const viewPos = (q, dd) => vec3(q.x.mul(2).sub(1).mul(dd).div(P00), float(1).sub(q.y.mul(2)).mul(dd).div(P11), dd.negate());
        const px = viewPos(st, d).toVar();
        const tx = U.texel.x, ty = U.texel.y;
        const dxp = depthTex.sample(st.add(vec2(tx, 0))).r, dxm = depthTex.sample(st.sub(vec2(tx, 0))).r;
        const dyp = depthTex.sample(st.add(vec2(0, ty))).r, dym = depthTex.sample(st.sub(vec2(0, ty))).r;
        // one-sided differences; pick the smaller one so silhouettes don't smear the normal
        const ddx1 = viewPos(st.add(vec2(tx, 0)), select(dxp.greaterThan(0), dxp, d)).sub(px);
        const ddx2 = px.sub(viewPos(st.sub(vec2(tx, 0)), select(dxm.greaterThan(0), dxm, d)));
        const ddy1 = viewPos(st.add(vec2(0, ty)), select(dyp.greaterThan(0), dyp, d)).sub(px);
        const ddy2 = px.sub(viewPos(st.sub(vec2(0, ty)), select(dym.greaterThan(0), dym, d)));
        const ddx = select(abs(ddx1.z).lessThan(abs(ddx2.z)), ddx1, ddx2);
        const ddy = select(abs(ddy1.z).lessThan(abs(ddy2.z)), ddy1, ddy2);
        const n = normalize(cross(ddy, ddx)).toVar();         // view space, facing the camera
        const V = normalize(px.negate());
        const NdV = clamp(dot(n, V), 0.0, 1.0);
        const thick = thickTex.sample(st).r;

        // transmission (three.js MeshPhysicalMaterial model, no absorption like the cloth): refract the view
        // ray by the IOR, travel `thickness`, sample the scene where it lands, blur by roughness, tint by colour
        const landUV = (ior) => {
          const eta = float(1).div(ior);
          const cosI = dot(V, n);
          const k = float(1).sub(eta.mul(eta).mul(float(1).sub(cosI.mul(cosI))));
          const dir = V.negate().mul(eta).add(n.mul(eta.mul(cosI).sub(sqrt(max(k, 0.0)))));   // refract(-V, n, 1/ior)
          const q = px.add(normalize(dir).mul(S.thickness));
          const z = max(q.z.negate(), 1e-3);
          return vec2(q.x.mul(P00).div(z).mul(0.5).add(0.5), float(0.5).sub(q.y.mul(P11).div(z).mul(0.5)));
        };
        const blurR = S.roughness.mul(S.roughness).mul(0.04);
        const sampleScene = (q) => {                    // roughness blur: 9 taps, or 1 when smooth (uniform branch)
          const acc = S.sceneTex.sample(q).rgb.toVar();
          If(blurR.greaterThan(1e-4), () => {
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2;
              acc.addAssign(S.sceneTex.sample(q.add(vec2(Math.cos(a), Math.sin(a)).mul(blurR))).rgb);
            }
            acc.divAssign(9);
          });
          return acc;
        };
        const bg = sampleScene(landUV(S.ior)).toVar();
        If(S.dispersion.greaterThan(1e-3), () => {      // per-channel IOR spread, as three.js does
          const spread = S.ior.sub(1).mul(0.025).mul(S.dispersion);
          bg.assign(vec3(sampleScene(landUV(S.ior.sub(spread))).x, bg.y, sampleScene(landUV(S.ior.add(spread))).z));
        });
        const transmitted = bg.mul(S.color);

        // lights: ambient + env (diffuse) + every point light (three.js falloff), blinn-phong + clearcoat highlights
        const nW = normalize(cameraWorldMatrix.mul(vec4(n, 0)).xyz);
        const lit = S.ambient.add(this.env(nW, float(1)).mul(S.envI)).toVar();
        const spec = vec3(0).toVar();
        const shin = pow(float(2), float(1).sub(S.roughness).mul(11)).add(2);
        const ccShin = float(1500);
        for (const L of S.lights) {
          const toL = L.pos.sub(px);
          const dist = max(length(toL), 1e-3);
          const l = toL.div(dist);
          const cutoff = L.range.greaterThan(0).select(pow(clamp(float(1).sub(pow(dist.div(max(L.range, 1e-4)), 4.0)), 0.0, 1.0), 2.0), float(1));
          const radiance = L.color.mul(pow(dist, L.decay.negate())).mul(cutoff);
          const NdL = max(dot(n, l), 0.0);
          lit.addAssign(radiance.mul(NdL));
          const NdH = max(dot(n, normalize(l.add(V))), 0.0);
          spec.addAssign(radiance.mul(pow(NdH, shin).mul(shin.add(8).div(25.1))).mul(NdL));
          spec.addAssign(radiance.mul(pow(NdH, ccShin).mul(S.clearcoat).mul(ccShin.div(25.1))).mul(NdL).mul(0.25));
        }
        const diffuse = S.color.mul(lit).mul(float(1).sub(S.metalness));
        const body = mix(diffuse, transmitted, S.transmission.mul(float(1).sub(S.metalness)));

        // fresnel env reflection + clearcoat + sheen
        const f0s = S.ior.sub(1).div(S.ior.add(1)).toVar();
        const F0 = mix(vec3(f0s.mul(f0s)), S.color, S.metalness);
        const fres = pow(float(1).sub(NdV), 5.0);
        const F = F0.add(vec3(1).sub(F0).mul(fres));
        const rW = normalize(cameraWorldMatrix.mul(vec4(reflect(V.negate(), n), 0)).xyz);
        const refl = this.env(rW, S.roughness).mul(S.envI);
        const ccRefl = this.env(rW, float(0.03)).mul(S.envI).mul(float(0.04).add(fres.mul(0.96)).mul(S.clearcoat));
        const sheen = S.sheenColor.mul(pow(float(1).sub(NdV), 2.0)).mul(S.sheen).mul(lit);
        const liquidCol = body.mul(vec3(1).sub(F)).add(refl.mul(F)).add(spec.mul(mix(vec3(1), S.color, S.metalness))).add(ccRefl).add(sheen);

        col.assign(mix(col, liquidCol, smoothstep(0.0, S.edge, thick)));   // feather thin edges into the scene
      });
      return vec4(col, 1.0);
    })();
  }

  dispose() {
    for (const rt of this.targets) rt.dispose();
    this.depthMesh.geometry.dispose();
  }
}

// Liquid 1 surface: fixed-radius sprites + a bilateral blur whose radius is set in world units (cm), N passes.
const TAPS = 16;
export class ScreenSpaceFluid extends FluidSurface {
  constructor(renderer, liquid, studioEnv) {
    super(renderer, liquid, studioEnv, 'l1');
    const U = Object.assign(this.U, { radius: uniform(0.012), smooth: uniform(0.02), falloff: uniform(0.02), projScale: uniform(1) });
    this.makeSprites(U.radius, positionGeometry.xy.mul(U.radius));
    this.rtA = this.target(THREE.FloatType); this.rtB = this.target(THREE.FloatType);
    this.src = texture(this.rtDepth.texture);
    const blurMat = new THREE.MeshBasicNodeMaterial();
    blurMat.colorNode = Fn(() => {
      const st = uv();
      const d0 = this.src.sample(st).r.toVar();
      const out = vec4(0).toVar();
      If(d0.greaterThan(0), () => {
        const step = clamp(U.smooth.mul(U.projScale).div(d0).div(TAPS), 0.0, 1.0);   // world radius -> px; never skip pixels
        const sigma = float(TAPS).mul(0.5);
        const acc = float(0).toVar(), wsum = float(0).toVar();
        Loop({ start: -TAPS, end: TAPS + 1, type: 'int', condition: '<' }, ({ i }) => {
          const fi = float(i);
          const d = this.src.sample(st.add(U.dir.mul(U.texel).mul(fi.mul(step)))).r;
          const dz = d.sub(d0).div(U.falloff);
          const w = exp(fi.mul(fi).div(sigma.mul(sigma).mul(-2))).mul(exp(dz.mul(dz).negate()));
          If(d.greaterThan(0), () => { acc.addAssign(d.mul(w)); wsum.addAssign(w); });
        });
        out.assign(vec4(acc.div(max(wsum, 1e-6)), 0, 0, 1));
      });
      return out;
    })();
    this.quad = new THREE.QuadMesh(blurMat);
    this.depthTex = texture(this.rtA.texture);
    this.thickTex = texture(this.rtThick.texture);
  }

  render(camera, Q, pixelW, pixelH) {
    const U = this.U;
    U.radius.value = Q.fluidRadius / 100;
    U.smooth.value = Q.fluidSmooth / 100;
    U.falloff.value = Math.max(1e-4, Q.fluidFalloff / 100);
    const h = this.begin(camera, Q, pixelW, pixelH);
    U.projScale.value = camera.projectionMatrix.elements[5] * h * 0.5;   // pixels per metre at depth 1
    const on = Q.fluidIterations > 0 ? 1 : 0;                           // 0 passes = a straight copy
    let src = this.rtDepth;
    for (let it = 0; it < Math.max(1, Q.fluidIterations); it++) {
      this.pass(this.quad, this.src, src, on, 0, this.rtB);
      this.pass(this.quad, this.src, this.rtB, 0, on, this.rtA);
      src = this.rtA;
    }
    this.end();
  }
}
