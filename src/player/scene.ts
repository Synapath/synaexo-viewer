import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Camera, Recording } from "./package";
import type { RecordDiagnostic } from "../lib/diagnostics";
import { SMPLX_NUM_JOINTS, SMPLX_NUM_VERTS } from "../smplx/skeleton";
import type { BodyFrame } from "./motion";
import { explicitOrbitDirection } from "./orbitBasis";

function cameraPose(camera: Camera | undefined, frame: number) {
  const poses = camera?.T_world_from_camera;
  if (!poses) return;
  return typeof poses[0][0] === "number" ? poses as number[][] : (poses as number[][][])[frame];
}

function createProjectionCamera({ image_size: [w, h], projectionK: K }: Camera) {
  if (!K) return;
  const n = 0.01, f = 1000;
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  camera.projectionMatrix.set(
    2 * K[0][0] / w, -2 * K[0][1] / w, 1 - 2 * K[0][2] / w, 0,
    0, 2 * K[1][1] / h, 2 * K[1][2] / h - 1, 0,
    0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),
    0, 0, -1, 0,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return camera;
}

function createJointTexture(host: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法绘制关节点");
  const theme = getComputedStyle(host);
  for (const [radius, color] of [[14, theme.getPropertyValue("--surface").trim()], [10, theme.color]] as const) {
    context.beginPath();
    context.arc(16, 16, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createScene(
  host: HTMLElement,
  tiles: HTMLElement[],
  descriptor: Recording,
  diagnose: RecordDiagnostic,
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  const contextLost = () => diagnose("scene.webgl_context_lost", {
    width: renderer.domElement.width, height: renderer.domElement.height,
    textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries,
  });
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x101010);
  host.prepend(renderer.domElement);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(SMPLX_NUM_VERTS * 3), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(descriptor.faces, 1));
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: true,
    roughness: 0.8,
  });
  const scene = new THREE.Scene(),
    mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x999999, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(2, 4, 3);
  scene.add(light);
  const orbitCamera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
  if (descriptor.world_frame.startsWith("pico_")) orbitCamera.up.set(0, -1, 0);
  const initialFrame = Math.max(
    0,
    descriptor.body_observed.findIndex(
      (body, index) =>
        body && descriptor.cameras.some((camera) => camera.pose_valid?.[index] ?? camera.source_observed[index]),
    ),
  );
  const initialView = descriptor.cameras.find(
    (camera) => camera.T_world_from_camera && camera.pose_valid?.[initialFrame],
  );
  const initialRows = cameraPose(initialView, initialFrame);
  // OrbitControls caches its up basis at construction. Freeze the viewing basis first.
  if (descriptor.display_up)
    orbitCamera.up.set(...descriptor.display_up);
  else if (initialRows)
    orbitCamera.up.set(
      -initialRows[0][1],
      -initialRows[1][1],
      -initialRows[2][1],
    );
  const controls = new OrbitControls(orbitCamera, tiles[0]);
  controls.enableDamping = false;
  const textures = descriptor.cameras.map(() => new THREE.Texture());
  const backgrounds = textures.map((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const background = new THREE.Scene(),
      quad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({
          map: texture,
          depthTest: false,
          depthWrite: false,
        }),
      );
    background.add(quad);
    return background;
  });
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const projectors = descriptor.cameras.map(createProjectionCamera);
  const cameraAxes = new THREE.Matrix4().makeScale(1, -1, -1);
  const jointScene = new THREE.Scene(), jointGeometry = new THREE.BufferGeometry();
  const jointPositions = new THREE.BufferAttribute(new Float32Array(SMPLX_NUM_JOINTS * 3), 3);
  jointGeometry.setAttribute("position", jointPositions.setUsage(THREE.DynamicDrawUsage));
  const jointTexture = createJointTexture(host);
  const jointMaterial = new THREE.PointsMaterial({
    map: jointTexture, sizeAttenuation: false, alphaTest: 0.5, depthTest: false, depthWrite: false,
  });
  const points = new THREE.Points(jointGeometry, jointMaterial);
  points.frustumCulled = false;
  jointScene.add(points);
  const axes = new THREE.AxesHelper(0.5);
  scene.add(axes);
  let current = -1,
    fitted = false,
    disposed = false;
  const lastCenter = new THREE.Vector3();
  function draw() {
    if (disposed || current < 0) return;
    const area = host.getBoundingClientRect();
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    tiles.forEach((tile, index) => {
      const box = tile.getBoundingClientRect();
      let width = box.width,
        height = box.height,
        x = box.left - area.left,
        y = area.bottom - box.bottom;
      if (index) {
        const [w, h] = descriptor.cameras[index - 1].image_size;
        const scale = Math.min(width / w, height / h);
        x += (width - w * scale) / 2;
        y += (height - h * scale) / 2;
        width = w * scale;
        height = h * scale;
      }
      if (width <= 0 || height <= 0) return;
      renderer.setViewport(x, y, width, height);
      renderer.setScissor(x, y, width, height);
      renderer.clear();
      if (!index) {
        orbitCamera.aspect = width / height;
        orbitCamera.updateProjectionMatrix();
        mesh.visible = descriptor.body_observed[current];
        renderer.render(scene, orbitCamera);
        return;
      }
      const config = descriptor.cameras[index - 1];
      if (!config.source_observed[current]) return;
      renderer.render(backgrounds[index - 1], ortho);
      const projector = projectors[index - 1];
      if (!projector || !descriptor.body_observed[current] || !config.pose_valid?.[current]) return;
      const rows = cameraPose(config, current);
      if (!rows) return;
      projector.matrix.set(
        rows[0][0], rows[0][1], rows[0][2], rows[0][3],
        rows[1][0], rows[1][1], rows[1][2], rows[1][3],
        rows[2][0], rows[2][1], rows[2][2], rows[2][3],
        rows[3][0], rows[3][1], rows[3][2], rows[3][3],
      ).multiply(cameraAxes);
      projector.matrixWorldNeedsUpdate = true;
      jointMaterial.size = THREE.MathUtils.clamp(width / 120, 4, 8);
      renderer.autoClear = false;
      renderer.render(jointScene, projector);
      renderer.autoClear = true;
    });
  }
  function resize() {
    const area = host.getBoundingClientRect();
    renderer.setSize(area.width, area.height, false);
    draw();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  tiles.forEach((tile) => observer.observe(tile));
  controls.addEventListener("change", draw);
  resize();
  return {
    present(
      { vertices, joints }: BodyFrame,
      index: number,
      images: HTMLCanvasElement[],
    ) {
      const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
      (attr.array as Float32Array).set(vertices);
      attr.needsUpdate = true;
      (jointPositions.array as Float32Array).set(joints);
      jointPositions.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      current = index;
      if (!fitted && descriptor.body_observed[index]) {
        const sphere = geometry.boundingSphere!;
        const direction = descriptor.display_up
          ? explicitOrbitDirection(orbitCamera.up)
          : new THREE.Vector3(2, orbitCamera.up.y, 3);
        if (initialRows && !descriptor.display_up) {
          direction.set(
            ...(initialRows
              .map((row) => 2 * row[0] - row[1] - 3 * row[2])
              .slice(0, 3) as [number, number, number]),
          );
        }
        controls.target.copy(sphere.center);
        orbitCamera.position
          .copy(sphere.center)
          .add(
            direction
              .normalize()
              .multiplyScalar(Math.max(1, sphere.radius) * 3),
          );
        lastCenter.copy(sphere.center);
        fitted = true;
        controls.update();
      } else if (fitted && descriptor.body_observed[index]) {
        const center = geometry.boundingSphere!.center,
          delta = center.clone().sub(lastCenter);
        controls.target.add(delta);
        orbitCamera.position.add(delta);
        lastCenter.copy(center);
      }
      images.forEach((image, i) => {
        textures[i].image = image;
        textures[i].needsUpdate = true;
      });
      draw();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      controls.dispose();
      textures.forEach((t) => { t.dispose(); t.image = null; });
      backgrounds.forEach((s) =>
        s.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        }),
      );
      geometry.dispose();
      material.dispose();
      jointGeometry.dispose();
      jointMaterial.dispose();
      jointTexture.dispose();
      jointTexture.image.width = jointTexture.image.height = 0;
      axes.geometry.dispose();
      (axes.material as THREE.Material).dispose();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
