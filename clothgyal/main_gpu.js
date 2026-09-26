import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, vec3, vec4, normalize, positionWorld, cameraPosition, cameraViewMatrix, cameraWorldMatrix,
  equirectUV, pass, max as tslMax, min as tslMin, cos, sin, If, Loop, float, select, abs, cross, log2, sqrt, exp } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as dat from 'dat.gui';
import { FACE_PRESETS, applyFace } from './face.js';
import { GpuSkin } from './gpuskin.js';

if (!navigator.gpu) {
  document.getElementById('loading').innerHTML = 'WebGPU is not available in this browser.<br>Use Chrome / Edge / Safari 26+, or the <a href="./cpu.html" style="color:#7fb">CPU version</a>.';
  throw new Error('no WebGPU');
}

// ---------- renderer / scene
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 50);
camera.position.set(-0.9, 1.5, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.1, 0);
controls.enableDamping = true;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.update();

const ambient = new THREE.AmbientLight(0x3a8c86, 0.25); // faint teal fill so shadows aren't pure black
scene.add(ambient);

// ---------- params (dat.gui)
const P = {
  dance: '', speed: 1.0, playing: true, smoothLoop: true, loopFade: 0.4,
  resolution: 'base',
  stiffness: 350, damping: 9, gravity: 2.0, slack: 0.15, stretch: 0.9, iterations: 6, offset: 0.002, smoothBase: 1.0, bending: 0.3, holdScale: 1.0, headHold: 0.55, lockThreshold: 1.0,
  windStrength: 1.0, windScale: 12, windSpeed: 0.6, windX: 0.6, windY: 0.1, windZ: -0.6,
  simulate: true, showTarget: false,
  face: 'neutral', faceAmount: 1.0, blink: true, talk: false, lookAround: false,
  followBody: true, followSmooth: 0.4, followHeight: 0.15, followVertical: 0.35,
  lightsFollow: true, ambient: 0.25, master: 1.0,
  skinColor: '#cdf7ec', clearcoat: 1.0, roughness: 0.25, metalness: 0.0, sheen: 0.4,
  envMap: 'None', envIntensity: 1.0, envBackground: false, envBlur: 0.0, bgFov: 100, bgRotation: 0, bgColor: '#000000', bgBrightness: 1.0,
  eyeGloss: 1.0, eyeSmooth: 0.97, eyeRough: 0.12, eyeReflect: 1.6, eyeBright: 1.1, eyeSceneEnv: false,
  transmission: 0.0, ior: 1.4, thickness: 0.05, attenuationColor: '#ffffff', attenuationDistance: 0.5, dispersion: 0.0,
  bloom: true, bloomStrength: 0.45, bloomRadius: 0.5, bloomThreshold: 0.72, bloomClamp: 8.0,
  reset: () => skin && skin.reset(),
};
const RES = { 'base (~13k pts)': 0, '2x (~53k pts)': 1, '3x (~210k pts)': 2, '4x (~840k pts)': 3 };
P.resolution = Object.keys(RES)[0];

// ---------- presets (P values + light settings). User-saved presets persist in localStorage.
const PRESET_KEYS = ['dance', 'speed', 'playing', 'smoothLoop', 'loopFade', 'resolution', 'stiffness', 'damping', 'gravity', 'slack', 'stretch', 'iterations',
  'offset', 'smoothBase', 'bending', 'holdScale', 'headHold', 'lockThreshold', 'windStrength', 'windScale', 'windSpeed', 'windX', 'windY', 'windZ', 'simulate', 'face', 'faceAmount', 'blink', 'talk',
  'lookAround', 'followBody', 'followSmooth', 'followHeight', 'followVertical', 'lightsFollow', 'ambient', 'master', 'skinColor',
  'clearcoat', 'roughness', 'metalness', 'sheen', 'envMap', 'envIntensity', 'envBackground', 'envBlur', 'bgFov', 'bgRotation', 'bgColor', 'bgBrightness', 'bloom', 'bloomStrength',
  'bloomRadius', 'bloomThreshold', 'bloomClamp',
  'eyeGloss', 'eyeSmooth', 'eyeRough', 'eyeReflect', 'eyeBright', 'eyeSceneEnv',
  'transmission', 'ior', 'thickness', 'dispersion'];
const BUILTIN_PRESETS = {
  'black hi res': {
    dance: 'Walk+TwerkV2(Baked)', speed: 0.54, playing: true, resolution: '3x (~210k pts)', simulate: true,
    stiffness: 265, damping: 3.5, gravity: 0, slack: 0.195, stretch: 0.97, iterations: 3, offset: 0.002,
    followBody: true, followSmooth: 0, followVertical: 1, followHeight: 0.15,
    bloom: true, bloomStrength: 0.24, bloomRadius: 0.5, bloomThreshold: 0.72, bloomClamp: 8,
    skinColor: '#b6cdfb', roughness: 0.25, metalness: 1, clearcoat: 1, sheen: 0.4,
    envMap: 'None', envIntensity: 1, envBackground: false, envBlur: 0,
  },
  'milky wet (original)': {
    dance: 'SingleLadiesTikTokDone', speed: 1, playing: true, resolution: 'base (~13k pts)', simulate: true,
    stiffness: 350, damping: 9, gravity: 2, slack: 0.15, stretch: 0.9, iterations: 6, offset: 0.002,
    followBody: true, followSmooth: 0.4, followVertical: 0.35, followHeight: 0.15,
    bloom: true, bloomStrength: 0.45, bloomRadius: 0.5, bloomThreshold: 0.72, bloomClamp: 8,
    skinColor: '#cdf7ec', roughness: 0.25, metalness: 0, clearcoat: 1, sheen: 0.4,
    envMap: 'None', envIntensity: 1, envBackground: false, envBlur: 0,
  },
};
function loadUserPresets() { try { return JSON.parse(localStorage.getItem('clothgyal_presets') || '{}'); } catch { return {}; } }
function saveUserPresets(obj) { try { localStorage.setItem('clothgyal_presets', JSON.stringify(obj)); } catch {} }
// presets hard-coded in the project live in web/presets.json (loaded at startup); browser-saved ones override by name
let FILE_PRESETS = {};
function allPresets() { return { ...BUILTIN_PRESETS, ...FILE_PRESETS, ...loadUserPresets() }; }
// baseline for every key, so a preset that omits a setting gets the default, not a leftover value
const DEFAULT_VALUES = Object.fromEntries(PRESET_KEYS.map((k) => [k, P[k]]));
const DEFAULT_PRESET = 'black hi res';
Object.assign(P, BUILTIN_PRESETS[DEFAULT_PRESET]);
P.preset = DEFAULT_PRESET;

// two point lights, positioned relative to her (or the world origin when "lightsFollow" is off)
const LIGHTS = {
  key: { color: '#fff4ea', intensity: 12, x: -1.2, y: 1.3, z: 1.6, distance: 0, decay: 2, orbit: false, orbitSpeed: 0.4 },
  rim: { color: '#9fdcff', intensity: 18, x: 0.4, y: 0.9, z: -1.6, distance: 0, decay: 2, orbit: false, orbitSpeed: -0.3 },
};
const DEFAULT_LIGHTS = JSON.parse(JSON.stringify(LIGHTS));
const lights = {};
for (const [name, L] of Object.entries(LIGHTS)) {
  const l = new THREE.PointLight(L.color, L.intensity, L.distance, L.decay);
  scene.add(l); lights[name] = l;
}

// ---------- post: bloom (TSL). Clamp HDR first so single hot pixels can't bloom into squares.
const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode('output');
const maxLumU = uniform(8.0);
const clamped = Fn(() => {
  const c = tslMax(sceneColor.rgb, vec3(0.0));
  const l = tslMax(tslMax(c.r, c.g), c.b);
  return vec4(c.mul(tslMin(maxLumU.div(tslMax(l, 1e-6)), 1.0)), 1.0);
})();
const bloomN = bloom(clamped, P.bloomStrength, P.bloomRadius, P.bloomThreshold);
const outBloom = sceneColor.add(bloomN), outPlain = sceneColor;
pipeline.outputNode = outBloom;
let bloomOn = true;
function setBloomOutput() {
  if (bloomOn === P.bloom) return;
  bloomOn = P.bloom; pipeline.outputNode = P.bloom ? outBloom : outPlain; pipeline.needsUpdate = true;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const skinMat = new THREE.MeshPhysicalNodeMaterial({
  color: P.skinColor, roughness: P.roughness, metalness: P.metalness, clearcoat: P.clearcoat, clearcoatRoughness: 0.04,
  sheen: P.sheen, sheenColor: new THREE.Color(0xbff6ff), sheenRoughness: 0.4,
});

// ---------- environment maps (equirectangular panoramas)
const ENVMAP_BASE = 'https://fractalfantasy.net/waterball/build/pano/';
const envMapOptions = { None: '' };
for (let i = 3; i <= 132; i++) envMapOptions[`Pano ${i}`] = `${ENVMAP_BASE}pano${i}.jpg`;
const envCache = {};
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');
let envToken = 0;
function setEnvMap(name) {
  const url = envMapOptions[name];
  const token = ++envToken;
  if (!url) { skinMat.envMap = null; scene.environment = null; applyEnvBackground(); applyEyes(); skinMat.needsUpdate = true; return; }
  const apply = (tex) => {
    if (token !== envToken) return;
    skinMat.envMap = tex; skinMat.envMapIntensity = P.envIntensity; skinMat.needsUpdate = true;
    scene.environment = tex;          // eyes / lashes / teeth pick it up too
    scene.environmentIntensity = P.envIntensity;
    applyEnvBackground();
    applyEyes();
  };
  if (envCache[url]) return apply(envCache[url]);
  hudExtra = ` · loading ${name}…`;
  texLoader.load(url, (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    envCache[url] = tex; hudExtra = '';
    apply(tex);
  }, undefined, () => { hudExtra = ` · failed to load ${name}`; });
}
// Background panorama on a camera-centred sphere with its OWN field of view. The view direction is
// taken into camera space, its x/y widened by tan(bgFov/2)/tan(camFov/2), then looked up in the
// equirect map, so more of the panorama fits in frame without changing the subject's size.
const BG = { fovScale: uniform(1), intensity: uniform(1), blur: uniform(0), rot: uniform(0), texH: uniform(1024) };
const bgPlaceholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
bgPlaceholder.needsUpdate = true;
const bgTex = texture(bgPlaceholder);
const bgMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
bgMat.colorNode = Fn(() => {
  const dirW = normalize(positionWorld.sub(cameraPosition));
  const dc = cameraViewMatrix.mul(vec4(dirW, 0.0)).xyz;                   // world -> camera
  const wide = vec3(dc.x.mul(BG.fovScale), dc.y.mul(BG.fovScale), dc.z);  // widen FOV
  const d0 = normalize(cameraWorldMatrix.mul(vec4(wide, 0.0)).xyz);       // camera -> world
  const c = cos(BG.rot), s2 = sin(BG.rot);
  const d = vec3(c.mul(d0.x).sub(s2.mul(d0.z)), d0.y, s2.mul(d0.x).add(c.mul(d0.z)));
  // soft blur: 32 gaussian-weighted taps on a golden-angle spiral cone around the view direction
  const col = vec3(0.0).toVar();
  If(BG.blur.lessThan(0.001), () => {
    col.assign(bgTex.sample(equirectUV(d)).rgb);
  }).Else(() => {
    const N = 32;
    const spread = BG.blur.mul(BG.blur).mul(0.9).add(BG.blur.mul(0.05));
    const up = select(abs(d.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
    const tx = normalize(cross(up, d)), ty = cross(d, tx);
    const lod = tslMax(float(0), log2(spread.mul(BG.texH).div(Math.PI).div(Math.sqrt(N)).mul(1.5)));
    const acc = vec3(0.0).toVar(), wsum = float(0).toVar();
    Loop(N, ({ i }) => {
      const fi = float(i).add(0.5);
      const r = sqrt(fi.div(N));
      const a = fi.mul(2.39996323);
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
function updateBgFov() {
  const k = Math.tan(THREE.MathUtils.degToRad(Math.min(P.bgFov, 179) / 2)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  BG.fovScale.value = k;
}
function applyEnvBackground() {
  const on = P.envBackground && scene.environment;
  bgSphere.visible = !!on;
  if (on) {
    bgTex.value = scene.environment;
    BG.texH.value = scene.environment.image ? scene.environment.image.height : 1024;
    BG.intensity.value = P.envIntensity * P.master * P.bgBrightness;
    BG.blur.value = P.envBlur;
    BG.rot.value = THREE.MathUtils.degToRad(P.bgRotation);
    updateBgFov();
  }
  scene.background = new THREE.Color(P.bgColor).multiplyScalar(P.bgBrightness);
}

// ---------- glossy eyes: own studio reflection map so they get catchlights even on a black background
const pmrem = new THREE.PMREMGenerator(renderer);
const eyeStudioEnv = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
const eyeMats = [];
function makeEyeMaterial(src) {
  const m = new THREE.MeshPhysicalMaterial({
    map: src.map || null, color: new THREE.Color(1, 1, 1),
    transparent: false, alphaTest: 0.5, side: THREE.FrontSide,
    roughness: P.eyeRough, metalness: 0, clearcoat: P.eyeGloss, clearcoatRoughness: 1 - P.eyeSmooth,
    ior: 1.376, specularIntensity: 1, envMap: eyeStudioEnv, envMapIntensity: P.eyeReflect,
  });
  eyeMats.push(m);
  return m;
}
function applyEyes() {
  for (const m of eyeMats) {
    m.clearcoat = P.eyeGloss; m.clearcoatRoughness = 1 - P.eyeSmooth; m.roughness = P.eyeRough;
    m.envMapIntensity = P.eyeReflect; m.color.setScalar(P.eyeBright);
    const env = P.eyeSceneEnv && scene.environment ? scene.environment : eyeStudioEnv;
    if (m.envMap !== env) { m.envMap = env; m.needsUpdate = true; }
  }
}

let mixer, actions = {}, current, body, skin, bodyMorphDict, hipsBone;
const followPos = new THREE.Vector3(), followDelta = new THREE.Vector3(), anchor = new THREE.Vector3();
let followInit = false, restHipY = null;
const follow1 = new THREE.Vector3(), followBase = new THREE.Vector3(), panOffset = new THREE.Vector3();
let lastTarget = null;

// keep the orbit pivot on her: move target + camera together so the user's angle/zoom is preserved
function updateFollow(dt) {
  if (!P.followBody || !hipsBone) { lastTarget = null; return; }
  hipsBone.getWorldPosition(followPos);
  // vertical: follow only part of the bounce around her rest hip height, so twerks don't shake the camera
  if (restHipY === null) restHipY = followPos.y;
  followPos.y = restHipY + (followPos.y - restHipY) * P.followVertical + P.followHeight;
  if (!followInit) {
    follow1.copy(followPos); followBase.copy(followPos); panOffset.set(0, 0, 0);
    followDelta.subVectors(followPos, controls.target); camera.position.add(followDelta);
    controls.target.copy(followPos); lastTarget = controls.target.clone(); followInit = true; return;
  }
  // whatever moved the target since last frame (right-drag pan, damping) is the user's pan: keep it
  if (lastTarget) panOffset.add(followDelta.subVectors(controls.target, lastTarget));
  // two-stage exponential smoothing, frame-rate independent; P.followSmooth = time constant in seconds
  const a = P.followSmooth <= 0 ? 1 : 1 - Math.exp(-dt / (P.followSmooth * 0.5));
  follow1.lerp(followPos, a);
  followBase.lerp(follow1, a);
  followDelta.copy(followBase).add(panOffset).sub(controls.target);
  controls.target.add(followDelta);
  camera.position.add(followDelta);
  lastTarget = lastTarget || new THREE.Vector3();
  lastTarget.copy(controls.target);
}

function updateLights(t) {
  anchor.set(0, 0, 0);
  if (P.lightsFollow && hipsBone) { hipsBone.getWorldPosition(anchor); anchor.y = 0; }
  for (const [name, L] of Object.entries(LIGHTS)) {
    const l = lights[name];
    let x = L.x, z = L.z;
    if (L.orbit) { const a = t * L.orbitSpeed, r = Math.hypot(L.x, L.z), a0 = Math.atan2(L.z, L.x); x = Math.cos(a0 + a) * r; z = Math.sin(a0 + a) * r; }
    l.position.set(anchor.x + x, anchor.y + L.y + 1.0, anchor.z + z);  // y is relative to ~hip height
    l.intensity = L.intensity * P.master;
  }
  ambient.intensity = P.ambient * P.master;
  const env = P.envIntensity * P.master;
  skinMat.envMapIntensity = env; scene.environmentIntensity = env;
  BG.intensity.value = env * P.bgBrightness;
}

function buildSkin() {
  const level = RES[P.resolution] ?? 0;
  if (skin) { scene.remove(skin.mesh); skin.dispose(); }
  skin = new GpuSkin(renderer, body, skinMat, P, level);
  skinMat.needsUpdate = true;
  scene.add(skin.mesh);
  hudExtra = ` · built ${skin.nU.toLocaleString()} pts in ${Math.round(skin.buildMs)} ms`;
}

const clock = new THREE.Clock();

new GLTFLoader().load('./clothgyal.glb', (gltf) => {
  document.getElementById('loading').remove();
  const root = gltf.scene;
  scene.add(root);
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.name.startsWith('WEB_Body')) body = o;
    if (o.isMesh) o.frustumCulled = false;
    if (o.name === 'CatBody') o.visible = false;
    if (o.isMesh && /high-poly/i.test(o.name)) o.material = makeEyeMaterial(o.material);
  });
  if (!body) root.traverse((o) => { if (!body && o.isSkinnedMesh && o.morphTargetDictionary) body = o; });

  bodyMorphDict = body.morphTargetDictionary || {};
  hipsBone = body.skeleton.bones.find((b) => /hips/i.test(b.name)) || body.skeleton.bones[0];
  buildSkin();
  body.visible = false; // the simulated copy is what we see

  mixer = new THREE.AnimationMixer(root);
  fetch('./presets.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((pr) => { FILE_PRESETS = pr || {}; })
  .then(() => fetch('./anims.json')).then((r) => r.json()).then((list) => {
    for (const d of list) danceFiles[d.name] = d.file;
    const names = list.map((d) => d.name).sort((a, b) => a.localeCompare(b));
    if (!names.includes(P.dance)) P.dance = names.includes('SingleLadiesTikTokDone') ? 'SingleLadiesTikTokDone' : names[0];
    danceList = names;
    buildGUI(names);
    gui.close();   // start with the controls collapsed
    applyPreset(P.preset, true);
    playDance(P.dance);
    renderer.setAnimationLoop(tick);
  });
}, (e) => {
  const el = document.getElementById('loading');
  if (el && e.total) el.textContent = `loading clothgyal.glb… ${Math.round(100 * e.loaded / e.total)}%`;
}, (err) => { document.getElementById('loading').textContent = 'failed to load clothgyal.glb: ' + err.message; });

// each dance lives in its own small GLB (web/anims/*.glb) and is fetched the first time it's picked
const danceFiles = {};
const animLoader = new GLTFLoader();
let loadToken = 0, hudExtra = '';
// Each dance gets two actions (clip + clone) so a loop can crossfade into a fresh copy of itself
// instead of snapping from the last pose back to the first.
function playDance(name) {
  const token = ++loadToken;
  const start = (pair) => {
    if (token !== loadToken) return;              // user picked another dance meanwhile
    if (current && !pair.includes(current)) current.fadeOut(0.3);
    const a = pair[0];
    a.reset().fadeIn(0.3).play();
    current = a; currentPair = pair;
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
let currentPair = null, lastActionTime = 0, carryFramesLeft = 0;
const lastHips = new THREE.Vector3(), hipsNow = new THREE.Vector3();

// before the mixer steps: set loop mode and hand over to the twin action near the end
function updateLooping() {
  if (!current || !currentPair) return;
  const dur = current.getClip().duration;
  for (const a of currentPair) {
    a.setLoop(P.smoothLoop ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = P.smoothLoop;
  }
  if (!P.smoothLoop) return;
  const fade = Math.min(P.loopFade, dur * 0.4);
  if (current.time >= dur - fade && current.isRunning()) {
    const next = currentPair[0] === current ? currentPair[1] : currentPair[0];
    next.reset().setEffectiveWeight(1).play();
    current.crossFadeTo(next, fade, false);
    current = next;
    // the blend can slide the body back fast (root motion): let the skin ride along during it
    carryFramesLeft = Math.ceil(fade / (1 / 60)) + 2;
  }
}
// after the mixer steps: detect hard jumps (loop wrap, big hips jump) and let the skin ride along
function detectJumps() {
  if (!current || !hipsBone || !skin) return;
  if (current.time < lastActionTime - 1e-3) skin.carryNext = true;    // wrapped around
  if (carryFramesLeft > 0) { carryFramesLeft--; skin.carryNext = true; }
  lastActionTime = current.time;
  hipsBone.getWorldPosition(hipsNow);
  if (hipsNow.distanceTo(lastHips) > 0.25) skin.carryNext = true;     // teleported
  lastHips.copy(hipsNow);
}

let gui, danceList = [], presetCtrl;

// apply every P/light value from a preset and push side effects (material, bloom, env, skin res, dance)
function applyPreset(name, initial = false) {
  const pr = allPresets()[name]; if (!pr) return;
  const prevRes = P.resolution, prevDance = P.dance;
  for (const k of PRESET_KEYS) P[k] = k in pr ? pr[k] : DEFAULT_VALUES[k];
  for (const n in LIGHTS) Object.assign(LIGHTS[n], DEFAULT_LIGHTS[n], (pr.lights && pr.lights[n]) || {});
  for (const [n, L] of Object.entries(LIGHTS)) { lights[n].color.set(L.color); lights[n].distance = L.distance; lights[n].decay = L.decay; }
  skinMat.color.set(P.skinColor); skinMat.roughness = P.roughness; skinMat.metalness = P.metalness;
  skinMat.clearcoat = P.clearcoat; skinMat.sheen = P.sheen;
  applyRefraction();
  applyEyes();
  bloomN.strength.value = P.bloomStrength; bloomN.radius.value = P.bloomRadius; bloomN.threshold.value = P.bloomThreshold;
  maxLumU.value = P.bloomClamp; setBloomOutput();
  setEnvMap(P.envMap);
  if (initial || P.resolution !== prevRes) buildSkin();
  if (!danceList.includes(P.dance)) P.dance = prevDance;
  if (initial || P.dance !== prevDance) playDance(P.dance);
  followInit = false; restHipY = null;
  if (skin) skin.reset();
  refreshGUI();
}
function applyRefraction() {
  skinMat.transmission = P.transmission; skinMat.ior = P.ior; skinMat.thickness = P.thickness;
  skinMat.attenuationColor.set(0xffffff);
  skinMat.attenuationDistance = Infinity;
  skinMat.dispersion = P.dispersion;
}
function refreshGUI(g = gui) {
  if (!g) return;
  for (const c of g.__controllers) c.updateDisplay();
  for (const f of Object.values(g.__folders)) refreshGUI(f);
}
function currentAsPreset() {
  const o = {}; for (const k of PRESET_KEYS) o[k] = P[k];
  o.lights = JSON.parse(JSON.stringify(LIGHTS));
  return o;
}

// ---------- project files: every setting + lights + camera, plus a backup of saved presets
function projectData() {
  return {
    format: 'clothgyal-project', version: 1, savedAt: new Date().toISOString(),
    name: P.preset, settings: currentAsPreset(),
    camera: { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov },
    presets: loadUserPresets(),
  };
}
function saveProject() {
  const name = (prompt('Project name:', P.preset || 'clothgyal project') || '').trim();
  if (!name) return;
  const data = projectData(); data.name = name;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[^\w\- ]+/g, '_') + '.clothgyal.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function loadProject() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0]; if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { return alert('Not a valid JSON file.'); }
    const settings = data.settings || data;                 // also accepts a bare "copy settings JSON" dump
    const name = data.name || file.name.replace(/(\.clothgyal)?\.json$/i, '');
    const u = loadUserPresets();
    if (data.presets) Object.assign(u, data.presets);        // restore any presets bundled in the project
    u[name] = settings; saveUserPresets(u);
    P.preset = name;
    presetCtrl = presetCtrl.options(Object.keys(allPresets())).name('preset').onChange((x) => applyPreset(x));
    applyPreset(name);
    if (data.camera) {
      camera.position.fromArray(data.camera.position); controls.target.fromArray(data.camera.target);
      if (data.camera.fov) { camera.fov = data.camera.fov; camera.updateProjectionMatrix(); }
      panOffset.set(0, 0, 0); lastTarget = null; followInit = false;
      controls.update();
    }
    hudExtra = ` · loaded project "${name}"`;
  };
  input.click();
}

// ---------- presets hard-coded into the project (web/presets.json) via the local dev server
function refreshPresetList() {
  presetCtrl = presetCtrl.options(Object.keys(allPresets())).name('preset').onChange((x) => applyPreset(x));
  refreshGUI();
}
// write one preset into web/presets.json via the local dev server; false if there's no server (e.g. GitHub Pages)
async function writePreset(name, settings) {
  try {
    const res = await fetch('./api/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, settings }) });
    if (!res.ok) throw new Error(res.status);
    FILE_PRESETS[name] = settings;
    const u = loadUserPresets(); if (name in u) { delete u[name]; saveUserPresets(u); }   // project copy is now the source
    return true;
  } catch (e) {
    const u = loadUserPresets(); u[name] = settings; saveUserPresets(u);                 // keep it in this browser instead
    return false;
  }
}
function noServerNotice() {
  if (confirm('Saved in this browser. No local project server is running (e.g. on GitHub Pages), so it can\'t be written into the project.\n\nDownload an updated presets.json to add to the project?')) downloadPresetsJson();
}
async function savePreset(nameArg) {
  const name = (nameArg || P.preset || '').trim(); if (!name) return;
  const ok = await writePreset(name, currentAsPreset());
  P.preset = name; refreshPresetList();
  hudExtra = ok ? ` · saved "${name}"` : ` · saved "${name}" (browser only)`;
  if (!ok) noServerNotice();
}
async function savePresetAs() {
  const name = (prompt('New preset name:', '') || '').trim();
  if (!name) return;
  if (name in allPresets() && !confirm(`"${name}" already exists. Overwrite it?`)) return;
  await savePreset(name);
}
async function saveAllPresetsToProject() {
  const all = { ...FILE_PRESETS, ...loadUserPresets() };
  let ok = true;
  for (const [name, settings] of Object.entries(all)) ok = (await writePreset(name, settings)) && ok;
  refreshPresetList();
  if (ok) hudExtra = ` · saved ${Object.keys(all).length} presets to web/presets.json`; else noServerNotice();
}
function downloadPresetsJson() {
  const all = { ...FILE_PRESETS, ...loadUserPresets() };
  const blob = new Blob([JSON.stringify(all, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'presets.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function buildGUI(danceNames) {
  gui = new dat.GUI({ width: 310 });
  const fp = gui.addFolder('Presets');
  presetCtrl = fp.add(P, 'preset', Object.keys(allPresets())).name('preset').onChange((n) => applyPreset(n));
  const actionsP = {
    save: () => {
      const n = prompt('Save current settings as preset:', P.preset);
      if (!n) return;
      const u = loadUserPresets(); u[n] = currentAsPreset(); saveUserPresets(u);
      P.preset = n; presetCtrl = presetCtrl.options(Object.keys(allPresets())).name('preset').onChange((x) => applyPreset(x));
      refreshGUI();
    },
    copy: () => { navigator.clipboard?.writeText(JSON.stringify(currentAsPreset(), null, 1)); },
    del: () => {
      const u = loadUserPresets(), name = P.preset;
      if (name in BUILTIN_PRESETS && !(name in u) && !(name in FILE_PRESETS)) return alert('Built-in presets can\'t be deleted.');
      if (!confirm(`Delete preset "${name}"?`)) return;
      if (name in FILE_PRESETS) {
        fetch('./api/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, delete: true }) })
          .then((r) => { if (!r.ok) throw 0; delete FILE_PRESETS[name]; refreshPresetList(); })
          .catch(() => alert('Can\'t remove it from web/presets.json without the local project server.'));
      }
      delete u[name]; saveUserPresets(u); P.preset = DEFAULT_PRESET;
      presetCtrl = presetCtrl.options(Object.keys(allPresets())).name('preset').onChange((x) => applyPreset(x));
      applyPreset(P.preset);
    },
  };
  fp.add({ savePreset: () => savePreset() }, 'savePreset').name('💾 save preset (overwrite current)');
  fp.add({ savePresetAs }, 'savePresetAs').name('save preset as…');
  fp.add({ saveAllPresetsToProject }, 'saveAllPresetsToProject').name('save all presets to project');
  fp.add(actionsP, 'copy').name('copy settings JSON');
  fp.add(actionsP, 'del').name('delete this preset');
  fp.add({ saveProject }, 'saveProject').name('export project (.json)');
  fp.add({ loadProject }, 'loadProject').name('import project (.json)');
  fp.add({ downloadPresetsJson }, 'downloadPresetsJson').name('⬇ download presets.json');
  fp.open();

  const fa = gui.addFolder('Animation');
  fa.add(P, 'dance', danceNames).name('dance').onChange(playDance);
  fa.add(P, 'speed', 0, 2, 0.01);
  fa.add(P, 'playing');
  fa.add(P, 'smoothLoop').name('smooth loop (crossfade)');
  fa.add(P, 'loopFade', 0.05, 2, 0.01).name('loop crossfade (s)');
  fa.open();

  const fs = gui.addFolder('Skin (spring cloth)');
  fs.add(P, 'resolution', Object.keys(RES)).name('mesh resolution').onChange(buildSkin);
  fs.add(P, 'simulate');
  fs.add(P, 'stiffness', 20, 1500, 1);
  fs.add(P, 'damping', 0, 40, 0.1);
  fs.add(P, 'gravity', -20, 20, 0.05).name('gravity (sag cm, − = float up)');
  fs.add(P, 'slack', 0, 0.6, 0.005).name('slack (folds)');
  fs.add(P, 'stretch', 0, 1, 0.01);
  fs.add(P, 'iterations', 0, 16, 1);
  const offsetCm = { get cm() { return P.offset * 100; }, set cm(v) { P.offset = v / 100; } };  // stored in metres, shown in cm
  fs.add(offsetCm, 'cm', 0, 10, 0.01).name('offset (cm)');
  fs.add(P, 'smoothBase', 0, 3, 0.01).name('smooth base (no facets)');
  fs.add(P, 'bending', 0, 1, 0.01).name('bending (fold size)');
  fs.add(P, 'holdScale', 0, 1.5, 0.01).name('hold strength (all)');
  fs.add(P, 'headHold', 0, 1, 0.01).name('head hold (skull)');
  fs.add(P, 'lockThreshold', 0.5, 1, 0.01).name('lock threshold (1 = none)');
  const fw = fs.addFolder('Wind');
  fw.add(P, 'windStrength', 0, 10, 0.01).name('strength');
  fw.add(P, 'windScale', 1, 60, 0.1).name('ripple size');
  fw.add(P, 'windSpeed', 0, 4, 0.01).name('gust speed');
  fw.add(P, 'windX', -1, 1, 0.01); fw.add(P, 'windY', -1, 1, 0.01); fw.add(P, 'windZ', -1, 1, 0.01);
  fs.add(P, 'reset').name('reset skin');
  fs.open();

  const ff = gui.addFolder('Face');
  ff.add(P, 'face', Object.keys(FACE_PRESETS)).name('expression');
  ff.add(P, 'faceAmount', 0, 1.5, 0.01).name('amount');
  ff.add(P, 'blink');
  ff.add(P, 'talk').name('talk loop');
  ff.add(P, 'lookAround').name('look around');

  const fc = gui.addFolder('Camera');
  fc.add(P, 'followBody').name('orbit around her').onChange((v) => { if (v) followInit = false; });
  fc.add(P, 'followSmooth', 0, 3, 0.01).name('smoothing (s)');
  fc.add(P, 'followVertical', 0, 1, 0.01).name('follow vertical bounce');
  fc.add(P, 'followHeight', -0.6, 0.8, 0.01).name('pivot height');
  fc.add({ recenter: () => { panOffset.set(0, 0, 0); } }, 'recenter').name('recenter on her (clear pan)');

  const fL = gui.addFolder('Lights');
  fL.add(P, 'master', 0, 4, 0.01).name('★ master brightness');
  fL.add(LIGHTS.key, 'intensity', 0, 150, 0.1).name('key brightness').listen();
  fL.add(LIGHTS.rim, 'intensity', 0, 150, 0.1).name('rim brightness').listen();
  fL.add(P, 'ambient', 0, 3, 0.01).name('ambient brightness').listen();
  fL.add(P, 'envIntensity', 0, 4, 0.01).name('env map brightness').listen();
  fL.add(P, 'lightsFollow').name('lights follow her');
  fL.open();
  for (const [name, L] of Object.entries(LIGHTS)) {
    const f = fL.addFolder(name === 'key' ? 'Key light (front)' : 'Rim light (behind)');
    const l = lights[name];
    f.addColor(L, 'color').onChange((v) => l.color.set(v));
    f.add(L, 'intensity', 0, 150, 0.1).name('brightness').listen();
    f.add(L, 'x', -4, 4, 0.01); f.add(L, 'y', -1, 3, 0.01); f.add(L, 'z', -4, 4, 0.01);
    f.add(L, 'distance', 0, 10, 0.01).name('range (0 = inf)').onChange((v) => (l.distance = v));
    f.add(L, 'decay', 0, 3, 0.01).onChange((v) => (l.decay = v));
    f.add(L, 'orbit'); f.add(L, 'orbitSpeed', -2, 2, 0.01).name('orbit speed');
    f.open();
  }

  const fe = gui.addFolder('Eyes');
  fe.add(P, 'eyeGloss', 0, 1, 0.01).name('gloss (clearcoat)').onChange(applyEyes);
  fe.add(P, 'eyeSmooth', 0, 1, 0.005).name('wetness (smoothness)').onChange(applyEyes);
  fe.add(P, 'eyeRough', 0, 1, 0.01).name('iris roughness').onChange(applyEyes);
  fe.add(P, 'eyeReflect', 0, 5, 0.01).name('reflection strength').onChange(applyEyes);
  fe.add(P, 'eyeBright', 0.2, 2, 0.01).name('iris brightness').onChange(applyEyes);
  fe.add(P, 'eyeSceneEnv').name('reflect scene env map').onChange(applyEyes);
  fe.open();

  const fb = gui.addFolder('Bloom');
  fb.add(P, 'bloom').name('enabled').onChange(setBloomOutput);
  fb.add(P, 'bloomStrength', 0, 3, 0.01).name('strength').onChange((v) => (bloomN.strength.value = v));
  fb.add(P, 'bloomRadius', 0, 1, 0.01).name('radius').onChange((v) => (bloomN.radius.value = v));
  fb.add(P, 'bloomThreshold', 0, 1, 0.01).name('threshold').onChange((v) => (bloomN.threshold.value = v));
  fb.add(P, 'bloomClamp', 1, 50, 0.1).name('highlight clamp').onChange((v) => (maxLumU.value = v));

  const fl = gui.addFolder('Skin material');
  fl.addColor(P, 'skinColor').name('color').onChange((v) => skinMat.color.set(v));
  fl.add(P, 'roughness', 0, 1, 0.01).onChange((v) => (skinMat.roughness = v));
  fl.add(P, 'metalness', 0, 1, 0.01).name('metallic').onChange((v) => (skinMat.metalness = v));
  fl.add(P, 'clearcoat', 0, 1, 0.01).onChange((v) => (skinMat.clearcoat = v));
  fl.add(P, 'sheen', 0, 1, 0.01).onChange((v) => (skinMat.sheen = v));
  fl.add(P, 'envMap', Object.keys(envMapOptions)).name('env map').onChange(setEnvMap);
  fl.add(P, 'envIntensity', 0, 4, 0.01).name('env intensity').onChange((v) => {
    skinMat.envMapIntensity = v; scene.environmentIntensity = v; applyEnvBackground();
  });
  fl.add(P, 'envBackground').name('show as background').onChange(applyEnvBackground);
  fl.add(P, 'envBlur', 0, 1, 0.01).name('background blur').onChange(applyEnvBackground);
  fl.add(P, 'bgFov', 10, 170, 0.5).name('background FOV').onChange(applyEnvBackground);
  fl.add(P, 'bgRotation', -180, 180, 0.5).name('background rotation').onChange(applyEnvBackground);
  fl.addColor(P, 'bgColor').name('background color').onChange(applyEnvBackground);
  fl.add(P, 'bgBrightness', 0, 3, 0.01).name('background brightness').onChange(applyEnvBackground);
  fl.add(P, 'transmission', 0, 1, 0.01).name('refraction: transmission').onChange(applyRefraction);
  fl.add(P, 'ior', 1, 2.333, 0.001).name('refraction: IOR').onChange(applyRefraction);
  fl.add(P, 'thickness', 0, 0.5, 0.001).name('refraction: thickness (m)').onChange(applyRefraction);
  fl.add(P, 'dispersion', 0, 10, 0.01).name('refraction: dispersion').onChange(applyRefraction);
  fl.open();
}

const hud = document.getElementById('hud');
window.__cg = { get skin() { return skin; }, get body() { return body; }, renderer, scene, camera, P, get tickErr() { return tickErr; }, applyEnvBackground: () => applyEnvBackground(), step: () => tickInner(), get current() { return current; }, get gui() { return gui; }, PRESET_KEYS, LIGHTS, currentAsPreset: () => currentAsPreset(), applyPreset: (n) => applyPreset(n), allPresets: () => allPresets(), saveUserPresets: (o) => saveUserPresets(o), loadUserPresets: () => loadUserPresets(), bgSphere, setEnvMap: (n) => setEnvMap(n) };
let fpsT = 0, fpsN = 0, simMs = 0;

let tickErr = null;
function tick() { try { tickInner(); } catch (e) { if (!tickErr) { tickErr = e; console.error('tick failed', e); } } }
function tickInner() {
  const forced = window.__cg && window.__cg.forceDt;
  const dt = forced || Math.min(clock.getDelta(), 1 / 20);
  const t = forced ? (window.__cg.simT = (window.__cg.simT || 0) + forced) : clock.elapsedTime;
  if (P.playing) { updateLooping(); mixer.update(dt * P.speed); }
  applyFace(body, bodyMorphDict, P, t);
  scene.updateMatrixWorld();
  detectJumps();

  const t0 = performance.now();
  skin.step(dt, t);
  simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;

  updateFollow(dt);
  updateLights(t);
  controls.update();
  bgSphere.position.copy(camera.position);
  pipeline.render();

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) { hud.textContent = `${Math.round(fpsN / fpsT)} fps · GPU sim dispatch ${simMs.toFixed(1)} ms · ${skin.nU.toLocaleString()} pts${hudExtra}`; fpsN = 0; fpsT = 0; }
}
