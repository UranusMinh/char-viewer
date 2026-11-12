// AI Game Studio — Three.js rigged-character viewer / web runtime
// ---------------------------------------------------------------------------
// Loads a rigged, animated GLB (skinned mesh + animation clips) and plays its
// clips (idle / walk / run ...) in the browser. This is the WEB engine target
// for the "auto-rig to game skeletons" stage: Tripo exports GLB with a standard
// skeleton + preset animations, and Three.js consumes it natively via
// GLTFLoader + AnimationMixer (no conversion needed).
//
// Swap in a pipeline output by either:
//   - opening  viewer.html?model=./models/character.glb
//   - or editing DEFAULT_MODEL below to your exported Tripo GLB.
// Verified against three.js r186 (2026-11-11).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Default to our latest pipeline character (CHAR-03, suited "poker player"); override with ?model=./models/x.glb.
const DEFAULT_MODEL = './models/CHAR-02.glb';

const MODEL_URL = new URLSearchParams(location.search).get('model') || DEFAULT_MODEL;

const statusEl = document.getElementById('status');
const clipSelectEl = document.getElementById('clipSelect');
const modelNameEl = document.getElementById('modelName');
const statsEl = document.getElementById('stats');
const speedEl = document.getElementById('speed');
const speedValEl = document.getElementById('speedVal');

// --- Scene ------------------------------------------------------------------
const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setAnimationLoop(animate);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(3, 2, 5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 2.0; // degrees-ish per frame factor; used when autoRotate is on
controls.target.set(0, 1, 0);

// Lights
scene.add(new THREE.HemisphereLight(0xffffff, 0x444a55, 2.2));
const dir = new THREE.DirectionalLight(0xffffff, 2.5);
dir.position.set(5, 10, 7);
scene.add(dir);

// Ground grid (its size is adjusted once the model is framed)
const grid = new THREE.GridHelper(20, 20, 0x3a4150, 0x262c35);
grid.material.transparent = true;
grid.material.opacity = 0.5;
scene.add(grid);

// --- Animation state --------------------------------------------------------
const clock = new THREE.Clock();
let mixer = null;
let actions = {};        // clip name -> AnimationAction
let activeAction = null;
let currentModel = null; // the loaded glTF scene (for wireframe toggling)
let skeletonHelper = null;
let paused = false;
let playSpeed = 1.0;

function fadeToAction(name, duration = 0.3) {
  const next = actions[name];
  if (!next || next === activeAction) return;
  if (activeAction) activeAction.fadeOut(duration);
  next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(duration).play();
  activeAction = next;
  if (clipSelectEl) clipSelectEl.value = name; // keep the dropdown in sync with the active clip
  resolveEquipmentCollisions();               // re-check weapon overlaps for the new pose
}

// Pick a sensible default clip: prefer idle, else the first one.
function pickDefaultClip(names) {
  return names.find((n) => /idle|survey|stand/i.test(n)) || names[0];
}

function buildClipUI(animations) {
  clipSelectEl.innerHTML = '';
  if (!animations.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No animation clips';
    opt.disabled = true;
    opt.selected = true;
    clipSelectEl.appendChild(opt);
    clipSelectEl.disabled = true;
    return;
  }
  clipSelectEl.disabled = false;
  for (const clip of animations) {
    const opt = document.createElement('option');
    opt.value = clip.name;
    opt.textContent = clip.name;
    clipSelectEl.appendChild(opt);
  }
}

// Switch clips when the dropdown changes.
clipSelectEl.addEventListener('change', () => fadeToAction(clipSelectEl.value));

// Center the model and fit the camera / grid to its size.
function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Drop feet onto the grid (y = 0) and recenter horizontally.
  object.position.x += -center.x;
  object.position.z += -center.z;
  object.position.y += -box.min.y;

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 2.2;
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.position.set(dist * 0.6, size.y * 0.6 + maxDim * 0.3, dist);
  camera.updateProjectionMatrix();
  controls.target.set(0, size.y * 0.5, 0);
  controls.update();

  const g = Math.ceil(maxDim * 2);
  grid.scale.setScalar(g / 20);
}

// --- Equipment collision detection ------------------------------------------
// KayKit-style exports parent EVERY weapon onto the hand bones at once, so the
// character appears to hold a crossbow AND a knife (and a throwable) at the same
// time. The weapon meshes are rigid-parented to the hand bones, so their
// world-space AABBs (THREE.Box3) track the pose. We detect the overlap with real
// bounding-box intersection and hide the colliding pieces, keeping a single
// main-hand weapon. Toggle with the "Collision" button to see the raw export.
const WEAPON_KW = /sword|crossbow|\bbow\b|knife|dagger|axe|shield|throw|staff|spear|mace|hammer|quiver|arrow|gun|wand|pistol|offhand|1h_|2h_/i;
let equipment = [];        // candidate weapon meshes, sorted by keep-priority
let collisionOn = true;    // auto-hide overlapping equipment + push weapon out of head
let singleWeapon = true;   // after the collision pass, keep only the top survivor
let equipStatus = '';      // short readout for the stats panel

// Head collider (for the weapon-vs-head push-out). Sphere tracked by the head bone.
let headBone = null;
const headLocalCenter = new THREE.Vector3();
let headRadius = 0;
const HEAD_PUSH_CAP = 0.4; // max metres we may shift a blade out of the skull
const HEAD_PUSH_ITERS = 5;
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _hc = new THREE.Vector3();

// Lower rank = preferred to keep. Off-hand is kept last so the main-hand blade wins.
function rankOf(name) {
  if (/offhand/i.test(name)) return 50;
  const order = [/knife|dagger|sword/i, /throw/i, /1h_/i, /crossbow|\bbow\b/i, /2h_/i];
  const i = order.findIndex((re) => re.test(name));
  return i < 0 ? 40 : i;
}

// A weapon mesh is a rigid (non-skinned) mesh rigged under a hand/weapon slot
// bone. Detect by the bone ancestor first (name-agnostic, robust), then fall
// back to weapon keywords so this also works on other rigs.
function hasWeaponSlotAncestor(o) {
  for (let p = o.parent; p; p = p.parent) {
    if (p.isBone && /handslot|weaponslot|\bslot\b/i.test(p.name)) return true;
  }
  return false;
}

function classifyEquipment(model) {
  equipment = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if ((!o.isSkinnedMesh && hasWeaponSlotAncestor(o)) || WEAPON_KW.test(o.name)) equipment.push(o);
  });
  equipment.sort((a, b) => rankOf(a.name) - rankOf(b.name));
  // Remember each weapon's bind-pose local position so the head push-out can be
  // reset every frame (non-destructive), and cache its oriented local box.
  for (const e of equipment) {
    e.userData.bindPos = e.position.clone();
    if (e.geometry && !e.geometry.boundingBox) e.geometry.computeBoundingBox();
  }
}

// Build a head sphere for the weapon-vs-head test. Centre is the head mesh's
// visual centre (reliable) tracked via the head bone; radius is derived from the
// bone→centre distance (the skinned head's own bounding box is unreliable).
function setupHeadCollider(model) {
  headBone = null; headRadius = 0;
  model.traverse((o) => { if (!headBone && o.isBone && /head/i.test(o.name)) headBone = o; });
  let headMesh = null;
  model.traverse((o) => { if (!headMesh && o.isMesh && /head/i.test(o.name)) headMesh = o; });
  if (!headBone || !headMesh) return;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(headMesh);
  const center = box.getCenter(_v1);
  const bonePos = headBone.getWorldPosition(_v2);
  headRadius = center.distanceTo(bonePos) * 0.64;
  headBone.worldToLocal(headLocalCenter.copy(center));
}

// Push one weapon out of the head sphere using its ORIENTED box (local-space
// clamp) so a long diagonal blade isn't over-reported like an axis-aligned box.
function pushWeaponOutOfHead(weapon) {
  if (!headBone || headRadius <= 0 || !weapon.geometry || !weapon.geometry.boundingBox) return 0;
  const kbb = weapon.geometry.boundingBox;
  let used = 0;
  for (let k = 0; k < HEAD_PUSH_ITERS; k++) {
    const hc = headBone.localToWorld(_hc.copy(headLocalCenter));
    const cpLocal = kbb.clampPoint(weapon.worldToLocal(_v1.copy(hc)), _v2);
    const cpWorld = weapon.localToWorld(cpLocal);          // nearest point on the blade
    const d = cpWorld.distanceTo(headBone.localToWorld(_hc.copy(headLocalCenter)));
    if (d >= headRadius) break;
    const step = Math.min(headRadius - d, HEAD_PUSH_CAP - used);
    if (step <= 1e-4) break;
    used += step;
    const dir = _v3.copy(cpWorld).sub(headBone.localToWorld(_hc.copy(headLocalCenter)));
    if (dir.lengthSq() < 1e-8) { weapon.getWorldPosition(dir); dir.sub(headBone.localToWorld(_hc.copy(headLocalCenter))); }
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
    dir.normalize().multiplyScalar(step);
    const wp = weapon.getWorldPosition(_v1).add(dir);
    weapon.position.copy(weapon.parent.worldToLocal(wp));
    weapon.updateMatrixWorld(true);
  }
  return used;
}

// Resolve weapon overlaps using real world-space bounding boxes, then lift the
// surviving weapon out of the head if an animated pose drives it into the skull.
function resolveEquipmentCollisions() {
  if (!equipment.length) { equipStatus = ''; return; }
  // Reset each weapon to its bind pose: AABBs are measured on real geometry, any
  // previous head push is undone, and turning collision OFF restores the raw export.
  for (const e of equipment) { e.visible = true; if (e.userData.bindPos) e.position.copy(e.userData.bindPos); }
  if (!collisionOn) { equipStatus = `all shown (${equipment.length})`; return; }

  scene.updateMatrixWorld(true); // weapons are rigid-parented to bones → boxes follow the pose
  const items = equipment.map((o) => ({ o, box: new THREE.Box3().setFromObject(o) }));
  const kept = [];
  let hidden = 0;
  for (const it of items) {
    if (kept.some((k) => it.box.intersectsBox(k.box))) { it.o.visible = false; hidden++; }
    else kept.push(it);
  }
  // "Keep only one weapon": hide every survivor except the top-ranked one.
  if (singleWeapon) for (let i = 1; i < kept.length; i++) { kept[i].o.visible = false; hidden++; }

  // Weapon-vs-head: push the single visible weapon out of the head sphere.
  const main = equipment.find((e) => e.visible);
  const push = main ? pushWeaponOutOfHead(main) : 0;

  const shown = equipment.filter((e) => e.visible).map((e) => e.name);
  equipStatus = `${shown.join(', ') || 'none'} (−${hidden}${push > 0.005 ? `, head −${push.toFixed(2)}m` : ''})`;
}

// --- Load -------------------------------------------------------------------
const loader = new GLTFLoader();
// Support Draco-compressed GLBs (our export stage can enable Draco).
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/');
loader.setDRACOLoader(draco);

modelNameEl.textContent = MODEL_URL.split('/').pop();

loader.load(
  MODEL_URL,
  (gltf) => {
    const model = gltf.scene;
    currentModel = model;
    scene.add(model);
    frameModel(model);
    applyWireframe(wireframeOn); // keep toggle state across reloads

    // Skeleton overlay (hidden until toggled). SkeletonHelper is in three core.
    skeletonHelper = new THREE.SkeletonHelper(model);
    skeletonHelper.visible = skeletonOn;
    skeletonHelper.material.linewidth = 2;
    scene.add(skeletonHelper);

    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      actions = {};
      for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
      buildClipUI(gltf.animations);
      fadeToAction(pickDefaultClip(gltf.animations.map((c) => c.name)), 0);
    } else {
      buildClipUI([]);
    }
    // Detect & resolve the "holding every weapon at once" overlap, and set up the
    // head collider so an animated blade gets pushed out of the skull.
    classifyEquipment(model);
    setupHeadCollider(model);
    resolveEquipmentCollisions();
    statusEl.classList.add('hidden');
  },
  (xhr) => {
    if (xhr.total) statusEl.textContent = `Loading model… ${Math.round((xhr.loaded / xhr.total) * 100)}%`;
  },
  (err) => {
    console.error(err);
    statusEl.classList.remove('hidden');
    statusEl.classList.add('err');
    statusEl.innerHTML =
      `Could not load <code>${MODEL_URL}</code>.<br><br>` +
      `Pass a model with <code>?model=./models/your.glb</code>, or export a rigged ` +
      `GLB from the pipeline into <code>viewer/threejs/models/</code>.`;
  }
);

// --- Control panel: collapse / expand the top-left dropdown -----------------
const panelToggle = document.getElementById('panelToggle');
const panelBody = document.getElementById('panelBody');
panelToggle.addEventListener('click', () => {
  const open = panelBody.classList.toggle('collapsed') === false;
  panelToggle.setAttribute('aria-expanded', String(open));
});

// --- View toggles: turntable auto-rotate + wireframe + skeleton -------------
let wireframeOn = false;
let skeletonOn = false;

function applyWireframe(on) {
  if (!currentModel) return;
  currentModel.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) if (m) m.wireframe = on;
  });
}

const btnRotate = document.getElementById('btnRotate');
btnRotate.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  btnRotate.classList.toggle('active', controls.autoRotate);
});

const btnWire = document.getElementById('btnWire');
btnWire.addEventListener('click', () => {
  wireframeOn = !wireframeOn;
  applyWireframe(wireframeOn);
  btnWire.classList.toggle('active', wireframeOn);
});

const btnSkeleton = document.getElementById('btnSkeleton');
btnSkeleton.addEventListener('click', () => {
  skeletonOn = !skeletonOn;
  if (skeletonHelper) skeletonHelper.visible = skeletonOn;
  btnSkeleton.classList.toggle('active', skeletonOn);
});

const btnPlay = document.getElementById('btnPlay');
btnPlay.addEventListener('click', () => {
  paused = !paused;
  btnPlay.textContent = paused ? 'Play' : 'Pause';
  btnPlay.classList.toggle('active', !paused);
});

// Collision toggle: on → auto-hide overlapping weapons (keep one); off → raw export.
const btnCollision = document.getElementById('btnCollision');
btnCollision.classList.toggle('active', collisionOn);
btnCollision.addEventListener('click', () => {
  collisionOn = !collisionOn;
  btnCollision.classList.toggle('active', collisionOn);
  resolveEquipmentCollisions();
});

speedEl.addEventListener('input', () => {
  playSpeed = parseFloat(speedEl.value);
  speedValEl.textContent = `${playSpeed.toFixed(2)}×`;
});

// --- Stats (triangles + draw calls + active clip) ---------------------------
function updateStats() {
  const info = renderer.info.render;
  const clip = activeAction ? activeAction.getClip().name : '—';
  statsEl.innerHTML =
    `clip: <b>${clip}</b>\n` +
    `tris: <b>${info.triangles.toLocaleString()}</b>\n` +
    `draw calls: <b>${info.calls}</b>` +
    (equipStatus ? `\nweapon: <b>${equipStatus}</b>` : '');
}

// --- Loop / resize ----------------------------------------------------------
function animate() {
  const dt = clock.getDelta();
  if (mixer && !paused) mixer.update(dt * playSpeed);
  controls.update();
  // Re-resolve every frame so weapon overlaps and the head push-out track the
  // current pose smoothly (cheap: a handful of boxes). Runs after mixer.update.
  if (equipment.length) resolveEquipmentCollisions();
  renderer.render(scene, camera);
  updateStats();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
