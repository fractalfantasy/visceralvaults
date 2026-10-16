// visceralvaults.com/cd: the catalogue as CDs.
//
// A white studio (three's RoomEnvironment: a room with softbox lamps) lights everything. The jewel case is clear
// polystyrene (a transmissive physical material, so the disc and the page bend through its edges). The disc is a
// shader of its own: the cover printed on its label in inks thin enough to let the silver through, and the tracks
// underneath, a grating 1.6 microns a turn, which split each lamp into a rainbow spoke through the middle. The
// frame is drawn to a high-range buffer first, so the brightest glints can throw small star flares before it's
// brought down to the screen.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const $ = (id) => document.getElementById(id);
const PAGE = 0xf6 / 255; // the page's grey (#f6f6f4, near enough)

// ---------------------------------------------------------------- the releases
const releases = await fetch('../data/releases.json').then(r => r.json());

// ---------------------------------------------------------------- renderer, camera, studio
const canvas = document.createElement('canvas');
document.body.prepend(canvas);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  $('fail').style.display = 'grid';
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.NoToneMapping; // the final pass does its own (see composite)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

const scene = new THREE.Scene();
// the page colour, chosen so that after the final pass's shoulder it lands exactly on the CSS grey
const shoulderInverse = (y) => (y <= 0.86 ? y : 0.86 - 0.14 * Math.log(1 - (y - 0.86) / 0.14));
const pageLinear = shoulderInverse(Math.pow((PAGE + 0.055) / 1.055, 2.4));
scene.background = new THREE.Color().setRGB(pageLinear, pageLinear, pageLinear * 0.995, THREE.LinearSRGBColorSpace);

const camera = new THREE.PerspectiveCamera(26, 1, 20, 4000);
camera.position.set(0, 520, 360);
camera.lookAt(0, 0, 8);

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.03).texture;
scene.environmentIntensity = 1.0;

// the same room as a plain cube map with mips, for the disc's own shader to look things up in
const roomCube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
const cubeCamera = new THREE.CubeCamera(0.1, 100, roomCube);
cubeCamera.position.set(0, 1.5, 0);
cubeCamera.update(renderer, room);

// the lamps of that room, as directions from the middle (for the disc's rainbows) and how bright each is
const LAMPS = [
  [-16.116, 14.37, 8.208, 50], [-16.109, 18.021, -8.207, 50], [14.904, 12.198, -1.832, 17],
  [-0.462, 8.89, 14.52, 43], [3.235, 11.486, -12.541, 20],
].map(([x, y, z, p]) => ({ dir: new THREE.Vector3(x, y - 1.5, z).normalize(), power: p / 50 }));

// a key light for the shadow on the table (the room does the rest of the lighting)
const sun = new THREE.DirectionalLight(0xffffff, 0.6);
sun.position.set(-210, 430, -170);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 1200 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.radius = 14;
sun.shadow.blurSamples = 20;
sun.shadow.bias = -0.0005;
scene.add(sun);

const table = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.ShadowMaterial({ opacity: 0.16 }));
table.rotation.x = -Math.PI / 2;
table.receiveShadow = true;
scene.add(table);

// ---------------------------------------------------------------- the jewel case (millimetres)
const W = 142, H = 138, R = 5;       // outside of the case
const DISC = 60, HOLE = 7.5;         // a CD: 120 mm across, a 15 mm hole

function roundRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function circle(r, segments = 96) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}
// a flat shape pulled up from z0 by depth, its edges softly rounded (that's where the glints live)
function slab(shape, depth, z0, bevel = 0.35) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 24 });
  g.translate(0, 0, z0 + bevel);
  return g;
}
function ring(inner, outer, depth, z0, bevel = 0.25) {
  const s = circle(outer);
  s.holes.push(circle(inner));
  return slab(s, depth, z0, bevel);
}

// Clear polystyrene, two ways. A sheet (the lid's face, the tray's floor) is nearly invisible face on and turns
// into a mirror of the room toward its edges. A rod (the walls, rails, lips, hinge, the rosette) is thick enough
// that light goes in, bounces off its far side and comes back out somewhere else in the room: that's what draws
// the dark and bright bands along a jewel case's edges, so a rod shows the room both reflected and bent through.
const plasticUniforms = {
  uRoom: { value: roomCube.texture },
  uGain: { value: 0.55 },    // the room's brightness, against the page
  uIor: { value: 1.59 },
};
function plasticMaterial(rod) {
  return new THREE.ShaderMaterial({
    uniforms: { ...plasticUniforms, uRod: { value: rod ? 1 : 0 } },
    transparent: true,
    depthWrite: rod,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform samplerCube uRoom;
      uniform float uGain;
      uniform float uIor;
      uniform float uRod;
      varying vec3 vWorld;
      varying vec3 vN;
      vec3 room(vec3 d, float lod) { return textureLod(uRoom, d, lod).rgb * uGain; }
      float schlick(float c, float f0) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        if (dot(N, V) < 0.0) N = -N;
        float c = clamp(dot(N, V), 0.0, 1.0);
        float f0 = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
        float F = schlick(c, f0);
        vec3 R = reflect(-V, N);
        vec3 mirrored = room(R, 0.1);
        if (uRod < 0.5) {
          // both faces of a thin sheet reflect; face on it takes almost nothing, at a slant it's a mirror
          float both = 2.0 * F / (1.0 + F);
          float edge = max(both - 2.0 * f0 / (1.0 + f0), 0.0);
          gl_FragColor = vec4(mirrored, clamp(edge + 0.03, 0.0, 1.0));
          return;
        }
        // into the rod, off its far side, and back out: the way out bends again, so it lands elsewhere in the room
        vec3 inside = refract(-V, N, 1.0 / uIor);
        vec3 bounced = reflect(inside, normalize(N * 0.6 + R * 0.4));
        vec3 out1 = refract(bounced, -N, uIor);
        if (dot(out1, out1) < 0.01) out1 = reflect(bounced, -N); // trapped: it bounces again
        vec3 through = room(out1, 0.25) * vec3(0.93, 0.96, 1.0);
        gl_FragColor = vec4(mix(through, mirrored, F), 0.7 + 0.3 * F);
      }`,
  });
}
const plastic = plasticMaterial(true);
const sheet = plasticMaterial(false);

const caseRoot = new THREE.Group();   // dragged and turned
const content = new THREE.Group();    // slides over as the lid opens, so the open pair stays centred
const flat = new THREE.Group();       // the case is built in x, y with its face along +z: this lays it on the table
flat.rotation.x = -Math.PI / 2;
caseRoot.add(content);
content.add(flat);
scene.add(caseRoot);

const parts = []; // what a tap can hit
function part(geometry, material, shadow = false) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = shadow;
  parts.push(m);
  return m;
}

// the tray: floor, walls, the rails inside the walls, the rosette that holds the disc
const tray = new THREE.Group();
flat.add(tray);
tray.add(part(slab(roundRect(W, H, R), 1.1, -5), sheet));
{
  const wall = roundRect(W, H, R);
  wall.holes.push(roundRect(W - 3, H - 3, R - 1.5));
  tray.add(part(slab(wall, 6, -5, 0.4), plastic, true));
  for (const y of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(W - 22, 1.2, 3.2), plastic);
    rail.position.set(4, y * (H / 2 - 7.5), -2.3);
    rail.castShadow = true;
    tray.add(rail);
  }
  tray.add(part(ring(16.2, 18.6, 3.0, -3.9), plastic, true));
  tray.add(part(ring(HOLE, 9.6, 3.6, -3.9), plastic));
  const tooth = new THREE.BoxGeometry(2.6, 2.2, 3.4);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const t = new THREE.Mesh(tooth, plastic);
    t.position.set(Math.cos(a) * 11.6, Math.sin(a) * 11.6, -1.9);
    t.rotation.z = a;
    tray.add(t);
  }
  // the spine's hinge pins, at the tray's left corners
  const pin = new THREE.CylinderGeometry(1.8, 1.8, 9, 24);
  for (const y of [-1, 1]) {
    const p = new THREE.Mesh(pin, plastic);
    p.position.set(-W / 2 + 0.6, y * (H / 2 - 5.5), 1.5);
    tray.add(p);
  }
}

// the disc: label and data faces (one shader), a polished edge, a clear hub
const discUniforms = {
  uArt: { value: null },
  uRoom: { value: roomCube.texture },
  uFace: { value: 1 },
  uLampDir: { value: LAMPS.map(l => l.dir) },
  uLampPower: { value: LAMPS.map(l => l.power) },
  uLight: { value: 0.32 },   // how much of the room's light falls on the print
  uMirror: { value: 0.9 },  // how bright the room looks in the silver
  uRainbow: { value: 2.0 },  // the tracks' colours
};
const discShader = {
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    varying vec3 vN;
    varying vec3 vRad;
    varying vec3 vTan;
    varying vec2 vLocal;
    void main() {
      vLocal = position.xy;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      mat3 m = mat3(modelMatrix);
      vN = normalize(m * normal);
      vec2 rd = normalize(position.xy + vec2(1e-6, 0.0));
      vRad = normalize(m * vec3(rd, 0.0));
      vTan = normalize(m * vec3(-rd.y, rd.x, 0.0));
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uArt;
    uniform samplerCube uRoom;
    uniform float uFace;
    uniform vec3 uLampDir[5];
    uniform float uLampPower[5];
    uniform float uLight;
    uniform float uMirror;
    uniform float uRainbow;
    varying vec3 vWorld;
    varying vec3 vN;
    varying vec3 vRad;
    varying vec3 vTan;
    varying vec2 vLocal;

    vec3 room(vec3 d, float lod) { return textureLod(uRoom, d, lod).rgb; }

    // a wavelength (nm) as a colour, from three overlapping bells (red with a violet tail, green, blue)
    vec3 hue(float nm) {
      float r = exp(-pow((nm - 605.0) / 48.0, 2.0)) + 0.32 * exp(-pow((nm - 430.0) / 22.0, 2.0));
      float g = exp(-pow((nm - 540.0) / 44.0, 2.0));
      float b = exp(-pow((nm - 455.0) / 32.0, 2.0));
      return vec3(r, g, b) * smoothstep(375.0, 395.0, nm) * (1.0 - smoothstep(700.0, 740.0, nm));
    }

    // The tracks are rings 1.6 microns apart. Light from a lamp leaves them toward the eye only where its
    // path keeps its sideways (along-the-track) direction, and its colour is set by the radial part:
    // (lamp + eye) . radial = order x wavelength / 1.6 microns. So each lamp paints a spectrum spoke
    // through the middle of the disc, its first, second and third orders one after another.
    vec3 rainbows(vec3 V, vec3 radial, vec3 along) {
      vec3 c = vec3(0.0);
      for (int i = 0; i < 5; i++) {
        vec3 s = uLampDir[i] + V;
        float a = dot(s, along);
        float spoke = exp(-a * a / 0.028); // the lamps are softboxes, not points: a broad spoke
        float x = abs(dot(s, radial)) * 1600.0;
        c += (hue(x) + 0.6 * hue(x / 2.0) + 0.35 * hue(x / 3.0)) * spoke * uLampPower[i];
      }
      return c;
    }

    void main() {
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vWorld);
      vec3 radial = normalize(vRad);
      vec3 along = normalize(vTan);
      float r = length(vLocal);
      float aa = fwidth(r) * 1.25 + 0.02;
      float cosv = clamp(dot(N, V), 0.0, 1.0);
      vec3 R = reflect(-V, N);

      // polished aluminium under the polycarbonate: the room, smeared a little across the tracks
      vec3 mirror = (room(R + radial * 0.05, 1.2) + 2.0 * room(R, 0.6) + room(R - radial * 0.05, 1.2)) * 0.25 * uMirror;
      float data = smoothstep(22.0 - aa, 22.0 + aa, r) * (1.0 - smoothstep(58.8 - aa, 58.8 + aa, r));
      vec3 colours = rainbows(V, radial, along) * uRainbow;
      vec3 silver = mirror * 0.9 + colours * (0.25 + 0.75 * data) * 1.4;

      // the stacking ring near the hub: moulded, frosted
      float stack = smoothstep(17.0 - aa, 17.0 + aa, r) * (1.0 - smoothstep(19.2 - aa, 19.2 + aa, r));
      vec3 col = mix(silver, room(N, 5.0) * uLight * 0.8 + room(R, 2.5) * 0.12 * uMirror, stack * 0.9);

      if (uFace > 0.5) {
        // the label: the cover, printed from just outside the mirror band to just inside the rim
        float printed = smoothstep(23.5 - aa, 23.5 + aa, r) * (1.0 - smoothstep(58.0 - aa, 58.0 + aa, r));
        vec3 art = texture(uArt, vLocal / (2.0 * ${DISC.toFixed(1)}) + 0.5).rgb;
        vec3 light = room(N, 6.5) * uLight + 0.04;            // the room's light falling on it
        vec3 ink = art * light * 0.92;
        // the silver showing through thin inks: the room tinted by them, and the tracks' colours, which show
        // even through the dark inks (as on a metallic print)
        vec3 sheen = art * mirror * 0.3 + colours * (0.13 + 0.45 * art);
        float F = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
        vec3 gloss = room(R, 0.7) * F * 0.9;                  // the lacquer on top
        col = mix(col, ink + sheen + gloss, printed);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const labelMaterial = new THREE.ShaderMaterial({ ...discShader, uniforms: discUniforms });
const dataMaterial = new THREE.ShaderMaterial({ ...discShader, uniforms: { ...discUniforms, uFace: { value: 0 } } });

const disc = new THREE.Group();
disc.position.z = -1.0;
tray.add(disc);
{
  const label = part(new THREE.RingGeometry(16.4, DISC, 192, 8), labelMaterial, true);
  label.position.z = 1.2;
  const under = part(new THREE.RingGeometry(16.4, DISC, 192, 8), dataMaterial);
  under.rotation.x = Math.PI;
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(DISC, DISC, 1.2, 192, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xdfe3e8, metalness: 1, roughness: 0.18 }));
  edge.rotation.x = Math.PI / 2;
  edge.position.z = 0.6;
  disc.add(label, under, edge, part(ring(HOLE, 16.6, 1.2, 0, 0.15), plastic));
}

// the lid: a sheet with lips along top and bottom and the hinge's knuckles; it turns about the left edge
const hinge = new THREE.Group();
hinge.position.set(-W / 2 + 0.6, 0, 1.5);
flat.add(hinge);
const lid = new THREE.Group();
lid.position.set(W / 2 - 0.6, 0, -1.5);
hinge.add(lid);
{
  lid.add(part(slab(roundRect(W, H, R), 1.3, 1.1), sheet));
  for (const y of [-1, 1]) {
    const lip = part(new THREE.BoxGeometry(W - 14, 1.3, 4.2), plastic, true);
    lip.position.set(5, y * (H / 2 - 0.65), -0.6);
    lid.add(lip);
    const tab = part(new THREE.BoxGeometry(4, 9, 1.3), plastic);
    tab.position.set(W / 2 - 4, y * (H / 2 - 9), 0.2);
    lid.add(tab);
  }
  const knuckle = new THREE.CylinderGeometry(2.1, 2.1, 12, 24);
  for (const y of [-1, 1]) {
    const k = part(knuckle, plastic);
    k.position.set(-W / 2 + 0.6, y * (H / 2 - 18), 1.5);
    lid.add(k);
  }
}

// ---------------------------------------------------------------- the frame: high range, then flares, then the screen
const hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const quarterA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const quarterB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });

// what's bright enough to flare: the glints, well above the white of the page
const brightPass = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: { tSource: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 2.2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tSource;
    uniform vec2 uTexel;
    uniform float uThreshold;
    varying vec2 vUv;
    vec3 over(vec2 uv) {
      vec3 c = texture2D(tSource, uv).rgb;
      return c * max(max(c.r, max(c.g, c.b)) - uThreshold, 0.0) / max(max(c.r, max(c.g, c.b)), 1e-3);
    }
    void main() {
      vec2 h = uTexel * 0.5;
      vec3 c = over(vUv + vec2(-h.x, -h.y)) + over(vUv + vec2(h.x, -h.y)) + over(vUv + vec2(-h.x, h.y)) + over(vUv + h);
      gl_FragColor = vec4(c * 0.25, 1.0);
    }`,
}));

// eight thin arms from each glint, like a lens's star filter
const starPass = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: { tSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tSource;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tSource, vUv).rgb;
      for (int a = 0; a < 4; a++) {
        float ang = float(a) * 0.7853982 + 0.26;
        vec2 d = vec2(cos(ang), sin(ang)) * uTexel * (a % 2 == 0 ? 1.6 : 1.0);
        for (int i = 1; i <= 14; i++) {
          float w = exp(-float(i) * 0.24) * (a % 2 == 0 ? 0.55 : 0.3);
          c += (texture2D(tSource, vUv + d * float(i)).rgb + texture2D(tSource, vUv - d * float(i)).rgb) * w;
        }
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
}));

// onto the screen: the flares (on a white page added light can't show, so they cool what they cross a little,
// with white-hot middles), a soft shoulder over the brightest values, then sRGB
const composite = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: { tScene: { value: null }, tStars: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tScene;
    uniform sampler2D tStars;
    varying vec2 vUv;
    vec3 shoulder(vec3 x) {
      return mix(x, 0.86 + 0.14 * (1.0 - exp(-(x - 0.86) / 0.14)), step(0.86, x));
    }
    vec3 toSRGB(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    void main() {
      vec3 c = texture2D(tScene, vUv).rgb;
      vec3 s = texture2D(tStars, vUv).rgb * 0.5;
      float k = clamp(dot(s, vec3(0.3333)), 0.0, 1.0);
      c = mix(c, vec3(0.5, 0.66, 1.0) * c, k * 0.55) + s;
      gl_FragColor = vec4(toSRGB(shoulder(c)), 1.0);
    }`,
}));

function resize() {
  const w = innerWidth, h = innerHeight, dpr = renderer.getPixelRatio();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep the open case (twice as wide) in frame on narrow screens
  camera.fov = THREE.MathUtils.clamp(26 * Math.max(1, 1.25 / camera.aspect), 26, 52);
  camera.updateProjectionMatrix();
  hdr.setSize(w * dpr, h * dpr);
  const qw = Math.max(1, Math.round(w * dpr / 4)), qh = Math.max(1, Math.round(h * dpr / 4));
  quarterA.setSize(qw, qh);
  quarterB.setSize(qw, qh);
  brightPass.material.uniforms.uTexel.value.set(1 / (w * dpr), 1 / (h * dpr));
  starPass.material.uniforms.uTexel.value.set(1 / qw, 1 / qh);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- covers
const loader = new THREE.TextureLoader();
const covers = releases.map(r => {
  const t = loader.load(`../${r.cover}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
});

// ---------------------------------------------------------------- state
const state = {
  index: 0,
  open: 0, openTarget: 0,
  spin: false, spinSpeed: 0,
  yaw: -0.35, pitch: 0, yawVel: 0, pitchVel: 0,
  scale: 1, swap: null,
};
const audio = new Audio();
audio.preload = 'none';
let track = 0;
let playing = false;

function setRelease(i) {
  state.index = i;
  const r = releases[i];
  discUniforms.uArt.value = covers[i];
  $('title').textContent = r.title;
  $('artist').textContent = r.artist;
  document.querySelectorAll('.thumb').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  history.replaceState(null, '', `#${r.id}`);
}

// a new release: the case closes and drops away, comes back with the new disc
function show(i) {
  i = (i + releases.length) % releases.length;
  if (i === state.index || state.swap) return;
  state.openTarget = 0;
  state.swap = { to: i, t: 0 };
  if (playing) startTrack(i, 0);
}

function startTrack(i, n) {
  const r = releases[i];
  if (!r.audio?.length) return;
  track = n % r.audio.length;
  audio.src = r.audio[track];
  audio.play().catch(() => {});
}
function setPlaying(on) {
  playing = on;
  $('play').setAttribute('aria-pressed', String(on));
  if (on) {
    if (!audio.src || !audio.src.includes(releases[state.index].audio?.[track] ?? '\0')) startTrack(state.index, 0);
    else audio.play().catch(() => {});
  } else {
    audio.pause();
  }
  updatePlaying();
}
function updatePlaying() {
  const r = releases[state.index];
  $('playing').textContent = playing && r.tracks ? `▶ ${r.tracks[track] ?? ''}` : '';
}
audio.addEventListener('ended', () => startTrack(state.index, track + 1));
audio.addEventListener('play', updatePlaying);

function toggleOpen() {
  state.openTarget = state.openTarget > 0.5 ? 0 : 1;
  $('open').setAttribute('aria-pressed', String(state.openTarget > 0.5));
  hideHint();
}
function toggleSpin() {
  state.spin = !state.spin;
  $('spin').setAttribute('aria-pressed', String(state.spin));
}

// ---------------------------------------------------------------- the dock
const dock = $('covers');
releases.forEach((r, i) => {
  const b = document.createElement('button');
  b.className = 'thumb';
  b.style.backgroundImage = `url("../${r.cover}")`;
  b.title = `${r.title} — ${r.artist}`;
  b.setAttribute('aria-label', `${r.title} by ${r.artist}`);
  b.addEventListener('click', () => show(i));
  dock.appendChild(b);
});
$('open').addEventListener('click', toggleOpen);
$('spin').addEventListener('click', toggleSpin);
$('play').addEventListener('click', () => setPlaying(!playing));
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'o') toggleOpen();
  else if (k === 's') toggleSpin();
  else if (k === 'p' || k === ' ') { e.preventDefault(); setPlaying(!playing); }
  else if (k === 'arrowright') show(state.index + 1);
  else if (k === 'arrowleft') show(state.index - 1);
});

const fromHash = releases.findIndex(r => `#${r.id}` === location.hash);
setRelease(fromHash >= 0 ? fromHash : 0);

let hintTimer = setTimeout(hideHint, 9000);
function hideHint() {
  clearTimeout(hintTimer);
  $('hint').classList.add('gone');
}

// ---------------------------------------------------------------- tap to open, drag to turn
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function hitsCase(x, y) {
  pointer.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(parts, false).length > 0;
}
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t: performance.now(), moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    canvas.classList.toggle('over', hitsCase(e.clientX, e.clientY));
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) {
    drag.moved = true;
    canvas.classList.add('dragging');
    hideHint();
  }
  if (drag.moved) {
    state.yaw += dx * 0.009;
    state.pitch = THREE.MathUtils.clamp(state.pitch + dy * 0.006, -0.9, 0.55);
    state.yawVel = dx * 0.009 * 60;
    state.pitchVel = dy * 0.006 * 60;
  }
});
const endDrag = (e) => {
  if (!drag) return;
  if (!drag.moved && performance.now() - drag.t < 500 && hitsCase(e.clientX, e.clientY)) toggleOpen();
  if (!drag.moved) state.yawVel = state.pitchVel = 0;
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- the loop
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clock = new THREE.Clock();
let openVel = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  // the lid: a damped spring, so it settles open with a little give
  const k = 90, damp = 15;
  openVel += ((state.openTarget - state.open) * k - openVel * damp) * dt;
  state.open += openVel * dt;
  const o = THREE.MathUtils.clamp(state.open, -0.05, 1.04);
  hinge.rotation.y = -o * THREE.MathUtils.degToRad(176);
  content.position.x = (W / 2) * ease(THREE.MathUtils.clamp(o, 0, 1));
  disc.position.z = -1.0 + 1.6 * Math.max(0, o - 0.6); // the disc rises a hair off the rosette once open

  // the disc: spins up and down smoothly (and while the music plays)
  const target = state.spin || playing ? Math.PI * 2 * 0.55 : 0;
  state.spinSpeed += (target - state.spinSpeed) * Math.min(1, dt * 2.2);
  disc.rotation.z -= state.spinSpeed * dt;

  // turning: drag, then coast; the tilt eases home, and the case sways a little at rest
  if (!drag) {
    state.yaw += state.yawVel * dt;
    state.pitch = THREE.MathUtils.clamp(state.pitch + state.pitchVel * dt, -0.9, 0.55);
    state.yawVel *= Math.exp(-dt * 3.2);
    state.pitchVel *= Math.exp(-dt * 3.2);
    state.pitch += (0 - state.pitch) * Math.min(1, dt * 0.8);
  }
  caseRoot.rotation.set(state.pitch + Math.sin(time * 0.6) * 0.025, state.yaw + Math.sin(time * 0.37) * 0.04, 0, 'YXZ');
  caseRoot.position.y = 14 + Math.sin(time * 0.8) * 1.2;

  // changing release: out (shrink, a quarter turn), swap the disc, back in with a bounce
  if (state.swap) {
    const s = state.swap;
    s.t += dt;
    if (s.t < 0.32) {
      state.scale = 1 - ease(s.t / 0.32);
    } else {
      if (!s.swapped) { s.swapped = true; setRelease(s.to); updatePlaying(); }
      const u = Math.min(1, (s.t - 0.32) / 0.55);
      state.scale = 1 + Math.sin(u * Math.PI) * 0.06 * (1 - u) + (ease(u) - 1);
      if (u >= 1) { state.swap = null; state.scale = 1; }
    }
    caseRoot.rotation.y += (1 - state.scale) * 0.9;
  }
  caseRoot.scale.setScalar(Math.max(0.001, state.scale));

  renderer.setRenderTarget(hdr);
  renderer.render(scene, camera);
  brightPass.material.uniforms.tSource.value = hdr.texture;
  renderer.setRenderTarget(quarterA);
  brightPass.render(renderer);
  starPass.material.uniforms.tSource.value = quarterA.texture;
  renderer.setRenderTarget(quarterB);
  starPass.render(renderer);
  composite.material.uniforms.tScene.value = hdr.texture;
  composite.material.uniforms.tStars.value = quarterB.texture;
  renderer.setRenderTarget(null);
  composite.render(renderer);
});
