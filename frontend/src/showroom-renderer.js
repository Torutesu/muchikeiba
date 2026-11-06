import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
const active = new Map(),
  models = new Map();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export function disposeAll() {
  for (const stage of active.values()) stage.dispose();
  active.clear();
}
function modelFor(index) {
  if (!models.has(index))
    models.set(
      index,
      new GLTFLoader()
        .loadAsync(`/models/partner-${index}.glb`)
        .then((gltf) => {
          gltf.scene.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = false;
              if (o.material.isMeshStandardMaterial) {
                o.material.envMapIntensity = 0.7;
              }
            }
          });
          return gltf;
        })
        .catch((error) => {
          models.delete(index);
          throw error;
        }),
    );
  return models.get(index);
}
export async function stage(container, index, { race = false } = {}) {
  if (active.has(container)) return;
  const fallback = container.querySelector("img"),
    canvas = document.createElement("canvas");
  canvas.className = "model-canvas";
  canvas.setAttribute(
    "aria-label",
    race ? "3Dのレースプレビュー" : "ドラッグで相棒の3Dモデルを回転",
  );
  canvas.setAttribute("role", "img");
  container.classList.add("showroom-container");
  let renderer,
    closed = false,
    frame,
    env,
    controls,
    resize,
    laneObserver,
    dirty = true;
  const localResources = [];
  const dispose = () => {
    closed = true;
    cancelAnimationFrame(frame);
    resize?.disconnect();
    laneObserver?.disconnect();
    controls?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
    env?.dispose();
    localResources.forEach((r) => r.dispose());
    canvas.remove();
  };
  active.set(container, { dispose });
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(canvas);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(race ? 40 : 33, 1, 0.1, 60);
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment();
    env = pmrem.fromScene(room, 0.04);
    scene.environment = env.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xfff7df, 0x576547, 1.3));
    const key = new THREE.DirectionalLight(0xffebc0, 2.2);
    key.position.set(3, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -3;
    key.shadow.bias = -0.001;
    scene.add(key);
    localResources.push(key.shadow);
    const rim = new THREE.DirectionalLight(0xdbe9ff, 0.8);
    rim.position.set(-3, 3, -3);
    scene.add(rim);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.ShadowMaterial({ opacity: 0.18 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    scene.add(floor);
    localResources.push(floor.geometry, floor.material);
    const trackStripes = [];
    if (race) {
      scene.background = new THREE.Color(0xc4d6c8);
      scene.fog = new THREE.Fog(0xc4d6c8, 18, 65);
      const turf = new THREE.MeshStandardMaterial({
          color: 0x68864b,
          roughness: 0.96,
        }),
        stripe = new THREE.MeshStandardMaterial({
          color: 0x76924e,
          roughness: 0.96,
        }),
        white = new THREE.MeshStandardMaterial({
          color: 0xe6e4d3,
          roughness: 0.5,
        });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(150, 200), turf);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.01;
      ground.receiveShadow = true;
      scene.add(ground);
      localResources.push(ground.geometry, turf, stripe, white);
      const stripeGeometry = new THREE.PlaneGeometry(9, 3);
      localResources.push(stripeGeometry);
      for (let z = -60; z < 60; z += 6) {
        const band = new THREE.Mesh(stripeGeometry, stripe);
        band.rotation.x = -Math.PI / 2;
        band.position.set(0, 0.005, z);
        band.receiveShadow = true;
        scene.add(band);
        trackStripes.push({ band, z });
      }
      const postGeometry = new THREE.CylinderGeometry(0.035, 0.045, 0.85, 8),
        railGeometry = new THREE.CylinderGeometry(0.055, 0.055, 120, 10);
      localResources.push(postGeometry, railGeometry);
      const posts = new THREE.InstancedMesh(postGeometry, white, 82),
        matrix = new THREE.Matrix4();
      let count = 0;
      for (const x of [-4.5, 4.5])
        for (let z = -60; z <= 60; z += 3) {
          matrix.makeTranslation(x, 0.43, z);
          posts.setMatrixAt(count++, matrix);
        }
      scene.add(posts);
      for (const x of [-4.5, 4.5]) {
        const rail = new THREE.Mesh(railGeometry, white);
        rail.rotation.x = Math.PI / 2;
        rail.position.set(x, 0.85, 0);
        scene.add(rail);
      }
    }
    camera.position.set(4.9, 2.5, -4.5);
    controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1.35, 0);
    controls.enablePan = false;
    controls.minDistance = 4.2;
    controls.maxDistance = 8;
    controls.minPolarAngle = 0.55;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = !reduced() && !race;
    controls.autoRotateSpeed = 0.45;
    if (race) {
      camera.position.set(4.9, 2.15, -3.4);
      controls.target.set(0, 1.25, 0);
      controls.enabled = false;
    }
    controls.update();
    controls.addEventListener("change", () => (dirty = true));
    const status = document.createElement("span");
    status.className = "model-status";
    status.setAttribute("role", "status");
    status.textContent = "3Dモデルを読み込み中";
    container.append(status);
    if (!race) {
      const hint = document.createElement("span");
      hint.className = "model-instruction";
      hint.textContent = "ドラッグで回転 · ピンチで拡大";
      container.append(hint);
    }
    resize = new ResizeObserver(() => {
      if (closed) return;
      const w = container.clientWidth,
        h = container.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      dirty = true;
    });
    resize.observe(container);
    laneObserver = new MutationObserver(() => (dirty = true));
    laneObserver.observe(container, {
      attributes: true,
      attributeFilter: ["data-lane"],
    });
    const source = await modelFor(index);
    if (closed) return;
    const horse = cloneSkeleton(source.scene);
    const sharedSkeletons = new Map();
    horse.traverse((o) => {
      if (o.isSkinnedMesh) {
        const key = o.skeleton.bones.map((b) => b.uuid).join("|");
        if (sharedSkeletons.has(key)) o.skeleton = sharedSkeletons.get(key);
        else sharedSkeletons.set(key, o.skeleton);
        o.skeleton.pose();
      }
    });
    localResources.push(...sharedSkeletons.values());
    scene.add(horse);
    const mixer = new THREE.AnimationMixer(horse);
    if (race && source.animations.length)
      mixer
        .clipAction(
          source.animations.find((a) => a.name.includes("Gallop")) ||
            source.animations[0],
        )
        .play();
    if (race && source.animations.length && reduced()) mixer.setTime(0.22);
    container.dataset.modelReady = "true";
    container.dataset.modelAnimated = String(
      race && source.animations.length > 0 && !reduced(),
    );
    status.textContent = race
      ? "3D PRESENTATION / LOCAL DEMO"
      : "REAL-TIME 3D / THOROUGHBRED";
    if (fallback) fallback.style.opacity = "0";
    const start = performance.now();
    let previous = start,
      lastRendered = 0;
    const animate = () => {
      if (closed) return;
      frame = requestAnimationFrame(animate);
      const now = performance.now();
      if (document.hidden || now - lastRendered < 33) return;
      if (reduced() && !dirty) return;
      dirty = false;
      lastRendered = now;
      const time = (performance.now() - start) / 1000;
      if (race) {
        const target = (Number(container.dataset.lane ?? 2) - 2) * 0.3;
        horse.position.x = reduced()
          ? target
          : THREE.MathUtils.lerp(horse.position.x, target, 0.12);
      }
      if (race && !reduced()) {
        horse.position.y = 0.012 + Math.sin(time * 4) * 0.008;
        horse.rotation.y = Math.sin(time * 0.35) * 0.025;
        trackStripes.forEach(
          ({ band, z }) => (band.position.z = z + ((time * 8) % 6)),
        );
      }
      if (!reduced())
        mixer.update(Math.min(0.05, (performance.now() - previous) / 1000));
      controls.autoRotate = !race && !reduced();
      previous = performance.now();
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
  } catch (error) {
    if (closed) return;
    container.dataset.modelReady = "fallback";
    canvas.remove();
    renderer?.dispose();
    let status = container.querySelector(".model-status");
    if (!status) {
      status = document.createElement("span");
      status.className = "model-status";
      status.setAttribute("role", "status");
      container.append(status);
    }
    status.textContent = "この端末では静止画プレビューを表示しています";
    const help = container.closest("dialog")?.querySelector(".quiet");
    if (help)
      help.textContent =
        "3D表示を利用できないため、モデルの静止画を表示しています。";
    if (fallback) fallback.style.opacity = "1";
  }
}

export function cleanup() {
  for (const [el, view] of active) {
    if (!el.isConnected) {
      view.dispose();
      active.delete(el);
    }
  }
}
export function disposeStage(el) {
  active.get(el)?.dispose();
  active.delete(el);
}
