// Face templates built from ARKit blendshape names (the 52 Apple face units) + MPFB visemes.
export const FACE_PRESETS = {
  neutral: {},
  smile: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.45, cheekSquintRight: 0.45, eyeSquintLeft: 0.25, eyeSquintRight: 0.25 },
  bigGrin: { mouthSmileLeft: 1, mouthSmileRight: 1, jawOpen: 0.25, mouthUpperUpLeft: 0.4, mouthUpperUpRight: 0.4, cheekSquintLeft: 0.7, cheekSquintRight: 0.7 },
  surprise: { browInnerUp: 1, browOuterUpLeft: 0.8, browOuterUpRight: 0.8, eyeWideLeft: 0.9, eyeWideRight: 0.9, jawOpen: 0.45, mouthFunnel: 0.3 },
  kiss: { mouthPucker: 1, mouthFunnel: 0.35, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  pout: { mouthPucker: 0.5, mouthShrugLower: 0.7, mouthRollUpper: 0.2, browInnerUp: 0.4 },
  angry: { browDownLeft: 1, browDownRight: 1, noseSneerLeft: 0.6, noseSneerRight: 0.6, mouthPressLeft: 0.5, mouthPressRight: 0.5, eyeSquintLeft: 0.4, eyeSquintRight: 0.4 },
  sad: { browInnerUp: 0.8, mouthFrownLeft: 0.8, mouthFrownRight: 0.8, mouthShrugLower: 0.4, eyeLookDownLeft: 0.3, eyeLookDownRight: 0.3 },
  disgust: { noseSneerLeft: 0.9, noseSneerRight: 0.7, mouthUpperUpLeft: 0.7, mouthUpperUpRight: 0.3, browDownLeft: 0.5 },
  wink: { eyeBlinkLeft: 1, mouthSmileLeft: 0.6, cheekSquintLeft: 0.6 },
  sultry: { eyeBlinkLeft: 0.35, eyeBlinkRight: 0.35, mouthPucker: 0.25, jawOpen: 0.08, browInnerUp: 0.2, mouthRollLower: 0.2 },
  scream: { jawOpen: 1, mouthStretchLeft: 0.6, mouthStretchRight: 0.6, eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 1 },
  tongueOut: { jawOpen: 0.4, tongueOut: 1, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
};

// MPFB/Microsoft viseme shape names in a pleasant talking order
export const VISEMES = ['aa_02', 'ey_eh_uh_04', 'ow_08', 'p_b_m_21', 'y_iy_ih_ix_06', 'f_v_18', 'aa_ah_ax_01', 'w_uw_07',
  's_z_15', 'er_05', 'l_14', 'th_dh_17', 'ao_03', 'sh_ch_jh_zh_16', 'k_g_ng_20', 'd_t_n_19', 'r_13'];

const cur = new Map();   // smoothed influences
let nextBlink = 2, blinkT = -1, lookT = 0, lookTarget = [0, 0];

function hash(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

export function applyFace(mesh, dict, P, t) {
  if (!mesh || !mesh.morphTargetInfluences) return;
  const want = new Map();
  const preset = FACE_PRESETS[P.face] || {};
  for (const [k, v] of Object.entries(preset)) want.set(k, v * P.faceAmount);

  if (P.talk) {
    const rate = 9;                                 // visemes per second
    const i = Math.floor(t * rate), f = (t * rate) % 1;
    const a = VISEMES[Math.floor(hash(i) * VISEMES.length)];
    const b = VISEMES[Math.floor(hash(i + 1) * VISEMES.length)];
    const pause = hash(Math.floor(t * 1.3) + 99) < 0.15;   // little breaths
    if (!pause) {
      want.set(a, (want.get(a) || 0) + (1 - f) * 0.9);
      want.set(b, (want.get(b) || 0) + f * 0.9);
    }
  }

  if (P.blink) {
    if (t > nextBlink && blinkT < 0) { blinkT = 0; }
    if (blinkT >= 0) {
      blinkT += 1 / 60;
      const v = Math.sin(Math.min(blinkT / 0.16, 1) * Math.PI);
      want.set('eyeBlinkLeft', Math.max(want.get('eyeBlinkLeft') || 0, v));
      want.set('eyeBlinkRight', Math.max(want.get('eyeBlinkRight') || 0, v));
      if (blinkT > 0.16) { blinkT = -1; nextBlink = t + 1.5 + Math.random() * 4; }
    }
  }

  if (P.lookAround) {
    if (t > lookT) { lookT = t + 0.8 + Math.random() * 2; lookTarget = [Math.random() * 2 - 1, Math.random() * 2 - 1]; }
    const [x, y] = lookTarget;
    if (x > 0) { want.set('eyeLookOutLeft', x * 0.8); want.set('eyeLookInRight', x * 0.8); }
    else { want.set('eyeLookInLeft', -x * 0.8); want.set('eyeLookOutRight', -x * 0.8); }
    if (y > 0) { want.set('eyeLookUpLeft', y * 0.6); want.set('eyeLookUpRight', y * 0.6); }
    else { want.set('eyeLookDownLeft', -y * 0.6); want.set('eyeLookDownRight', -y * 0.6); }
  }

  const infl = mesh.morphTargetInfluences;
  for (const name in dict) {
    const target = want.get(name) || 0;
    const prev = cur.get(name) || 0;
    const fast = name.startsWith('eyeBlink') || VISEMES.includes(name);
    const v = prev + (target - prev) * (fast ? 0.6 : 0.12);
    cur.set(name, v);
    infl[dict[name]] = v < 1e-4 ? 0 : v;
  }
}
