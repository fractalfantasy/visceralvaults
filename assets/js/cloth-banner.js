import * as THREE from "three/webgpu";
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
  const gridW = segX + 1;
  const gridH = segY + 1;
  const logoPixels = await loadImageGrid("assets/img/site/vvlogoblur.png", gridW, gridH);
  const RELIEF_HEIGHT = 0.16;
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const p = (gy * gridW + gx) * 4;
      const gray = logoPixels[p] / 255; // R channel; logo is grayscale
      cloth.depthTarget[cloth.index(gx, gy)] = gray * RELIEF_HEIGHT;
    }
  }

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -PLANE_WIDTH / 2, PLANE_WIDTH / 2,
    PLANE_HEIGHT / 2, -PLANE_HEIGHT / 2,
    0.1, 10
  );
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const material = new THREE.MeshStandardMaterial({
    color: 0x2b2d33,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(cloth.geometry, material);
  scene.add(mesh);

  const pointLight = new THREE.PointLight(0xffffff, 3, 0, 0);
  pointLight.position.set(-0.55, 0.6, 1.3);
  scene.add(pointLight);

  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(ambient);

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

    cloth.update(dt);
    await renderer.renderAsync(scene, camera);

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
