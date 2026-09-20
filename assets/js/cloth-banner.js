import * as THREE from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GUI } from "dat.gui";
import { Cloth } from "./cloth.js";

const canvas = document.getElementById("liquid-canvas");
const fallback = document.querySelector(".hero-fallback");

const AA_STORAGE_KEY = "vv-antialias";
function getAntialiasPref() {
  return localStorage.getItem(AA_STORAGE_KEY) !== "off"; // on by default
}

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
// vertex grid would alias into a patchy, noisy-looking relief.
function sampleImageGrid(img, gridW, gridH) {
  const c = document.createElement("canvas");
  c.width = gridW;
  c.height = gridH;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, gridW, gridH);
  return ctx.getImageData(0, 0, gridW, gridH).data;
}

async function init() {
  // MSAA sample count is baked into the post-processing pipeline the first
  // time it compiles, so toggling it live isn't reliable — the GUI checkbox
  // instead stores a preference and reloads the page to apply it cleanly.
  const antialias = getAntialiasPref();
  const renderer = new THREE.WebGPURenderer({ canvas, antialias, alpha: false });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const logoImage = await loadImage("assets/img/site/vvlogoblur-tight.png");

  // The banner is a fixed full-viewport background, so the mesh matches the
  // viewport's aspect instead of the logo's — the logo occupies a band at
  // the top of it, sized to its own proportions, with plain rippling cloth
  // filling the rest down to the bottom of the screen. Width is fixed at 1
  // "world unit"; height follows the viewport, and both the mesh and the
  // camera get rebuilt together whenever that aspect changes (debounced —
  // see resize() below) so they never drift out of sync with each other.
  const PLANE_WIDTH = 1;
  const LOGO_ASPECT = 732 / 240; // vvlogoblur-tight.png, cropped tight to the letters
  const LOGO_BAND_HEIGHT = PLANE_WIDTH / LOGO_ASPECT;
  // Where the logo band's own center sits, as a fraction of viewport height
  // down from the top. 0.5 = vertically centered.
  const LOGO_CENTER_FRACTION = 0.5;
  let VERTEX_BUDGET = 45000;
  const RELIEF_HEIGHT = 0.04;
  // Ripple impulse per unit of relief-height change, weighted by the logo's
  // own shape (so a slider move pokes the cloth roughly like a full-strength
  // pointer poke would at the max slider range, scaled down for smaller
  // moves) rather than just fading the target height in place.
  const RELIEF_RIPPLE_SCALE = 30;

  let PLANE_HEIGHT;
  let cloth;
  let logoGray;
  let mesh;
  let currentReliefHeight = 0; // what's actually baked into cloth.depthTarget right now
  let reliefHeightValue = RELIEF_HEIGHT; // last value asked for, survives mesh rebuilds

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-PLANE_WIDTH / 2, PLANE_WIDTH / 2, 0.5, -0.5, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const material = new THREE.MeshStandardMaterial({
    color: 0x161616,
    roughness: 0.25,
    metalness: 0.31,
    side: THREE.DoubleSide,
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

  // (Re)builds the cloth grid and its logo-band bake to match the current
  // viewport aspect, swapping the mesh in place. Safe to call repeatedly —
  // used both for the initial setup and every time the aspect settles after
  // a resize.
  function buildCloth() {
    PLANE_HEIGHT = window.innerHeight / window.innerWidth;

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
    // The reference's displacementScale (9.45) was tuned for a much larger
    // world scale; on our unit-height plane it blew Z-displacement out past
    // the plane's own size. Scale it down to a subtle emboss instead.
    newCloth.displacementScale = 0.8;

    // Bake the logo into a band near the top of the cloth's resting shape
    // (centered at LOGO_CENTER_FRACTION down) as a static depth target;
    // everything outside the band stays flat (0).
    const gridW = segX + 1;
    const bandRows = Math.max(1, Math.round(segY * (LOGO_BAND_HEIGHT / PLANE_HEIGHT)));
    const bandCenterRow = Math.round(segY * LOGO_CENTER_FRACTION);
    const bandStartRow = Math.max(0, Math.round(bandCenterRow - bandRows / 2));
    const pixels = sampleImageGrid(logoImage, gridW, bandRows + 1);
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
    scene.add(mesh);

    camera.top = PLANE_HEIGHT / 2;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
  }

  buildCloth();

  const pointLight = new THREE.PointLight(0xffffff, 20, 0, 0);
  pointLight.position.set(-0.35, 0.59, 0.57);
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
  const pointerParams = { radius: 0.155, strength: 0.08 };

  const gui = new GUI();

  const materialFolder = gui.addFolder("Material");
  const roughnessCtrl = materialFolder.add(guiParams, "roughness", 0, 1, 0.01);
  const metalnessCtrl = materialFolder.add(guiParams, "metalness", 0, 1, 0.01);
  materialFolder.addColor(guiParams, "color").onChange((v) => { material.color.set(v); });

  const lightFolder = gui.addFolder("Point Light");
  const lightXCtrl = lightFolder.add(guiParams, "lightX", -2, 2, 0.01);
  const lightYCtrl = lightFolder.add(guiParams, "lightY", -2, 2, 0.01);
  const lightZCtrl = lightFolder.add(guiParams, "lightZ", 0, 5, 0.01);
  const lightIntensityCtrl = lightFolder.add(guiParams, "lightIntensity", 0, 20, 0.1).name("brightness");

  const displacementFolder = gui.addFolder("Displacement");
  const reliefCtrl = displacementFolder.add(guiParams, "reliefHeight", 0, 0.6, 0.005).name("depth map amount");

  const pointerFolder = gui.addFolder("Pointer");
  pointerFolder.add(pointerParams, "radius", 0.01, 0.3, 0.005).name("mouse size");
  pointerFolder.add(pointerParams, "strength", 0, 0.2, 0.005).name("liquid amount");

  const meshFolder = gui.addFolder("Mesh");
  const meshResolutionOptions = { Low: 12000, Medium: 45000, High: 110000, "Very High": 220000 };
  guiParams.meshResolution = VERTEX_BUDGET;
  meshFolder.add(guiParams, "meshResolution", meshResolutionOptions).name("resolution").onChange((v) => {
    VERTEX_BUDGET = Number(v);
    buildCloth();
  });
  guiParams.antialiasing = getAntialiasPref();
  meshFolder.add(guiParams, "antialiasing").name("antialiasing (reloads)").onChange((v) => {
    localStorage.setItem(AA_STORAGE_KEY, v ? "on" : "off");
    location.reload();
  });

  // ---------- post-processing (bloom) ----------
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = THREE.pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();

  const BLOOM_STRENGTH = 0.41;
  const BLOOM_RADIUS = 0.4;
  const BLOOM_THRESHOLD = 1;
  const bloomPass = bloom(sceneColor, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  postProcessing.outputNode = sceneColor.add(bloomPass);

  guiParams.bloomStrength = BLOOM_STRENGTH;
  guiParams.bloomRadius = BLOOM_RADIUS;
  guiParams.bloomSoftness = bloomPass.smoothWidth.value;
  guiParams.bloomThreshold = BLOOM_THRESHOLD;

  const bloomFolder = gui.addFolder("Bloom");
  const bloomStrengthCtrl = bloomFolder.add(guiParams, "bloomStrength", 0, 3, 0.01).name("amount");
  const bloomRadiusCtrl = bloomFolder.add(guiParams, "bloomRadius", 0, 1, 0.01).name("radius").onChange((v) => { bloomPass.radius.value = v; });
  const bloomThresholdCtrl = bloomFolder.add(guiParams, "bloomThreshold", 0, 1, 0.01).name("threshold");
  const bloomSoftnessCtrl = bloomFolder.add(guiParams, "bloomSoftness", 0, 0.5, 0.005).name("gradient softness").onChange((v) => { bloomPass.smoothWidth.value = v; });

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
    { key: "bloomStrength", label: "Bloom: Amount", base: guiParams.bloomStrength, ampMax: 1.5, controller: bloomStrengthCtrl, apply: (v) => { bloomPass.strength.value = v; } },
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

  async function frame(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    updateAnimators(now / 1000);
    cloth.update(dt);
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
