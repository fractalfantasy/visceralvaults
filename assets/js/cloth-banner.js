import * as THREE from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GUI } from "dat.gui";
import { Cloth } from "./cloth.js";

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

// Downsamples straight to the cloth's grid resolution so each vertex gets a
// smoothly-averaged value (letting the canvas's own image scaling do the
// blur) instead of point-sampling a high-contrast image, which at a coarse
// vertex grid would alias into a patchy, noisy-looking relief.
function loadImageGrid(src, gridW, gridH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = gridW;
      c.height = gridH;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, gridW, gridH);
      resolve(ctx.getImageData(0, 0, gridW, gridH).data);
    };
    img.onerror = reject;
    img.src = src;
  });
}

async function init() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const ASPECT = 996 / 500;
  const PLANE_HEIGHT = 1;
  const PLANE_WIDTH = PLANE_HEIGHT * ASPECT;
  const segX = window.innerWidth < 700 ? 160 : 280;
  const segY = Math.max(4, Math.round(segX / ASPECT));

  const cloth = new Cloth({
    width: PLANE_WIDTH,
    height: PLANE_HEIGHT,
    segmentsX: segX,
    segmentsY: segY,
  });
  // The reference's displacementScale (9.45) was tuned for a much larger
  // world scale; on our unit-height plane it blew Z-displacement out past
  // the plane's own size. Scale it down to a subtle emboss instead.
  cloth.displacementScale = 0.8;

  // Bake the logo into the cloth's resting shape as a static depth target.
  // The raw grayscale is kept separately so the relief height can be
  // rescaled live (via the GUI) without re-reading the image.
  const gridW = segX + 1;
  const gridH = segY + 1;
  const logoPixels = await loadImageGrid("assets/img/site/vvlogoblur.png", gridW, gridH);
  const logoGray = new Float32Array(cloth.count);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const p = (gy * gridW + gx) * 4;
      logoGray[cloth.index(gx, gy)] = logoPixels[p] / 255; // R channel; logo is grayscale
    }
  }

  // Ripple impulse per unit of relief-height change, weighted by the logo's
  // own shape (so a slider move pokes the cloth roughly like a full-strength
  // pointer poke would at the max slider range, scaled down for smaller
  // moves) rather than just fading the target height in place.
  const RELIEF_RIPPLE_SCALE = 30;
  let currentReliefHeight = 0;

  function applyReliefHeight(height, { ripple = false } = {}) {
    const delta = height - currentReliefHeight;
    for (let i = 0; i < cloth.count; i++) {
      cloth.depthTarget[i] = logoGray[i] * height;
      if (ripple) {
        cloth.v[i] += logoGray[i] * delta * RELIEF_RIPPLE_SCALE;
      }
    }
    currentReliefHeight = height;
  }

  const RELIEF_HEIGHT = 0.05;
  applyReliefHeight(RELIEF_HEIGHT);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -PLANE_WIDTH / 2, PLANE_WIDTH / 2,
    PLANE_HEIGHT / 2, -PLANE_HEIGHT / 2,
    0.1, 10
  );
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0.37,
    metalness: 0.78,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(cloth.geometry, material);
  scene.add(mesh);

  const pointLight = new THREE.PointLight(0xffffff, 20, 0, 0);
  pointLight.position.set(-0.35, -0.13, 0.41);
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

  const gui = new GUI();

  const materialFolder = gui.addFolder("Material");
  const roughnessCtrl = materialFolder.add(guiParams, "roughness", 0, 1, 0.01).onChange((v) => { material.roughness = v; });
  const metalnessCtrl = materialFolder.add(guiParams, "metalness", 0, 1, 0.01).onChange((v) => { material.metalness = v; });
  materialFolder.addColor(guiParams, "color").onChange((v) => { material.color.set(v); });
  materialFolder.open();

  const lightFolder = gui.addFolder("Point Light");
  const lightXCtrl = lightFolder.add(guiParams, "lightX", -2, 2, 0.01).onChange((v) => { pointLight.position.x = v; });
  const lightYCtrl = lightFolder.add(guiParams, "lightY", -2, 2, 0.01).onChange((v) => { pointLight.position.y = v; });
  const lightZCtrl = lightFolder.add(guiParams, "lightZ", 0, 5, 0.01).onChange((v) => { pointLight.position.z = v; });
  const lightIntensityCtrl = lightFolder.add(guiParams, "lightIntensity", 0, 20, 0.1).name("brightness").onChange((v) => { pointLight.intensity = v; });
  lightFolder.open();

  const displacementFolder = gui.addFolder("Displacement");
  const reliefCtrl = displacementFolder.add(guiParams, "reliefHeight", 0, 0.6, 0.005).name("depth map amount").onChange((v) => { applyReliefHeight(v, { ripple: true }); });
  displacementFolder.open();

  // ---------- post-processing (bloom) ----------
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = THREE.pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();

  const BLOOM_STRENGTH = 0.31;
  const BLOOM_RADIUS = 0.4;
  const BLOOM_THRESHOLD = 0.99;
  const bloomPass = bloom(sceneColor, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  postProcessing.outputNode = sceneColor.add(bloomPass);

  guiParams.bloomStrength = BLOOM_STRENGTH;
  guiParams.bloomThreshold = BLOOM_THRESHOLD;

  const bloomFolder = gui.addFolder("Bloom");
  const bloomStrengthCtrl = bloomFolder.add(guiParams, "bloomStrength", 0, 3, 0.01).name("amount").onChange((v) => { bloomPass.strength.value = v; });
  const bloomThresholdCtrl = bloomFolder.add(guiParams, "bloomThreshold", 0, 1, 0.01).name("threshold").onChange((v) => { bloomPass.threshold.value = v; });
  bloomFolder.open();

  // ---------- animators ----------
  // Each animator drives one target parameter as base + amount*sin(2*pi*freq*t),
  // reusing that parameter's own controller (so its slider updates live and
  // the existing onChange logic still applies the value everywhere it needs
  // to go — including the depth-map's ripple-on-change behavior).
  const animatableTargets = [
    { key: "roughness", label: "Material: Roughness", base: guiParams.roughness, ampMax: 0.5, controller: roughnessCtrl },
    { key: "metalness", label: "Material: Metalness", base: guiParams.metalness, ampMax: 0.5, controller: metalnessCtrl },
    { key: "lightX", label: "Point Light: X", base: guiParams.lightX, ampMax: 2, controller: lightXCtrl },
    { key: "lightY", label: "Point Light: Y", base: guiParams.lightY, ampMax: 2, controller: lightYCtrl },
    { key: "lightZ", label: "Point Light: Z", base: guiParams.lightZ, ampMax: 2.5, controller: lightZCtrl },
    { key: "lightIntensity", label: "Point Light: Brightness", base: guiParams.lightIntensity, ampMax: 10, controller: lightIntensityCtrl },
    { key: "reliefHeight", label: "Displacement: Depth Map Amount", base: guiParams.reliefHeight, ampMax: 0.3, controller: reliefCtrl },
    { key: "bloomStrength", label: "Bloom: Amount", base: guiParams.bloomStrength, ampMax: 1.5, controller: bloomStrengthCtrl },
    { key: "bloomThreshold", label: "Bloom: Threshold", base: guiParams.bloomThreshold, ampMax: 0.5, controller: bloomThresholdCtrl },
  ];
  const targetOptions = {};
  animatableTargets.forEach((t) => { targetOptions[t.label] = t.key; });

  const animators = [];
  const animatorsFolder = gui.addFolder("Animators");
  animatorsFolder.open();

  let animatorCount = 0;

  function addAnimator() {
    animatorCount++;
    const target = animatableTargets[0];
    const state = { targetKey: target.key, freq: 0.5, amount: 0, speed: 1, enabled: true };
    const sub = animatorsFolder.addFolder(`Animator ${animatorCount}`);

    const targetCtrl = sub.add(state, "targetKey", targetOptions).name("parameter");
    const amountCtrl = sub.add(state, "amount", 0, target.ampMax, target.ampMax / 200).name("amount");
    sub.add(state, "freq", 0, 3, 0.01).name("frequency");
    sub.add(state, "speed", 0.1, 5, 0.01).name("speed");
    sub.add(state, "enabled");

    targetCtrl.onChange((key) => {
      const t = animatableTargets.find((a) => a.key === key);
      amountCtrl.max(t.ampMax);
      if (state.amount > t.ampMax) {
        state.amount = t.ampMax;
        amountCtrl.updateDisplay();
      }
    });

    sub.add({
      remove: () => {
        animatorsFolder.removeFolder(sub);
        const i = animators.indexOf(entry);
        if (i >= 0) animators.splice(i, 1);
      },
    }, "remove").name("− remove");

    sub.open();

    const entry = { state };
    animators.push(entry);
  }

  animatorsFolder.add({ addAnimator }, "addAnimator").name("+ Add Animator");

  function updateAnimators(t) {
    for (const { state } of animators) {
      if (!state.enabled) continue;
      const target = animatableTargets.find((a) => a.key === state.targetKey);
      if (!target) continue;
      const v = target.base + state.amount * Math.sin(2 * Math.PI * state.freq * state.speed * t);
      target.controller.setValue(v);
    }
  }

  // ---------- pointer interaction ----------
  // Orthographic camera looking straight on, so screen UV maps linearly
  // onto the plane's local X/Y — no raycasting needed.
  const FORCE_SCALE = 1400;
  const MAX_FORCE = 18;
  const POINTER_RADIUS = 0.06;

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
      const strength = Math.min(speed * FORCE_SCALE, MAX_FORCE);
      if (strength > 0.001) {
        cloth.applyForce(x, y, POINTER_RADIUS, strength);
      }
    }
    lastLocalX = x;
    lastLocalY = y;
  }

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = localFromEvent(e);
    cloth.applyForce(x, y, POINTER_RADIUS * 1.4, MAX_FORCE);
    lastLocalX = x;
    lastLocalY = y;
  });
  canvas.addEventListener("pointerleave", () => {
    lastLocalX = null;
    lastLocalY = null;
  });

  // ---------- resize ----------
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
  }

  window.addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  resize();

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
