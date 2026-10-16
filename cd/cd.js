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
// JASHIM's two singles get CDs of their own here (covers and words from the press page), next to the album
const SINGLES = [
  { id: 'yo-se', of: 'jashim', song: 0, title: 'Yo Sé', artist: 'JASHIM', date: '2026-10-02', cover: 'jashim/img/single-yo-se.jpg',
    links: [{ label: 'Listen', href: 'https://visceralvaults.lnk.to/YoSe' }] },
  { id: 'gistro', of: 'jashim', song: 3, title: 'Gistro (feat. Moonstar)', artist: 'JASHIM', date: '2026-10-16', cover: 'jashim/img/single-2.jpg',
    links: [{ label: 'Listen', href: 'https://VisceralVaults.lnk.to/Gistro' }] },
];
for (const single of SINGLES.slice().reverse()) {
  const album = releases.find(r => r.id === single.of);
  if (!album) continue;
  Object.assign(single, { audio: [album.audio[single.song]], tracks: [album.tracks[single.song]], lengths: [album.lengths?.[single.song]], credit: album.credit });
  releases.splice(releases.indexOf(album) + 1, 0, single);
}

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
const cameraHome = new THREE.Vector3(0, 520, 360);
const cameraTarget = new THREE.Vector3(0, 0, 8);
camera.position.copy(cameraHome);
camera.lookAt(cameraTarget);
camera.updateMatrixWorld();
const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
const panned = { x: 0, y: 0 };

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
// one more softbox, a long strip high behind the case, near where the lid mirrors the room for the camera: as the
// case drifts and turns, its highlight sweeps across the lid
const STRIP = [2.2, 11.6, -8.6];
{
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.8), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(12), side: THREE.DoubleSide }));
  strip.position.set(...STRIP);
  strip.lookAt(0, 1.5, 0);
  room.add(strip);
}
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
  [-0.462, 8.89, 14.52, 43], [3.235, 11.486, -12.541, 20], [...STRIP, 12],
].map(([x, y, z, p]) => ({ dir: new THREE.Vector3(x, y - 1.5, z).normalize(), power: p / 50 }));

// a key light for the shadow on the table (the room does the rest of the lighting)
const sun = new THREE.DirectionalLight(0xffffff, 0.6);
sun.position.set(-210, 430, -170);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 1200 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.radius = 22;
sun.shadow.blurSamples = 20;
sun.shadow.bias = -0.0005;
scene.add(sun);

// the floor the shadow falls on: well below the case, so turning the case never cuts into it
const table = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.ShadowMaterial({ opacity: 0.12 }));
table.rotation.x = -Math.PI / 2;
table.position.y = -110;
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
function plasticMaterial(rod, boost = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { ...plasticUniforms, uRod: { value: rod ? 1 : 0 }, uBoost: { value: boost } },
    transparent: true,
    depthWrite: rod,
    side: THREE.DoubleSide,
    // premultiplied: what a sheet reflects adds to what's behind it, so a highlight brightens without greying
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
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
      uniform float uBoost;
      varying vec3 vWorld;
      varying vec3 vN;
      vec3 room(vec3 d, float lod) { return textureLod(uRoom, d, lod).rgb * uGain; }
      float schlick(float c, float f0) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }

      // the room seen through a rod at one wavelength: in, off its far side, out (where it bends again)
      vec3 throughRod(vec3 V, vec3 N, vec3 R, float ior, float lod) {
        vec3 inside = refract(-V, N, 1.0 / ior);
        vec3 bounced = reflect(inside, normalize(N * 0.6 + R * 0.4));
        vec3 out1 = refract(bounced, -N, ior);
        if (dot(out1, out1) < 0.01) out1 = reflect(bounced, -N); // trapped: it bounces again
        return room(out1, lod);
      }

      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        if (dot(N, V) < 0.0) N = -N;
        float c = clamp(dot(N, V), 0.0, 1.0);
        float f0 = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
        float F = schlick(c, f0);
        vec3 R = reflect(-V, N);
        // a direction across the surface, for splitting the colours apart a little (chromatic aberration)
        vec3 across = normalize(cross(N, V) + vec3(1e-4, 0.0, 0.0));
        vec3 mirrored = room(R, 0.1);
        // the studio's lamps reflected: each colour from a slightly different angle, so a highlight's edges
        // fringe red on one side and blue on the other
        vec3 lamps = vec3(room(normalize(R + across * 0.012), 0.0).r, room(R, 0.0).g, room(normalize(R - across * 0.012), 0.0).b);
        vec3 glint = max(lamps - 1.1, 0.0);
        if (uRod < 0.5) {
          // both faces of a thin sheet reflect: face on, only the bright lamps show; at a slant it's a mirror
          float both = 2.0 * F / (1.0 + F);
          float edge = max(both - 2.0 * f0 / (1.0 + f0), 0.0);
          float a = clamp(edge + 0.03, 0.0, 1.0);
          gl_FragColor = vec4(mirrored * a + glint * both * 0.9 * uBoost, a);
          return;
        }
        // polystyrene bends red a little less than blue: the rods split the room into colour at their edges
        vec3 through = vec3(
          throughRod(V, N, R, uIor - 0.022, 0.25).r,
          throughRod(V, N, R, uIor, 0.25).g,
          throughRod(V, N, R, uIor + 0.022, 0.25).b
        ) * vec3(0.93, 0.96, 1.0);
        float a = 0.7 + 0.3 * F;
        gl_FragColor = vec4(mix(through, mirrored, F) * a + glint * F * 0.8, a);
      }`,
  });
}
const plastic = plasticMaterial(true);
const sheet = plasticMaterial(false);
const lidSheet = plasticMaterial(false, 1.3); // the front of the case: the highlight people look for

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
  uRelief: { value: null },
  uStickers: { value: 0 },                          // 1: the label is a sheet of stickers (an image with gaps)
  uTint: { value: new THREE.Color(1, 1, 1) },       // the disc's metal: silver, or gold
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
    varying vec3 vTx;
    varying vec3 vTy;
    void main() {
      vLocal = position.xy;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      mat3 m = mat3(modelMatrix);
      vN = normalize(m * normal);
      vTx = m * vec3(1.0, 0.0, 0.0);
      vTy = m * vec3(0.0, 1.0, 0.0);
      vec2 rd = normalize(position.xy + vec2(1e-6, 0.0));
      vRad = normalize(m * vec3(rd, 0.0));
      vTan = normalize(m * vec3(-rd.y, rd.x, 0.0));
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uArt;
    uniform sampler2D uRelief;
    uniform float uStickers;
    uniform vec3 uTint;
    uniform samplerCube uRoom;
    uniform float uFace;
    uniform vec3 uLampDir[6];
    uniform float uLampPower[6];
    uniform float uLight;
    uniform float uMirror;
    uniform float uRainbow;
    varying vec3 vWorld;
    varying vec3 vN;
    varying vec3 vRad;
    varying vec3 vTan;
    varying vec2 vLocal;
    varying vec3 vTx;
    varying vec3 vTy;

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
      for (int i = 0; i < 6; i++) {
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
      vec3 silver = (mirror * 0.9 + colours * (0.25 + 0.75 * data) * 1.4) * uTint;

      // the stacking ring near the hub: moulded, frosted
      float stack = smoothstep(17.0 - aa, 17.0 + aa, r) * (1.0 - smoothstep(19.2 - aa, 19.2 + aa, r));
      vec3 col = mix(silver, room(N, 5.0) * uLight * 0.8 + room(R, 2.5) * 0.12 * uMirror, stack * 0.9);

      if (uFace > 0.5 && uStickers > 0.5) {
        // the label is stickers: die-cut, standing up off the metal, which shows (and glistens) between them
        vec2 uv = vLocal / (2.0 * ${DISC.toFixed(1)}) + 0.5;
        vec4 art = texture(uArt, uv);
        // their soft shadow on the metal, from the studio's main lamps above and to the left
        float under = textureLod(uArt, uv + vec2(0.004, -0.005), 4.0).a;
        col *= 1.0 - 0.4 * under;
        // the sticker's own surface: flat on top, rounded over at its edge (the relief map), lit by the room
        float e = 1.5 / 1024.0;
        float hl = textureLod(uRelief, uv - vec2(e, 0.0), 0.5).r;
        float hr = textureLod(uRelief, uv + vec2(e, 0.0), 0.5).r;
        float hd = textureLod(uRelief, uv - vec2(0.0, e), 0.5).r;
        float hu = textureLod(uRelief, uv + vec2(0.0, e), 0.5).r;
        float k = 0.55 / (2.0 * e * 2.0 * ${DISC.toFixed(1)});   // 0.55 mm high, over the gap in mm
        vec3 n = normalize(vec3(-(hr - hl) * k, -(hu - hd) * k, 1.0));
        vec3 Ns = normalize(normalize(vTx) * n.x + normalize(vTy) * n.y + N * n.z);
        vec3 Rs = reflect(-V, Ns);
        float cs = clamp(dot(Ns, V), 0.0, 1.0);
        float Fs = 0.05 + 0.95 * pow(1.0 - cs, 5.0);
        float shine = texture(uRelief, uv).g;
        // the stickers come with their own shine painted in: keep their colours, lit a little by the room's key
        float key = clamp(dot(Ns, normalize(uLampDir[0] + uLampDir[3])), 0.0, 1.0);
        vec3 body = art.rgb * (0.72 + 0.32 * key);
        vec3 laminate = room(Rs, 0.25) * (Fs * 1.1 + 0.05) * shine;
        // the laminate is a holographic film: thin-film colours that slide with the angle, faint, over everything
        vec3 film = hue(430.0 + 300.0 * fract(cs * 1.6 + dot(uv, vec2(1.7, 1.1)))) * room(Rs, 2.0) * 0.07 * shine;
        vec3 sticker = body + laminate + film + colours * 0.05 * shine;
        float onLabel = smoothstep(23.0 - aa, 23.0 + aa, r);
        col = mix(col, sticker, art.a * onLabel);
      } else if (uFace > 0.5) {
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
  lid.add(part(slab(roundRect(W, H, R), 1.3, 1.1), lidSheet));
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

// the booklet, held in the lid under its face: the cover on the front, the release's notes inside
const BOOK = 120;
const booklet = new THREE.Group();
booklet.position.set(2, 0, 0.7);
lid.add(booklet);
const bookletFront = part(new THREE.PlaneGeometry(BOOK, BOOK),
  new THREE.MeshPhysicalMaterial({ roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 0.5 }));
bookletFront.position.z = 0.15;
const bookletInside = part(new THREE.PlaneGeometry(BOOK, BOOK), new THREE.MeshPhysicalMaterial({ roughness: 0.75, specularIntensity: 0.3, envMapIntensity: 0.42 }));
bookletInside.rotation.y = Math.PI; // facing into the case
booklet.add(bookletFront, bookletInside);

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
  uniforms: { tScene: { value: null }, tStars: { value: null }, uDark: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tScene;
    uniform sampler2D tStars;
    uniform float uDark;
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
      // the flares split a little by colour toward the frame's edges, as a lens's do
      vec2 ca = (vUv - 0.5) * 0.006;
      vec3 s = vec3(texture2D(tStars, vUv + ca).r, texture2D(tStars, vUv).g, texture2D(tStars, vUv - ca).b) * 0.5;
      float k = clamp(dot(s, vec3(0.3333)), 0.0, 1.0);
      c = mix(c, vec3(0.5, 0.66, 1.0) * c, k * 0.55 * (1.0 - uDark)) + s; // (on black, added light shows as it is)
      gl_FragColor = vec4(toSRGB(shoulder(c)), 1.0);
    }`,
}));

let portrait = false;
let baseFov = 26;
let openFov = 26;
function resize() {
  const w = innerWidth, h = innerHeight, dpr = renderer.getPixelRatio();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // A case opens sideways, the lid to the left, on every screen. On a tall one the closed case fills the width,
  // and the camera pulls back as the lid opens so both halves fit across.
  portrait = camera.aspect < 0.85;
  const distance = cameraHome.distanceTo(cameraTarget);
  const fit = (halfWidth) => THREE.MathUtils.radToDeg(2 * Math.atan(halfWidth / (distance * camera.aspect)));
  baseFov = portrait ? fit(84) : THREE.MathUtils.clamp(26 * Math.max(1, 1.25 / camera.aspect), 26, 52);
  openFov = portrait ? fit(158) : baseFov;
  camera.fov = baseFov;
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
// The discs' designs (discs/<id>.webp: a ring of die-cut stickers drawn from the cover, see-through between them;
// discs/<id>-relief.webp: how each sticker stands up), and the metal each is pressed on. A release without one
// has its cover printed on a silver disc.
const DISCS = {
  'jashim': { metal: [0.93, 0.97, 1.0] },          // icy silver
  'yo-se': { metal: [0.8, 0.96, 1.0] },            // icy cyan
  'gistro': { metal: [0.62, 0.92, 0.92] },         // teal
  'ww4': { metal: [0.76, 0.85, 1.0] },             // blue-lit chrome
  'worst-vocal-dub': { metal: [0.6, 0.74, 1.0] },  // the blue smoke
  'yea-hoe-mixes': { metal: [0.42, 0.43, 0.46] },  // gunmetal, for the dark rock
  'how-we-rock': { metal: [0.7, 0.8, 1.0] },       // night blue
  'one': { metal: [1.0, 1.0, 1.0] },               // bright silver
  'yea-hoe': { metal: [1.0, 0.72, 0.32] },         // gold
};
const texture = (url, srgb) => {
  const t = loader.load(url);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
};
// a booklet's front where it differs from the site's cover (JASHIM's with its parental advisory label)
const BOOKLETS = { jashim: 'booklets/jashim.jpg' };
const covers = releases.map(r => {
  const cover = texture(BOOKLETS[r.id] ?? `../${r.cover}`, true);
  return DISCS[r.id]
    ? { cover, art: texture(`discs/${r.id}.webp`, true), relief: texture(`discs/${r.id}-relief.webp`, false), metal: DISCS[r.id].metal }
    : { cover, art: cover, relief: null, metal: [1, 1, 1] };
});

// ---------------------------------------------------------------- the booklet's inside page
// Set like the label's press pages: the wordmark and the date, the title in Impact stretched 180% wide, the
// artists, the tracklist, the credits; for a release with a press release, its opening paragraphs too.
const NOTES = {
  'yo-se': {
    cat: 'Single',
    text: ['JASHIM’s first single introduces the world of his self-titled debut: a hazy, sensual Latin club track built around beautiful micromelodies, a rolling dembow rhythm, and the intimate chemistry of a summer night.',
      'Smooth rhodes chords float above a deep UK bassline, creating a contrast between warmth and low-end pressure.'],
  },
  gistro: {
    cat: 'Single',
    text: ['“GISTRO” is the second single from JASHIM’s self-titled LP, pushing the project deeper into JASHIM’s club universe with a high-energy Neoperreo track produced by Sinjin Hawke.',
      'Legendary Montreal Vogue commentator Moonstar delivers cunty ballroom vocals that turn the track into a call-to-action for baddies.'],
  },
  jashim: {
    cat: 'VV007',
    text: [
      'JASHIM releases his self-titled debut album ‘JASHIM’, an exploration of courtship and love in Montreal’s latinx underground.',
      'The record moves between euphoria and vulnerability: beautiful micromelodies, guaracha, and the tension of two people caught on the same late-night frequency. It feels like a melancholic perreo on a mid-summer night.',
      'Guests include vskz, Moonstar, Xlow, KIDDEIN and Sinjin Hawke, who also executive-produced the record.',
    ],
  },
};
const fontsReady = (async () => {
  try {
    const impact = new FontFace('Impact VV', 'url(https://fractalfantasy.net/signature/impact.woff)');
    document.fonts.add(await impact.load());
  } catch (e) { /* Impact itself, or a fallback */ }
  await Promise.all(['400 20px Inter', '600 20px Inter', '700 20px Inter'].map(f => document.fonts.load(f)));
})();
const wordmark = new Image();
wordmark.src = '../assets/img/site/visceral-vaults-wordmark-grey.png';
// A title as the label sets Impact on white: stretched 180% wide and hollow, an even outline all round. The
// letters are drawn solid and stretched, then hollowed: grown by half the line's width (copies all round) less
// shrunk by the same (where all those copies still overlap), so the line is as thick on the verticals as across.
function outlined(text, size, line) {
  const pad = 8;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${size}px "Impact VV", Impact, "Arial Black", sans-serif`;
  const w = Math.ceil(probe.measureText(text).width * 1.8) + 2 * pad, h = Math.ceil(size * 1.05) + 2 * pad;
  const layer = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const solid = layer();
  const sg = solid.getContext('2d');
  sg.font = probe.font;
  sg.fillStyle = '#111';
  sg.save();
  sg.translate(pad, pad + size * 0.86);
  sg.scale(1.8, 1);
  sg.fillText(text, 0, 0);
  sg.restore();
  const grown = layer(), shrunk = layer();
  const gg = grown.getContext('2d'), kg = shrunk.getContext('2d');
  kg.drawImage(solid, 0, 0);
  kg.globalCompositeOperation = 'destination-in';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, x = Math.cos(a) * line / 2, y = Math.sin(a) * line / 2;
    gg.drawImage(solid, x, y);
    kg.drawImage(solid, x, y);
  }
  gg.globalCompositeOperation = 'destination-out';
  gg.drawImage(shrunk, 0, 0);
  return grown;
}
const insidePages = new Map();
function insidePage(r) {
  if (insidePages.has(r.id)) return insidePages.get(r.id);
  const N = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  insidePages.set(r.id, t);
  const photo = new Image();
  photo.src = `../${r.cover}`;
  Promise.all([fontsReady, wordmark.decode().catch(() => {}), photo.decode().catch(() => {})]).then(() => {
    const g = canvas.getContext('2d');
    const notes = NOTES[r.id];
    const M = 78;
    g.fillStyle = '#f1f1ef';
    g.fillRect(0, 0, N, N);
    g.fillStyle = '#111';
    g.textBaseline = 'alphabetic';
    if (wordmark.naturalWidth) g.drawImage(wordmark, M, M - 6, 190, 190 * wordmark.naturalHeight / wordmark.naturalWidth);
    const [y, m, d] = (r.date || '').split('-');
    g.font = '600 19px Inter';
    g.fillStyle = '#8a8a8a';
    g.textAlign = 'right';
    g.fillText([notes?.cat, d && `${d}.${m}.${y}`].filter(Boolean).join('   ·   '), N - M, M + 8);
    // the title: Impact, 180% wide, as wide as the page allows
    g.textAlign = 'left';
    g.fillStyle = '#111';
    let size = 150;
    g.font = `${size}px "Impact VV", Impact, "Arial Black", sans-serif`;
    const w = g.measureText(r.title.toUpperCase()).width * 1.8;
    size = Math.min(150, size * (N - 2 * M) / w);
    g.font = `${size}px "Impact VV", Impact, "Arial Black", sans-serif`;
    g.drawImage(outlined(r.title.toUpperCase(), size, Math.max(3, size * 0.034)), M - 8, M + 40 - 8);
    let top = M + 40 + size * 0.86 + 52;
    g.font = '600 26px Inter';
    g.fillText(r.artist, M, top);
    top += 34;
    g.fillStyle = '#d4d4d4';
    g.fillRect(M, top, N - 2 * M, 2);
    top += 50;
    // the words (if any) on the left, the tracks on the right; without words, the cover's picture beside the tracks
    const pictured = !notes && photo.naturalWidth;
    if (pictured) {
      const side = Math.min(N - M - 540, N - M - 90 - top);
      g.drawImage(photo, N - M - side, top - 8, side, side);
    }
    const tracksX = notes ? 560 : M;
    const tracksW = (pictured ? 500 : N - M) - tracksX;
    if (notes) {
      g.fillStyle = '#111';
      g.font = '500 21px Inter';
      let ty = top;
      for (const para of notes.text) {
        const words = para.split(' ');
        let line = '';
        for (const word of words) {
          const test = line ? `${line} ${word}` : word;
          if (g.measureText(test).width > tracksX - M - 40) { g.fillText(line, M, ty); ty += 30; line = word; } else line = test;
        }
        g.fillText(line, M, ty);
        ty += 44;
      }
    }
    const tracks = r.tracks || [];
    const cols = !notes && !pictured && tracks.length > 6 ? 2 : 1;
    const colW = (tracksW - (cols - 1) * 50) / cols;
    const perCol = Math.ceil(tracks.length / cols);
    const step = Math.min(40, (N - M - 120 - top) / perCol);
    tracks.forEach((name, i) => {
      const x = tracksX + Math.floor(i / perCol) * (colW + 50);
      const ty = top + (i % perCol) * step;
      g.font = '700 19px Inter';
      g.fillStyle = '#777';
      g.textAlign = 'left';
      g.fillText(String(i + 1).padStart(2, '0'), x, ty);
      g.font = '600 22px Inter';
      g.fillStyle = '#0a0a0a';
      let label = name;
      while (g.measureText(label).width > colW - 120 && label.length > 4) label = label.slice(0, -2) + '…';
      g.fillText(label, x + 44, ty);
      if (r.lengths?.[i]) {
        g.font = '500 19px Inter';
        g.fillStyle = '#666';
        g.textAlign = 'right';
        g.fillText(r.lengths[i], x + colW, ty);
      }
    });
    // the credits along the bottom
    g.textAlign = 'left';
    g.font = '500 17px Inter';
    g.fillStyle = '#6a6a6a';
    const year = y || new Date().getFullYear();
    g.fillText([r.credit, `℗ & © ${year} Visceral Vaults, a sublabel of Fractal Fantasy`].filter(Boolean).join('   ·   '), M, N - M);
    t.needsUpdate = true;
  });
  return t;
}

// ---------------------------------------------------------------- state
const state = {
  index: 0,
  open: 0, openTarget: 0,
  spin: false, spinSpeed: 0, discAngle: 0,
  yaw: -0.35, pitch: 0, yawVel: 0, pitchVel: 0,
  scale: 1, swap: null, idle: 0, discOutTarget: 0, out: 0, driftYaw: 0, driftPitch: 0,
};

function setRelease(i) {
  state.index = i;
  const r = releases[i];
  const c = covers[i];
  discUniforms.uArt.value = c.art;
  discUniforms.uRelief.value = c.relief ?? c.art;
  discUniforms.uStickers.value = c.relief ? 1 : 0;
  discUniforms.uTint.value.setRGB(...c.metal);
  bookletFront.material.map = c.cover;
  bookletFront.material.needsUpdate = true;
  bookletInside.material.map = insidePage(r);
  bookletInside.material.needsUpdate = true;
  $('title').textContent = r.title;
  $('artist').textContent = r.artist;
  document.querySelectorAll('.thumb').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  history.replaceState(null, '', `#${r.id}`);
}

// a new release: the case closes and drops away, comes back with the new disc (and opens, if asked)
function show(i, { open = false } = {}) {
  i = (i + releases.length) % releases.length;
  if (i === state.index || state.swap) {
    if (open && i === state.index) setOpen(true);
    return;
  }
  setOpen(false);
  state.swap = { to: i, t: 0, open };
}

function setOpen(on) {
  state.openTarget = on ? 1 : 0;
  if (!on) setDiscOut(false);
}
// the disc out of its case, filling the screen (and the release playing), or back in
function setDiscOut(on) {
  if ((state.discOutTarget > 0.5) === on) return;
  state.discOutTarget = on ? 1 : 0;
  if (on) {
    hideHint();
    playRelease(state.index);
  }
}
function playRelease(i) {
  if (!player) return;
  const entry = entries.findIndex(e => e.release === releases[i]);
  if (entry < 0) return;
  if (entries[player.currentPlaylistIndex].release !== releases[i]) {
    shownEntry = entry;
    credits(releases[i]);
    player.playSong(entry);
  } else if (player.song.paused) {
    player.play();
  }
}

function toggleOpen() {
  setOpen(state.openTarget < 0.5);
  hideHint();
}
function toggleSpin() {
  state.spin = !state.spin;
}

// ---------------------------------------------------------------- the FF player (as on visceralvaults.com)
// One playlist of every playable song, release after release; a song that isn't out yet (JASHIM's album
// before November 6th, but for its singles) is left out. When it moves on to another release's song,
// that release's case comes up and opens; picking a case while it plays jumps to that release.
function canPlay(release, i) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return !release.singles || today >= release.date || (release.singles[i] ?? '9999') <= today;
}
const PLATFORMS = [['spotify', 'Spotify'], ['appleMusic', 'Apple Music'], ['youtube', 'YouTube'], ['bandcamp', 'Bandcamp']];
const releaseLinks = (r) => PLATFORMS.filter(([k]) => r[k]).map(([k, label]) => [label, r[k]])
  .concat((r.links || []).map(l => [l.label, l.href]));

const todayISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
// each song once: until an album is out, a song that's also a single plays from the single's CD; then from the album's
const albumOut = (id) => (releases.find(r => r.id === id)?.date ?? '') <= todayISO;
const ownedBySingle = (release, i) => SINGLES.some(s => s.of === release.id && s.song === i && releases.includes(s) && !albumOut(release.id));
const entries = releases.flatMap(release => (release.tracks || []).map((_, i) => ({ release, i })))
  .filter(({ release, i }) => release.audio?.[i] && canPlay(release, i))
  .filter(({ release, i }) => (release.of ? !albumOut(release.of) && release.date <= todayISO : !ownedBySingle(release, i)));
let player = null;
let shownEntry = -1;
if (typeof FFPlayer !== 'undefined' && entries.length) {
  const first = entries[0].release;
  player = new FFPlayer({
    title: first.title, artist: first.artist, description: 'Visceral Vaults', mode: 'audio playlist',
    src: entries.map(({ release, i }) => release.audio[i]),
    songTitle: entries.map(({ release, i }) => release.tracks[i]),
    download: true, links: releaseLinks(first), volume: true, loop: true,
  });
  const back = document.createElement('button');
  back.className = 'back';
  back.setAttribute('aria-label', 'Previous');
  back.addEventListener('click', () => player.previousSong());
  player.container.prepend(back);
}
const playing = () => !!player && !!player.song && !player.song.paused;

// the bar's credits and links: the release of its song
function credits(release) {
  player.container.querySelector('#playerTitle').textContent = release.title;
  player.container.querySelector('#playerArtist').textContent = release.artist;
  const panel = player.container.querySelector('.ffplayer-links');
  if (panel) panel.replaceChildren(...releaseLinks(release).map(([label, href]) => Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener', textContent: label })));
}

// skipping (or playing on) into another release's songs brings its case up, open (checked every frame)
function followPlayer() {
  if (!player || player.currentPlaylistIndex === shownEntry || state.swap) return;
  shownEntry = player.currentPlaylistIndex;
  const { release } = entries[shownEntry];
  credits(release);
  show(releases.indexOf(release), { open: true });
}

// picking a case moves the bar to that release's first song (playing it if the bar was playing)
function pick(i) {
  i = (i + releases.length) % releases.length;
  show(i);
  if (!player) return;
  const entry = entries.findIndex(e => e.release === releases[i]);
  if (entry < 0 || entries[player.currentPlaylistIndex].release === releases[i]) return;
  shownEntry = entry;
  credits(releases[i]);
  if (playing()) player.playSong(entry);
  else player._goTo(entry, false);
}

// ---------------------------------------------------------------- black or white
function setDark(on) {
  document.body.classList.toggle('dark', on);
  $('dark').setAttribute('aria-pressed', String(on));
  const v = on ? 0 : pageLinear;
  scene.background.setRGB(v, v, on ? 0 : v * 0.995, THREE.LinearSRGBColorSpace);
  composite.material.uniforms.uDark.value = on ? 1 : 0;
  table.material.opacity = on ? 0 : 0.12;
  try { localStorage.setItem('vv-cd-dark', on ? '1' : ''); } catch (e) { /* storage blocked */ }
}

// ---------------------------------------------------------------- the dock
const dock = $('covers');
releases.forEach((r, i) => {
  const b = document.createElement('button');
  b.className = 'thumb';
  b.style.backgroundImage = DISCS[r.id]
    ? `url("discs/${r.id}.webp"), radial-gradient(rgb(${DISCS[r.id].metal.map(v => Math.round(v * 225)).join(',')}), #bbb)`
    : `url("../${r.cover}")`;
  b.title = `${r.title} — ${r.artist}`;
  b.setAttribute('aria-label', `${r.title} by ${r.artist}`);
  b.addEventListener('click', () => pick(i));
  dock.appendChild(b);
});
$('dark').addEventListener('click', () => setDark(!document.body.classList.contains('dark')));
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') setDiscOut(false);
  else if (k === 'o') toggleOpen();
  else if (k === 's') toggleSpin();
  else if (k === 'b') setDark(!document.body.classList.contains('dark'));
  else if ((k === 'p' || k === ' ') && player) { e.preventDefault(); player.togglePlay(); }
  else if (k === 'arrowright') pick(state.index + 1);
  else if (k === 'arrowleft') pick(state.index - 1);
});

const fromHash = releases.findIndex(r => `#${r.id}` === location.hash);
setRelease(fromHash >= 0 ? fromHash : 0);
if (player) {
  const entry = Math.max(0, entries.findIndex(e => e.release === releases[state.index]));
  if (entry) player._goTo(entry, false);
  shownEntry = player.currentPlaylistIndex;
  credits(entries[shownEntry].release);
}
try { if (localStorage.getItem('vv-cd-dark')) setDark(true); } catch (e) { /* storage blocked */ }

let hintTimer = setTimeout(hideHint, 9000);
function hideHint() {
  clearTimeout(hintTimer);
  $('hint').classList.add('gone');
}

// ---------------------------------------------------------------- tap to open, drag to turn
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function hitWhat(x, y) {
  pointer.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(parts, false)[0];
  if (!hit) return null;
  for (let o = hit.object; o; o = o.parent) if (o === disc) return 'disc';
  return 'case';
}
const hitsCase = (x, y) => hitWhat(x, y) !== null;
let drag = null;
let lastTouch = performance.now();
for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(type, () => { if (type !== 'pointermove' || drag || pinch) lastTouch = performance.now(); }, { passive: true });

// The view: one finger (or the mouse) turns the case and a tap opens it; two fingers pinch to zoom and move
// together to pan. On a trackpad, pinching zooms and a two-finger scroll pans; a mouse wheel zooms. A double
// click or a double tap off the case puts the view back.
const view = { zoom: 1, panX: 0, panY: 0 };   // pan in millimetres, across the camera's own picture
const pointers = new Map();
let pinch = null;
const mmPerPixel = () => (2 * cameraHome.distanceTo(cameraTarget) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (camera.zoom * innerHeight);
function panBy(dxPx, dyPx) {
  const k = mmPerPixel();
  view.panX = THREE.MathUtils.clamp(view.panX - dxPx * k, -260, 260);
  view.panY = THREE.MathUtils.clamp(view.panY + dyPx * k, -260, 260);
}
function zoomBy(factor) {
  view.zoom = THREE.MathUtils.clamp(view.zoom * factor, 0.6, 3.2);
}
function twoFingers() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* a pointer the browser no longer tracks */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // take the case over from wherever its drift has it, without a jump
  state.yaw += state.driftYaw;
  state.pitch += state.driftPitch;
  state.driftYaw = state.driftPitch = state.idle = 0;
  if (pointers.size === 2) {
    // a second finger: stop turning (no tap either), start pinching and panning
    drag = null;
    state.yawVel = state.pitchVel = 0;
    canvas.classList.remove('dragging');
    pinch = twoFingers();
    hideHint();
    return;
  }
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t: performance.now(), moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const now = twoFingers();
    if (pinch.dist > 0) zoomBy(now.dist / pinch.dist);
    panBy(now.x - pinch.x, now.y - pinch.y);
    pinch = now;
    return;
  }
  if (!drag) {
    if (e.pointerType === 'mouse') canvas.classList.toggle('over', hitsCase(e.clientX, e.clientY));
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
  if (drag.moved && state.discOutTarget < 0.5) {
    state.yaw += dx * 0.009;
    state.pitch = THREE.MathUtils.clamp(state.pitch + dy * 0.006, -0.9, 0.55);
    state.yawVel = dx * 0.009 * 60;
    state.pitchVel = dy * 0.006 * 60;
  }
});
let lastTap = { t: 0, x: 0, y: 0 };
const endDrag = (e) => {
  pointers.delete(e.pointerId);
  if (pinch) {
    // lifting one of two fingers ends the pinch; the finger left doesn't start turning the case
    if (pointers.size < 2) pinch = null;
    return;
  }
  if (!drag) return;
  if (!drag.moved && performance.now() - drag.t < 500) {
    const hit = hitWhat(e.clientX, e.clientY);
    if (state.discOutTarget > 0.5) setDiscOut(false);                        // out: any tap puts it back
    else if (hit === 'disc' && state.openTarget > 0.5) setDiscOut(true);     // the disc in an open case: out it comes
    else if (hit) toggleOpen();
    else if (performance.now() - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) resetView();
    lastTap = { t: performance.now(), x: e.clientX, y: e.clientY };
  }
  if (!drag.moved) state.yawVel = state.pitchVel = 0;
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  lastTouch = performance.now();
  const lines = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey) zoomBy(Math.exp(-e.deltaY * lines * 0.01));                       // a trackpad pinch
  else if (e.deltaX !== 0 || (Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY))) panBy(-e.deltaX * lines, -e.deltaY * lines); // a two-finger scroll
  else zoomBy(Math.exp(-e.deltaY * lines * 0.0015));                               // a mouse wheel
}, { passive: false });
function resetView() {
  view.zoom = 1;
  view.panX = view.panY = 0;
}
canvas.addEventListener('dblclick', (e) => { if (!hitsCase(e.clientX, e.clientY)) resetView(); });

// ---------------------------------------------------------------- the loop
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clock = new THREE.Clock();
let openVel = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  // the view eases to where the fingers (or the trackpad) put it
  const follow = Math.min(1, dt * 12);
  panned.x += (view.panX - panned.x) * follow;
  panned.y += (view.panY - panned.y) * follow;
  const offset = new THREE.Vector3().addScaledVector(cameraRight, panned.x).addScaledVector(cameraUp, panned.y);
  camera.position.copy(cameraHome).add(offset);
  camera.lookAt(new THREE.Vector3().copy(cameraTarget).add(offset));
  const zoom = camera.zoom + (view.zoom - camera.zoom) * follow;
  if (Math.abs(zoom - camera.zoom) > 1e-4) { camera.zoom = zoom; camera.updateProjectionMatrix(); }

  // the lid: a damped spring, so it settles open with a little give
  const k = 90, damp = 15;
  openVel += ((state.openTarget - state.open) * k - openVel * damp) * dt;
  state.open += openVel * dt;
  const o = THREE.MathUtils.clamp(state.open, -0.05, 1.04);
  hinge.rotation.y = -o * THREE.MathUtils.degToRad(176);
  content.position.x = (W / 2) * ease(THREE.MathUtils.clamp(o, 0, 1));
  if (portrait) {
    // on a tall screen the open case is twice as wide as the screen allows: pull back as it opens
    const fov = THREE.MathUtils.lerp(baseFov, openFov, ease(THREE.MathUtils.clamp(o, 0, 1)));
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }
  disc.position.set(0, 0, -1.0 + 1.6 * Math.max(0, o - 0.6)); // the disc rises a hair off the rosette once open
  disc.scale.setScalar(1);

  // the disc: spins up and down smoothly (and while the music plays)
  followPlayer();
  const target = state.spin || playing() ? Math.PI * 2 * 0.55 : 0;
  state.spinSpeed += (target - state.spinSpeed) * Math.min(1, dt * 2.2);
  state.discAngle -= state.spinSpeed * dt;

  // turning: drag, then coast; the tilt eases home, and the case sways a little at rest
  if (!drag) {
    state.yaw += state.yawVel * dt;
    state.pitch = THREE.MathUtils.clamp(state.pitch + state.pitchVel * dt, -0.9, 0.55);
    state.yawVel *= Math.exp(-dt * 3.2);
    state.pitchVel *= Math.exp(-dt * 3.2);
    state.pitch += (0 - state.pitch) * Math.min(1, dt * 0.8);
  }
  const turn = portrait ? 0.24 : 0;                 // a tall screen: less of a three-quarter view, to fill the width
  disc.rotation.set(0, 0, state.discAngle - turn);  // the disc's art stays upright
  // Left alone for a few seconds, the case drifts: a slow, small turn and tilt (two slow waves, so it never quite
  // repeats) that walks the studio's highlights across the lid and the disc. A touch takes over at once.
  const idleFor = (performance.now() - lastTouch) / 1000;
  state.idle += ((idleFor > 2.5 ? 1 : 0) - state.idle) * Math.min(1, dt * (idleFor > 2.5 ? 0.35 : 4));
  const driftYaw = (Math.sin(time * 0.19) * 0.17 + Math.sin(time * 0.083 + 1.3) * 0.08) * state.idle;
  const driftPitch = (Math.sin(time * 0.14 + 0.7) * 0.075 + Math.sin(time * 0.061) * 0.035) * state.idle;
  state.driftYaw = driftYaw;
  state.driftPitch = driftPitch;
  caseRoot.rotation.set(state.pitch + driftPitch + Math.sin(time * 0.6) * 0.012, turn + state.yaw + driftYaw, 0, 'YXZ');
  caseRoot.position.set(0, 14 + Math.sin(time * 0.8) * 1.2, 0);

  // changing release: out (shrink, a quarter turn), swap the disc, back in with a bounce
  if (state.swap) {
    const s = state.swap;
    s.t += dt;
    if (s.t < 0.32) {
      state.scale = 1 - ease(s.t / 0.32);
    } else {
      if (!s.swapped) { s.swapped = true; setRelease(s.to); }
      const u = Math.min(1, (s.t - 0.32) / 0.55);
      state.scale = 1 + Math.sin(u * Math.PI) * 0.06 * (1 - u) + (ease(u) - 1);
      if (u >= 1) { if (s.open) setOpen(true); state.swap = null; state.scale = 1; }
    }
    caseRoot.rotation.y += (1 - state.scale) * 0.9;
  }
  caseRoot.scale.setScalar(Math.max(0.001, state.scale));

  // The disc out: it leaves the tray on a small arc, turns to face the camera and comes up to fill the screen
  // (the full width of a phone, the height of a wide screen, short of the bars), spinning; the case moves up
  // and back out of its way.
  state.out += (state.discOutTarget - state.out) * Math.min(1, dt * 3.2);
  const lift = ease(THREE.MathUtils.clamp(state.out, 0, 1));
  if (lift > 0.0005) {
    const toward = camera.getWorldDirection(new THREE.Vector3());
    caseRoot.position.addScaledVector(cameraUp, (camera.aspect < 1 ? 170 : 75) * lift).addScaledVector(toward, 140 * lift);
    caseRoot.updateMatrixWorld(true);
    const from = new THREE.Vector3(), fromQ = new THREE.Quaternion(), unit = new THREE.Vector3();
    disc.matrixWorld.decompose(from, fromQ, unit);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom;
    const fill = 0.86 * Math.min(camera.aspect, 1) * (camera.aspect < 1 ? 1 : 0.8);
    const distance = 2 * DISC / (fill * 2 * tanHalf);
    const to = camera.position.clone().addScaledVector(toward, distance).addScaledVector(cameraUp, distance * tanHalf * 0.06);
    const toQ = camera.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), state.discAngle));
    const at = from.clone().lerp(to, lift).addScaledVector(cameraUp, Math.sin(Math.PI * lift) * 25);
    const local = new THREE.Matrix4().compose(at, fromQ.clone().slerp(toQ, lift), unit)
      .premultiply(disc.parent.matrixWorld.clone().invert());
    local.decompose(disc.position, disc.quaternion, disc.scale);
  }

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
