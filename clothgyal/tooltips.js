// Mouse-over help for every GUI control. Keyed by the controller's property name; Liquid 2's keys arrive unprefixed
// (it goes through a Proxy), Liquid 3's keep their l3_ prefix, and the material fields share one set of tips.

const MAT = {
  Color: 'Base tint. With high transmission this tints the light passing through.',
  Roughness: 'Surface blur. 0 = mirror-sharp reflections and refraction; higher = frosted.',
  Metalness: 'Makes it reflect like metal (tinted, no see-through). Keep 0 for liquid or skin.',
  Clearcoat: 'Extra glossy varnish layer on top — adds a second sharp highlight.',
  Sheen: 'Soft velvety glow at grazing angles (fabric look).',
  Transmission: 'How see-through it is. 1 = glass/water, 0 = opaque.',
  Ior: 'Index of refraction: how much the background bends. Water 1.33, glass 1.5, diamond 2.4.',
  Thickness: 'How thick the material is treated when refracting. Bigger = stronger lens distortion.',
  Dispersion: 'Rainbow edges from splitting light into colours (like a prism).',
  EnvIntensity: 'How strongly the environment map reflects on this material.',
};

const TIPS = {
  // presets
  preset: 'Load a saved look (all settings).',
  save: 'Overwrite the selected preset with the current settings.',
  saveAs: 'Save the current settings as a new preset.',
  del: 'Delete the selected preset.',
  saveAll: 'Write all presets into presets.json in the project (dev server only).',
  exportProject: 'Download all presets as a .json file.',
  importProject: 'Load presets from a .json file.',
  // animation / face
  dance: 'Which animation plays.',
  speed: 'Animation playback speed.',
  playing: 'Pause / play the animation.',
  loopFade: 'Crossfade time when the animation loops, to hide the jump. 0 = hard loop.',
  face: 'Facial expression.',
  faceAmount: 'How strong the expression is.',
  blink: 'Automatic blinking.',
  lashBlink: 'How far the eyelashes close when she blinks (1 = exactly with the lid, higher = the upper lashes come down further).',
  talk: 'Loop a talking mouth motion.',
  lookAround: 'Eyes wander around.',
  playable: 'Control her yourself: W A S D to move (relative to the camera), Space to front flip, Shift to crouch. Turn off to go back to the dance.',
  showFloor: 'Show a grid floor while playing, so you can see where she is walking.',
  idleAnim: 'What she does while standing still: the basic idle, or any of her dances.',
  frontFlip: 'Space does a running front flip (Mixamo animation, with its own height). Off = a plain jump using jump height.',
  moveSpeed: 'How fast she moves. Slow = walk, fast = run (it blends between them).',
  jumpHeight: 'How high she jumps (plain jump only; the flip has its own height).',
  crouchAmount: 'How low she crouches when holding Shift.',
  turnSpeed: 'How quickly she turns to face the direction she moves.',
  // body / cloth
  showBody: 'Show or hide her body (hide to see only the liquid).',
  resolution: 'Polygon density of the skin mesh. Higher = smoother folds, slower.',
  simulate: 'Run the cloth simulation on the skin. Off = skin follows the animation exactly.',
  reset: 'Restart this simulation from rest.',
  stiffness: 'How strongly the cloth keeps its shape. Higher = tighter, less floppy.',
  damping: 'Removes wobble. Higher = calmer, slower motion.',
  gravity: 'How much the cloth sags downward.',
  motionDrag: 'Air drag from her moving through space: how much the cloth streams back when she runs, jumps or spins. 0 = moves with her body, 1 = heavy drag (the old behaviour, which smears it when running).',
  slack: 'Extra looseness so the cloth forms folds and wrinkles.',
  stretch: 'How much the cloth may stretch before resisting.',
  iterations: 'Solver passes per frame. More = stiffer and more accurate, slower.',
  cm: 'How far the cloth floats above her skin.',
  smoothBase: 'Smooths the body shape the cloth rests on (hides small bumps).',
  bending: 'Resistance to bending. Higher = bigger, softer folds.',
  holdScale: 'How strongly the cloth is pulled back onto her body.',
  headHold: 'Extra hold on the head/face so it stays readable.',
  lockThreshold: 'Areas above this weight are locked to the body. 1 = nothing locked.',
  windStrength: 'Wind force on the cloth.',
  windScale: 'Size of the wind ripples.',
  windSpeed: 'How fast the gusts change.',
  windX: 'Wind direction, left / right.', windY: 'Wind direction, up / down.', windZ: 'Wind direction, front / back.',
  skinColor: MAT.Color,

  // Liquid 1 & 2
  liquidEnabled: 'Turn this liquid on. When off it costs nothing.',
  liquidSimulate: 'Run the simulation (off = freeze).',
  liquidGrid: 'Simulation grid resolution. Higher = finer detail, slower.',
  liquidCount: 'Number of particles.',
  liquidSubsteps: 'Simulation steps per frame. More = more stable, slower.',
  liquidAttractMode: 'Surface: liquid clings to her skin. Fill inside: liquid fills her body volume.',
  liquidMeshAttract: 'How strongly particles are pulled toward her body.',
  liquidMeshRepulse: 'Pushes particles back out if they go too deep under the skin (surface mode).',
  liquidFillBand: 'Thickness of the wall that holds liquid inside her (fill mode).',
  liquidOverflow: 'How much liquid may spill out of her body (fill mode).',
  liquidWbDt: 'Simulation time step. Bigger = faster motion, less stable.',
  liquidWbSpeed: 'Overall simulation speed.',
  liquidWbDrag: 'Air drag — slows everything down.',
  liquidWbGravity: 'Gravity per step.',
  liquidAttract: 'How strongly particles are pulled to the nearest point on her skin.',
  liquidRange: 'How far away from her the pull still works.',
  liquidGravity: 'Gravity on the liquid (× earth).',
  liquidStick: 'How much the liquid gets carried along with her movement.',
  liquidOffset: 'Where on the skin the liquid settles: + outside, − inside.',
  liquidStiffness: 'Pressure: how hard the liquid resists being squashed.',
  liquidDensity: 'Rest density. Higher = particles pack closer.',
  liquidViscosity: 'Thickness: 0 = water, higher = honey.',
  liquidRespawn: 'How often stray particles get respawned back on her.',
  liquidMaxSpeed: 'Speed limit for particles, stops explosive spraying.',
  liquidShowBounds: 'Show the box the liquid lives in.',
  liquidBoundsX: 'Box width.', liquidBoundsY: 'Box height.', liquidBoundsZ: 'Box depth.',
  liquidWallStiffness: 'How hard the box walls push back.',
  liquidBottomWall: 'Raises the floor of the box.',
  liquidRender: 'Draw as a smooth screen-space surface, or as individual droplets.',
  liquidSize: 'Droplet size (droplets view).',
  fluidRadius: 'Size of each particle when building the surface. Bigger = blobbier, fewer gaps.',
  wbDensitySize: 'Particles in dense areas get bigger.',
  wbStretch: 'Stretch particles along their motion (streaks).',
  wbFilterSize: 'Surface blur size. Higher = smoother, less grainy.',
  wbMaxFilter: 'Maximum blur radius in pixels.',
  wbDepthScale: 'How big a depth jump stops the blur (keeps separate blobs separate).',
  wbIterations: 'Blur passes. More = smoother, slower.',
  wbThickBlur: 'Blur for the thickness (colour depth) pass.',
  fluidSmooth: 'Surface smoothing size.',
  fluidFalloff: 'Keeps edges crisp while smoothing.',
  fluidIterations: 'Smoothing passes. More = smoother, slower.',
  fluidResolution: 'Resolution of the liquid render buffers. Lower = faster, softer.',
  fluidEdge: 'Softness of the liquid silhouette edge.',
  match: 'Copy the cloth material settings onto this liquid.',

  // Liquid 3 (Hector)
  l3_enabled: 'Turn Liquid 3 on. When off it costs nothing.',
  l3_render: 'Draw as a smooth marching-cubes mesh, or show the raw particles.',
  l3_spring: 'THE force that keeps the liquid inside her: each particle is pulled toward its home point in her body. Higher = tighter / more solid, lower = looser and sloshier.',
  l3_damping: 'Removes energy from the pull. Low = jiggly overshoot and sloshing, high = smooth and calm.',
  l3_maxSpeed: 'Speed limit for particles.',
  l3_gravity: 'Gravity on the whole liquid (× earth). Makes it sag inside her.',
  l3_spacing: 'Distance between particles. Smaller = more particles and detail, slower.',
  l3_relax: 'How strongly particles push each other apart so they don\'t overlap.',
  l3_noise: 'Swirling turbulence that stirs the liquid.',
  l3_noiseFreq: 'Size of the swirls. Low = big slow currents, high = small busy eddies.',
  l3_splashAccel: 'How hard she must move before liquid splashes off. Lower = splashes more easily.',
  l3_fling: 'How fast splashes fly off (× her speed).',
  l3_surfDepth: 'How deep below the surface liquid can splash from. Bigger = bigger splashes.',
  l3_dripRate: 'Random drips falling off per second (per particle).',
  l3_dripLife: 'How long a splash/drop lives before it respawns inside her.',
  l3_dripGravity: 'Gravity on flying drops (× earth).',
  l3_cohesion: 'Surface tension: drops stick together into blobs and strands.',
  l3_showBounds: 'Show the box the liquid lives in. Drops leaving it respawn.',
  l3_boundsX: 'Box width.', l3_boundsY: 'Box height.', l3_boundsZ: 'Box depth.',
  l3_floor: 'Height of the box floor (0 = her ground level). Lower it so drops fall further before respawning.',
  l3_boundsLag: 'How slowly the box follows her. 0 = locked to her hips (snaps with every turn), higher = drifts after her smoothly so turns don\'t swing the liquid. It never lets her leave the box.',
  l3_mcRes: 'Voxel size of the surface mesh. Finer = more detail, slower.',
  l3_surfStyle: 'How particles become a surface. Spheres: every particle is a smooth ball, so every drop and splash shows. Hector: particles just mark voxels, a blur rounds them, and only dense liquid survives — cleaner, glassier, stray drops vanish.',
  l3_threshold: 'Hector style: how dense the blurred liquid must be to count as surface (his "range"). Higher = tighter, cleaner, fewer drops and threads. Lower = fuller, keeps more splashes.',
  l3_dropRadius: 'How big each particle\'s blob is on the surface. Bigger = fuller, merges more.',
  l3_blurSize: 'Smooths the surface. Higher = rounder and glassier, lower = bumpier.',
  l3_particleSize: 'Particle size in the particles view.',

  // scene
  followBody: 'Camera orbits around her as she moves.',
  followSmooth: 'How smoothly the camera follows.',
  followVertical: 'How much the camera follows her up/down bounce.',
  followHeight: 'Height of the camera pivot point.',
  recenter: 'Clear any panning.',
  master: 'Brightness of all lights at once.',
  ambient: 'Flat fill light everywhere.',
  lightsFollow: 'Lights move with her.',
  color: 'Light colour.',
  intensity: 'Light brightness.',
  x: 'Light position, left / right.', y: 'Light position, height.', z: 'Light position, front / back.',
  distance: 'How far the light reaches. 0 = infinite.',
  decay: 'How fast the light fades with distance.',
  orbit: 'Light circles around her.',
  orbitSpeed: 'How fast the light orbits.',
  envMap: 'Environment image used for reflections and lighting.',
  envIntensity: 'Strength of environment reflections.',
  envBackground: 'Show the environment image behind her.',
  envBlur: 'Blur the background image.',
  bgFov: 'Zoom of the background image.',
  bgRotation: 'Rotate the environment.',
  bgColor: 'Background colour when the environment is hidden.',
  bgBrightness: 'Background brightness.',
  eyeGloss: 'Shine on the eyes.',
  eyeSmooth: 'Wet look of the eyes.',
  eyeRough: 'Roughness of the iris.',
  eyeReflect: 'Reflection strength on the eyes.',
  eyeBright: 'Iris brightness.',
  eyeSceneEnv: 'Eyes reflect the scene environment instead of a studio.',
  bloom: 'Glow around bright highlights.',
  bloomStrength: 'Glow strength.',
  bloomRadius: 'Glow spread.',
  bloomThreshold: 'Only highlights brighter than this glow.',
  bloomClamp: 'Caps very bright pixels so they don\'t flare.',
};

function tipFor(key) {
  if (TIPS[key]) return TIPS[key];
  const m = /^(?:l3_)?liq(Color|Roughness|Metalness|Clearcoat|Sheen|Transmission|Ior|Thickness|Dispersion|EnvIntensity)$/.exec(key);
  if (m) return MAT[m[1]];
  const f = key[0].toUpperCase() + key.slice(1);   // cloth material: roughness, ior, ...
  return MAT[f];
}

let box, timer;
function show(text, e) {
  if (!box) {
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:10000;max-width:260px;padding:6px 9px;border-radius:6px;pointer-events:none;'
      + 'background:rgba(20,20,24,.95);color:#eee;font:12px/1.35 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);display:none';
    document.body.appendChild(box);
  }
  box.textContent = text; box.style.display = 'block';
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(e.clientX - r.width - 14, innerWidth - r.width - 8)) + 'px';   // left of the cursor (GUI is on the right)
  box.style.top = Math.min(e.clientY + 14, innerHeight - r.height - 8) + 'px';
}
function hide() { clearTimeout(timer); if (box) box.style.display = 'none'; }

// walk a dat.GUI tree and attach tips to every controller row
export function addTooltips(gui) {
  for (const c of gui.__controllers) {
    const text = tipFor(c.property), li = c.__li;
    if (!text || li.__tip) continue;
    li.__tip = true;
    li.addEventListener('mouseenter', (e) => { clearTimeout(timer); timer = setTimeout(() => show(text, e), 350); });
    li.addEventListener('mousemove', (e) => { if (box?.style.display === 'block') show(text, e); });
    li.addEventListener('mouseleave', hide);
    li.addEventListener('mousedown', hide);
  }
  for (const f of Object.values(gui.__folders)) addTooltips(f);
}
