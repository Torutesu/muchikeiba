// 3D race view for the web prototype — a WebGL port of unity/Assets/Muchi/Runtime/RaceWorld.cs, dressed like Codex's
// key art (unity/design/figma-screens 02-first-ride / 09-ranked-race):
//   - the same racecourse (Greenfield straight, or the course generated from the engine's TrackGeometry through
//     CourseFrame, finish line at z=420 facing +Z), finish beam, fog and afternoon sun;
//   - a photoreal backdrop: Codex's course plates (Art/Courses, Art/Weather: grandstand, crowd, trees, hills, sky) on a
//     cylinder that travels with the camera, with the plate's horizon at eye level; the sky above it continues the
//     plate's colour (CSS gradient behind the transparent canvas);
//   - mown-stripe turf, outfield grass and dirt as small canvas textures (also on software GL), white rails on green
//     posts, distance poles (400–100 m) with boards and a winning post;
//   - Codex's FBX partner models: the player's equipped featured partner at full detail; rivals on the catalog's LOD1
//     with their own silks and coat colours (the asset contract look, else a per-gate palette); blob shadows;
//   - the camera: RaceCameraRig's mode and FOV from the engine (follow / final straight / side at the finish), drawn
//     as a lower, closer chase cam behind the partner (like the key art), with an FOV kick on the whip.
// Everything here is presentation: poses come from the WASM engine (CourseFrame.Horse of the interpolated engine
// state + xShift) and nothing feeds back into the simulation.
//
// Unity is left-handed (X right, Y up, Z forward); three.js is right-handed. World positions map (x, y, z) → (x, y, -z),
// yaw (clockwise from +Z) maps to rotation.y = -yaw. Unity imports the FBX mirrored on X and then turns the model 180°;
// combined with the Z mirror that is the identity, so the FBX is used as authored (no extra rotation).
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const FEATURED = ['Partner_Bay_Crimson', 'Partner_Chestnut_Azure', 'Partner_DappleGrey_Violet', 'Partner_Black_Emerald', 'Partner_Palomino_Gold'];
const RIVAL = 'Models/PartnerLODs/Partner_Bay_Azure_LOD1';
const BONES = ['Front_L_Upper', 'Front_L_Lower', 'Front_R_Upper', 'Front_R_Lower', 'Hind_L_Upper', 'Hind_L_Lower', 'Hind_R_Upper', 'Hind_R_Lower', 'Jockey_Body', 'Head'];
const DEG = Math.PI / 180;
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const hex = (h) => new THREE.Color(h); // CSS hex in sRGB → linear
const U = (x, y, z) => new THREE.Vector3(x, y, -z); // Unity world → three world

// PartnerCatalog (unity/Assets/Muchi/Game/PartnerCatalog.cs): asset contract look → coat and silk set.
const COAT = { bay: 'Bay', dark_bay: 'Bay', brown: 'Bay', chestnut: 'Chestnut', black: 'Black', gray: 'DappleGrey', grey: 'DappleGrey', white: 'DappleGrey', default: 'Bay' };
const SILK = { red: 'Crimson', maroon: 'Crimson', pink: 'Crimson', orange: 'Crimson', blue: 'Azure', sky: 'Azure', navy: 'Azure', purple: 'Violet', green: 'Emerald', lime: 'Emerald', yellow: 'Gold', gold: 'Gold' };
// colours of the 25 prebuilt variants (material names "Racing silk / Azure", "Coat / Bay" …) for recolouring the LOD
const SILK_RGB = { Crimson: ['#9e060e', '#f0deb3'], Azure: ['#0a3c8f', '#2fc4ec'], Violet: ['#4a1f8f', '#e2ccff'], Emerald: ['#0a6a3c', '#f2e9cf'], Gold: ['#e0b214', '#2a1a08'] };
const COAT_RGB = { Bay: ['#3a170b', '#0b0605'], Chestnut: ['#7a3412', '#4e200b'], Black: ['#141212', '#060606'], DappleGrey: ['#a9a6a1', '#5c5955'], Palomino: ['#c69c55', '#efe0bb'] };
const SILK_ORDER = ['Crimson', 'Azure', 'Violet', 'Emerald', 'Gold'], COAT_ORDER = ['Bay', 'Chestnut', 'Black', 'DappleGrey', 'Palomino'];
function lookOf(e, slot) {
  // offline races have no looks (fallback visuals, all the same): a per-gate palette keeps the field readable
  if (!e?.colors?.length && !e?.coat) return { silk: SILK_ORDER[(slot + 1) % 5], coat: COAT_ORDER[(slot * 3 + 1) % 5], accent: (slot % 2) === 1 };
  const coatKey = e?.coat || 'bay';
  const coat = coatKey === 'chestnut' && e?.mane === 'flaxen' ? 'Palomino' : (COAT[coatKey] ?? 'Bay');
  let silk = 'Crimson';
  for (const c of e?.colors ?? []) if (SILK[c]) { silk = SILK[c]; break; }
  return { silk, coat, accent: false };
}

// Backdrop plates: Codex's course art, the row of the image that sits at eye level, and the sky colour above it
const PLATES = {
  spring: { res: 'Art/Courses/spring-course', horizon: 396, sky: ['#3f86e2', '#70adf8'] },
  sunny: { res: 'Art/Weather/sunny', horizon: 560, sky: ['#5b93dc', '#a7c4ec'] },
  autumn: { res: 'Art/Courses/autumn-course', horizon: 396, sky: ['#6a3a3e', '#be745a'] },
};

export class RaceView {
  constructor(canvas, resolve, catalog) {
    this.canvas = canvas; this.resolve = resolve; this.catalog = catalog;
    this.models = new Map(); this.horses = []; this.info = null; this.clock = performance.now();
    this.fovKick = 0;
  }

  async load() {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    // the stage is scaled to the window: render at the pixels it will actually cover (phones: ~1×, big monitors: up to 2×)
    r.setPixelRatio(Math.max(.75, Math.min(2, (globalThis.devicePixelRatio || 1) * Math.min(innerWidth / 1600, innerHeight / 900))));
    r.setSize(1600, 900, false);
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    // software GL (CI, Figma previews without a GPU, very low-end devices): no shadow maps, no tone mapping and fewer
    // pixels (the textures stay), so the race still renders every engine frame (06 §9.1)
    try {
      const gl = r.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.lite = /swiftshader|llvmpipe|software/i.test(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '');
    } catch { this.lite = false; }
    if (this.lite) { r.shadowMap.enabled = false; r.setPixelRatio(.5); }
    if (!this.lite) { r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05; }
    const scene = this.scene = new THREE.Scene();
    // RenderSettings: ambient (.66,.76,.86), exp² fog (.68,.83,.95); a lighter fog for depth without washing the plate
    this.ambient = new THREE.HemisphereLight(srgb(.78, .86, .95), srgb(.36, .44, .30), 2.4);
    scene.add(this.ambient);
    scene.fog = new THREE.FogExp2(srgb(.72, .84, .95), .0022);
    scene.background = null;
    // "Afternoon sun": directional, intensity 1.25, Euler(38, -35, 0), soft shadows
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.25 * 2.4);
    const e = new THREE.Euler(38 * DEG, -35 * DEG, 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, 1).applyEuler(e); // Unity light forward (left-handed numbers)
    this.sunDir = new THREE.Vector3(fwd.x, fwd.y, -fwd.z).normalize();
    sun.castShadow = !this.lite; sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 260;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
    sun.color = srgb(1, .95, .86); // warm afternoon sun
    scene.add(sun); scene.add(sun.target);
    // "Chase camera": FOV 57, far clip 1200
    this.camera = new THREE.PerspectiveCamera(57, 16 / 9, 0.3, 1200);
    this.mats = new Map();
    const aniso = this.lite ? 1 : Math.min(8, r.capabilities.getMaxAnisotropy());
    this.tex = { mown: mownTexture(aniso), grass: grassTexture(aniso), dirt: dirtTexture(aniso), pole: poleTexture(), blob: blobTexture() };
    this.course = new THREE.Group(); scene.add(this.course);
    this.finish = new THREE.Group(); this.course.add(this.finish);
    // finish beam and posts (part of the course for every race)
    this.box(this.finish, [0, 7, 420], [32, .35, .4], this.mat(.95, .96, .91));
    for (const x of [-15, 15]) this.box(this.finish, [x, 3.5, 420], [.4, 7, .4], this.mat(.95, .96, .91));
    // the ground beyond the course out to the horizon, under the backdrop
    const far = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshLambertMaterial({ color: hex('#cfe8b8'), map: rep(this.tex.grass, 300, 300) }));
    far.rotation.x = -Math.PI / 2; far.position.y = -.45; far.receiveShadow = false; this.far = far; scene.add(far);
    // backdrop plates
    this.plates = {};
    const tl = new THREE.TextureLoader();
    await Promise.all(Object.entries(PLATES).map(async ([k, p]) => {
      const url = this.resolve(p.res);
      if (!url) return;
      try { this.plates[k] = await tl.loadAsync(url); } catch (err) { console.warn('plate', k, err?.message ?? err); }
    }));

    const loader = new FBXLoader();
    const paths = [...FEATURED.map((id) => 'Models/Partners/' + id), RIVAL];
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

  /** The backdrop: a plate on a cylinder around the camera (tiled 3× with mirroring), its horizon row at eye level. */
  setBackdrop(key, night) {
    if (this.backdrop) { this.scene.remove(this.backdrop); this.backdrop.geometry.dispose(); this.backdrop.material.dispose(); this.backdrop = null; }
    const p = PLATES[key], img = this.plates[key];
    this.canvas.style.background = night
      ? 'linear-gradient(180deg, #02040c 0%, #0a1020 60%, #0d1220 100%)'
      : `linear-gradient(180deg, ${p.sky[0]} 0%, ${p.sky[1]} 22%, ${p.sky[1]} 100%)`;
    this.renderer.setClearColor(hex(night ? "#0a1020" : p.sky[1])); // opaque canvas (cheaper to composite): the sky above the plate
    if (!img) return;
    const H0 = img.image.height, W0 = img.image.width, s = H0 / 900; // plates are 1600×900 (rows below in 900ths)
    const cropB = Math.min(H0, (p.horizon + 40) * s), R = 640, tiles = 3;
    const t = img.clone(); t.needsUpdate = true;
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.MirroredRepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(tiles, cropB / H0); t.offset.set(0, 1 - cropB / H0);
    const H = (2 * Math.PI * R / tiles) * (cropB / W0);
    const below = H * ((cropB - p.horizon * s) / cropB);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 72, 1, true), new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false }));
    if (night) m.material.color = hex('#3a4566');
    m.renderOrder = -10; m.frustumCulled = false;
    m.userData = { yOff: H / 2 - below };
    this.backdrop = m; this.scene.add(m);
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
  /** The running surface as one strip along the course line, UVs in metres (stripes across, every 12 m). */
  surface(parent, line, width, y, dirt) {
    const geo = strip(line, width, y, 8, 12);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, map: dirt ? this.tex.dirt : this.tex.mown }));
    m.receiveShadow = true; parent.add(m); return m;
  }
  /** White rails on green posts along a line. */
  rails(parent, lines, step = 1) {
    const posts = [], rails = [];
    for (const line of lines) {
      rails.push(...ribbon(line, .14, .12, 1.18));
      line.forEach(([x, z], i) => { if (i % step === 0) posts.push([[x, .58, z], [.09, 1.16, .09]]); });
    }
    this.boxes(parent, rails, this.mat(.97, .97, .95)); this.boxes(parent, posts, this.mat(.12, .42, .28));
  }
  /** Distance poles (400 / 300 / 200 / 100 m before the line) with number boards, and the winning post. */
  markers(parent, railAt) {
    for (const d of [400, 300, 200, 100]) {
      const at = railAt(420 - d);
      if (!at) continue;
      const [x, side] = at, px = x + side * 1.4;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, 3.4, 8), new THREE.MeshLambertMaterial({ map: this.tex.pole }));
      pole.position.copy(U(px, 1.8, 420 - d)); parent.add(pole);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 1.4), new THREE.MeshBasicMaterial({ map: numberBoard(String(d)), side: THREE.DoubleSide }));
      board.position.copy(U(px, 3.9, 420 - d)); parent.add(board); // faces the chase camera (looking down the course)
    }
    const at = railAt(420);
    if (at) {
      const [x, side] = at, px = x + side * 1.4;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(.14, .14, 5, 10), this.mat(.97, .97, .95)); post.position.copy(U(px, 2.5, 420)); parent.add(post);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.1, 28), new THREE.MeshBasicMaterial({ map: numberBoard('', true), side: THREE.DoubleSide }));
      disc.position.copy(U(px, 4.6, 420)); parent.add(disc);
    }
  }

  // Greenfield straight (RaceWorld.Initialize): turf, mown stripes, rails at x=±15 from z=-60 to 500
  buildStraight(g) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(250, 650), new THREE.MeshLambertMaterial({ color: 0xffffff, map: rep(this.tex.grass, 250 / 6, 650 / 6) }));
    ground.rotation.x = -Math.PI / 2; ground.position.copy(U(0, -.05, 220)); ground.receiveShadow = true; g.add(ground);
    const line = []; for (let z = -60; z <= 500; z += 10) line.push([0, z]);
    this.surface(g, line, 30, .04, false);
    const L = (x) => line.map(([, z]) => [x, z]);
    this.rails(g, [L(-15), L(15)]);
    this.markers(g, () => [-15, -1]);
  }
  // RaceWorld.BuildCourse: ground, running surface and rails from the engine's track geometry
  buildCourse(g, w, dirt) {
    const [minX, minZ, maxX, maxZ] = w.bounds;
    const gw = maxX - minX + 160, gd = maxZ - minZ + 160;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshLambertMaterial({ color: 0xffffff, map: rep(this.tex.grass, gw / 6, gd / 6) }));
    ground.rotation.x = -Math.PI / 2; ground.position.copy(U((minX + maxX) / 2, -.06, (minZ + maxZ) / 2)); ground.receiveShadow = true; g.add(ground);
    this.surface(g, w.surface, w.outerRailM - w.innerRailM + 1, .04, dirt);
    this.rails(g, [w.inner, w.outer], Math.max(1, Math.round(4 / Math.max(.5, avgStep(w.inner)))));
    // the inner rail of the home straight (the side the poles stand on): the rail point nearest each distance
    const railAt = (z) => {
      let best = null, bd = 12;
      for (const [x, pz] of w.inner) { const d = Math.abs(pz - z); if (Math.abs(x) < 40 && d < bd) { bd = d; best = x; } }
      return best == null ? null : [best, best < 0 ? -1 : 1];
    };
    this.markers(g, railAt);
  }

  // RaceWorld.StartRace
  start(info, playerPartner) {
    this.info = info;
    const w = info.world;
    if (this.generated) { this.course.remove(this.generated); disposeGroup(this.generated); }
    const g = this.generated = new THREE.Group(); this.course.add(g);
    const dirt = info.surface === 'dirt';
    if (w.straight) this.buildStraight(g); else this.buildCourse(g, w, dirt);
    // SetNight
    const night = w.night;
    this.sun.intensity = (night ? .35 : 1.25) * 2.4;
    this.scene.fog.color = night ? srgb(.05, .07, .12) : srgb(.72, .84, .95);
    this.ambient.intensity = night ? .9 : 2.4;
    this.far.material.color = night ? hex('#2a3a2a') : hex('#cfe8b8');
    this.setBackdrop(night ? 'autumn' : dirt ? 'sunny' : 'spring', night);
    for (const h of this.horses) this.scene.remove(h.anchor);
    this.horses = [];
    this.setGhosts(0);
    const n = info.names.length;
    const ps = this.playerSlot = info.playerSlot ?? 0;
    // offline fields carry one fallback look for every rival: then each gate gets its own silks instead
    const same = new Set((w.entrants ?? []).filter((_, i) => i !== ps).map((e) => JSON.stringify([e?.coat, e?.colors]))).size <= 1;
    for (let i = 0; i < n; i++) {
      if (i === ps && !this.lite) { this.horses.push(this.anchor(i, this.models.get('Models/Partners/' + FEATURED[Math.max(0, Math.min(4, playerPartner))]) ?? this.models.get(RIVAL))); continue; }
      if (i === ps) { const h = this.anchor(i, this.models.get(RIVAL)); recolour(h.model, { silk: SILK_ORDER[Math.max(0, Math.min(4, playerPartner))], coat: ['Bay', 'Chestnut', 'DappleGrey', 'Black', 'Palomino'][Math.max(0, Math.min(4, playerPartner))], accent: false }); this.horses.push(h); continue; } // software GL: the LOD in the partner's colours (171k → 27k triangles)
      const h = this.anchor(i, this.models.get(RIVAL) ?? this.models.get('Models/Partners/' + FEATURED[0]));
      recolour(h.model, lookOf(same ? null : w.entrants?.[i], i));
      this.horses.push(h);
    }
    // the chase camera starts where RaceWorld.Lobby left it and swoops in behind the player
    this.camera.position.copy(U(4, 2.8, 31)); this.camera.lookAt(U(0, 1.65, 25));
    this.clock = performance.now(); this.t0 = this.clock;
    this.fovKick = 0; this.fwd = null; this.lowT = 0;
  }

  /** The whip: a short FOV kick (presentation of the spur; the engine takes the input itself). */
  kick() { this.fovKick = 7; }

  /**
   * Round 19 (REQ-PERF-003, §56.3): the RenderProfile of Muchi.Client (via WASM) on this view — render scale on the pixel
   * ratio, shadows off / hard / soft. Presentation only: nothing here reaches the engine. Software GL keeps its own floor.
   */
  setQuality(p) {
    const r = this.renderer;
    if (!r || !p) return;
    this.quality = p;
    const base = Math.max(.75, Math.min(2, (globalThis.devicePixelRatio || 1) * Math.min(innerWidth / 1600, innerHeight / 900)));
    const ratio = this.lite ? Math.min(.5, base * p.renderScale) : base * p.renderScale;
    if (Math.abs(r.getPixelRatio() - ratio) > .001) { r.setPixelRatio(ratio); r.setSize(1600, 900, false); }
    const shadows = !this.lite && p.shadows !== 'off';
    const type = p.shadows === 'soft' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (r.shadowMap.enabled !== shadows || r.shadowMap.type !== type) {
      r.shadowMap.enabled = shadows; r.shadowMap.type = type;
      this.sun.castShadow = shadows;
      this.scene.traverse((o) => { if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true; });
    }
    this.canvas.dataset.pixelRatio = ratio.toFixed(3); this.canvas.dataset.shadows = shadows ? p.shadows : 'off';
  }

  /** Time attack ghosts (GhostPlayer, their own simulation): the partner model, translucent, never interacting. */
  setGhosts(n, playerPartner = 0) {
    for (const g of this.ghosts ?? []) this.scene.remove(g.anchor);
    this.ghosts = [];
    const src = this.models.get('Models/Partners/' + FEATURED[Math.max(0, Math.min(4, playerPartner))]);
    for (let i = 0; i < n; i++) {
      const a = this.anchor(-1 - i, src);
      a.model.traverse((o) => {
        if (!o.isMesh) return;
        const ms = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => { const c = m.clone(); c.transparent = true; c.opacity = 0.38; c.depthWrite = false; return c; });
        o.material = Array.isArray(o.material) ? ms : ms[0];
        o.castShadow = false;
      });
      a.blob.visible = false;
      this.ghosts.push(a);
    }
  }

  // RaceWorld.Anchor + PartnerGallop.Bind (+ a soft blob shadow on the turf)
  anchor(slot, src) {
    const anchor = new THREE.Group();
    const model = src ? src.clone(true) : proxyHorse();
    const base = model.scale.clone();
    model.scale.copy(base).multiplyScalar(.95);
    anchor.add(model); this.scene.add(anchor);
    const blob = new THREE.Mesh(this.blobGeo ??= new THREE.PlaneGeometry(1.5, 3.2), this.blobMat ??= new THREE.MeshBasicMaterial({ map: this.tex.blob, transparent: true, depthWrite: false, opacity: .55 }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = .03; blob.renderOrder = 1; anchor.add(blob);
    const bones = BONES.map(() => null), rest = BONES.map(() => null);
    model.traverse((o) => {
      const name = o.name.includes('|') ? o.name.slice(o.name.lastIndexOf('|') + 1) : o.name;
      const b = BONES.indexOf(name);
      if (b >= 0 && !bones[b]) { bones[b] = o; rest[b] = o.quaternion.clone(); }
    });
    return { anchor, model, blob, modelY: model.position.y, bones, rest };
  }

  // RaceWorld.Present + PartnerGallop.LateUpdate
  draw(f) {
    if (!this.info || !f.horses) return;
    const now = performance.now(), dt = Math.min(.1, (now - this.clock) / 1000); this.clock = now;
    // round 15 (REQ-PHOTO-002): a photo is one engine tick — the gallop pose is frozen too (cam mode 'Photo')
    const photo = f.cam?.[7] === 'Photo';
    const time = photo ? 0.37 : (now - this.t0) / 1000;
    const q = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);
    const cycle = time * 12.5;
    for (let i = 0; i < this.horses.length; i++) {
      const h = this.horses[i], p = f.horses[i];
      if (!p || p[6] === false) continue;
      // software GL: rivals far behind the camera's view distance are not drawn (a few pixels tall; saves raster time)
      h.anchor.position.copy(U(p[0], .06 * Math.sin(time * 13 + i), p[1]));
      if (this.lite && i !== this.playerSlot) { h.anchor.visible = this.camera.position.distanceToSquared(h.anchor.position) < 110 * 110; if (!h.anchor.visible) continue; }
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
    (this.ghosts ?? []).forEach((g, i) => {
      const p = f.ghostPoses?.[i];
      g.anchor.visible = !!p;
      if (!p) return;
      g.anchor.position.copy(U(p[0], .06 * Math.sin(time * 13 + 7), p[1]));
      g.anchor.rotation.y = -p[2] * DEG;
      if (p[3]) g.model.position.y = g.modelY + .018 + .028 * Math.abs(Math.sin(cycle * 2 + 1));
    });
    const me = this.horses[this.playerSlot ?? 0]?.anchor;
    this.fovKick *= Math.exp(-dt * 2.2);
    if (me) {
      const [px, ph, pz, lx, lh, lz, fov = 57, mode = 'Follow'] = f.cam ?? [];
      // "ahead" is where the engine's rig looks (its camera → its look point), flattened; else the horse's heading
      const fwd = f.cam ? U(lx - px, 0, lz - pz) : new THREE.Vector3(0, 0, 1).applyQuaternion(me.quaternion);
      fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
      // smooth the heading, not the position: the camera stays locked to the partner even at a low frame rate
      this.fwd = this.fwd ? this.fwd.lerp(fwd, 1 - Math.exp(-dt * 5)).normalize() : fwd.clone(); fwd.copy(this.fwd);
      let pos, look, fv = fov;
      if (f.cam && (photo || (this.useRig && mode === 'Finish'))) {
        // RaceCameraRig's side-on shot at the line, as the engine places it
        pos = U(px, ph, pz); look = U(lx, lh, lz);
      } else {
        // the key-art chase cam: low and close behind the partner, the field ahead large in frame (lower in the
        // final straight, like RaceCameraRig's FinalStraight mode)
        this.lowT = (this.lowT ?? 0) + ((mode === 'FinalStraight' ? 1 : 0) - (this.lowT ?? 0)) * (1 - Math.exp(-dt * 2)); const k = this.lowT;
        pos = me.position.clone().addScaledVector(fwd, -4.1 + .6 * k).add(new THREE.Vector3(0, 2.6 - .25 * k, 0));
        look = me.position.clone().addScaledVector(fwd, 22).add(new THREE.Vector3(0, 1.45 + .1 * k, 0));
        fv = Math.max(50, Math.min(62, fov));
      }
      if (mode === 'Finish' && this.useRig) this.camera.position.lerp(pos, 1 - Math.exp(-dt * 6)); else this.camera.position.copy(pos);
      const target = photo ? fv : fv + this.fovKick;
      if (photo && this.camera.fov !== target) { this.camera.fov = target; this.camera.updateProjectionMatrix(); }
      else if (Math.abs(this.camera.fov - target) > .01) { this.camera.fov += (target - this.camera.fov) * (1 - Math.exp(-dt * 6)); this.camera.updateProjectionMatrix(); }
      this.camera.lookAt(look);
      // keep the shadow frustum around the player
      this.sun.target.position.copy(me.position);
      this.sun.position.copy(me.position).addScaledVector(this.sunDir, -120);
    }
    if (this.backdrop) this.backdrop.position.set(this.camera.position.x, this.camera.position.y + this.backdrop.userData.yOff, this.camera.position.z);
    this.far.position.x = this.camera.position.x; this.far.position.z = this.camera.position.z;
    this.renderer.render(this.scene, this.camera);
  }

  /** Screen position (1600×900 stage pixels) of a point `up` metres above a horse, or null when behind the camera. */
  project(slot, up = 2.7) {
    const h = this.horses[slot];
    if (!h) return null;
    const v = h.anchor.position.clone().add(new THREE.Vector3(0, up, 0)).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x + 1) * 800, y: (1 - v.y) * 450 };
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
const avgStep = (line) => { let s = 0; for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]); return s / Math.max(1, line.length - 1); };
/** A flat strip along a polyline ([x, z] Unity), `width` metres wide; u across (every uM), v along (every vM). */
function strip(line, width, y, uM, vM) {
  const pos = [], uv = [], idx = [];
  let s = 0;
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = tz, nz = -tx, [x, z] = line[i];
    if (i > 0) s += Math.hypot(x - line[i - 1][0], z - line[i - 1][1]);
    const L = U(x + nx * width / 2, y, z + nz * width / 2), R = U(x - nx * width / 2, y, z - nz * width / 2);
    pos.push(L.x, L.y, L.z, R.x, R.y, R.z);
    uv.push(0, s / vM, width / uM, s / vM);
    if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals();
  // the winding depends on the line's direction: make the normals point up
  const n = g.attributes.normal;
  if (n.count && n.getY(0) < 0) { for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]; g.setIndex(idx); g.computeVertexNormals(); }
  return g;
}
/** Rival look: recolour the LOD's silks (body, helmet, pattern, trim) and coat (coat, mane) by material name. */
function recolour(model, look) {
  const [silk, accent] = SILK_RGB[look.silk], [coat, mane] = COAT_RGB[look.coat];
  const primary = look.accent ? accent : silk, second = look.accent ? silk : accent;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
      const n = m.name || '';
      let c = null;
      if (/^(Racing silk|Helmet|Woven silk)/.test(n)) c = primary;
      else if (/^(Woven pattern|Trim|Number embroidery)/.test(n)) c = second;
      else if (/^Coat/.test(n)) c = coat;
      else if (/^Mane/.test(n)) c = mane;
      if (!c) return m;
      const k = m.clone(); k.color = hex(c); return k;
    });
    o.material = Array.isArray(o.material) ? mats : mats[0];
  });
}

// ---- small canvas textures (cheap, also on software GL)
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function canvasTex(w, h, draw, aniso = 1, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
  return t;
}
const rep = (t, x, y) => { const c = t.clone(); c.needsUpdate = true; c.repeat.set(x, y); return c; };
function blades(x, w, h, n, light, dark) {
  for (let i = 0; i < n; i++) {
    x.fillStyle = rnd() < .5 ? light : dark;
    x.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), 1, 1 + Math.floor(rnd() * 3));
  }
}
/** Racing turf: two mown bands (one tile = 12 m along the course) with blade noise. */
function mownTexture(aniso) {
  return canvasTex(128, 256, (x, w, h) => {
    x.fillStyle = '#5c9f36'; x.fillRect(0, 0, w, h / 2);
    x.fillStyle = '#4b8c2c'; x.fillRect(0, h / 2, w, h / 2);
    blades(x, w, h, 5200, 'rgba(150,210,90,.45)', 'rgba(40,90,25,.45)');
  }, aniso);
}
/** Outfield grass: rougher, a little darker, no stripes. */
function grassTexture(aniso) {
  return canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = '#4a8a2f'; x.fillRect(0, 0, w, h);
    blades(x, w, h, 3200, 'rgba(130,190,80,.5)', 'rgba(35,80,22,.5)');
  }, aniso);
}
/** Dirt: sand with hoof marks. */
function dirtTexture(aniso) {
  return canvasTex(128, 256, (x, w, h) => {
    x.fillStyle = '#9b7350'; x.fillRect(0, 0, w, h);
    blades(x, w, h, 4200, 'rgba(190,150,110,.5)', 'rgba(90,62,40,.5)');
    x.strokeStyle = 'rgba(80,55,35,.25)'; x.lineWidth = 2;
    for (let i = 0; i < 9; i++) { const px = rnd() * w; x.beginPath(); x.moveTo(px, 0); x.lineTo(px + rnd() * 6 - 3, h); x.stroke(); }
  }, aniso);
}
function poleTexture() {
  return canvasTex(8, 64, (x, w, h) => { for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#f4f4f0' : '#d22b2b'; x.fillRect(0, i * 8, w, 8); } });
}
function blobTexture() {
  return canvasTex(64, 128, (x, w, h) => {
    const g = x.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,.8)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.save(); x.translate(0, 0); x.scale(1, 2); x.fillStyle = g; x.fillRect(0, 0, w, h / 2); x.restore();
  }, 1, false);
}
/** A distance board ("200") or the winning-post disc (red ring on white). */
function numberBoard(text, disc = false) {
  return canvasTex(128, disc ? 128 : 86, (x, w, h) => {
    if (disc) { x.fillStyle = '#f6f6f2'; x.fillRect(0, 0, w, h); x.fillStyle = '#d22b2b'; x.beginPath(); x.arc(w / 2, h / 2, w * .42, 0, Math.PI * 2); x.fill(); x.fillStyle = '#f6f6f2'; x.beginPath(); x.arc(w / 2, h / 2, w * .24, 0, Math.PI * 2); x.fill(); return; }
    x.fillStyle = '#f6f6f2'; x.fillRect(0, 0, w, h); x.fillStyle = '#0d2a1c'; x.fillRect(4, 4, w - 8, h - 8);
    x.fillStyle = '#f6f6f2'; x.font = 'bold 54px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, w / 2, h / 2 + 2);
  }, 1, false);
}

function disposeGroup(g) { g.traverse((o) => { if (o.isInstancedMesh) o.dispose(); else if (o.isMesh && o.geometry !== undefined && o.geometry.type === 'BufferGeometry') o.geometry.dispose(); }); }

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
