// 3D race view for the web prototype — a WebGL port of unity/Assets/Muchi/Runtime/RaceWorld.cs:
//   - the same racecourse (Greenfield straight, or the course generated from the engine's TrackGeometry through
//     CourseFrame, finish line at z=420 facing +Z), grandstand, finish beam, sky, fog and afternoon sun;
//   - Codex's FBX partner models (player: the equipped featured partner; opponents: catalog opponentLod),
//     animated like PartnerGallop.cs;
//   - the chase camera of RaceWorld.Present (FOV 57, 6.5 m behind / 3 m above, look 9 m ahead, exp smoothing).
// Poses come from the WASM engine (CourseFrame.Horse of the interpolated engine state + xShift).
//
// Unity is left-handed (X right, Y up, Z forward); three.js is right-handed. World positions map (x, y, z) → (x, y, -z),
// yaw (clockwise from +Z) maps to rotation.y = -yaw. Unity imports the FBX mirrored on X and then turns the model 180°;
// combined with the Z mirror that is the identity, so the FBX is used as authored (no extra rotation).
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const FEATURED = ['Partner_Bay_Crimson', 'Partner_Chestnut_Azure', 'Partner_DappleGrey_Violet', 'Partner_Black_Emerald', 'Partner_Palomino_Gold'];
const BONES = ['Front_L_Upper', 'Front_L_Lower', 'Front_R_Upper', 'Front_R_Lower', 'Hind_L_Upper', 'Hind_L_Lower', 'Hind_R_Upper', 'Hind_R_Lower', 'Jockey_Body', 'Head'];
const DEG = Math.PI / 180;
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const U = (x, y, z) => new THREE.Vector3(x, y, -z); // Unity world → three world

// PartnerCatalog (unity/Assets/Muchi/Game/PartnerCatalog.cs): asset contract look → one of the 25 prebuilt models.
const COAT = { bay: 'Bay', dark_bay: 'Bay', brown: 'Bay', chestnut: 'Chestnut', black: 'Black', gray: 'DappleGrey', grey: 'DappleGrey', white: 'DappleGrey', default: 'Bay' };
const SILK = { red: 'Crimson', maroon: 'Crimson', pink: 'Crimson', orange: 'Crimson', blue: 'Azure', sky: 'Azure', navy: 'Azure', purple: 'Violet', green: 'Emerald', lime: 'Emerald', yellow: 'Gold', gold: 'Gold' };
function resolveVariant(catalog, e) {
  const coatKey = e?.coat || 'bay';
  const coat = coatKey === 'chestnut' && e?.mane === 'flaxen' ? 'Palomino' : (COAT[coatKey] ?? 'Bay');
  let silk = 'Crimson';
  for (const c of e?.colors ?? []) if (SILK[c]) { silk = SILK[c]; break; }
  const byId = new Map(catalog.partnerVariants.map((v) => [v.id, v]));
  const exact = byId.get(`Partner_${coat}_${silk}`);
  if (exact) return exact;
  const ids = [...byId.keys()].sort();
  return byId.get(ids.find((id) => byId.get(id).coat === coat) ?? ids[0]);
}

export class RaceView {
  constructor(canvas, resolve, catalog) {
    this.canvas = canvas; this.resolve = resolve; this.catalog = catalog;
    this.models = new Map(); this.horses = []; this.info = null; this.clock = performance.now();
  }

  async load() {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    r.setSize(1600, 900, false);
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = this.scene = new THREE.Scene();
    // RenderSettings: ambient (.66,.76,.86), exp² fog (.68,.83,.95) density .0014; camera background (.39,.69,.94)
    this.ambient = new THREE.HemisphereLight(srgb(.74, .84, .94), srgb(.42, .46, .40), 2.3);
    scene.add(this.ambient);
    scene.fog = new THREE.FogExp2(srgb(.68, .83, .95), .0014);
    scene.background = srgb(.39, .69, .94);
    // "Afternoon sun": directional, intensity 1.25, Euler(38, -35, 0), soft shadows
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.25 * 2.4);
    const e = new THREE.Euler(38 * DEG, -35 * DEG, 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, 1).applyEuler(e); // Unity light forward (left-handed numbers)
    this.sunDir = new THREE.Vector3(fwd.x, fwd.y, -fwd.z).normalize();
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 260;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
    scene.add(sun); scene.add(sun.target);
    // "Chase camera": FOV 57, far clip 1200
    this.camera = new THREE.PerspectiveCamera(57, 16 / 9, 0.3, 1200);
    this.mats = new Map();
    this.course = new THREE.Group(); scene.add(this.course);
    this.finish = new THREE.Group(); this.course.add(this.finish);
    // finish beam and posts (part of the course for every race)
    this.box(this.finish, [0, 7, 420], [32, .35, .4], this.mat(.95, .96, .91));
    for (const x of [-15, 15]) this.box(this.finish, [x, 3.5, 420], [.4, 7, .4], this.mat(.95, .96, .91));

    const loader = new FBXLoader();
    const paths = [...FEATURED.map((id) => 'Models/Partners/' + id), 'Models/PartnerLODs/Partner_Bay_Azure_LOD1'];
    await Promise.all(paths.map(async (p) => {
      const url = this.resolve(p);
      if (!url) return;
      try {
        const obj = await loader.loadAsync(url);
        // Unity's FBX import converts the file's centimetre unit scale to metres; FBXLoader keeps file units.
        const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
        if (size.y > 20) obj.scale.multiplyScalar(0.01);
        obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
        this.models.set(p, obj);
      } catch (err) { console.warn('model', p, err?.message ?? err); }
    }));
  }

  mat(r, g, b) {
    const k = `${r},${g},${b}`;
    if (!this.mats.has(k)) this.mats.set(k, new THREE.MeshLambertMaterial({ color: srgb(r, g, b) }));
    return this.mats.get(k);
  }
  // RaceWorld.Box: a unit cube at a Unity position/scale (optional yaw in degrees, Unity convention)
  box(parent, p, s, m, yaw = 0) {
    const mesh = new THREE.Mesh(this.unitBox ??= new THREE.BoxGeometry(1, 1, 1), m);
    mesh.position.copy(U(...p)); mesh.scale.set(...s); mesh.rotation.y = -yaw * DEG;
    mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  }
  // many boxes of one material → one InstancedMesh
  boxes(parent, list, m, receive = true) {
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(this.unitBox ??= new THREE.BoxGeometry(1, 1, 1), m, list.length);
    const q = new THREE.Quaternion(), M = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0);
    list.forEach(([p, s, yaw = 0], i) => { q.setFromAxisAngle(up, -yaw * DEG); M.compose(U(...p), q, new THREE.Vector3(...s)); inst.setMatrixAt(i, M); });
    inst.receiveShadow = receive; inst.castShadow = false;
    parent.add(inst);
  }

  // Greenfield straight (RaceWorld.Initialize): turf, mown stripes, rails at x=±15 from z=-60 to 500
  buildStraight(g) {
    const rail = this.mat(.95, .96, .91);
    this.box(g, [0, -.22, 220], [250, .4, 650], this.mat(.23, .48, .12));
    const stripes = [], posts = [], rails = [];
    for (let z = -60; z < 500; z += 10) {
      if (z % 20 === 0) stripes.push([[0, -.008, z], [28, .012, 10]]);
      for (const x of [-15, 15]) { posts.push([[x, .65, z], [.15, 1.3, .15]]); rails.push([[x, 1.25, z + 5], [.15, .15, 10]]); }
    }
    this.boxes(g, stripes, this.mat(.27, .52, .14));
    this.boxes(g, posts, rail); this.boxes(g, rails, rail);
  }
  // RaceWorld.BuildCourse: ground, running surface and rails from the engine's track geometry
  buildCourse(g, w, dirt) {
    const [minX, minZ, maxX, maxZ] = w.bounds;
    this.box(g, [(minX + maxX) / 2, -.25, (minZ + maxZ) / 2], [maxX - minX + 160, .4, maxZ - minZ + 160], this.mat(.20, .42, .11));
    const surface = dirt ? this.mat(.55, .40, .26) : this.mat(.27, .53, .15);
    const rail = this.mat(.95, .96, .91);
    const width = w.outerRailM - w.innerRailM + 1;
    this.boxes(g, ribbon(w.surface, width, .02, -.03), surface);
    const posts = [], rails = [];
    for (const line of [w.inner, w.outer]) {
      rails.push(...ribbon(line, .15, .15, 1.25));
      for (const [x, z] of line) posts.push([[x, .65, z], [.15, 1.3, .15]]);
    }
    this.boxes(g, rails, rail); this.boxes(g, posts, rail);
  }
  // RaceWorld.BuildStands: terraces, canopy and crowd on the outside of the home straight
  buildStands(g, side) {
    const concrete = this.mat(.58, .65, .70), roof = this.mat(.12, .23, .32);
    for (let tier = 0; tier < 5; tier++) this.box(g, [side * (35 + tier * 3), 1 + tier * 2, 160], [8, 2, 230], concrete);
    this.box(g, [side * 42, 15, 160], [29, .5, 250], roof);
    const crowd = [[], [], []];
    for (let i = 0; i < 300; i++) crowd[i % 3].push([[side * (34 + (i % 5) * 3), 2 + (i % 5) * 2, 48 + Math.floor(i / 5) * 3.8], [.65, .85, .65]]);
    const cm = [this.mat(.9, .3, .25), this.mat(.9, .85, .7), this.mat(.15, .35, .65)];
    crowd.forEach((list, k) => this.boxes(g, list, cm[k]));
  }

  // RaceWorld.StartRace
  start(info, playerPartner) {
    this.info = info;
    const w = info.world;
    if (this.generated) { this.course.remove(this.generated); disposeGroup(this.generated); }
    const g = this.generated = new THREE.Group(); this.course.add(g);
    if (w.straight) this.buildStraight(g); else this.buildCourse(g, w, info.surface === 'dirt');
    this.buildStands(g, w.straight ? -1 : w.outsideSign);
    // SetNight
    const night = w.night;
    this.sun.intensity = (night ? .35 : 1.25) * 2.4;
    this.scene.background = night ? srgb(.04, .06, .12) : srgb(.39, .69, .94);
    this.scene.fog.color = night ? srgb(.05, .07, .12) : srgb(.68, .83, .95);
    this.ambient.intensity = night ? .9 : 2.3;
    for (const h of this.horses) this.scene.remove(h.anchor);
    this.horses = [];
    const n = info.names.length;
    for (let i = 0; i < n; i++) {
      let path;
      if (i === 0) path = 'Models/Partners/' + FEATURED[Math.max(0, Math.min(4, playerPartner))];
      else { const v = resolveVariant(this.catalog, w.entrants?.[i]); path = v?.opponentLod ?? v?.model; }
      const src = this.models.get(path) ?? this.models.get('Models/PartnerLODs/Partner_Bay_Azure_LOD1') ?? this.models.get('Models/Partners/' + FEATURED[0]);
      this.horses.push(this.anchor(i, src));
    }
    // the chase camera starts where RaceWorld.Lobby left it and swoops in behind the player
    this.camera.position.copy(U(4, 2.8, 31)); this.camera.lookAt(U(0, 1.65, 25));
    this.clock = performance.now(); this.t0 = this.clock;
  }

  // RaceWorld.Anchor + PartnerGallop.Bind
  anchor(slot, src) {
    const anchor = new THREE.Group();
    const model = src ? src.clone(true) : proxyHorse();
    const base = model.scale.clone();
    model.scale.copy(base).multiplyScalar(.95);
    anchor.add(model); this.scene.add(anchor);
    const bones = BONES.map(() => null), rest = BONES.map(() => null);
    model.traverse((o) => {
      const name = o.name.includes('|') ? o.name.slice(o.name.lastIndexOf('|') + 1) : o.name;
      const b = BONES.indexOf(name);
      if (b >= 0 && !bones[b]) { bones[b] = o; rest[b] = o.quaternion.clone(); }
    });
    return { anchor, model, modelY: model.position.y, bones, rest };
  }

  // RaceWorld.Present + PartnerGallop.LateUpdate
  draw(f) {
    if (!this.info || !f.horses) return;
    const now = performance.now(), dt = Math.min(.1, (now - this.clock) / 1000); this.clock = now;
    const time = (now - this.t0) / 1000;
    const q = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);
    const cycle = time * 12.5;
    for (let i = 0; i < this.horses.length; i++) {
      const h = this.horses[i], p = f.horses[i];
      if (!p || p[6] === false) continue;
      h.anchor.position.copy(U(p[0], .06 * Math.sin(time * 13 + i), p[1]));
      h.anchor.rotation.y = -p[2] * DEG;
      // gallop (StartRace sets every partner racing)
      h.model.position.y = h.modelY + .018 + .028 * Math.abs(Math.sin(cycle * 2));
      for (let b = 0; b < 8; b++) {
        if (!h.bones[b]) continue;
        const leg = b >> 1, lower = (b % 2) === 1, left = (leg % 2) === 0, hind = leg >= 2;
        const phase = cycle + (left ? 0 : Math.PI) + (hind ? Math.PI : 0);
        const angle = lower ? (-8 - 17 * Math.max(0, Math.sin(phase + 1.0))) : (hind ? 27 : 22) * Math.sin(phase);
        h.bones[b].quaternion.copy(h.rest[b]).multiply(q.setFromAxisAngle(X, angle * DEG));
      }
      if (h.bones[8]) h.bones[8].quaternion.copy(h.rest[8]).multiply(q.setFromAxisAngle(X, 2.2 * Math.sin(cycle * 2) * DEG));
      if (h.bones[9]) h.bones[9].quaternion.copy(h.rest[9]).multiply(q.setFromAxisAngle(X, 1.4 * Math.sin(cycle) * DEG));
    }
    const me = this.horses[0]?.anchor;
    if (me) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(me.quaternion);
      const target = me.position.clone().addScaledVector(fwd, -6.5).add(new THREE.Vector3(0, 3, 0));
      this.camera.position.lerp(target, 1 - Math.exp(-dt * 6));
      this.camera.lookAt(me.position.clone().addScaledVector(fwd, 9).add(new THREE.Vector3(0, 1.8, 0)));
      // keep the shadow frustum around the player
      this.sun.target.position.copy(me.position);
      this.sun.position.copy(me.position).addScaledVector(this.sunDir, -120);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

// RaceWorld.Ribbon: boxes between consecutive course points ([x, z] in Unity metres)
function ribbon(line, width, height, y) {
  const out = [];
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], [cx, cz] = line[i];
    const dx = cx - ax, dz = cz - az, len = Math.hypot(dx, dz);
    if (len < 1e-2) continue;
    out.push([[(ax + cx) / 2, y, (az + cz) / 2], [width, height, len + .05], Math.atan2(dx, dz) / DEG]);
  }
  return out;
}

function disposeGroup(g) { g.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); }

// RaceWorld.ProxyHorse equivalent when a model failed to load: a simple coloured block horse.
function proxyHorse() {
  const g = new THREE.Group();
  const coat = new THREE.MeshLambertMaterial({ color: srgb(.42, .19, .09) }), silk = new THREE.MeshLambertMaterial({ color: srgb(.85, .08, .1) });
  const add = (s, p, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(...s), m); b.position.set(...p); g.add(b); };
  add([.55, .7, 1.9], [0, 1.35, 0], coat); add([.3, .9, .35], [0, 1.9, -1.05], coat);
  for (const [x, z] of [[-.18, -.7], [.18, -.7], [-.18, .7], [.18, .7]]) add([.14, 1.1, .14], [x, .55, z], coat);
  add([.4, .6, .35], [0, 2.1, .1], silk);
  return g;
}
