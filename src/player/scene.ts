import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Camera, Recording } from "./package";
import type { RecordDiagnostic } from "../lib/diagnostics";
import { SMPLX_NUM_JOINTS } from "../smplx/skeleton";
import type { BodyFrame } from "./engine";
import { createMeshScene } from "./meshScene";
import { cameraPose } from "./projection";

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

  const parents = descriptor.jointParents;
  const bonePositions = new Float32Array((parents.length - 1) * 6);
  const boneGeometry = new LineSegmentsGeometry().setPositions(bonePositions);
  const boneBuffer = (boneGeometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute).data;
  boneBuffer.setUsage(THREE.DynamicDrawUsage);
  const boneMaterial = new LineMaterial({
    color: getComputedStyle(host).color, linewidth: 1.5, depthTest: false, depthWrite: false,
  });
  const bones = new LineSegments2(boneGeometry, boneMaterial);
  bones.frustumCulled = false;
  points.renderOrder = 1;
  jointScene.add(bones, points);
  let current = -1, disposed = false;
  let mesh: ReturnType<typeof createMeshScene> | undefined;
  function viewport(x: number, y: number, width: number, height: number) {
    renderer.setViewport(x, y, width, height);
    renderer.setScissor(x, y, width, height);
    renderer.clear();
  }
  function draw() {
    if (disposed || current < 0) return;
    const area = host.getBoundingClientRect();
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    if (mesh) {
      const box = mesh.viewport.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        viewport(box.left - area.left, area.bottom - box.bottom, box.width, box.height);
        mesh.drawOrbit(box.width, box.height);
      }
    }
    tiles.forEach((tile, index) => {
      const box = tile.getBoundingClientRect();
      const config = descriptor.cameras[index];
      const [w, h] = config.image_size;
      const scale = Math.min(box.width / w, box.height / h);
      const width = w * scale, height = h * scale;
      const x = box.left - area.left + (box.width - width) / 2;
      const y = area.bottom - box.bottom + (box.height - height) / 2;
      if (width <= 0 || height <= 0) return;
      viewport(x, y, width, height);
      if (!config.source_observed[current]) return;
      renderer.render(backgrounds[index], ortho);
      const projector = projectors[index];
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
      boneMaterial.resolution.set(width, height);
      boneMaterial.linewidth = Math.max(1.5, jointMaterial.size / 4);
      renderer.autoClear = false;
      if (mesh) mesh.drawOverlay(projector);
      else renderer.render(jointScene, projector);
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
  resize();
  return {
    setMeshViewport(element: HTMLElement | null) {
      if ((mesh?.viewport ?? null) === element) return;
      if (mesh) {
        observer.unobserve(mesh.viewport);
        mesh.dispose();
      }
      mesh = element ? createMeshScene(renderer, element, descriptor, draw) : undefined;
      if (element) observer.observe(element);
      resize();
    },
    present(
      { joints, vertices }: BodyFrame,
      index: number,
      images: HTMLCanvasElement[],
    ) {
      (jointPositions.array as Float32Array).set(joints);
      jointPositions.needsUpdate = true;
      for (let child = 1; child < parents.length; child++) {
        const parent = parents[child] * 3, offset = (child - 1) * 6;
        bonePositions.set(joints.subarray(parent, parent + 3), offset);
        bonePositions.set(joints.subarray(child * 3, child * 3 + 3), offset + 3);
      }
      boneBuffer.needsUpdate = true;
      current = index;
      images.forEach((image, i) => {
        textures[i].image = image;
        textures[i].needsUpdate = true;
      });
      if (mesh && vertices) mesh.present(vertices, index);
      draw();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      mesh?.dispose();
      textures.forEach((t) => { t.dispose(); t.image = null; });
      backgrounds.forEach((s) =>
        s.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        }),
      );
      boneGeometry.dispose();
      boneMaterial.dispose();
      jointGeometry.dispose();
      jointMaterial.dispose();
      jointTexture.dispose();
      jointTexture.image.width = jointTexture.image.height = 0;
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
