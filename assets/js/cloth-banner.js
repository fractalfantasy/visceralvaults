import * as THREE from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GUI } from "dat.gui";
import { Cloth } from "./cloth.js?v=1";
import { VerletCloth } from "./verlet-cloth.js?v=2";

const canvas = document.getElementById("liquid-canvas");
const fallback = document.querySelector(".hero-fallback");

function showFallback() {
  if (canvas) canvas.hidden = true;
  if (fallback) fallback.hidden = false;
}

if (!canvas) {
  showFallback();
} else {
  init().catch((err) => {
    console.error("Cloth banner failed to start:", err);
    showFallback();
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Downsamples straight to the cloth's grid resolution so each vertex gets a
// smoothly-averaged value (letting the canvas's own image scaling do the
// blur) instead of point-sampling a high-contrast image, which at a coarse
// vertex grid would alias into a patchy, noisy-looking relief. `crop`
// restricts the source region drawn, so the letters can be sampled without
// whatever padding the source image has around them.
function sampleImageGrid(img, gridW, gridH, crop) {
  const c = document.createElement("canvas");
  c.width = gridW;
  c.height = gridH;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, gridW, gridH);
  return ctx.getImageData(0, 0, gridW, gridH).data;
}

// Different source images have different amounts of padding around the
// letters (some cropped tight by hand, some not), so instead of hardcoding
// one image's crop we detect the bright-pixel bounding box at load time and
// pad it a little, working the same way for any displacement image chosen
// from the GUI dropdown.
function computeTightBounds(img, threshold = 15) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);

  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  if (x1 < x0 || y1 < y0) return { x: 0, y: 0, width, height }; // nothing above threshold

  const bboxW = x1 - x0;
  const bboxH = y1 - y0;
  const padX = bboxW * 0.03;
  const padY = bboxH * 0.1;
  const cx0 = Math.max(0, x0 - padX);
  const cy0 = Math.max(0, y0 - padY);
  const cx1 = Math.min(width, x1 + padX);
  const cy1 = Math.min(height, y1 + padY);
  return { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 };
}

// Baked into the repo (like data/releases.json) so every visitor sees the
// same curated presets with no backend — new ones get added by saving
// locally, exporting, and committing them here. Only used as a last-resort
// fallback if that fetch fails; see loadSharedPresets().
const FALLBACK_PRESET = {
  roughness: 0.34,
  metalness: 0.48,
  color: "#ff0000",
  refraction: true,
  ior: 2.333,
  dispersion: 1.84,
  thickness: 0,
  envMap: "https://fractalfantasy.net/waterball/build/pano/pano36.jpg",
  lightX: -0.85,
  lightY: 1.08,
  lightZ: 0.57,
  lightIntensity: 4.1,
  logoImage: "vvlogoblur-tight.png",
  reliefHeight: 0.04,
  pointerRadius: 0.155,
  pointerStrength: 0.025,
  meshResolution: 45000,
  bloomStrength: 1,
  bloomRadius: 0.41,
  bloomThreshold: 0.85,
  bloomSoftness: 0.01,
};

const PRESETS_STORAGE_KEY = "vv-presets";

async function loadSharedPresets() {
  try {
    const res = await fetch("data/presets.json");
    const presets = await res.json();
    if (presets && Object.keys(presets).length > 0) return presets;
  } catch {
    // fall through to the fallback below
  }
  return { "Red Candy Paint": FALLBACK_PRESET };
}

function loadCustomPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

async function init() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // Shared presets are baked into the repo and the same for every visitor;
  // custom ones are saved locally (per browser, via the Presets folder) and
  // take priority over a shared preset of the same name. One of the pooled
  // presets is picked at random below to seed the initial look.
  const sharedPresets = await loadSharedPresets();
  const customPresets = loadCustomPresets();
  const startupPresetPool = { ...sharedPresets, ...customPresets };
  const startupPresetNames = Object.keys(startupPresetPool);
  const startupPresetName = startupPresetNames[Math.floor(Math.random() * startupPresetNames.length)];
  const startupPreset = startupPresetPool[startupPresetName];

  const LOGO_IMAGE_BASE = "assets/img/site/";
  const logoImageOptions = {
    "Blur (tight)": "vvlogoblur-tight.png",
    "Blur (original)": "vvlogoblur.png",
    "Blur 2": "vvlogoblur2.png",
    "Blur 3": "vvlogoblur3.png",
  };
  let logoImage = await loadImage(LOGO_IMAGE_BASE + startupPreset.logoImage);
  let logoCrop = computeTightBounds(logoImage);
  // The cloth material has its own independent displacement image/amount —
  // defaults to the same picture as the liquid mesh's, but each can be
  // changed without affecting the other.
  let clothLogoImage = logoImage;
  let clothLogoCrop = logoCrop;

  // The banner is a fixed full-viewport background, so the mesh matches the
  // viewport's aspect instead of the logo's — the logo occupies a band at
  // the top of it, sized to its own proportions, with plain rippling cloth
  // filling the rest down to the bottom of the screen. Width is fixed at 1
  // "world unit"; height follows the viewport, and both the mesh and the
  // camera get rebuilt together whenever that aspect changes (debounced —
  // see resize() below) so they never drift out of sync with each other.
  const PLANE_WIDTH = 1;
  let LOGO_ASPECT = logoCrop.width / logoCrop.height;
  let LOGO_BAND_HEIGHT = PLANE_WIDTH / LOGO_ASPECT;
  let CLOTH_LOGO_ASPECT = LOGO_ASPECT;
  let CLOTH_LOGO_BAND_HEIGHT = LOGO_BAND_HEIGHT;
  // Where the logo band's own center sits, as a fraction of viewport height
  // down from the top. 0.5 = vertically centered.
  const LOGO_CENTER_FRACTION = 0.5;
  // Touch/coarse-pointer devices skew toward weaker GPUs, so start them at
  // the Mesh folder's "Low" resolution regardless of what the preset asks
  // for.
  const IS_MOBILE = window.matchMedia("(pointer: coarse)").matches;
  let VERTEX_BUDGET = IS_MOBILE ? 12000 : startupPreset.meshResolution;
  // The cloth sim's folds read fine at a much lower vertex count than the
  // logo relief needs, and it's off by default, so this stays fixed rather
  // than following the liquid mesh's own resolution setting.
  let CLOTH_VERTEX_BUDGET = IS_MOBILE ? 300 : 800;
  const RELIEF_HEIGHT = startupPreset.reliefHeight;
  // Ripple impulse per unit of relief-height change, weighted by the logo's
  // own shape (so a slider move pokes the cloth roughly like a full-strength
  // pointer poke would at the max slider range, scaled down for smaller
  // moves) rather than just fading the target height in place.
  const RELIEF_RIPPLE_SCALE = 30;

  // Live-tunable liquid-sim parameters (see cloth.js for what each one
  // actually does to the wave equation). Kept separate from the Cloth
  // instance itself since buildCloth() replaces that instance on resize/
  // mesh-resolution/logo-image changes — these survive a rebuild and get
  // reapplied to whatever the new instance is.
  const clothParams = {
    waveSpeed: 200,
    restoring: 56,
    damping: 3,
    maxVelocity: 500,
    depthGain: 10,
    // The reference's own default (9.45) was tuned for a much larger world
    // scale; on our unit-height plane it blew Z-displacement out past the
    // plane's own size, so this starts much lower.
    displacementScale: 0.8,
  };

  // Independent of the liquid mesh — off by default, and its physics update
  // is skipped entirely (not just hidden) while disabled, so it costs
  // nothing until switched on.
  const clothSimParams = {
    enabled: false,
    gravity: -0.35,
    wind: 0.25,
    damping: 0.98,
    // Treats the liquid mesh's current surface as a floor the cloth can't
    // sink below — off by default since it's an extra per-vertex height
    // lookup against the liquid grid every frame (cheap, but only worth
    // paying for when both meshes are actually shown together).
    collisions: false,
  };

  // Master on/off for the liquid mesh, mirroring clothSimParams.enabled —
  // skips cloth.update(dt) in the render loop entirely while off, not just
  // hiding the mesh.
  let liquidEnabled = true;

  let PLANE_HEIGHT;
  let cloth;
  let logoGray;
  let mesh;
  let verletCloth;
  let clothMesh;
  let clothLogoGray;
  let currentReliefHeight = 0; // what's actually baked into cloth.depthTarget right now
  let reliefHeightValue = RELIEF_HEIGHT; // last value asked for, survives mesh rebuilds
  let clothReliefHeightValue = RELIEF_HEIGHT;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-PLANE_WIDTH / 2, PLANE_WIDTH / 2, 0.5, -0.5, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const material = new THREE.MeshPhysicalMaterial({
    color: startupPreset.color,
    roughness: startupPreset.roughness,
    metalness: startupPreset.metalness,
    side: THREE.DoubleSide,
    transmission: startupPreset.refraction ? 1 : 0,
    ior: startupPreset.ior,
    dispersion: startupPreset.dispersion,
    thickness: startupPreset.thickness,
  });

  // Same set of params as the liquid material (see "Cloth Material" in the
  // GUI below) — starts out matching it too, then diverges independently.
  const clothMaterial = new THREE.MeshPhysicalMaterial({
    color: startupPreset.color,
    roughness: startupPreset.roughness,
    metalness: startupPreset.metalness,
    side: THREE.DoubleSide,
    transmission: startupPreset.refraction ? 1 : 0,
    ior: startupPreset.ior,
    dispersion: startupPreset.dispersion,
    thickness: startupPreset.thickness,
  });

  function applyReliefHeight(height, { ripple = false } = {}) {
    const delta = height - currentReliefHeight;
    for (let i = 0; i < cloth.count; i++) {
      cloth.depthTarget[i] = logoGray[i] * height;
      if (ripple) {
        cloth.v[i] += logoGray[i] * delta * RELIEF_RIPPLE_SCALE;
      }
    }
    currentReliefHeight = height;
    reliefHeightValue = height;
  }

  // The cloth sim's relief is embossed on top of its physics (see
  // depthTarget/depthOffset in verlet-cloth.js) rather than fed into the
  // constraint solver, so — unlike the liquid's — there's no ripple-impulse
  // variant.
  function applyClothReliefHeight(height) {
    for (let i = 0; i < verletCloth.count; i++) {
      verletCloth.depthTarget[i] = clothLogoGray[i] * height;
    }
    clothReliefHeightValue = height;
  }

  // (Re)builds the cloth grid and its logo-band bake to match the current
  // viewport aspect, swapping the mesh in place. Safe to call repeatedly —
  // used both for the initial setup and every time the aspect settles after
  // a resize.
  // Rebuilds just the liquid mesh at VERTEX_BUDGET's current resolution —
  // split out from buildClothMesh() so changing one mesh's resolution
  // doesn't also rebuild the other.
  function buildLiquidMesh() {
    // Keep total vertex count roughly constant regardless of aspect, so a
    // tall/narrow mobile viewport doesn't end up with far more vertices (and
    // a much heavier per-frame simulation) than a wide desktop one.
    const segX = Math.max(20, Math.round(Math.sqrt(VERTEX_BUDGET / PLANE_HEIGHT)));
    const segY = Math.max(4, Math.round(segX * PLANE_HEIGHT));

    const newCloth = new Cloth({
      width: PLANE_WIDTH,
      height: PLANE_HEIGHT,
      segmentsX: segX,
      segmentsY: segY,
    });
    Object.assign(newCloth, clothParams);

    // Bake the logo into a band near the top of the cloth's resting shape
    // (centered at LOGO_CENTER_FRACTION down) as a static depth target;
    // everything outside the band stays flat (0).
    const gridW = segX + 1;
    const bandRows = Math.max(1, Math.round(segY * (LOGO_BAND_HEIGHT / PLANE_HEIGHT)));
    const bandCenterRow = Math.round(segY * LOGO_CENTER_FRACTION);
    const bandStartRow = Math.max(0, Math.round(bandCenterRow - bandRows / 2));
    const pixels = sampleImageGrid(logoImage, gridW, bandRows + 1, logoCrop);
    const newLogoGray = new Float32Array(newCloth.count); // zero-filled outside the band
    for (let i = 0; i <= bandRows; i++) {
      const gy = bandStartRow + i;
      for (let gx = 0; gx < gridW; gx++) {
        const p = (i * gridW + gx) * 4;
        newLogoGray[newCloth.index(gx, gy)] = pixels[p] / 255; // R channel; logo is grayscale
      }
    }

    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }

    cloth = newCloth;
    logoGray = newLogoGray;
    currentReliefHeight = 0;
    applyReliefHeight(reliefHeightValue);

    mesh = new THREE.Mesh(cloth.geometry, material);
    mesh.visible = liquidEnabled;
    scene.add(mesh);
  }

  // Rebuilds just the cloth-sim mesh — see buildLiquidMesh() above.
  function buildClothMesh() {
    const clothSegX = Math.max(10, Math.round(Math.sqrt(CLOTH_VERTEX_BUDGET / PLANE_HEIGHT)));
    const clothSegY = Math.max(6, Math.round(clothSegX * PLANE_HEIGHT));
    if (clothMesh) {
      scene.remove(clothMesh);
      clothMesh.geometry.dispose();
    }
    verletCloth = new VerletCloth({
      width: PLANE_WIDTH,
      height: PLANE_HEIGHT,
      segmentsX: clothSegX,
      segmentsY: clothSegY,
    });
    verletCloth.gravity = clothSimParams.gravity;
    verletCloth.wind = clothSimParams.wind;
    verletCloth.damping = clothSimParams.damping;

    // Bakes the cloth's own (independently chosen) displacement image onto
    // its own grid, same band-placement logic as the liquid mesh above.
    const clothGridW = clothSegX + 1;
    const clothBandRows = Math.max(1, Math.round(clothSegY * (CLOTH_LOGO_BAND_HEIGHT / PLANE_HEIGHT)));
    const clothBandCenterRow = Math.round(clothSegY * LOGO_CENTER_FRACTION);
    const clothBandStartRow = Math.max(0, Math.round(clothBandCenterRow - clothBandRows / 2));
    const clothPixels = sampleImageGrid(clothLogoImage, clothGridW, clothBandRows + 1, clothLogoCrop);
    const newClothLogoGray = new Float32Array(verletCloth.count);
    for (let i = 0; i <= clothBandRows; i++) {
      const gy = clothBandStartRow + i;
      for (let gx = 0; gx < clothGridW; gx++) {
        const p = (i * clothGridW + gx) * 4;
        newClothLogoGray[verletCloth.index(gx, gy)] = clothPixels[p] / 255;
      }
    }
    clothLogoGray = newClothLogoGray;
    applyClothReliefHeight(clothReliefHeightValue);

    clothMesh = new THREE.Mesh(verletCloth.geometry, clothMaterial);
    clothMesh.position.z = 0.02; // clears the liquid mesh's own surface if both are shown at once
    clothMesh.visible = clothSimParams.enabled;
    scene.add(clothMesh);
  }

  // Rebuilds both meshes and refits the camera — used for the initial setup
  // and on resize, where the viewport aspect (and so both meshes' segment
  // counts) actually changes. A resolution-dropdown change only needs to
  // rebuild its own mesh, so those call buildLiquidMesh()/buildClothMesh()
  // directly instead.
  function buildCloth() {
    PLANE_HEIGHT = window.innerHeight / window.innerWidth;
    buildLiquidMesh();
    buildClothMesh();
    camera.top = PLANE_HEIGHT / 2;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
  }

  buildCloth();

  const pointLight = new THREE.PointLight(0xffffff, startupPreset.lightIntensity, 0, 0);
  pointLight.position.set(startupPreset.lightX, startupPreset.lightY, startupPreset.lightZ);
  scene.add(pointLight);

  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(ambient);

  // ---------- debug controls ----------
  const guiParams = {
    roughness: material.roughness,
    metalness: material.metalness,
    color: "#" + material.color.getHexString(),
    lightX: pointLight.position.x,
    lightY: pointLight.position.y,
    lightZ: pointLight.position.z,
    lightIntensity: pointLight.intensity,
    reliefHeight: RELIEF_HEIGHT,
  };

  // Mutable so the pointer-interaction code (defined further down) can read
  // whatever the GUI slider is currently set to.
  const pointerParams = { radius: startupPreset.pointerRadius, strength: startupPreset.pointerStrength };

  // dat.gui's auto-scroll ("taller than window") math assumes the panel is
  // anchored from the top of the screen and clamps its open height to the
  // remaining space below it; anchored from the bottom (below) instead,
  // that space reads as ~0 and the panel opens with no visible content.
  // We don't need its scrolling — folders default closed anyway — so it's
  // simplest to turn the feature off outright.
  const gui = new GUI({ scrollable: false });

  // Added directly to the root gui (not a folder) so it renders as its own
  // row above every folder, including Presets. Off by default — the fps
  // value only gets computed/updated in the render loop while the checkbox
  // is on, so there's no cost when it's not in use. `.listen()` is dat.gui's
  // built-in "poll this property and keep the display live" mechanism.
  guiParams.showFps = false;
  gui.add(guiParams, "showFps").name("FPS counter");
  guiParams.fps = 0;
  gui.add(guiParams, "fps").name("fps").listen();

  // Populated near the end of init(), once every other controller exists to
  // wire a snapshot/apply system to — created here first just so it renders
  // at the top of the panel.
  const presetsFolder = gui.addFolder("Presets");

  const materialFolder = gui.addFolder("Liquid Material");
  guiParams.liquidEnabled = liquidEnabled;
  const liquidEnabledCtrl = materialFolder.add(guiParams, "liquidEnabled").name("enabled").onChange((v) => {
    liquidEnabled = v;
    mesh.visible = v;
  });
  const roughnessCtrl = materialFolder.add(guiParams, "roughness", 0, 1, 0.01);
  const metalnessCtrl = materialFolder.add(guiParams, "metalness", 0, 1, 0.01);
  const colorCtrl = materialFolder.addColor(guiParams, "color").onChange((v) => { material.color.set(v); });

  guiParams.refraction = material.transmission > 0;
  guiParams.ior = material.ior;
  guiParams.dispersion = material.dispersion;
  // WebGPU/TSL compiles a material's node graph once and caches it; toggling
  // transmission on switches which lighting-model branch that graph needs
  // (plain PBR vs. IBL volume refraction), so it has to be told to rebuild —
  // just mutating the property is silently ignored by the cached shader.
  const refractionCtrl = materialFolder.add(guiParams, "refraction").onChange((v) => {
    material.transmission = v ? 1 : 0;
    material.needsUpdate = true;
  });
  const iorCtrl = materialFolder.add(guiParams, "ior", 1, 2.333, 0.001).name("index of refraction").onChange((v) => {
    material.ior = v;
    material.needsUpdate = true;
  });
  // Dispersion only has a visible effect once refraction/transmission is on.
  const dispersionCtrl = materialFolder.add(guiParams, "dispersion", 0, 5, 0.01).name("chromatic aberration").onChange((v) => {
    material.dispersion = v;
    material.needsUpdate = true;
  });
  guiParams.thickness = material.thickness;
  // The actual bend/distortion (not just IOR's Fresnel-reflectivity effect)
  // scales with thickness — see the comment where the material is created.
  const thicknessCtrl = materialFolder.add(guiParams, "thickness", 0, 1, 0.005).name("refraction depth").onChange((v) => {
    material.thickness = v;
    material.needsUpdate = true;
  });

  // Hotlinked rather than vendored — 130 panoramas would bloat the repo,
  // and the host already serves them with permissive CORS headers so they
  // can be loaded straight into a WebGPU texture.
  const ENVMAP_BASE = "https://fractalfantasy.net/waterball/build/pano/";
  const envMapOptions = { None: "" };
  for (let i = 3; i <= 132; i++) envMapOptions[`Pano ${i}`] = `${ENVMAP_BASE}pano${i}.jpg`;

  const textureLoader = new THREE.TextureLoader();
  let currentEnvTexture = null;
  let currentBackgroundTexture = null;

  // The cloth mesh fills the whole viewport and is the only other thing in
  // the scene, so refraction/transmission had nothing behind it to sample —
  // it read a flat black backdrop no matter what thickness/IOR was set to.
  // A big sphere textured on the inside gives the camera (which sits well
  // inside it) an actual surrounding environment to bend through, the way
  // a skybox works — it stays hidden behind the opaque mesh normally and
  // only shows/warps once transmission reveals it.
  const BACKGROUND_SPHERE_RADIUS = 6;
  const backgroundSphere = new THREE.Mesh(
    new THREE.SphereGeometry(BACKGROUND_SPHERE_RADIUS, 60, 40),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
  );
  backgroundSphere.visible = false;
  scene.add(backgroundSphere);

  function setEnvMap(url) {
    const previousTexture = currentEnvTexture;
    const previousBackground = currentBackgroundTexture;
    if (!url) {
      scene.environment = null;
      backgroundSphere.visible = false;
      currentEnvTexture = null;
      currentBackgroundTexture = null;
      if (previousTexture) previousTexture.dispose();
      if (previousBackground) previousBackground.dispose();
      return;
    }
    textureLoader.load(url, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      scene.environment = tex;
      currentEnvTexture = tex;
      if (previousTexture) previousTexture.dispose();
    });
    // Loaded as a separate Texture (not reusing the equirect one) since the
    // sphere needs the image mapped by its own UVs, not by view direction.
    textureLoader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      backgroundSphere.material.map = tex;
      backgroundSphere.material.needsUpdate = true;
      backgroundSphere.visible = true;
      currentBackgroundTexture = tex;
      if (previousBackground) previousBackground.dispose();
    });
  }

  // The cloth material's own env map is a per-material override (rather
  // than going through scene.environment like the liquid's) so the two can
  // reflect different panoramas independently. It doesn't drive the
  // background sphere — that stays tied to the liquid's choice, since one
  // skybox is enough to give refraction something to bend.
  let currentClothEnvTexture = null;
  function setClothEnvMap(url) {
    const previousTexture = currentClothEnvTexture;
    if (!url) {
      clothMaterial.envMap = null;
      clothMaterial.needsUpdate = true;
      currentClothEnvTexture = null;
      if (previousTexture) previousTexture.dispose();
      return;
    }
    textureLoader.load(url, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      clothMaterial.envMap = tex;
      clothMaterial.needsUpdate = true;
      currentClothEnvTexture = tex;
      if (previousTexture) previousTexture.dispose();
    });
  }

  guiParams.envMap = startupPreset.envMap;
  const envMapCtrl = materialFolder.add(guiParams, "envMap", envMapOptions).name("env map").onChange(setEnvMap);
  setEnvMap(guiParams.envMap);

  guiParams.logoImage = startupPreset.logoImage;
  const logoImageCtrl = materialFolder.add(guiParams, "logoImage", logoImageOptions).name("displacement image").onChange(async (filename) => {
    logoImage = await loadImage(LOGO_IMAGE_BASE + filename);
    logoCrop = computeTightBounds(logoImage);
    LOGO_ASPECT = logoCrop.width / logoCrop.height;
    LOGO_BAND_HEIGHT = PLANE_WIDTH / LOGO_ASPECT;
    buildCloth();
  });
  // dat.gui's setValue() rounds every value to the nearest step — including
  // ones set programmatically by an animator, not just manual drags — so a
  // coarse step here visibly staircases the animated depth-map amount
  // instead of moving smoothly.
  const reliefCtrl = materialFolder.add(guiParams, "reliefHeight", 0, 0.6, 0.0001).name("depth map amount");

  // ---------- cloth material ----------
  // Same set of controls as Liquid Material above, driving the separate
  // clothMaterial/verletCloth instead — including its own independent
  // displacement image/amount, not tied to the liquid mesh's choice. Reuses
  // the same envMapOptions/logoImageOptions lists rather than duplicating
  // them, and the same scene-level environment (there's only one skybox;
  // both materials reflect/refract it automatically).
  const clothMaterialFolder = gui.addFolder("Cloth Material");
  guiParams.clothEnabled = clothSimParams.enabled;
  const clothEnabledCtrl = clothMaterialFolder.add(guiParams, "clothEnabled").name("enabled").onChange((v) => {
    clothSimParams.enabled = v;
    clothMesh.visible = v;
  });
  guiParams.clothRoughness = clothMaterial.roughness;
  const clothRoughnessCtrl = clothMaterialFolder.add(guiParams, "clothRoughness", 0, 1, 0.01).name("roughness").onChange((v) => { clothMaterial.roughness = v; });
  guiParams.clothMetalness = clothMaterial.metalness;
  const clothMetalnessCtrl = clothMaterialFolder.add(guiParams, "clothMetalness", 0, 1, 0.01).name("metalness").onChange((v) => { clothMaterial.metalness = v; });
  guiParams.clothColor = "#" + clothMaterial.color.getHexString();
  const clothColorCtrl = clothMaterialFolder.addColor(guiParams, "clothColor").name("color").onChange((v) => { clothMaterial.color.set(v); });
  guiParams.clothRefraction = clothMaterial.transmission > 0;
  const clothRefractionCtrl = clothMaterialFolder.add(guiParams, "clothRefraction").name("refraction").onChange((v) => {
    clothMaterial.transmission = v ? 1 : 0;
    clothMaterial.needsUpdate = true;
  });
  guiParams.clothIor = clothMaterial.ior;
  const clothIorCtrl = clothMaterialFolder.add(guiParams, "clothIor", 1, 2.333, 0.001).name("index of refraction").onChange((v) => {
    clothMaterial.ior = v;
    clothMaterial.needsUpdate = true;
  });
  guiParams.clothDispersion = clothMaterial.dispersion;
  const clothDispersionCtrl = clothMaterialFolder.add(guiParams, "clothDispersion", 0, 5, 0.01).name("chromatic aberration").onChange((v) => {
    clothMaterial.dispersion = v;
    clothMaterial.needsUpdate = true;
  });
  guiParams.clothThickness = clothMaterial.thickness;
  const clothThicknessCtrl = clothMaterialFolder.add(guiParams, "clothThickness", 0, 1, 0.005).name("refraction depth").onChange((v) => {
    clothMaterial.thickness = v;
    clothMaterial.needsUpdate = true;
  });
  // Defaults to None (no extra texture load) rather than mirroring the
  // liquid's env map — independent by default, same as every other cloth
  // material param.
  guiParams.clothEnvMap = "";
  const clothEnvMapCtrl = clothMaterialFolder.add(guiParams, "clothEnvMap", envMapOptions).name("env map").onChange(setClothEnvMap);
  guiParams.clothLogoImage = startupPreset.logoImage;
  const clothLogoImageCtrl = clothMaterialFolder.add(guiParams, "clothLogoImage", logoImageOptions).name("displacement image").onChange(async (filename) => {
    clothLogoImage = await loadImage(LOGO_IMAGE_BASE + filename);
    clothLogoCrop = computeTightBounds(clothLogoImage);
    CLOTH_LOGO_ASPECT = clothLogoCrop.width / clothLogoCrop.height;
    CLOTH_LOGO_BAND_HEIGHT = PLANE_WIDTH / CLOTH_LOGO_ASPECT;
    buildCloth();
  });
  guiParams.clothReliefHeight = clothReliefHeightValue;
  const clothReliefCtrl = clothMaterialFolder.add(guiParams, "clothReliefHeight", 0, 0.6, 0.0001).name("depth map amount").onChange(applyClothReliefHeight);

  const lightFolder = gui.addFolder("Point Light");
  const lightXCtrl = lightFolder.add(guiParams, "lightX", -2, 2, 0.01);
  const lightYCtrl = lightFolder.add(guiParams, "lightY", -2, 2, 0.01);
  const lightZCtrl = lightFolder.add(guiParams, "lightZ", 0, 5, 0.01);
  const lightIntensityCtrl = lightFolder.add(guiParams, "lightIntensity", 0, 20, 0.1).name("brightness");

  // ---------- liquid sim ----------
  const liquidFolder = gui.addFolder("Liquid Sim");
  guiParams.waveSpeed = clothParams.waveSpeed;
  guiParams.restoring = clothParams.restoring;
  guiParams.damping = clothParams.damping;
  guiParams.depthGain = clothParams.depthGain;
  guiParams.displacementScale = clothParams.displacementScale;
  guiParams.maxVelocity = clothParams.maxVelocity;

  // Applies to clothParams (so a rebuild from buildCloth() keeps the value)
  // and directly to the live cloth instance (so it takes effect immediately
  // without needing one).
  function addClothParamCtrl(key, min, max, step, label) {
    return liquidFolder.add(guiParams, key, min, max, step).name(label).onChange((v) => {
      clothParams[key] = v;
      cloth[key] = v;
    });
  }

  const waveSpeedCtrl = addClothParamCtrl("waveSpeed", 0, 800, 1, "wave speed");
  const restoringCtrl = addClothParamCtrl("restoring", 0, 200, 1, "stiffness");
  const dampingCtrl = addClothParamCtrl("damping", 0, 20, 0.1, "damping");
  const depthGainCtrl = addClothParamCtrl("depthGain", 0, 50, 0.5, "logo growth rate");
  const displacementScaleCtrl = addClothParamCtrl("displacementScale", 0, 3, 0.01, "height scale");
  const maxVelocityCtrl = addClothParamCtrl("maxVelocity", 50, 2000, 10, "max velocity (safety clamp)");

  // ---------- cloth sim ----------
  // A second, independent mesh (see verlet-cloth.js) — off by default, and
  // its physics update is skipped entirely while disabled (not just
  // hidden), so it costs nothing until switched on. Can be shown alongside
  // the liquid mesh or on its own.
  const clothSimFolder = gui.addFolder("Cloth Sim");
  guiParams.clothCollisions = clothSimParams.collisions;
  const clothCollisionsCtrl = clothSimFolder.add(guiParams, "clothCollisions").name("activate collisions").onChange((v) => {
    clothSimParams.collisions = v;
  });
  guiParams.clothGravity = clothSimParams.gravity;
  const clothGravityCtrl = clothSimFolder.add(guiParams, "clothGravity", -2, 0, 0.01).name("gravity").onChange((v) => {
    clothSimParams.gravity = v;
    verletCloth.gravity = v;
  });
  guiParams.clothWind = clothSimParams.wind;
  const clothWindCtrl = clothSimFolder.add(guiParams, "clothWind", 0, 2, 0.01).name("wind").onChange((v) => {
    clothSimParams.wind = v;
    verletCloth.wind = v;
  });
  guiParams.clothDamping = clothSimParams.damping;
  const clothDampingCtrl = clothSimFolder.add(guiParams, "clothDamping", 0.8, 1, 0.001).name("damping").onChange((v) => {
    clothSimParams.damping = v;
    verletCloth.damping = v;
  });

  // Pointer interaction controls live under Liquid Sim — "mouse size" also
  // doubles as the cloth's grab radius (see onPointerMove), but it's a
  // physics-feel knob either way, not a material property.
  const pointerRadiusCtrl = liquidFolder.add(pointerParams, "radius", 0.01, 0.3, 0.005).name("mouse size");
  const pointerStrengthCtrl = liquidFolder.add(pointerParams, "strength", 0, 0.2, 0.005).name("liquid amount");

  const meshResolutionOptions = { Low: 12000, Medium: 45000, High: 110000, "Very High": 220000 };
  guiParams.meshResolution = VERTEX_BUDGET;
  const meshResolutionCtrl = materialFolder.add(guiParams, "meshResolution", meshResolutionOptions).name("resolution").onChange((v) => {
    VERTEX_BUDGET = Number(v);
    buildLiquidMesh();
  });

  // Much lower than the liquid's own tiers — a real 3D constraint-solved
  // cloth costs far more per vertex than the liquid's cheap height field
  // (iterative relaxation over ~4 constraints/vertex, every frame), so
  // reusing the liquid's vertex counts here would get heavy fast.
  const clothMeshResolutionOptions = { Low: 150, Medium: 400, High: 800, "Very High": 1600 };
  guiParams.clothMeshResolution = CLOTH_VERTEX_BUDGET;
  const clothMeshResolutionCtrl = clothMaterialFolder.add(guiParams, "clothMeshResolution", clothMeshResolutionOptions).name("resolution").onChange((v) => {
    CLOTH_VERTEX_BUDGET = Number(v);
    buildClothMesh();
  });

  // ---------- post-processing (bloom) ----------
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = THREE.pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();

  const BLOOM_STRENGTH = 1;
  const BLOOM_RADIUS = 0.41;
  const BLOOM_THRESHOLD = 0.85;
  const bloomPass = bloom(sceneColor, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  const bloomOutputNode = sceneColor.add(bloomPass);
  postProcessing.outputNode = BLOOM_STRENGTH > 0 ? bloomOutputNode : sceneColor;

  // The bloom node still runs its downsample/blur passes every frame purely
  // by being part of the output graph, regardless of how low its strength
  // uniform is — skipping it at 0 means swapping it out of the graph
  // entirely, not just multiplying by zero.
  function applyBloomStrength(v) {
    bloomPass.strength.value = v;
    const shouldBloom = v > 0;
    const isBloomOn = postProcessing.outputNode === bloomOutputNode;
    if (shouldBloom !== isBloomOn) {
      postProcessing.outputNode = shouldBloom ? bloomOutputNode : sceneColor;
      postProcessing.needsUpdate = true;
    }
  }

  guiParams.bloomStrength = BLOOM_STRENGTH;
  guiParams.bloomRadius = BLOOM_RADIUS;
  guiParams.bloomSoftness = bloomPass.smoothWidth.value;
  guiParams.bloomThreshold = BLOOM_THRESHOLD;

  const bloomFolder = gui.addFolder("Bloom");
  const bloomStrengthCtrl = bloomFolder.add(guiParams, "bloomStrength", 0, 1, 0.01).name("amount");
  const bloomRadiusCtrl = bloomFolder.add(guiParams, "bloomRadius", 0, 1, 0.01).name("radius").onChange((v) => { bloomPass.radius.value = v; });
  const bloomThresholdCtrl = bloomFolder.add(guiParams, "bloomThreshold", 0, 1, 0.01).name("threshold");
  const bloomSoftnessCtrl = bloomFolder.add(guiParams, "bloomSoftness", 0, 0.5, 0.005).name("gradient softness").onChange((v) => { bloomPass.smoothWidth.value = v; });

  // ---------- presets ----------
  // A snapshot is just the plain values every relevant controller already
  // reads/writes; applying one is a series of controller.setValue() calls,
  // which re-fires each control's own onChange — same code path as a user
  // dragging it by hand — so material updates, buildCloth() (logo image /
  // mesh resolution) and setEnvMap() all happen automatically.
  function getPresetSnapshot() {
    return {
      roughness: guiParams.roughness,
      metalness: guiParams.metalness,
      color: guiParams.color,
      refraction: guiParams.refraction,
      ior: guiParams.ior,
      dispersion: guiParams.dispersion,
      thickness: guiParams.thickness,
      envMap: guiParams.envMap,
      lightX: guiParams.lightX,
      lightY: guiParams.lightY,
      lightZ: guiParams.lightZ,
      lightIntensity: guiParams.lightIntensity,
      logoImage: guiParams.logoImage,
      reliefHeight: guiParams.reliefHeight,
      pointerRadius: pointerParams.radius,
      pointerStrength: pointerParams.strength,
      meshResolution: guiParams.meshResolution,
      bloomStrength: guiParams.bloomStrength,
      bloomRadius: guiParams.bloomRadius,
      bloomThreshold: guiParams.bloomThreshold,
      bloomSoftness: guiParams.bloomSoftness,
      waveSpeed: guiParams.waveSpeed,
      restoring: guiParams.restoring,
      damping: guiParams.damping,
      depthGain: guiParams.depthGain,
      displacementScale: guiParams.displacementScale,
      maxVelocity: guiParams.maxVelocity,
      clothEnabled: guiParams.clothEnabled,
      clothCollisions: guiParams.clothCollisions,
      clothGravity: guiParams.clothGravity,
      clothWind: guiParams.clothWind,
      clothDamping: guiParams.clothDamping,
      clothRoughness: guiParams.clothRoughness,
      clothMetalness: guiParams.clothMetalness,
      clothColor: guiParams.clothColor,
      clothRefraction: guiParams.clothRefraction,
      clothIor: guiParams.clothIor,
      clothDispersion: guiParams.clothDispersion,
      clothThickness: guiParams.clothThickness,
      clothLogoImage: guiParams.clothLogoImage,
      clothReliefHeight: guiParams.clothReliefHeight,
      liquidEnabled: guiParams.liquidEnabled,
      clothEnvMap: guiParams.clothEnvMap,
      clothMeshResolution: guiParams.clothMeshResolution,
    };
  }

  const PRESET_CONTROLLERS = {
    liquidEnabled: liquidEnabledCtrl,
    roughness: roughnessCtrl, metalness: metalnessCtrl, color: colorCtrl,
    refraction: refractionCtrl, ior: iorCtrl, dispersion: dispersionCtrl, thickness: thicknessCtrl,
    envMap: envMapCtrl, lightX: lightXCtrl, lightY: lightYCtrl, lightZ: lightZCtrl,
    lightIntensity: lightIntensityCtrl, logoImage: logoImageCtrl, reliefHeight: reliefCtrl,
    pointerRadius: pointerRadiusCtrl, pointerStrength: pointerStrengthCtrl,
    meshResolution: meshResolutionCtrl, bloomStrength: bloomStrengthCtrl,
    bloomRadius: bloomRadiusCtrl, bloomThreshold: bloomThresholdCtrl, bloomSoftness: bloomSoftnessCtrl,
    waveSpeed: waveSpeedCtrl, restoring: restoringCtrl, damping: dampingCtrl,
    depthGain: depthGainCtrl, displacementScale: displacementScaleCtrl, maxVelocity: maxVelocityCtrl,
    clothEnabled: clothEnabledCtrl, clothCollisions: clothCollisionsCtrl, clothGravity: clothGravityCtrl,
    clothWind: clothWindCtrl, clothDamping: clothDampingCtrl,
    clothRoughness: clothRoughnessCtrl, clothMetalness: clothMetalnessCtrl, clothColor: clothColorCtrl,
    clothRefraction: clothRefractionCtrl, clothIor: clothIorCtrl, clothDispersion: clothDispersionCtrl,
    clothThickness: clothThicknessCtrl, clothEnvMap: clothEnvMapCtrl,
    clothLogoImage: clothLogoImageCtrl, clothReliefHeight: clothReliefCtrl,
    clothMeshResolution: clothMeshResolutionCtrl,
  };

  function applyPreset(snapshot) {
    if (!snapshot) return;
    for (const key in PRESET_CONTROLLERS) {
      if (snapshot[key] !== undefined) PRESET_CONTROLLERS[key].setValue(snapshot[key]);
    }
  }

  // A saved custom preset always wins over a shared one of the same name,
  // so overwriting e.g. "Red Candy Paint" sticks locally — the override is
  // what's in localStorage, not the version baked into data/presets.json.
  function resolvePreset(name) {
    return customPresets[name] || sharedPresets[name];
  }

  function saveCurrentAsPreset(name) {
    customPresets[name] = getPresetSnapshot();
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(customPresets));
  }

  let presetCtrl = null;
  function rebuildPresetDropdown(selected) {
    if (presetCtrl) presetsFolder.remove(presetCtrl);
    const options = Object.keys({ ...sharedPresets, ...customPresets });
    guiParams.preset = selected;
    presetCtrl = presetsFolder.add(guiParams, "preset", options).name("load preset").onChange((name) => {
      applyPreset(resolvePreset(name));
    });
  }

  guiParams.newPresetName = "";
  presetsFolder.add(guiParams, "newPresetName").name("new preset name");
  presetsFolder.add({
    save: () => {
      const name = guiParams.newPresetName.trim();
      if (!name) return;
      saveCurrentAsPreset(name);
      guiParams.newPresetName = "";
      rebuildPresetDropdown(name);
    },
  }, "save").name("+ save as preset");
  presetsFolder.add({
    save: () => {
      if (!guiParams.preset) return;
      saveCurrentAsPreset(guiParams.preset);
    },
  }, "save").name("+ save preset");

  // The scene was already built from startupPreset's values directly (see
  // top of init()), so this just makes the dropdown reflect that choice —
  // no need to re-apply it.
  rebuildPresetDropdown(startupPresetName);

  // ---------- animators ----------
  // Each animator drives one target parameter as base + amount*sin(2*pi*speed*t),
  // reusing that parameter's own controller (so its slider updates live and
  // whatever it's wired to — material, light, bloom, the depth-map's
  // ripple-on-change — still applies). "base" tracks whatever value was last
  // set by hand, not a fixed default: dragging a slider while its animator is
  // off re-centers future oscillation on the new value, and turning an
  // animator off snaps its target back to that last manually-set value
  // rather than leaving it wherever the sine wave stopped.
  let animatingNow = false;

  const animatableTargets = [
    { key: "roughness", label: "Material: Roughness", base: guiParams.roughness, ampMax: 0.5, controller: roughnessCtrl, apply: (v) => { material.roughness = v; } },
    { key: "metalness", label: "Material: Metalness", base: guiParams.metalness, ampMax: 0.5, controller: metalnessCtrl, apply: (v) => { material.metalness = v; } },
    { key: "lightX", label: "Point Light: X", base: guiParams.lightX, ampMax: 2, controller: lightXCtrl, apply: (v) => { pointLight.position.x = v; } },
    { key: "lightY", label: "Point Light: Y", base: guiParams.lightY, ampMax: 2, controller: lightYCtrl, apply: (v) => { pointLight.position.y = v; } },
    { key: "lightZ", label: "Point Light: Z", base: guiParams.lightZ, ampMax: 2.5, controller: lightZCtrl, apply: (v) => { pointLight.position.z = v; } },
    { key: "lightIntensity", label: "Point Light: Brightness", base: guiParams.lightIntensity, ampMax: 10, controller: lightIntensityCtrl, apply: (v) => { pointLight.intensity = v; } },
    { key: "reliefHeight", label: "Displacement: Depth Map Amount", base: guiParams.reliefHeight, ampMax: 0.3, controller: reliefCtrl, apply: (v) => { applyReliefHeight(v, { ripple: true }); } },
    { key: "bloomStrength", label: "Bloom: Amount", base: guiParams.bloomStrength, ampMax: 1, controller: bloomStrengthCtrl, apply: applyBloomStrength },
    { key: "bloomThreshold", label: "Bloom: Threshold", base: guiParams.bloomThreshold, ampMax: 0.5, controller: bloomThresholdCtrl, apply: (v) => { bloomPass.threshold.value = v; } },
  ];
  const targetOptions = {};
  animatableTargets.forEach((t) => { targetOptions[t.label] = t.key; });

  function setTargetValue(target, v) {
    animatingNow = true;
    target.controller.setValue(v);
    animatingNow = false;
  }

  animatableTargets.forEach((target) => {
    target.controller.onChange((v) => {
      target.apply(v);
      if (!animatingNow) target.base = v;
    });
  });

  // Waveforms all range over [-1, 1] like sine does, so swapping shape
  // doesn't require re-tuning an animator's amount.
  const WAVEFORMS = {
    sine: (phase) => Math.sin(2 * Math.PI * phase),
    square: (phase) => (Math.sin(2 * Math.PI * phase) >= 0 ? 1 : -1),
    saw: (phase) => 2 * (phase - Math.floor(phase)) - 1,
  };
  const waveformOptions = { Sine: "sine", Square: "square", Saw: "saw" };

  const animators = [];
  const animatorsFolder = gui.addFolder("Animators");

  let animatorCount = 0;

  function addAnimator(initial = {}) {
    animatorCount++;
    let currentTarget = animatableTargets.find((a) => a.key === initial.targetKey) || animatableTargets[0];
    const state = {
      targetKey: currentTarget.key,
      amount: initial.amount ?? 0,
      speed: initial.speed ?? 0.5,
      waveform: initial.waveform ?? "sine",
      enabled: initial.enabled ?? true,
    };
    const sub = animatorsFolder.addFolder(`Animator ${animatorCount}`);

    const targetCtrl = sub.add(state, "targetKey", targetOptions).name("parameter");
    const amountCtrl = sub.add(state, "amount", 0, currentTarget.ampMax, currentTarget.ampMax / 200).name("amount");
    sub.add(state, "speed", 0, 3, 0.01).name("speed");
    sub.add(state, "waveform", waveformOptions).name("waveform");
    const enabledCtrl = sub.add(state, "enabled");

    targetCtrl.onChange((key) => {
      // Snap the previous target back to its own last manual value before
      // handing control to the newly-selected one.
      setTargetValue(currentTarget, currentTarget.base);

      currentTarget = animatableTargets.find((a) => a.key === key);
      amountCtrl.max(currentTarget.ampMax);
      if (state.amount > currentTarget.ampMax) {
        state.amount = currentTarget.ampMax;
        amountCtrl.updateDisplay();
      }
    });

    enabledCtrl.onChange((isOn) => {
      if (!isOn) setTargetValue(currentTarget, currentTarget.base);
    });

    sub.add({
      remove: () => {
        if (state.enabled) setTargetValue(currentTarget, currentTarget.base);
        animatorsFolder.removeFolder(sub);
        const i = animators.indexOf(entry);
        if (i >= 0) animators.splice(i, 1);
      },
    }, "remove").name("− remove");

    if (initial.open) sub.open();

    const entry = { state };
    animators.push(entry);
  }

  animatorsFolder.add({ addAnimator: () => addAnimator({ open: true }) }, "addAnimator").name("+ Add Animator");

  addAnimator({ targetKey: "reliefHeight", amount: 0.037, speed: 0.24 });
  addAnimator({ targetKey: "lightX", amount: 0.49, speed: 0.13 });
  addAnimator({ targetKey: "lightY", amount: 0.47, speed: 0.07 });
  addAnimator({ targetKey: "reliefHeight", amount: 0.017, speed: 0.03, waveform: "square" });

  gui.close();

  function updateAnimators(t) {
    // Multiple animators can target the same parameter — sum their offsets
    // from that parameter's base rather than letting the last one processed
    // silently overwrite the others.
    const offsets = new Map();
    for (const { state } of animators) {
      if (!state.enabled) continue;
      const target = animatableTargets.find((a) => a.key === state.targetKey);
      if (!target) continue;
      const wave = (WAVEFORMS[state.waveform] || WAVEFORMS.sine)(state.speed * t);
      offsets.set(target.key, (offsets.get(target.key) || 0) + state.amount * wave);
    }
    for (const [key, offset] of offsets) {
      const target = animatableTargets.find((a) => a.key === key);
      setTargetValue(target, target.base + offset);
    }
  }

  // ---------- pointer interaction ----------
  // Orthographic camera looking straight on, so screen UV maps linearly
  // onto the plane's local X/Y — no raycasting needed.
  const FORCE_SCALE = 1400;
  const MAX_FORCE = 18;

  let lastLocalX = null;
  let lastLocalY = null;

  function localFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    return {
      x: (u - 0.5) * PLANE_WIDTH,
      y: (0.5 - v) * PLANE_HEIGHT,
    };
  }

  function onPointerMove(e) {
    const { x, y } = localFromEvent(e);
    if (lastLocalX !== null) {
      const dx = x - lastLocalX;
      const dy = y - lastLocalY;
      const speed = Math.sqrt(dx * dx + dy * dy);
      const strength = Math.min(speed * FORCE_SCALE, MAX_FORCE) * pointerParams.strength;
      if (strength > 0.001) {
        cloth.applyForce(x, y, pointerParams.radius, strength);
      }
    }
    // Reuses the same "mouse size" radius as the liquid poke rather than
    // adding a separate cloth-only control.
    if (clothSimParams.enabled) verletCloth.grabAt(x, y, x, y, 0, pointerParams.radius);
    lastLocalX = x;
    lastLocalY = y;
  }

  // touch-action:none (CSS) is what actually stops touch-drags from
  // scrolling the page; preventDefault here is just backup for browsers
  // that still try to turn a drag into a scroll/refresh gesture anyway.
  canvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    onPointerMove(e);
  });
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const { x, y } = localFromEvent(e);
    cloth.applyForce(x, y, pointerParams.radius * 1.4, MAX_FORCE * pointerParams.strength);
    if (clothSimParams.enabled) verletCloth.grabAt(x, y, x, y, 0, pointerParams.radius * 1.4);
    lastLocalX = x;
    lastLocalY = y;
  });
  canvas.addEventListener("pointerleave", () => {
    lastLocalX = null;
    lastLocalY = null;
  });

  // ---------- resize ----------
  // Every resize tick re-fits the renderer and camera to the new aspect
  // immediately (so the render never looks stretched), but rebuilding the
  // mesh itself — new segment counts, re-baking the logo band — is
  // debounced until the resize settles, since it's too heavy to redo on
  // every intermediate frame while someone's actively dragging the window
  // edge. The camera fit also runs once up front for initial sizing,
  // without scheduling a pointless rebuild moments after buildCloth() just
  // ran synchronously above.
  function fitToViewport() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);

    const aspect = h / w;
    camera.top = (PLANE_WIDTH * aspect) / 2;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
  }

  let rebuildTimer = null;

  function onWindowResize() {
    fitToViewport();
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(buildCloth, 300);
  }

  window.addEventListener("resize", onWindowResize);
  if (window.ResizeObserver) new ResizeObserver(onWindowResize).observe(canvas);
  fitToViewport();

  // ---------- render loop ----------
  let raf = null;
  let lastTime = performance.now();
  let fpsSmoothed = 0;

  async function frame(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    updateAnimators(now / 1000);
    if (liquidEnabled) cloth.update(dt);
    if (clothSimParams.enabled) {
      verletCloth.simulate(dt, now / 1000, clothSimParams.collisions ? (x, y) => cloth.heightAt(x, y) : undefined);
    }

    if (guiParams.showFps && dt > 0) {
      const instantFps = 1 / dt;
      fpsSmoothed = fpsSmoothed ? fpsSmoothed * 0.9 + instantFps * 0.1 : instantFps;
      guiParams.fps = Math.round(fpsSmoothed);
    } else if (guiParams.fps !== 0) {
      guiParams.fps = 0;
    }

    await postProcessing.renderAsync();

    raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!raf) {
      lastTime = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  raf = requestAnimationFrame(frame);
}
