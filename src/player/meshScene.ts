import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SMPLX_NUM_VERTS } from "../smplx/skeleton";
import { explicitOrbitDirection } from "./orbitBasis";
import type { Recording } from "./package";
import { cameraPose } from "./projection";

export function createMeshScene(
  renderer: THREE.WebGLRenderer,
  viewport: HTMLElement,
  recording: Recording,
  redraw: () => void,
) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(SMPLX_NUM_VERTS * 3);
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setIndex(new THREE.BufferAttribute(recording.faces, 1));
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.8 });
  const overlay = material.clone();
  overlay.transparent = true;
  overlay.opacity = 0.5;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  const axes = new THREE.AxesHelper(0.5);
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(2, 4, 3);
  scene.add(mesh, axes, new THREE.HemisphereLight(0xffffff, 0x999999, 2), light);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
  if (recording.world_frame.startsWith("pico_")) camera.up.set(0, -1, 0);
  const initialFrame = recording.body_observed.findIndex((body, index) =>
    body && recording.cameras.some(view => view.pose_valid?.[index]),
  );
  const initialView = recording.cameras.find(view => view.pose_valid?.[initialFrame] && view.T_world_from_camera);
  const initialRows = cameraPose(initialView, initialFrame);
  if (recording.display_up) camera.up.set(...recording.display_up);
  else if (initialRows) camera.up.set(-initialRows[0][1], -initialRows[1][1], -initialRows[2][1]);
  const controls = new OrbitControls(camera, viewport);
  controls.addEventListener("change", redraw);
  const lastCenter = new THREE.Vector3();
  let fitted = false, observed = false;

  return {
    viewport,
    present(vertices: Float32Array, frame: number) {
      observed = recording.body_observed[frame];
      if (!observed) return;
      positions.set(vertices);
      positionAttribute.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere!;
      if (!fitted) {
        const direction = recording.display_up
          ? explicitOrbitDirection(camera.up)
          : new THREE.Vector3(2, camera.up.y, 3);
        if (initialRows && !recording.display_up)
          direction.fromArray(initialRows.slice(0, 3).map(row => 2 * row[0] - row[1] - 3 * row[2]));
        controls.target.copy(sphere.center);
        camera.position.copy(sphere.center).add(direction.normalize().multiplyScalar(Math.max(1, sphere.radius) * 3));
        fitted = true;
        controls.update();
      } else {
        const delta = sphere.center.clone().sub(lastCenter);
        controls.target.add(delta);
        camera.position.add(delta);
      }
      lastCenter.copy(sphere.center);
    },
    drawOrbit(width: number, height: number) {
      if (!fitted) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      mesh.material = material;
      mesh.visible = observed;
      axes.visible = true;
      renderer.render(scene, camera);
    },
    drawOverlay(projector: THREE.Camera) {
      if (!observed) return;
      mesh.material = overlay;
      mesh.visible = true;
      axes.visible = false;
      renderer.clearDepth();
      renderer.render(scene, projector);
    },
    dispose() {
      controls.dispose();
      geometry.dispose();
      material.dispose();
      overlay.dispose();
      axes.geometry.dispose();
      (axes.material as THREE.Material).dispose();
    },
  };
}
