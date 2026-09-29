// Playable character: WASD (camera-relative) to move, Space to (front-flip) jump, Shift to crouch.
// Movement clips are Mixamo downloads (skeleton-only GLBs in anims/player/) retargeted onto her rig at load time:
// per bone, the source's world-space rotation away from its rest pose is applied to her rest pose after her bones
// are first aligned to the source's (her A-pose -> its T-pose). The crouch is a squat pose built here in code.
import * as THREE from 'three/webgpu';

const CLIPS = { idle: 'idle', walk: 'walk', run: 'run', flip: 'flip' };   // anims/player/<file>.glb
const FPS = 30;
const PREFERRED_CHILD = /Spine|Neck|Head$|Middle1|Leg$|Foot$|ToeBase$/;   // which child a bone "points" at

export const BASIC_IDLE = 'basic (mixamo)';
export const playerDefaults = { playable: false, showFloor: true, idleAnim: 'SquareUpIdleGettingGripDone', moveSpeed: 3, jumpHeight: 0.8, frontFlip: true, turnSpeed: 10, crouchAmount: 1 };

const _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

// rest pose of a skeleton in `space` coordinates: world rotation + position per bone name
function captureRest(bones, space) {
  const inv = new THREE.Quaternion(), invM = new THREE.Matrix4();
  space.updateMatrixWorld(true);
  space.getWorldQuaternion(inv).invert(); invM.copy(space.matrixWorld).invert();
  const rest = new Map();
  for (const b of bones) {
    const q = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(inv);
    const p = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(invM);
    rest.set(b.name, { q, p });
  }
  return rest;
}

function childFor(b, has) {
  const kids = b.children.filter((c) => c.isBone && has(c.name));
  return kids.find((c) => PREFERRED_CHILD.test(c.name)) || kids[0];
}

// retarget the source's clip onto her skeleton (under tgtRoot; tgtRest = her rest pose from captureRest)
function retarget({ srcRoot, srcBones, clip }, { tgtRoot, tgtRest, tgtHips }) {
  const srcByName = new Map(srcBones.map((b) => [b.name, b]));
  const srcRest = captureRest(srcBones, srcRoot);
  const srcHips = srcBones.find((b) => /Hips$/.test(b.name));

  // her bones in hierarchy order, and her "T-posed" rest (each bone turned to point where the source's does)
  const order = [];
  (function walk(b) { order.push(b); for (const c of b.children) if (c.isBone) walk(c); })(tgtHips);
  const hipsParentQ = tgtHips.parent.getWorldQuaternion(new THREE.Quaternion()).premultiply(tgtRoot.getWorldQuaternion(_q2).invert());
  const localRest = new Map(), aligned = new Map();
  for (const b of order) {
    const parentW = b === tgtHips ? hipsParentQ : aligned.get(b.parent.name);
    const parentRestW = b === tgtHips ? hipsParentQ : tgtRest.get(b.parent.name).q;
    const lq = parentRestW.clone().invert().multiply(tgtRest.get(b.name).q);          // rest local rotation
    localRest.set(b.name, lq);
    const w = parentW.clone().multiply(lq);
    // swing the bone so it points (toward its child) the way the source's does in the source's rest pose
    const c = childFor(b, (n) => srcByName.has(n) && tgtRest.has(n));
    if (b !== tgtHips && c && srcByName.has(b.name)) {
      const restW = tgtRest.get(b.name).q;
      const dirHer = tgtRest.get(c.name).p.clone().sub(tgtRest.get(b.name).p).applyQuaternion(restW.clone().invert()).applyQuaternion(w).normalize();
      const dirSrc = srcRest.get(c.name).p.clone().sub(srcRest.get(b.name).p).normalize();
      if (dirHer.lengthSq() > 0 && dirSrc.lengthSq() > 0) w.premultiply(_q.setFromUnitVectors(dirHer, dirSrc));
    }
    aligned.set(b.name, w);
  }

  const scale = tgtRest.get(tgtHips.name).p.y / srcRest.get(srcHips.name).p.y;
  const hipsParentM = new THREE.Matrix4().copy(tgtHips.parent.matrixWorld).premultiply(new THREE.Matrix4().copy(tgtRoot.matrixWorld).invert());
  const hipsParentInv = hipsParentM.clone().invert();
  const mixerS = new THREE.AnimationMixer(srcRoot), invSrcRoot = new THREE.Matrix4();
  {
    const n = Math.max(2, Math.round(clip.duration * FPS) + 1), times = new Float32Array(n);
    const qv = new Map(order.map((b) => [b.name, new Float32Array(n * 4)])), pv = new Float32Array(n * 3);
    mixerS.clipAction(clip).play();
    const W = new Map();
    for (let f = 0; f < n; f++) {
      const t = times[f] = Math.min(clip.duration, f / FPS);
      mixerS.setTime(t); srcRoot.updateMatrixWorld(true); invSrcRoot.copy(srcRoot.matrixWorld).invert();
      for (const b of order) {
        const s = srcByName.get(b.name), parentW = b === tgtHips ? hipsParentQ : W.get(b.parent.name);
        let w;
        if (s) {   // delta from the source rest, applied to her aligned rest
          s.getWorldQuaternion(_q); const d = _q.clone().multiply(srcRest.get(b.name).q.clone().invert());
          w = d.multiply(aligned.get(b.name));
        } else w = parentW.clone().multiply(localRest.get(b.name));
        W.set(b.name, w);
        const l = parentW.clone().invert().multiply(w);
        l.toArray(qv.get(b.name), f * 4);
      }
      srcHips.getWorldPosition(_v).applyMatrix4(invSrcRoot).sub(srcRest.get(srcHips.name).p).multiplyScalar(scale);
      _v.add(tgtRest.get(tgtHips.name).p);
      _v.toArray(pv, f * 3);
    }
    // in place: remove horizontal drift (keep the sway), then into the hips' parent space
    const dx = pv[(n - 1) * 3] - pv[0], dz = pv[(n - 1) * 3 + 2] - pv[2];
    const speed = Math.hypot(dx, dz) / clip.duration;                 // how fast the clip travels (m/s, her size)
    let mx = 0, mz = 0;
    for (let f = 0; f < n; f++) { pv[f * 3] -= dx * f / (n - 1); pv[f * 3 + 2] -= dz * f / (n - 1); mx += pv[f * 3] / n; mz += pv[f * 3 + 2] / n; }
    const rp = tgtRest.get(tgtHips.name).p;
    for (let f = 0; f < n; f++) {
      _v2.set(pv[f * 3] - mx + rp.x, pv[f * 3 + 1], pv[f * 3 + 2] - mz + rp.z).applyMatrix4(hipsParentInv).toArray(pv, f * 3);
    }
    const tracks = [new THREE.VectorKeyframeTrack(`${tgtHips.name}.position`, times, pv)];
    for (const b of order) if (srcByName.has(b.name)) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, qv.get(b.name)));
    mixerS.stopAllAction();
    const out = new THREE.AnimationClip('player_' + clip.name, clip.duration, tracks);
    out.userData = { speed };
    return out;
  }
}

export class Player {
  constructor({ root, body, mixer, loader, P, getDanceClip }) {
    this.root = root; this.body = body; this.mixer = mixer; this.loader = loader; this.P = P; this.getDanceClip = getDanceClip;
    this.keys = new Set(); this.ready = null; this.active = false;
    this.vel = new THREE.Vector3(); this.speed = 0; this.phase = 0; this.crouchW = 0; this.yaw = 0;
    this.y = 0; this.vy = 0; this.grounded = true; this.squash = 0; this.crouch = 0;
    const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName);
    addEventListener('keydown', (e) => {
      if (!this.active || typing(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.jumpQueued = true; }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  load() {
    return (this.ready ||= (async () => {
      const bones = this.body.skeleton.bones;
      this.body.skeleton.pose();                                     // her bind pose = rest
      const rest = captureRest(bones, this.root);
      const hips = bones.find((b) => /Hips$/.test(b.name));
      this.hipsName = hips.name;
      this.hipOffset = rest.get(hips.name).p.clone().setY(0);        // her rig sits off the model's origin: turn around her
      this.hipRestLocal = rest.get(hips.name).p.clone().applyMatrix4(new THREE.Matrix4().copy(hips.parent.matrixWorld).invert().multiply(this.root.matrixWorld));
      const clips = {};
      await Promise.all(Object.entries(CLIPS).map(([k, file]) => new Promise((res, rej) => this.loader.load(`./anims/player/${file}.glb`, (g) => {
        const srcBones = []; g.scene.traverse((o) => { if (/^mixamorig/.test(o.name)) srcBones.push(o); });
        clips[k] = retarget({ srcRoot: g.scene, srcBones, clip: g.animations[0] }, { tgtRoot: this.root, tgtRest: rest, tgtHips: hips });
        res();
      }, undefined, rej))));
      const A = (c) => this.mixer.clipAction(c);
      this.flipClip = clips.flip;
      // idleBasic = the Mixamo idle: the base under the crouch (whatever idle is picked for standing)
      this.a = { idle: A(clips.idle), idleBasic: A(clips.idle.clone()), walk: A(clips.walk), run: A(clips.run) };
      for (const k of ['walk', 'run']) this.a[k].timeScale = 0;   // driven by our own synced phase
      this.speeds = { walk: clips.walk.userData.speed || 1.4, run: clips.run.userData.speed || 3.5 };
      const crouch = this.crouchClip(bones, rest, hips);
      this.a.crouch = this.mixer.clipAction(crouch, undefined, THREE.AdditiveAnimationBlendMode);
      this.a.crouch.timeScale = 0;                                     // a held pose
      this.idleClips = new Map([[BASIC_IDLE, clips.idle]]);
    })());
  }

  // additive squat: thighs forward, shins back (feet stay flat), a little forward lean, hips dropped to match
  crouchClip(bones, rest, hips) {
    const TH = THREE.MathUtils.degToRad(48), R = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    const want = { UpLeg: R(-TH), Leg: R(TH * 0.9), Foot: R(0), Spine: R(TH * 0.25), Spine1: R(TH * 0.35), Spine2: R(TH * 0.4), Neck: R(TH * 0.2), Head: R(0) };
    const W = new Map(), tracks = [];
    const parentRest = (b) => (b === hips ? null : rest.get(b.parent.name).q);
    const order = []; (function walk(b) { order.push(b); for (const c of b.children) if (c.isBone) walk(c); })(hips);
    const hipsParentQ = hips.parent.getWorldQuaternion(new THREE.Quaternion()).premultiply(this.root.getWorldQuaternion(new THREE.Quaternion()).invert());
    for (const b of order) {
      const restW = rest.get(b.name).q, pNew = b === hips ? hipsParentQ : W.get(b.parent.name), pRest = parentRest(b) || hipsParentQ;
      const localRest = pRest.clone().invert().multiply(restW);
      const key = Object.keys(want).find((k) => new RegExp(`(Left|Right)?${k}$`).test(b.name.replace(/^mixamorig:?/, '')) && !/Hand|Arm|Shoulder/.test(b.name));
      const w = key ? want[key].clone().multiply(restW) : pNew.clone().multiply(localRest);   // posed world rotation
      W.set(b.name, w);
      if (!key) continue;
      const localNew = pNew.clone().invert().multiply(w), delta = localRest.clone().invert().multiply(localNew);
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, [0, 1], [...delta.toArray(), ...delta.toArray()]));
    }
    // hips drop = how much the bent thigh + shin shorten the leg
    const leg = (n) => rest.get(n).p, L = bones.find((b) => /LeftUpLeg$/.test(b.name));
    const knee = L.children.find((c) => c.isBone), ankle = knee.children.find((c) => c.isBone);
    const lt = leg(L.name).distanceTo(leg(knee.name)), ls = leg(knee.name).distanceTo(leg(ankle.name));
    const drop = lt * (1 - Math.cos(TH)) + ls * (1 - Math.cos(TH * 0.9));
    tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, [0, 1], [0, -drop, 0, 0, -drop, 0]));
    const clip = new THREE.AnimationClip('player_crouch', 1, tracks);
    clip.blendMode = THREE.AdditiveAnimationBlendMode;
    return clip;
  }

  // idle = the basic Mixamo idle or one of her own dances (already on her rig: only centred on her rest hips, so the
  // turn pivot stays right). Prepared once per name.
  async setIdle(name) {
    await this.load();
    let clip = this.idleClips.get(name);
    if (!clip && name && this.getDanceClip) {
      const src = await this.getDanceClip(name).catch(() => null);
      if (src) {
        clip = src.clone(); clip.name = 'player_idle_' + name;
        const tr = clip.tracks.find((t) => t.name === `${this.hipsName}.position`);
        if (tr) {
          const v = tr.values, n = v.length / 3; let mx = 0, mz = 0;
          for (let i = 0; i < n; i++) { mx += v[i * 3] / n; mz += v[i * 3 + 2] / n; }
          for (let i = 0; i < n; i++) { v[i * 3] += this.hipRestLocal.x - mx; v[i * 3 + 2] += this.hipRestLocal.z - mz; }
        }
        this.idleClips.set(name, clip);
      }
    }
    clip ||= this.idleClips.get(BASIC_IDLE);
    if (this.a.idle.getClip() === clip) return;
    const old = this.a.idle, w = old.getEffectiveWeight();
    this.a.idle = this.mixer.clipAction(clip);
    this.a.idle.reset().play().setEffectiveWeight(w);
    old.stop();
  }

  async start() {
    await this.load();
    await this.setIdle(this.P.idleAnim);
    this.active = true; this.keys.clear();
    this.speed = 0; this.vel.set(0, 0, 0); this.phase = 0; this.crouchW = 0; this.y = 0; this.flipAct?.stop(); this.flipAct = null; this.vy = 0; this.grounded = true; this.crouch = 0; this.squash = 0;
    this.yaw = this.root.rotation.y;
    this.pos = this.hipOffset.clone().applyAxisAngle(_up, this.yaw).add(this.root.position).setY(0);   // where she stands
    for (const a of Object.values(this.a)) { a.reset().setEffectiveWeight(0).play(); }
    this.a.idle.setEffectiveWeight(1);
    this.a.idle.fadeIn(0.3);
  }

  stop() {
    this.active = false; this.keys.clear();
    if (this.a) for (const a of Object.values(this.a)) a.fadeOut(0.3);
    this.flipAct?.fadeOut(0.3); this.flipAct = null;
    this.root.position.set(0, 0, 0); this.root.rotation.set(0, 0, 0);
  }

  // before the mixer steps: move the root, set the blend weights / phases
  update(dt, camera) {
    if (!this.active || !this.a) return;
    const P = this.P, k = this.keys;
    // camera-relative input
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    camera.getWorldDirection(_v); _v.y = 0; _v.normalize();
    _v2.set(-_v.z, 0, _v.x);                                          // camera right
    const move = _v.multiplyScalar(f).addScaledVector(_v2, s);
    const moving = move.lengthSq() > 0;
    if (moving) move.normalize();
    const crouching = k.has('ShiftLeft') || k.has('ShiftRight');
    const target = moving ? P.moveSpeed * (crouching ? 0.4 : 1) : 0;
    this.crouchW += ((crouching ? 1 : 0) - this.crouchW) * (1 - Math.exp(-dt * 10));   // standing base: picked idle -> Mixamo idle
    // velocity eases toward the input (a reversal slows down through zero instead of flipping instantly)
    this.vel.lerp(_v2.copy(move).multiplyScalar(target), 1 - Math.exp(-dt * 6));
    this.speed = this.vel.length();
    if (moving) {
      const want = Math.atan2(move.x, move.z);
      let d = want - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (1 - Math.exp(-dt * P.turnSpeed));
    }
    this.pos.addScaledVector(this.vel, dt);
    this.root.quaternion.setFromAxisAngle(_up, this.yaw);
    this.root.position.copy(this.pos).sub(_v.copy(this.hipOffset).applyAxisAngle(_up, this.yaw));

    // jump (ballistic, lands at y = 0) with a squash on take-off and landing
    if (this.jumpQueued && this.grounded && !this.flipAct) {
      if (P.frontFlip && this.flipClip) {                              // the Mixamo flip carries its own height + spin
        this.flipAct = this.mixer.clipAction(this.flipClip);
        this.flipAct.setLoop(THREE.LoopOnce, 1); this.flipAct.clampWhenFinished = true;
        this.flipAct.reset().setEffectiveWeight(0).play(); this.flipT = 0;
      } else { this.vy = Math.sqrt(2 * 9.81 * P.jumpHeight); this.grounded = false; this.squash = 1; }
    }
    this.jumpQueued = false;
    if (!this.grounded) {
      this.vy -= 9.81 * dt; this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.grounded = true; this.squash = 1; }
    }
    this.squash = Math.max(0, this.squash - dt * 5);
    this.root.position.y = this.y;   // (after the pivot offset, which is horizontal)
    // flip clip weight: quick blend in, blend out over its recovery, then back to locomotion
    let flipW = 0;
    if (this.flipAct) {
      this.flipT += dt;
      const dur = this.flipClip.duration;
      flipW = Math.max(0, Math.min(1, this.flipT / 0.1, (dur - this.flipT) / 0.2));
      this.flipAct.setEffectiveWeight(flipW);
      if (this.flipT >= dur) { this.flipAct.stop(); this.flipAct = null; flipW = 0; }
    }
    const loco = 1 - flipW;

    // blend: idle -> walk -> run by speed, walk/run share one normalized phase so feet stay in step
    // (walk / run speeds are the clips' own stride speeds, so the feet don't slide)
    const WALK = this.speeds.walk, RUN = Math.max(this.speeds.run, WALK + 0.5);
    const sp = this.speed, wWalk = sp < WALK ? sp / WALK : Math.max(0, 1 - (sp - WALK) / (RUN - WALK));
    const wRun = sp < WALK ? 0 : Math.min(1, (sp - WALK) / (RUN - WALK)), wIdle = Math.max(0, 1 - sp / WALK);
    const dW = this.a.walk.getClip().duration, dR = this.a.run.getClip().duration;
    const cycles = (1 - wRun) * (sp / WALK) / dW + wRun * (sp / RUN) / dR;   // gait cycles per second
    this.phase = (this.phase + dt * cycles) % 1;
    this.a.walk.time = this.phase * dW; this.a.run.time = this.phase * dR;
    this.a.idle.setEffectiveWeight(wIdle * loco * (1 - this.crouchW)); this.a.idleBasic.setEffectiveWeight(wIdle * loco * this.crouchW);
    this.a.walk.setEffectiveWeight(wWalk * loco); this.a.run.setEffectiveWeight(wRun * loco);
    // crouch layer (additive): held Shift, in the air (tuck), and the take-off / landing squash
    const air = this.grounded ? 0 : 0.5;
    const want = Math.max(crouching ? P.crouchAmount : 0, air, this.squash * 0.7) * loco;
    this.crouch += (want - this.crouch) * (1 - Math.exp(-dt * 12));
    this.a.crouch.setEffectiveWeight(this.crouch);
  }
}
