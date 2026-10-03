// ClothGyal viewer (three.js r186 WebGPU). Pieces:
//   GpuSkin (gpuskin.js)       spring-cloth skin simulated on the GPU over the animated body
//   LiquidSystem (liquids.js)  Liquid 1 / Liquid 2: each its own sim + material + screen-space surface + GUI
//   HectorLiquid (liquid3.js)  Liquid 3: Hector Arellano's particle fluid filling her body, marching-cubes mesh
//   Player (player.js)         playable mode: WASD / jump (front flip) / crouch with Mixamo clips retargeted to her
//   face.js                    ARKit face presets, blink / talk / look-around
//   tooltips.js                mouse-over help for every GUI control
// Everything the GUI edits lives in P (flat keys) so a preset is just a flat JSON object (web/presets.json).
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, vec3, vec4, normalize, positionWorld, cameraPosition, cameraViewMatrix, cameraWorldMatrix,
  equirectUV, pass, max as tslMax, min as tslMin, cos, sin, If, Loop, float, select, abs, cross, log2, sqrt, exp,
  fract, fwidth, mix, smoothstep, length } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as dat from 'dat.gui';
import { FACE_PRESETS, applyFace, followEyelids } from './face.js?v=e4fb0672f0';
import { GpuSkin } from './gpuskin.js?v=e4fb0672f0';
import { LiquidSystem, liquidDefaults, addMaterialControls, applyPhysical, MATERIAL_FIELDS } from './liquids.js?v=e4fb0672f0';
import { HectorLiquid, hectorDefaults } from './liquid3.js?v=e4fb0672f0';
import { Player, playerDefaults, BASIC_IDLE } from './player.js?v=e4fb0672f0';
import { addTooltips } from './tooltips.js?v=e4fb0672f0';

if (!navigator.gpu) {
  document.getElementById('loading').textContent = 'WebGPU is not available in this browser (use Chrome / Edge / Safari 26+).';
  throw new Error('no WebGPU');
}

// ---------- renderer / scene / camera
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 50);
camera.position.set(-0.9, 1.5, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.1, 0);
controls.enableDamping = true;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- settings
const P = {
  preset: '',
  // animation + face
  dance: '', speed: 1.0, playing: true, loopFade: 0.4,
  face: 'neutral', faceAmount: 1.0, blink: true, lashBlink: 1.4, talk: false, lookAround: false,
  // body (spring-cloth skin)
  showBody: true, resolution: 'base (~13k pts)', simulate: true,
  stiffness: 350, damping: 9, motionDrag: 0.3, gravity: 2.0, slack: 0.15, stretch: 0.9, iterations: 6, offset: 0.002, smoothBase: 1.0, bending: 0.3,
  holdScale: 1.0, headHold: 0.55, lockThreshold: 1.0,
  windStrength: 1.0, windScale: 12, windSpeed: 0.6, windX: 0.6, windY: 0.1, windZ: -0.6,
  skinColor: '#cdf7ec', roughness: 0.25, metalness: 0.0, clearcoat: 1.0, sheen: 0.4, transmission: 0.0, ior: 1.4, thickness: 0.05, dispersion: 0.0,
  // scene
  followBody: true, followSmooth: 0.4, followHeight: 0.15, followVertical: 0.35,
  master: 1.0, ambient: 0.25, lightsFollow: true,
  envMap: 'None', envIntensity: 1.0, envBackground: false, envBlur: 0.0, bgFov: 100, bgRotation: 0, bgColor: '#000000', bgBrightness: 1.0,
  eyeGloss: 1.0, eyeSmooth: 0.97, eyeRough: 0.12, eyeReflect: 1.6, eyeBright: 1.1, eyeSceneEnv: false,
  bloom: true, bloomStrength: 0.45, bloomRadius: 0.5, bloomThreshold: 0.72, bloomClamp: 8.0,
};
const RES = { 'base (~13k pts)': 0, '2x (~53k pts)': 1, '3x (~210k pts)': 2, '4x (~840k pts)': 3 };
Object.assign(P, playerDefaults);
const PRESET_KEYS = [...Object.keys(P).filter((k) => k !== 'preset'), ...liquidDefaults(P), ...hectorDefaults(P)];
const DEFAULT_VALUES = Object.fromEntries(PRESET_KEYS.map((k) => [k, P[k]]));   // a preset that omits a key gets this
const STARTUP_PRESET = 'black hi res';

// point lights, placed relative to her hips (or the origin when lightsFollow is off)
const LIGHTS = {
  key: { color: '#fff4ea', intensity: 12, x: -1.2, y: 1.3, z: 1.6, distance: 0, decay: 2, orbit: false, orbitSpeed: 0.4 },
  rim: { color: '#9fdcff', intensity: 18, x: 0.4, y: 0.9, z: -1.6, distance: 0, decay: 2, orbit: false, orbitSpeed: -0.3 },
};
const DEFAULT_LIGHTS = JSON.parse(JSON.stringify(LIGHTS));
const lights = Object.fromEntries(Object.entries(LIGHTS).map(([n, L]) => [n, new THREE.PointLight(L.color, L.intensity, L.distance, L.decay)]));
const lightList = Object.values(lights);
const ambient = new THREE.AmbientLight(0x3a8c86, 0.25);   // faint teal fill so shadows aren't pure black
scene.add(ambient, ...lightList);

// ---------- materials
const skinMat = new THREE.MeshPhysicalNodeMaterial({ clearcoatRoughness: 0.04, sheenColor: new THREE.Color(0xbff6ff), sheenRoughness: 0.4 });
const skinKey = (f) => (f === 'Color' ? 'skinColor' : f[0].toLowerCase() + f.slice(1));   // skin material keys on P
const applySkinMaterial = () => applyPhysical(skinMat, P, skinKey);
// a liquid's "copy cloth material": obj + keyOf address the liquid's own keys (Liquid 2 goes through its l2_ proxy)
function matchClothMaterial(obj, keyOf) {
  for (const [f] of MATERIAL_FIELDS) obj[keyOf(f)] = P[skinKey(f)];
  obj[keyOf('EnvIntensity')] = P.envIntensity;
}

// glossy eyes: their own studio reflection map so they get catchlights even on a black background
const studioEnv = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.02).texture;
const eyeMats = [];
function makeEyeMaterial(src) {
  const m = new THREE.MeshPhysicalMaterial({ map: src.map || null, alphaTest: 0.5, ior: 1.376, envMap: studioEnv });
  eyeMats.push(m);
  return m;
}
function applyEyes() {
  for (const m of eyeMats) {
    m.clearcoat = P.eyeGloss; m.clearcoatRoughness = 1 - P.eyeSmooth; m.roughness = P.eyeRough;
    m.envMapIntensity = P.eyeReflect; m.color.setScalar(P.eyeBright);
    const env = P.eyeSceneEnv && scene.environment ? scene.environment : studioEnv;
    if (m.envMap !== env) { m.envMap = env; m.needsUpdate = true; }
  }
}

// ---------- liquids
const app = { renderer, scene, P };
const liquids = [new LiquidSystem(app, 'Liquid 1 (compute_particles_fluid)', ''), new LiquidSystem(app, 'Liquid 2 (waterball)', 'l2_'),
  new HectorLiquid(app, 'Liquid 3 (hector)')];

// ---------- post: liquids composited over the scene, then bloom (HDR clamped first so hot pixels can't bloom into squares)
const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sceneTex = scenePass.getTextureNode('output');
const sceneViewZ = scenePass.getViewZNode();
let sceneColor = sceneTex;
for (const l of liquids) sceneColor = l.composite(sceneColor, sceneTex, sceneViewZ, studioEnv, lightList.length);
const maxLumU = uniform(8.0);
const clamped = Fn(() => {
  const c = tslMax(sceneColor.rgb, vec3(0.0));
  const l = tslMax(tslMax(c.r, c.g), c.b);
  return vec4(c.mul(tslMin(maxLumU.div(tslMax(l, 1e-6)), 1.0)), 1.0);
})();
const bloomN = bloom(clamped, P.bloomStrength, P.bloomRadius, P.bloomThreshold);
const outBloom = sceneColor.add(bloomN);
function applyBloom() {
  bloomN.strength.value = P.bloomStrength; bloomN.radius.value = P.bloomRadius; bloomN.threshold.value = P.bloomThreshold;
  maxLumU.value = P.bloomClamp;
  const out = P.bloom ? outBloom : sceneColor;
  if (pipeline.outputNode !== out) { pipeline.outputNode = out; pipeline.needsUpdate = true; }
}

// ---------- environment map (equirectangular panoramas) + background sphere with its own FOV
// waterball's panoramas on fractalfantasy.net: the ones moved to the media bucket load from media.fractalfantasy.net
// (the old /waterball/build/pano/ path serves those without CORS); the rest are still static files there, with CORS
const MEDIA_PANOS = new Set([64, 68, 69, 75, 83, 84, 87, 90]);
const panoUrl = (i) => (i <= 57 && i !== 48) || MEDIA_PANOS.has(i)
  ? `https://media.fractalfantasy.net/waterball/pano${i}.jpg`
  : `https://fractalfantasy.net/waterball/build/pano/pano${i}.jpg`;
const envMapOptions = { None: '' };
for (let i = 3; i <= 132; i++) envMapOptions[`Pano ${i}`] = panoUrl(i);
const envCache = {};
const texLoader = new THREE.TextureLoader().setCrossOrigin('anonymous');
let envToken = 0;
function setEnvMap(name) {
  const url = envMapOptions[name], token = ++envToken;
  const apply = (tex) => {
    if (token !== envToken) return;
    skinMat.envMap = tex; skinMat.needsUpdate = true;
    for (const l of liquids) l.setEnv(tex);
    scene.environment = tex;                 // eyes / lashes / teeth pick it up too
    applyEnvBackground(); applyEyes();
  };
  if (!url) return apply(null);
  if (envCache[url]) return apply(envCache[url]);
  hudExtra = ` · loading ${name}…`;
  texLoader.load(url, (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    envCache[url] = tex; hudExtra = '';
    apply(tex);
  }, undefined, () => { hudExtra = ` · failed to load ${name}`; });
}
// the view direction goes to camera space, x/y widen by tan(bgFov/2)/tan(camFov/2), then look up the panorama:
// more of it fits in frame without changing her size. Optional blur: 32 gaussian taps on a golden-angle cone.
const BG = { fovScale: uniform(1), intensity: uniform(1), blur: uniform(0), rot: uniform(0), texH: uniform(1024) };
const bgTex = texture(new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1));
bgTex.value.needsUpdate = true;
const bgMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
bgMat.colorNode = Fn(() => {
  const dc = cameraViewMatrix.mul(vec4(normalize(positionWorld.sub(cameraPosition)), 0.0)).xyz;
  const d0 = normalize(cameraWorldMatrix.mul(vec4(dc.x.mul(BG.fovScale), dc.y.mul(BG.fovScale), dc.z, 0.0)).xyz);
  const c = cos(BG.rot), s2 = sin(BG.rot);
  const d = vec3(c.mul(d0.x).sub(s2.mul(d0.z)), d0.y, s2.mul(d0.x).add(c.mul(d0.z)));
  const col = vec3(0.0).toVar();
  If(BG.blur.lessThan(0.001), () => { col.assign(bgTex.sample(equirectUV(d)).rgb); }).Else(() => {
    const N = 32;
    const spread = BG.blur.mul(BG.blur).mul(0.9).add(BG.blur.mul(0.05));
    const up = select(abs(d.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
    const tx = normalize(cross(up, d)), ty = cross(d, tx);
    const lod = tslMax(float(0), log2(spread.mul(BG.texH).div(Math.PI).div(Math.sqrt(N)).mul(1.5)));
    const acc = vec3(0.0).toVar(), wsum = float(0).toVar();
    Loop(N, ({ i }) => {
      const fi = float(i).add(0.5), r = sqrt(fi.div(N)), a = fi.mul(2.39996323);
      const s = normalize(d.add(tx.mul(cos(a)).add(ty.mul(sin(a))).mul(r.mul(spread))));
      const w = exp(r.mul(r).mul(-2.0));
      acc.addAssign(bgTex.sample(equirectUV(s)).level(lod).rgb.mul(w)); wsum.addAssign(w);
    });
    col.assign(acc.div(wsum));
  });
  return vec4(col.mul(BG.intensity), 1.0);
})();
const bgSphere = new THREE.Mesh(new THREE.SphereGeometry(40, 64, 32), bgMat);
bgSphere.frustumCulled = false; bgSphere.renderOrder = -1000; bgSphere.visible = false;
scene.add(bgSphere);

function applyEnvBackground() {
  const env = scene.environment, on = P.envBackground && !!env;
  bgSphere.visible = on;
  if (on) {
    bgTex.value = env;
    BG.texH.value = env.image ? env.image.height : 1024;
    BG.blur.value = P.envBlur;
    BG.rot.value = THREE.MathUtils.degToRad(P.bgRotation);
    BG.fovScale.value = Math.tan(THREE.MathUtils.degToRad(Math.min(P.bgFov, 179) / 2)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  }
  scene.background = new THREE.Color(P.bgColor).multiplyScalar(P.bgBrightness);
}

// ground for playable mode: world-space grid (1 m lines + faint 25 cm lines) that fades out with distance; the plane
// follows the camera in whole metres so the lines stay put under her feet
const floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, transparent: true, depthWrite: false });
{
  const gridLine = (scale) => {
    const a = positionWorld.xz.div(scale), d = abs(fract(a.sub(0.5)).sub(0.5)).div(fwidth(a));
    return float(1).sub(tslMin(tslMin(d.x, d.y), 1));
  };
  const lines = tslMax(gridLine(1), gridLine(0.25).mul(0.35));
  floorMat.colorNode = mix(vec3(0.05, 0.05, 0.06), vec3(0.55, 0.6, 0.65), lines);
  floorMat.opacityNode = float(1).sub(smoothstep(6, 22, length(positionWorld.xz.sub(cameraPosition.xz)))).mul(0.9);
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), floorMat);
floor.renderOrder = -1; floor.visible = false;
scene.add(floor);

// ---------- character, skin, animation
let mixer, current, currentPair = null, body, skin, bodyMorphDict, hipsBone, player, lashes = [];
const actions = {}, danceFiles = {}, charParts = [];
let danceList = [], loadToken = 0, hudExtra = '';
const animLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);   // dances are resampled + meshopt-compressed

function buildSkin() {
  if (skin) { scene.remove(skin.mesh); skin.dispose(); }
  skin = new GpuSkin(renderer, body, skinMat, P, RES[P.resolution] ?? 0);
  skin.onCarry = () => { for (const l of liquids) l.carry(); };
  scene.add(skin.mesh);
  hudExtra = ` · built ${skin.nU.toLocaleString()} pts in ${Math.round(skin.buildMs)} ms`;
  for (const l of liquids) if (l.enabled || l.built) l.build(skin);
}

// each dance is its own GLB (web/anims/*.glb), fetched when first picked. Two actions per dance (clip + clone) so a
// loop can crossfade into a fresh copy of itself instead of snapping from the last pose to the first.
function playDance(name) {
  if (P.playable) { P.playable = false; setPlayable(false, false); refreshGUI(); }
  const token = ++loadToken;
  const start = (pair) => {
    if (token !== loadToken) return;              // picked another dance meanwhile
    if (current && !pair.includes(current)) current.fadeOut(0.3);
    pair[0].reset().fadeIn(0.3).play();
    current = pair[0]; currentPair = pair;
    if (skin) skin.carryNext = true;
    hudExtra = '';
  };
  if (actions[name]) return start(actions[name]);
  hudExtra = ` · loading ${name}…`;
  animLoader.load(danceFiles[name], (g) => {
    const clip = g.animations[0]; clip.name = name;
    const clip2 = clip.clone(); clip2.name = name + '__b';
    actions[name] = [mixer.clipAction(clip), mixer.clipAction(clip2)];
    start(actions[name]);
  }, undefined, (err) => { hudExtra = ` · failed to load ${name}`; console.error(err); });
}

// playable mode: the dance hands the rig over to the WASD controller (and back)
function setPlayable(on, resumeDance = true) {
  if (on) {
    if (current) { for (const a of currentPair || [current]) a.fadeOut(0.3); }
    current = null; currentPair = null; ++loadToken;
    P.followBody = true; followInit = false; refreshGUI();
    player.start().catch((e) => { hudExtra = ' · failed to load locomotion'; console.error(e); });
  } else {
    player.stop();
    if (skin) skin.carryNext = true;
    followInit = false;
    if (resumeDance) playDance(P.dance);
  }
}

// before the mixer steps: loop mode, and hand over to the twin action near the end (crossfade)
let lastActionTime = 0, carryFramesLeft = 0;
const lastHips = new THREE.Vector3(), hipsNow = new THREE.Vector3();
function updateLooping() {
  if (!current || !currentPair) return;
  const smooth = P.loopFade > 0.01, dur = current.getClip().duration;
  for (const a of currentPair) { a.setLoop(smooth ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = smooth; }
  if (!smooth) return;
  const fade = Math.min(P.loopFade, dur * 0.4);
  if (current.time >= dur - fade && current.isRunning()) {
    const next = currentPair[0] === current ? currentPair[1] : currentPair[0];
    next.reset().setEffectiveWeight(1).play();
    current.crossFadeTo(next, fade, false);
    current = next;
    carryFramesLeft = Math.ceil(fade * 60) + 2;   // the blend can slide the root fast: let the skin ride along
  }
}
// after the mixer steps: hard jumps (loop wrap, teleport) -> the skin (and liquids) ride along instead of snapping
function detectJumps() {
  if (!current || !hipsBone || !skin) return;
  if (current.time < lastActionTime - 1e-3) skin.carryNext = true;
  if (carryFramesLeft > 0) { carryFramesLeft--; skin.carryNext = true; }
  lastActionTime = current.time;
  hipsBone.getWorldPosition(hipsNow);
  if (hipsNow.distanceTo(lastHips) > 0.25) skin.carryNext = true;
  lastHips.copy(hipsNow);
}

// ---------- camera follow: keep the orbit pivot on her (target + camera move together, so angle/zoom stay)
const followPos = new THREE.Vector3(), followDelta = new THREE.Vector3(), follow1 = new THREE.Vector3(), followBase = new THREE.Vector3();
const panOffset = new THREE.Vector3();
let followInit = false, restHipY = null, lastTarget = null;
function updateFollow(dt) {
  if (!P.followBody || !hipsBone) { lastTarget = null; return; }
  hipsBone.getWorldPosition(followPos);
  if (restHipY === null) restHipY = followPos.y;        // follow only part of the vertical bounce
  followPos.y = restHipY + (followPos.y - restHipY) * P.followVertical + P.followHeight;
  if (!followInit) {
    follow1.copy(followPos); followBase.copy(followPos); panOffset.set(0, 0, 0);
    camera.position.add(followDelta.subVectors(followPos, controls.target));
    controls.target.copy(followPos); lastTarget = controls.target.clone(); followInit = true; return;
  }
  if (lastTarget) panOffset.add(followDelta.subVectors(controls.target, lastTarget));   // user pan since last frame
  const smooth = P.playable ? Math.min(P.followSmooth, 0.15) : P.followSmooth;          // playable: keep up with her
  const a = smooth <= 0 ? 1 : 1 - Math.exp(-dt / (smooth * 0.5));                      // two-stage exponential smoothing
  follow1.lerp(followPos, a); followBase.lerp(follow1, a);
  followDelta.copy(followBase).add(panOffset).sub(controls.target);
  controls.target.add(followDelta); camera.position.add(followDelta);
  (lastTarget ||= new THREE.Vector3()).copy(controls.target);
}

const anchor = new THREE.Vector3();
function updateLights(t) {
  anchor.set(0, 0, 0);
  if (P.lightsFollow && hipsBone) { hipsBone.getWorldPosition(anchor); anchor.y = 0; }
  for (const [name, L] of Object.entries(LIGHTS)) {
    let x = L.x, z = L.z;
    if (L.orbit) { const a = t * L.orbitSpeed + Math.atan2(L.z, L.x), r = Math.hypot(L.x, L.z); x = Math.cos(a) * r; z = Math.sin(a) * r; }
    lights[name].position.set(anchor.x + x, anchor.y + L.y + 1.0, anchor.z + z);   // y relative to ~hip height
    lights[name].intensity = L.intensity * P.master;
  }
  ambient.intensity = P.ambient * P.master;
  const env = P.envIntensity * P.master;
  skinMat.envMapIntensity = env; scene.environmentIntensity = env;
  BG.intensity.value = env * P.bgBrightness;
  for (const l of liquids) l.updateEnv(P.master);
}

// ---------- presets: web/presets.json (written through the local dev server) + browser-saved ones (override by name)
let FILE_PRESETS = {};
const loadUserPresets = () => { try { return JSON.parse(localStorage.getItem('clothgyal_presets') || '{}'); } catch { return {}; } };
const saveUserPresets = (o) => { try { localStorage.setItem('clothgyal_presets', JSON.stringify(o)); } catch {} };
const allPresets = () => ({ ...FILE_PRESETS, ...loadUserPresets() });
function currentAsPreset() {
  const o = Object.fromEntries(PRESET_KEYS.map((k) => [k, P[k]]));
  o.lights = JSON.parse(JSON.stringify(LIGHTS));
  return o;
}
// apply a preset (missing keys -> defaults) and push every side effect
function applyPreset(name, initial = false) {
  const pr = allPresets()[name]; if (!pr) return;
  const prevRes = P.resolution, prevDance = P.dance;
  for (const k of PRESET_KEYS) P[k] = k in pr ? pr[k] : DEFAULT_VALUES[k];
  P.preset = name;
  for (const n in LIGHTS) Object.assign(LIGHTS[n], DEFAULT_LIGHTS[n], pr.lights?.[n] || {});
  for (const [n, L] of Object.entries(LIGHTS)) { lights[n].color.set(L.color); lights[n].distance = L.distance; lights[n].decay = L.decay; }
  applySkinMaterial(); applyEyes(); applyBloom(); setEnvMap(P.envMap);
  for (const l of liquids) l.applyMaterial();
  if (initial || P.resolution !== prevRes) buildSkin();
  for (const l of liquids) l.sync(skin);             // (re)build any enabled liquid whose particle setup changed
  for (const l of liquids) l.reset();
  if (!danceList.includes(P.dance)) P.dance = prevDance;
  // playable is saved too: switch into / out of it, otherwise (re)start the preset's dance
  const wantPlay = !!P.playable, playing = !!player?.active;
  if (wantPlay) { if (!playing) setPlayable(true); else player.setIdle(P.idleAnim); }
  else if (playing) setPlayable(false);                          // hands back to the preset's dance
  else if (initial || P.dance !== prevDance) playDance(P.dance);
  followInit = false; restHipY = null;
  skin?.reset();
  refreshGUI(); for (const l of liquids) l.guiStyle?.();
}
async function writePreset(name, settings, del = false) {   // false when there's no local server (e.g. GitHub Pages)
  try {
    const res = await fetch('./api/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(del ? { name, delete: true } : { name, settings }) });
    if (!res.ok) throw new Error(res.status);
    if (del) delete FILE_PRESETS[name]; else FILE_PRESETS[name] = settings;
    const u = loadUserPresets(); if (name in u) { delete u[name]; saveUserPresets(u); }   // the project copy is the source now
    return true;
  } catch {
    if (!del) { const u = loadUserPresets(); u[name] = settings; saveUserPresets(u); }    // keep it in this browser
    return false;
  }
}
function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function noServer() {
  if (confirm('Saved in this browser only: no local project server (tools/serve.py) is running.\n\nDownload an updated presets.json to put in web/?')) download('presets.json', allPresets());
}
const presetActions = {
  async save(nameArg) {
    const name = (typeof nameArg === 'string' ? nameArg : P.preset || '').trim(); if (!name) return;
    const ok = await writePreset(name, currentAsPreset());
    P.preset = name; setPresetList();
    hudExtra = ` · saved "${name}"${ok ? '' : ' (browser only)'}`;
    if (!ok) noServer();
  },
  async saveAs() {
    const name = (prompt('New preset name:', '') || '').trim(); if (!name) return;
    if (name in allPresets() && !confirm(`"${name}" already exists. Overwrite it?`)) return;
    await presetActions.save(name);
  },
  async del() {
    const name = P.preset; if (!name || !confirm(`Delete preset "${name}"?`)) return;
    const u = loadUserPresets(); delete u[name]; saveUserPresets(u);
    if (name in FILE_PRESETS && !(await writePreset(name, null, true))) alert('Removed from this browser; web/presets.json needs the local project server.');
    setPresetList(); applyPreset(Object.keys(allPresets())[0]);
  },
  async saveAll() {
    const all = allPresets(); let ok = true;
    for (const [n, s] of Object.entries(all)) ok = (await writePreset(n, s)) && ok;
    setPresetList();
    if (ok) hudExtra = ` · saved ${Object.keys(all).length} presets to web/presets.json`; else noServer();
  },
  exportProject() {    // every setting + lights + camera, plus a backup of browser-saved presets
    const name = (prompt('Project name:', P.preset || 'clothgyal project') || '').trim(); if (!name) return;
    download(name.replace(/[^\w\- ]+/g, '_') + '.clothgyal.json', {
      format: 'clothgyal-project', version: 1, savedAt: new Date().toISOString(), name, settings: currentAsPreset(),
      camera: { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov }, presets: loadUserPresets(),
    });
  },
  importProject() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      let data; try { data = JSON.parse(await file.text()); } catch { return alert('Not a valid JSON file.'); }
      const name = data.name || file.name.replace(/(\.clothgyal)?\.json$/i, '');
      const u = loadUserPresets(); Object.assign(u, data.presets || {}); u[name] = data.settings || data; saveUserPresets(u);
      setPresetList(); applyPreset(name);
      if (data.camera) {
        camera.position.fromArray(data.camera.position); controls.target.fromArray(data.camera.target);
        if (data.camera.fov) { camera.fov = data.camera.fov; camera.updateProjectionMatrix(); }
        panOffset.set(0, 0, 0); lastTarget = null; followInit = false; controls.update();
      }
      hudExtra = ` · loaded project "${name}"`;
    };
    input.click();
  },
};

// ---------- GUI: Presets · Animation · Body · Liquid 1 · Liquid 2 · Liquid 3 · Scene
let gui, presetCtrl;
function refreshGUI(g = gui) {
  if (!g) return;
  for (const c of g.__controllers) c.updateDisplay();
  for (const f of Object.values(g.__folders)) refreshGUI(f);
}
function setPresetList() {
  presetCtrl = presetCtrl.options(Object.keys(allPresets())).name('preset').onChange((n) => applyPreset(n));   // (a new controller)
  addTooltips(gui); refreshGUI();
}
function buildGUI() {
  gui = new dat.GUI({ width: 400 });
  const fp = gui.addFolder('Presets');
  presetCtrl = fp.add(P, 'preset', Object.keys(allPresets())).name('preset').onChange((n) => applyPreset(n));
  fp.add(presetActions, 'save').name('💾 save (overwrite)');
  fp.add(presetActions, 'saveAs').name('save as…');
  fp.add(presetActions, 'del').name('delete');
  fp.add(presetActions, 'saveAll').name('save all to project');
  fp.add(presetActions, 'exportProject').name('export project (.json)');
  fp.add(presetActions, 'importProject').name('import project (.json)');

  const fa = gui.addFolder('Animation');
  fa.add(P, 'dance', danceList).onChange(playDance);
  const fpl = fa.addFolder('Playable (WASD · Space flip · Shift crouch)');
  fpl.add(P, 'playable').name('playable').onChange((v) => setPlayable(v));
  fpl.add(P, 'showFloor').name('show floor');
  fpl.add(P, 'idleAnim', [BASIC_IDLE, ...danceList]).name('idle animation').onChange((n) => { if (player?.active) player.setIdle(n); });
  fpl.add(P, 'moveSpeed', 0.5, 6, 0.05).name('move speed (m/s)');
  fpl.add(P, 'jumpHeight', 0.1, 1.5, 0.01).name('jump height (m)');
  fpl.add(P, 'frontFlip').name('front flip on jump');
  fpl.add(P, 'turnSpeed', 1, 30, 0.1).name('turn speed');
  fpl.add(P, 'crouchAmount', 0, 1.3, 0.01).name('crouch depth');
  fa.add(P, 'speed', 0, 2, 0.01);
  fa.add(P, 'playing');
  fa.add(P, 'loopFade', 0, 2, 0.01).name('loop crossfade (s, 0 = off)');
  const ff = fa.addFolder('Face');
  ff.add(P, 'face', Object.keys(FACE_PRESETS)).name('expression');
  ff.add(P, 'faceAmount', 0, 1.5, 0.01).name('amount');
  ff.add(P, 'blink'); ff.add(P, 'lashBlink', 0.5, 2.5, 0.01).name('lash blink depth');
  ff.add(P, 'talk').name('talk loop'); ff.add(P, 'lookAround').name('look around');

  const fb = gui.addFolder('Body');
  fb.add(P, 'showBody').name('show body');
  fb.add(P, 'resolution', Object.keys(RES)).name('mesh resolution').onChange(buildSkin);
  fb.add(P, 'simulate').name('cloth sim');
  fb.add({ reset: () => skin?.reset() }, 'reset').name('reset cloth');
  const fc = fb.addFolder('Cloth');
  fc.add(P, 'stiffness', 20, 1500, 1);
  fc.add(P, 'damping', 0, 40, 0.1);
  fc.add(P, 'motionDrag', 0, 1, 0.01).name('motion drag');
  fc.add(P, 'gravity', -20, 20, 0.05).name('gravity (sag cm)');
  fc.add(P, 'slack', 0, 0.6, 0.005).name('slack (folds)');
  fc.add(P, 'stretch', 0, 1, 0.01);
  fc.add(P, 'iterations', 0, 16, 1);
  fc.add({ get cm() { return P.offset * 100; }, set cm(v) { P.offset = v / 100; } }, 'cm', 0, 10, 0.01).name('offset (cm)');
  fc.add(P, 'smoothBase', 0, 3, 0.01).name('smooth base');
  fc.add(P, 'bending', 0, 1, 0.01).name('bending (fold size)');
  fc.add(P, 'holdScale', 0, 1.5, 0.01).name('hold strength');
  fc.add(P, 'headHold', 0, 1, 0.01).name('head hold');
  fc.add(P, 'lockThreshold', 0.5, 1, 0.01).name('lock threshold (1 = none)');
  const fw = fb.addFolder('Wind');
  fw.add(P, 'windStrength', 0, 10, 0.01).name('strength');
  fw.add(P, 'windScale', 1, 60, 0.1).name('ripple size');
  fw.add(P, 'windSpeed', 0, 4, 0.01).name('gust speed');
  fw.add(P, 'windX', -1, 1, 0.01); fw.add(P, 'windY', -1, 1, 0.01); fw.add(P, 'windZ', -1, 1, 0.01);
  addMaterialControls(fb.addFolder('Material'), P, skinKey, applySkinMaterial);

  for (const l of liquids) l.gui(gui, { skin: () => skin, matchCloth: matchClothMaterial, refresh: () => refreshGUI() });

  const fs = gui.addFolder('Scene');
  const fcam = fs.addFolder('Camera');
  fcam.add(P, 'followBody').name('orbit around her').onChange((v) => { if (v) followInit = false; });
  fcam.add(P, 'followSmooth', 0, 3, 0.01).name('smoothing (s)');
  fcam.add(P, 'followVertical', 0, 1, 0.01).name('follow vertical bounce');
  fcam.add(P, 'followHeight', -0.6, 0.8, 0.01).name('pivot height');
  fcam.add({ recenter: () => panOffset.set(0, 0, 0) }, 'recenter').name('recenter (clear pan)');
  const fl = fs.addFolder('Lights');
  fl.add(P, 'master', 0, 4, 0.01).name('★ master brightness');
  fl.add(P, 'ambient', 0, 3, 0.01).name('ambient');
  fl.add(P, 'lightsFollow').name('lights follow her');
  for (const [name, L] of Object.entries(LIGHTS)) {
    const f = fl.addFolder(name === 'key' ? 'Key light' : 'Rim light'), l = lights[name];
    f.addColor(L, 'color').onChange((v) => l.color.set(v));
    f.add(L, 'intensity', 0, 150, 0.1).name('brightness');
    f.add(L, 'x', -4, 4, 0.01); f.add(L, 'y', -1, 3, 0.01); f.add(L, 'z', -4, 4, 0.01);
    f.add(L, 'distance', 0, 10, 0.01).name('range (0 = inf)').onChange((v) => (l.distance = v));
    f.add(L, 'decay', 0, 3, 0.01).onChange((v) => (l.decay = v));
    f.add(L, 'orbit'); f.add(L, 'orbitSpeed', -2, 2, 0.01).name('orbit speed');
  }
  const fe = fs.addFolder('Environment');
  fe.add(P, 'envMap', Object.keys(envMapOptions)).name('env map').onChange(setEnvMap);
  fe.add(P, 'envIntensity', 0, 4, 0.01).name('env intensity');
  fe.add(P, 'envBackground').name('show as background').onChange(applyEnvBackground);
  fe.add(P, 'envBlur', 0, 1, 0.01).name('background blur').onChange(applyEnvBackground);
  fe.add(P, 'bgFov', 10, 170, 0.5).name('background FOV').onChange(applyEnvBackground);
  fe.add(P, 'bgRotation', -180, 180, 0.5).name('background rotation').onChange(applyEnvBackground);
  fe.addColor(P, 'bgColor').name('background colour').onChange(applyEnvBackground);
  fe.add(P, 'bgBrightness', 0, 3, 0.01).name('background brightness').onChange(applyEnvBackground);
  const fey = fs.addFolder('Eyes');
  fey.add(P, 'eyeGloss', 0, 1, 0.01).name('gloss').onChange(applyEyes);
  fey.add(P, 'eyeSmooth', 0, 1, 0.005).name('wetness').onChange(applyEyes);
  fey.add(P, 'eyeRough', 0, 1, 0.01).name('iris roughness').onChange(applyEyes);
  fey.add(P, 'eyeReflect', 0, 5, 0.01).name('reflection').onChange(applyEyes);
  fey.add(P, 'eyeBright', 0.2, 2, 0.01).name('iris brightness').onChange(applyEyes);
  fey.add(P, 'eyeSceneEnv').name('reflect scene env map').onChange(applyEyes);
  const fbl = fs.addFolder('Bloom');
  fbl.add(P, 'bloom').name('enabled').onChange(applyBloom);
  fbl.add(P, 'bloomStrength', 0, 3, 0.01).name('strength').onChange(applyBloom);
  fbl.add(P, 'bloomRadius', 0, 1, 0.01).name('radius').onChange(applyBloom);
  fbl.add(P, 'bloomThreshold', 0, 1, 0.01).name('threshold').onChange(applyBloom);
  fbl.add(P, 'bloomClamp', 1, 50, 0.1).name('highlight clamp').onChange(applyBloom);
  addTooltips(gui);
  gui.close();   // start collapsed
}

// ---------- load everything, then run
new GLTFLoader().load('./clothgyal.glb?v=e4fb0672f0', async (gltf) => {
  document.getElementById('loading').remove();
  const root = gltf.scene;
  scene.add(root);
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.name.startsWith('WEB_Body')) body = o;
    if (o.isMesh) o.frustumCulled = false;
    if (o.isMesh && /high-poly/i.test(o.name)) o.material = makeEyeMaterial(o.material);
  });
  body ||= (() => { let b; root.traverse((o) => { if (!b && o.isSkinnedMesh && o.morphTargetDictionary) b = o; }); return b; })();
  root.traverse((o) => { if (o.isMesh && o !== body) charParts.push(o); });   // eyes, lashes, teeth (hidden with the body)
  body.visible = false;                                                        // the simulated skin is what we see
  bodyMorphDict = body.morphTargetDictionary || {};
  lashes = followEyelids(body, charParts.filter((o) => o.isSkinnedMesh && /eyelash/i.test(o.name)));   // blink with the lids
  hipsBone = body.skeleton.bones.find((b) => /hips/i.test(b.name)) || body.skeleton.bones[0];
  mixer = new THREE.AnimationMixer(root);
  player = new Player({ root, body, mixer, loader: animLoader, P,
    getDanceClip: (name) => new Promise((res, rej) => animLoader.load(danceFiles[name], (g) => res(g.animations[0]), undefined, rej)) });

  FILE_PRESETS = await fetch('./presets.json?v=e4fb0672f0').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const list = await fetch('./anims.json?v=e4fb0672f0').then((r) => r.json());
  for (const d of list) danceFiles[d.name] = d.file;
  danceList = list.map((d) => d.name).sort((a, b) => a.localeCompare(b));
  P.dance = danceList.includes('SingleLadiesTikTokDone') ? 'SingleLadiesTikTokDone' : danceList[0];
  P.preset = STARTUP_PRESET in allPresets() ? STARTUP_PRESET : Object.keys(allPresets())[0] || '';
  buildGUI();
  if (P.preset) applyPreset(P.preset, true); else { buildSkin(); playDance(P.dance); applySkinMaterial(); applyEyes(); applyBloom(); setEnvMap(P.envMap); }
  renderer.setAnimationLoop(tick);
}, (e) => {
  const el = document.getElementById('loading');
  if (el && e.total) el.textContent = `loading clothgyal.glb… ${Math.round(100 * e.loaded / e.total)}%`;
}, (err) => { document.getElementById('loading').textContent = 'failed to load clothgyal.glb: ' + err.message; });

// ---------- frame
const hud = document.getElementById('hud');
const clock = new THREE.Clock(), liqCenter = new THREE.Vector3(), drawSize = new THREE.Vector2();
let fpsT = 0, fpsN = 0, simMs = 0, tickErr = null;
function tick() { try { frame(); } catch (e) { if (!tickErr) { tickErr = e; console.error('frame failed', e); } } }
function frame() {
  const forced = window.__cg?.forceDt;           // test hook: fixed steps even in a background tab
  const dt = forced || Math.min(clock.getDelta(), 1 / 20);
  const t = forced ? (window.__cg.simT = (window.__cg.simT || 0) + forced) : clock.elapsedTime;
  if (P.playing) { updateLooping(); player?.update(dt * P.speed, camera); mixer.update(dt * P.speed); }
  floor.visible = P.playable && P.showFloor; floor.position.set(Math.round(camera.position.x), -0.002, Math.round(camera.position.z));
  applyFace(body, bodyMorphDict, P, t, lashes);
  scene.updateMatrixWorld();
  detectJumps();

  const t0 = performance.now();
  skin.step(dt, t);
  hipsBone.getWorldPosition(liqCenter);
  for (const l of liquids) l.step(dt, liqCenter);
  simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;

  updateFollow(dt);
  updateLights(t);
  controls.update();
  bgSphere.position.copy(camera.position);
  skin.mesh.visible = P.showBody;
  for (const o of charParts) o.visible = P.showBody;
  if (liquids.some((l) => l.enabled)) {
    camera.updateMatrixWorld();
    renderer.getDrawingBufferSize(drawSize);
    for (const l of liquids) l.render(camera, lightList, ambient, drawSize.x, drawSize.y);
  } else for (const l of liquids) l.idle();
  pipeline.render();

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) {
    const liq = liquids.map((l, i) => (l.enabled ? ` · liquid ${i + 1}: ${l.info ?? l.count.toLocaleString()}` : '')).join('');
    hud.textContent = `${Math.round(fpsN / fpsT)} fps · sim dispatch ${simMs.toFixed(1)} ms · ${skin.nU.toLocaleString()} pts${liq}${hudExtra}`;
    fpsN = 0; fpsT = 0;
  }
}

// debug / test hook
window.__cg = {
  P, liquids, renderer, scene, camera, controls, PRESET_KEYS, LIGHTS, step: () => frame(), get player() { return player; }, applyPreset, allPresets, currentAsPreset,
  loadUserPresets, saveUserPresets, get skin() { return skin; }, get gui() { return gui; }, get tickErr() { return tickErr; },
};
