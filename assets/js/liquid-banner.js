import * as THREE from "three";

const canvas = document.getElementById("liquid-canvas");
const fallback = document.querySelector(".hero-fallback");

function showFallback() {
  if (canvas) canvas.hidden = true;
  if (fallback) fallback.hidden = false;
}

if (!canvas || !window.WebGLRenderingContext) {
  showFallback();
} else {
  init();
}

function init() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (e) {
    showFallback();
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    uLogo: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uLogo;
      uniform float uTime;
      uniform vec2 uResolution;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      void main() {
        vec2 uv = vUv;
        float t = uTime * 0.12;

        vec2 warp = vec2(
          noise(uv * 3.0 + vec2(t, 1.7)),
          noise(uv * 3.0 + vec2(4.2, t))
        );
        vec2 duv = uv + (warp - 0.5) * 0.025;

        float mask = texture2D(uLogo, duv).r;
        if (mask < 0.05) discard;

        float eps = 1.5 / uResolution.x;
        float hL = texture2D(uLogo, duv - vec2(eps, 0.0)).r;
        float hR = texture2D(uLogo, duv + vec2(eps, 0.0)).r;
        float hD = texture2D(uLogo, duv - vec2(0.0, eps)).r;
        float hU = texture2D(uLogo, duv + vec2(0.0, eps)).r;
        vec3 normal = normalize(vec3(hL - hR, hD - hU, 0.25));

        float bands = sin((normal.x + normal.y) * 8.0 + uTime * 0.8) * 0.5 + 0.5;
        float shine = pow(bands, 2.0);
        float rim = pow(1.0 - abs(normal.z), 2.0);

        vec3 metal = mix(vec3(0.35, 0.36, 0.4), vec3(1.0), shine);
        metal += rim * 0.4;

        gl_FragColor = vec4(metal, mask);
      }
    `,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  scene.add(new THREE.Mesh(geometry, material));

  const loader = new THREE.TextureLoader();
  loader.load(
    "assets/img/site/vvlogo.png",
    (texture) => {
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      uniforms.uLogo.value = texture;
      start();
    },
    undefined,
    () => showFallback()
  );

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    uniforms.uResolution.value.set(w, h);
  }

  let raf = null;
  let started = false;

  function render(time) {
    uniforms.uTime.value = time * 0.001;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(render);
  }

  function start() {
    if (started) return;
    started = true;
    resize();
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    raf = requestAnimationFrame(render);
  }

  document.addEventListener("visibilitychange", () => {
    if (!started) return;
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!raf) {
      raf = requestAnimationFrame(render);
    }
  });
}
