import { Vector3 as THREE_V3, Matrix3 as THREE_M3, BufferAttribute as THREE_BA } from 'three/webgpu';

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

// Eyelashes (separate meshes without blend shapes) follow the eyelids: each lash vertex gets, for every eye* shape,
// the displacement of the lid skin it sits on (inverse-distance blend of the nearest body vertices, in bind space).
// applyFace then drives those shapes with the body's own values.
export function followEyelids(body, meshes) {
  const bg = body.geometry, names = Object.keys(body.morphTargetDictionary || {}).filter((n) => /^eye/.test(n));
  if (!names.length) return [];
  const bPos = bg.attributes.position, nB = bPos.count, v = new THREE_V3();
  const toBind = (m, i, attr) => v.fromBufferAttribute(attr, i).applyMatrix4(m.bindMatrix);
  // body vertices near the eyes only (candidates for every lash vertex): anything that moves in an eye shape
  const moving = [];
  for (let i = 0; i < nB; i++) {
    for (const n of names) { const d = bg.morphAttributes.position[body.morphTargetDictionary[n]]; if (Math.abs(d.getX(i)) + Math.abs(d.getY(i)) + Math.abs(d.getZ(i)) > 1e-6) { moving.push(i); break; } }
  }
  const bp = moving.map((i) => toBind(body, i, bPos).clone());
  const bRot = new THREE_M3().setFromMatrix4(body.bindMatrix), out = [];
  for (const m of meshes) {
    const g = m.geometry, pos = g.attributes.position, n = pos.count;
    const toLocal = new THREE_M3().setFromMatrix4(m.bindMatrix).invert();
    const morphs = names.map(() => new Float32Array(n * 3));
    for (let i = 0; i < n; i++) {
      const p = toBind(m, i, pos);
      const near = [[Infinity, 0], [Infinity, 0], [Infinity, 0]];            // 3 nearest (insertion, no sort)
      for (let k = 0; k < bp.length; k++) {
        const d2 = bp[k].distanceToSquared(p);
        if (d2 < near[2][0]) { near[2] = [d2, k]; if (near[2][0] < near[1][0]) [near[1], near[2]] = [near[2], near[1]]; if (near[1][0] < near[0][0]) [near[0], near[1]] = [near[1], near[0]]; }
      }
      let tw = 0; for (const [d2] of near) tw += 1 / (d2 + 1e-8);
      names.forEach((name, t) => {
        const d = bg.morphAttributes.position[body.morphTargetDictionary[name]], acc = new THREE_V3();
        for (const [d2, k] of near) acc.add(new THREE_V3().fromBufferAttribute(d, moving[k]).multiplyScalar(1 / (d2 + 1e-8) / tw));
        acc.applyMatrix3(bRot).applyMatrix3(toLocal);                 // body-local delta -> bind space -> lash-local
        morphs[t].set([acc.x, acc.y, acc.z], i * 3);
      });
    }
    g.morphAttributes.position = morphs.map((a, t) => Object.assign(new THREE_BA(a, 3), { name: names[t] }));   // names -> morphTargetDictionary
    g.morphTargetsRelative = true;
    m.updateMorphTargets();
    out.push(m);
  }
  return out;
}

export function applyFace(mesh, dict, P, t, followers = []) {
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
  // lashes: the lid's own shapes, the blink pushed further (lashLidBlink) so the upper lashes close fully
  for (const f of followers) for (const name in f.morphTargetDictionary) {
    f.morphTargetInfluences[f.morphTargetDictionary[name]] = (infl[dict[name]] || 0) * (name.startsWith('eyeBlink') ? P.lashBlink : 1);
  }
}
