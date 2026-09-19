import * as THREE from "three/webgpu";

const {
  Fn, uniform, texture, uv, vec2, vec3, vec4,
  mix, smoothstep, clamp, length, normalize, max: nmax, dot, pow,
  MeshBasicNodeMaterial, RenderTarget, HalfFloatType, LinearFilter,
  Scene, OrthographicCamera, PlaneGeometry, Mesh, WebGPURenderer,
} = THREE;

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
    console.error("Liquid banner failed to start:", err);
    showFallback();
  });
}

async function init() {
  const renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // ---------- simulation setup (ping-pong height/velocity field) ----------
  const SIM_W = 512;
  const SIM_H = 256;

  function makeSimTarget() {
    const rt = new RenderTarget(SIM_W, SIM_H, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    return rt;
  }

  let simA = makeSimTarget();
  let simB = makeSimTarget();

  const simScene = new Scene();
  const simCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new PlaneGeometry(2, 2);

  const uMouse = uniform(new THREE.Vector2(0.5, 0.5));
  const uMouseStrength = uniform(0);
  const texelX = 1 / SIM_W;
  const texelY = 1 / SIM_H;

  const prevSimTex = texture(simA.texture);

  const simMaterial = new MeshBasicNodeMaterial();
  simMaterial.colorNode = Fn(() => {
    const uvNode = uv();
    const self = prevSimTex.uv(uvNode);
    const h = self.r.toVar();
    const v = self.g.toVar();

    const l = prevSimTex.uv(uvNode.add(vec2(-texelX, 0))).r;
    const r = prevSimTex.uv(uvNode.add(vec2(texelX, 0))).r;
    const u = prevSimTex.uv(uvNode.add(vec2(0, texelY))).r;
    const d = prevSimTex.uv(uvNode.add(vec2(0, -texelY))).r;

    const laplacian = l.add(r).add(u).add(d).sub(h.mul(4));
    const vNew = v.add(laplacian.mul(0.5)).mul(0.985);
    const hNew = h.add(vNew);

    const distToMouse = length(uvNode.sub(uMouse));
    const inject = smoothstep(0.09, 0.0, distToMouse).mul(uMouseStrength);

    const finalH = clamp(hNew.add(inject), -1.0, 1.0);
    return vec4(finalH, vNew, 0, 1);
  })();

  const simMesh = new Mesh(quadGeo, simMaterial);
  simScene.add(simMesh);

  // ---------- display pass (liquid shaded with logo displacement) ----------
  const displayScene = new Scene();
  const displayCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const logoTexture = new THREE.TextureLoader().load("assets/img/site/vvlogo.png");
  logoTexture.minFilter = LinearFilter;
  logoTexture.magFilter = LinearFilter;
  logoTexture.generateMipmaps = false;

  const logoTex = texture(logoTexture);
  const rippleTex = texture(simA.texture);

  const displayMaterial = new MeshBasicNodeMaterial();
  displayMaterial.colorNode = Fn(() => {
    const uvNode = uv();
    const epsX = 1.5 / SIM_W;
    const epsY = 1.5 / SIM_H;
    const logoW = 0.55;

    const heightAt = (offset) => logoTex.uv(uvNode.add(offset)).r.mul(logoW)
      .add(rippleTex.uv(uvNode.add(offset)).r);

    const hL = heightAt(vec2(-epsX, 0));
    const hR = heightAt(vec2(epsX, 0));
    const hD = heightAt(vec2(0, -epsY));
    const hU = heightAt(vec2(0, epsY));

    const normal = normalize(vec3(hL.sub(hR), hD.sub(hU), 0.6));
    const slope = length(vec2(normal.x, normal.y));

    const lightDir = normalize(vec3(0.4, 0.5, 0.7));
    const diff = nmax(dot(normal, lightDir), 0.0);
    const spec = pow(diff, 20.0);

    const base = vec3(0.0, 0.0, 0.0);
    const sheen = vec3(0.55, 0.57, 0.62);
    const highlight = vec3(1.0, 1.0, 1.0);

    let color = mix(base, sheen, clamp(slope.mul(diff).mul(2.4), 0.0, 1.0));
    color = mix(color, highlight, clamp(spec.mul(slope).mul(3.0), 0.0, 1.0));

    return vec4(color, 1.0);
  })();

  const displayMesh = new Mesh(quadGeo, displayMaterial);
  displayScene.add(displayMesh);

  // ---------- pointer interaction ----------
  let lastX = null;
  let lastY = null;

  function setMouseFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    uMouse.value.set(x, y);

    if (lastX !== null) {
      const dx = x - lastX;
      const dy = y - lastY;
      const speed = Math.min(Math.sqrt(dx * dx + dy * dy) * 40, 1.2);
      uMouseStrength.value = speed;
    }
    lastX = x;
    lastY = y;
  }

  canvas.addEventListener("pointermove", setMouseFromEvent);
  canvas.addEventListener("pointerdown", (e) => {
    setMouseFromEvent(e);
    uMouseStrength.value = 1.5;
  });
  canvas.addEventListener("pointerleave", () => {
    lastX = null;
    lastY = null;
    uMouseStrength.value = 0;
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

  async function frame() {
    // step simulation: render simMaterial (reading simA) into simB
    prevSimTex.value = simA.texture;
    renderer.setRenderTarget(simB);
    await renderer.renderAsync(simScene, simCamera);

    // swap
    const tmp = simA;
    simA = simB;
    simB = tmp;

    // fade mouse strength so a held pointer doesn't flood the field
    uMouseStrength.value *= 0.85;

    // display: sample latest simA
    rippleTex.value = simA.texture;
    renderer.setRenderTarget(null);
    await renderer.renderAsync(displayScene, displayCamera);

    raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!raf) {
      raf = requestAnimationFrame(frame);
    }
  });

  raf = requestAnimationFrame(frame);
}
