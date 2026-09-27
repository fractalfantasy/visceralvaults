// A liquid = its own simulation (liquid.js), droplet material, screen-space surface (ssfluid*.js), shading
// uniforms and GUI folder. Disabled, it costs nothing per frame: no compute, no surface passes, and its composite
// is one skipped branch. Settings are flat keys on the app's P (so presets stay flat JSON); Liquid 2 reads the
// same key names prefixed 'l2_' through a small proxy, so every piece of code works with either liquid.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Liquid, LIQUID_MAX } from './liquid.js?v=f3eb47adb6';
import { ScreenSpaceFluid } from './ssfluid.js?v=f3eb47adb6';
import { WaterballFluid } from './ssfluid_wb.js?v=f3eb47adb6';

// ---- settings (Liquid 1 names; Liquid 2 = same names prefixed l2_)
const SHARED = {
  liquidEnabled: false, liquidSimulate: true, liquidGrid: 64, liquidCount: 150000, liquidSubsteps: 2,
  liquidOffset: 0.4, liquidStick: 4, liquidRange: 15, liquidStiffness: 20, liquidDensity: 25, liquidViscosity: 0.1,
  liquidRespawn: 0.5, liquidMaxSpeed: 3, liquidShowBounds: false, liquidBoundsX: 1.8, liquidBoundsY: 2.3, liquidBoundsZ: 1.4,
  liquidRender: 'screen-space fluid', liquidSize: 0.35, fluidRadius: 1.2, fluidResolution: 1.0, fluidEdge: 0.4,
  liqColor: '#bfe6ff', liqRoughness: 0.05, liqMetalness: 0.0, liqClearcoat: 1.0, liqSheen: 0.0, liqEnvIntensity: 1.0,
  liqTransmission: 0.85, liqIor: 1.33, liqThickness: 0.05, liqDispersion: 0.0,
};
const L1_ONLY = { liquidAttract: 300, liquidGravity: 1.0, fluidSmooth: 2.5, fluidFalloff: 2.0, fluidIterations: 2 };
const L2_ONLY = {   // WaterBall sim (mls-mpm/g2p.wgsl defaults; sphere -> her mesh) + WaterBall surface
  liquidWbDt: 0.2, liquidWbSpeed: 1, liquidWbDrag: 0, liquidMeshAttract: 1, liquidMeshRepulse: 1, liquidWbGravity: 0,
  liquidWallStiffness: 1, liquidBottomWall: 0, liquidAttractMode: 'surface', liquidFillBand: 2, liquidOverflow: 0,
  wbDensitySize: 4, wbStretch: 0.4, wbFilterSize: 12, wbMaxFilter: 40, wbDepthScale: 10, wbIterations: 4, wbThickBlur: 30,
};
// WaterBall stiffness; rest density 25 (its 4 suits a filled volume, see "fill inside"); no stickiness
const L2_OVERRIDES = { liquidStiffness: 3, liquidStick: 0 };

const isLiqKey = (k) => typeof k === 'string' && /^(liquid|fluid|liq|wb)/.test(k);

// add both liquids' defaults to P; returns the preset keys they own
export function liquidDefaults(P) {
  const l1 = { ...SHARED, ...L1_ONLY }, l2 = { ...SHARED, ...L2_ONLY, ...L2_OVERRIDES };
  Object.assign(P, l1);
  for (const [k, v] of Object.entries(l2)) P['l2_' + k] = v;
  return [...Object.keys(l1), ...Object.keys(l2).map((k) => 'l2_' + k)];
}

// the three.js MeshPhysicalMaterial settings shared by the skin and both liquids (key suffixes -> labels, ranges)
export const MATERIAL_FIELDS = [
  ['Color', 'color'], ['Roughness', 'roughness', 0, 1, 0.01], ['Metalness', 'metallic', 0, 1, 0.01],
  ['Clearcoat', 'clearcoat', 0, 1, 0.01], ['Sheen', 'sheen', 0, 1, 0.01], ['Transmission', 'transmission', 0, 1, 0.01],
  ['Ior', 'IOR', 1, 2.333, 0.001], ['Thickness', 'thickness (m)', 0, 0.5, 0.001], ['Dispersion', 'dispersion', 0, 10, 0.01],
];
export function addMaterialControls(folder, obj, keyOf, onChange) {
  for (const [f, label, min, max, step] of MATERIAL_FIELDS) {
    const c = f === 'Color' ? folder.addColor(obj, keyOf(f)) : folder.add(obj, keyOf(f), min, max, step);
    c.name(label).onChange(onChange);
  }
}
// push the fields (read through keyOf) onto a MeshPhysical(Node)Material
export function applyPhysical(m, obj, keyOf) {
  m.color.set(obj[keyOf('Color')]); m.roughness = obj[keyOf('Roughness')]; m.metalness = obj[keyOf('Metalness')];
  m.clearcoat = obj[keyOf('Clearcoat')]; m.sheen = obj[keyOf('Sheen')]; m.transmission = obj[keyOf('Transmission')];
  m.ior = obj[keyOf('Ior')]; m.thickness = obj[keyOf('Thickness')]; m.dispersion = obj[keyOf('Dispersion')];
}

export class LiquidSystem {
  // app: { renderer, scene, P }; prefix '' (Liquid 1) or 'l2_' (Liquid 2)
  constructor(app, title, prefix) {
    this.app = app; this.title = title;
    const P = app.P;
    this.Q = prefix ? new Proxy(P, {
      get: (t, k) => t[isLiqKey(k) ? prefix + k : k],
      set: (t, k, v) => { t[isLiqKey(k) ? prefix + k : k] = v; return true; },
    }) : P;
    this.waterball = !!prefix;
    this.mat = new THREE.MeshPhysicalNodeMaterial({ clearcoatRoughness: 0.03, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.3 });
    this.sim = new Liquid(app.renderer, this.mat, this.Q, this.waterball ? 'waterball' : 'ours');
    app.scene.add(this.sim.mesh, this.sim.boundsHelper);
  }

  get enabled() { return !!this.Q.liquidEnabled; }
  get built() { return !!this.sim.kG2P; }
  get count() { return this.sim.count; }

  // surface + shading uniforms; returns sceneColor with this liquid composited over it
  composite(sceneColor, sceneTex, sceneViewZ, studioEnv, lightCount) {
    const Surface = this.waterball ? WaterballFluid : ScreenSpaceFluid;
    this.surface = new Surface(this.app.renderer, this.sim, studioEnv);
    this.S = {
      sceneTex, color: uniform(new THREE.Color()), sheenColor: uniform(new THREE.Color(1, 1, 1)), roughness: uniform(0),
      metalness: uniform(0), clearcoat: uniform(1), sheen: uniform(0), envI: uniform(1), transmission: uniform(1),
      ior: uniform(1.33), thickness: uniform(0.05), dispersion: uniform(0), ambient: uniform(new THREE.Color()), edge: uniform(0.004),
      lights: Array.from({ length: lightCount }, () => ({ pos: uniform(new THREE.Vector3()), color: uniform(new THREE.Color()), decay: uniform(2), range: uniform(0) })),
    };
    this.applyMaterial();
    return this.surface.shade(sceneColor, sceneViewZ, this.S);
  }

  applyMaterial() {
    const Q = this.Q, m = this.mat, S = this.S, master = this.app.P.master;
    applyPhysical(m, Q, (f) => 'liq' + f); m.envMapIntensity = Q.liqEnvIntensity * master;
    if (!S) return;
    S.color.value.set(Q.liqColor).convertSRGBToLinear(); S.roughness.value = Q.liqRoughness; S.metalness.value = Q.liqMetalness;
    S.clearcoat.value = Q.liqClearcoat; S.sheen.value = Q.liqSheen; S.transmission.value = Q.liqTransmission;
    S.ior.value = Q.liqIor; S.thickness.value = Q.liqThickness; S.dispersion.value = Q.liqDispersion;
    S.envI.value = Q.liqEnvIntensity * master; S.edge.value = Math.max(1e-5, Q.fluidEdge / 100);
  }

  setEnv(tex) { this.mat.envMap = tex; this.mat.needsUpdate = true; this.surface.setEnv(tex); }

  // (re)build the sim kernels for this skin / particle count; sync() only when enabled and something changed
  build(skin) { if (skin) { this.sim.build(skin, Math.min(LIQUID_MAX, Math.max(1000, this.Q.liquidCount | 0))); this.builtCount = this.Q.liquidCount; } }
  sync(skin) { if (this.enabled && skin && (!this.built || this.builtCount !== this.Q.liquidCount)) this.build(skin); }
  reset() { this.sim.reset(); }
  carry() { this.sim.carry(); }
  updateEnv(master) { this.mat.envMapIntensity = this.Q.liqEnvIntensity * master; }
  idle() { this.surface.U.on.value = 0; }

  step(dt, center) { this.sim.step(dt, center); }                 // the sim itself does nothing while disabled

  // screen-space surface passes for this frame (nothing when disabled / drawn as droplets)
  render(camera, lights, ambient, w, h) {
    const Q = this.Q, on = this.enabled && Q.liquidRender === 'screen-space fluid' && !!this.sim.kG2P;
    this.surface.U.on.value = on ? 1 : 0;
    if (!on) return;
    const S = this.S, v = new THREE.Vector3();
    lights.forEach((l, i) => {
      const L = S.lights[i];
      L.pos.value.copy(l.getWorldPosition(v)).applyMatrix4(camera.matrixWorldInverse);
      L.color.value.copy(l.color).multiplyScalar(l.visible ? l.intensity / Math.PI : 0);
      L.decay.value = l.decay; L.range.value = l.distance;
    });
    S.ambient.value.copy(ambient.color).multiplyScalar(ambient.intensity);
    S.envI.value = Q.liqEnvIntensity * this.app.P.master;
    this.surface.render(camera, Q, w, h);
  }

  // GUI folder: enabled / reset, then Sim, Surface, Material
  gui(parent, { skin, matchCloth, refresh }) {   // matchCloth(obj, keyOf): copy the skin material into obj's keys
    const Q = this.Q, lm = () => this.applyMaterial();
    const f = parent.addFolder(this.title);
    f.add(Q, 'liquidEnabled').name('enabled').onChange((v) => { if (v && !this.sim.kG2P) this.build(skin()); else if (v) this.reset(); });
    f.add({ reset: () => this.reset() }, 'reset').name('reset liquid');

    const fs = f.addFolder('Sim');
    fs.add(Q, 'liquidSimulate').name('simulate');
    fs.add(Q, 'liquidGrid', [64, 96, 128]).name('grid resolution');
    fs.add(Q, 'liquidCount', 5000, LIQUID_MAX, 1000).name('particles').onFinishChange(() => { if (this.sim.kG2P) this.build(skin()); });
    fs.add(Q, 'liquidSubsteps', 1, 6, 1).name('steps per frame');
    if (this.waterball) {
      fs.add(Q, 'liquidAttractMode', ['surface', 'fill inside']).name('attract mode').onChange(() => this.reset());
      fs.add(Q, 'liquidMeshAttract', 0, 20, 0.01).name('meshAttract');
      fs.add(Q, 'liquidMeshRepulse', 0, 20, 0.01).name('meshRepulse (surface)');
      fs.add(Q, 'liquidFillBand', 0.3, 8, 0.1).name('fill: wall band (cm)');
      fs.add(Q, 'liquidOverflow', 0, 1, 0.01).name('fill: overflow');
      fs.add(Q, 'liquidWbDt', 0.01, 1, 0.01).name('time step (grid)');
      fs.add(Q, 'liquidWbSpeed', 0, 4, 0.01).name('speed');
      fs.add(Q, 'liquidWbDrag', 0, 0.2, 0.001).name('drag');
      fs.add(Q, 'liquidWbGravity', -0.5, 0.5, 0.001).name('gravity (per step)');
    } else {
      fs.add(Q, 'liquidAttract', 0, 3000, 1).name('attraction');
      fs.add(Q, 'liquidRange', 2, 30, 0.5).name('attraction range (cm)');
      fs.add(Q, 'liquidGravity', -2, 3, 0.01).name('gravity (× earth)');
    }
    fs.add(Q, 'liquidStick', 0, 40, 0.1).name('stickiness (carried by her)');
    fs.add(Q, 'liquidOffset', -3, 5, 0.01).name('surface offset (cm)');
    fs.add(Q, 'liquidStiffness', 0, 400, 0.5).name('stiffness (pressure)');
    fs.add(Q, 'liquidDensity', 0.1, 60, 0.1).name('rest density');
    fs.add(Q, 'liquidViscosity', 0, 2, 0.005).name('viscosity');
    fs.add(Q, 'liquidRespawn', 0, 5, 0.01).name('respawn rate (/s)');
    fs.add(Q, 'liquidMaxSpeed', 0.1, 10, 0.05).name('max velocity (m/s)');
    const fb = fs.addFolder('Bounds');
    fb.add(Q, 'liquidShowBounds').name('show');
    fb.add(Q, 'liquidBoundsX', 0.5, 4, 0.01).name('width (m)');
    fb.add(Q, 'liquidBoundsY', 0.5, 4, 0.01).name('height (m)');
    fb.add(Q, 'liquidBoundsZ', 0.5, 4, 0.01).name('depth (m)');
    if (this.waterball) {
      fb.add(Q, 'liquidWallStiffness', 0, 5, 0.01).name('wall stiffness');
      fb.add(Q, 'liquidBottomWall', 0, 1, 0.01).name('raise floor');
    }

    const fr = f.addFolder('Surface');
    fr.add(Q, 'liquidRender', ['screen-space fluid', 'droplets']).name('render as');
    fr.add(Q, 'liquidSize', 0.05, 3, 0.01).name('droplet size (cm)');
    fr.add(Q, 'fluidRadius', 0.2, 5, 0.01).name('particle radius (cm)');
    if (this.waterball) {
      fr.add(Q, 'wbDensitySize', 0, 20, 0.1).name('density size scale');
      fr.add(Q, 'wbStretch', 0, 5, 0.01).name('velocity stretch');
      fr.add(Q, 'wbFilterSize', 0, 60, 0.5).name('blur filter size');
      fr.add(Q, 'wbMaxFilter', 1, 100, 1).name('max filter (px)');
      fr.add(Q, 'wbDepthScale', 0.5, 40, 0.1).name('blur depth threshold (× r)');
      fr.add(Q, 'wbIterations', 1, 8, 1).name('blur iterations');
      fr.add(Q, 'wbThickBlur', 0, 100, 1).name('thickness blur (px)');
    } else {
      fr.add(Q, 'fluidSmooth', 0, 10, 0.01).name('smoothing (cm)');
      fr.add(Q, 'fluidFalloff', 0.1, 10, 0.01).name('edge preserve (cm)');
      fr.add(Q, 'fluidIterations', 0, 4, 1).name('smoothing passes');
    }
    fr.add(Q, 'fluidResolution', 0.25, 1, 0.05).name('buffer resolution');
    fr.add(Q, 'fluidEdge', 0.01, 3, 0.01).name('edge softness (cm)').onChange(lm);

    const fm = f.addFolder('Material');
    fm.add({ match: () => { matchCloth(Q, (k) => 'liq' + k); lm(); refresh(); } }, 'match').name('⇆ copy cloth material');
    addMaterialControls(fm, Q, (k) => 'liq' + k, lm);
    fm.add(Q, 'liqEnvIntensity', 0, 4, 0.01).name('env intensity').onChange(lm);
    return f;
  }
}
