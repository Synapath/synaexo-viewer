import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Recording } from "./package";

export function createScene(
  host: HTMLElement,
  tiles: HTMLElement[],
  descriptor: Recording,
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x101010);
  host.prepend(renderer.domElement);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(10475 * 3), 3),
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
  const overlayMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
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
  const initialRows = initialView?.T_world_from_camera
    ? typeof initialView.T_world_from_camera[0][0] === "number"
      ? (initialView.T_world_from_camera as number[][])
      : (initialView.T_world_from_camera as number[][][])[initialFrame]
    : null;
  // OrbitControls caches its up basis at construction. Freeze the viewing basis first.
  if (initialRows)
    orbitCamera.up.set(
      -initialRows[0][1],
      -initialRows[1][1],
      -initialRows[2][1],
    );
  const controls = new OrbitControls(orbitCamera, tiles[0]);
  controls.enableDamping = false;
  const cameras = descriptor.cameras.map(() => new THREE.PerspectiveCamera());
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
  const axes = new THREE.AxesHelper(0.5);
  scene.add(axes);
  let current = -1,
    fitted = false,
    disposed = false;
  const lastCenter = new THREE.Vector3();
  const pose = new THREE.Matrix4(),
    flip = new THREE.Matrix4().makeScale(1, -1, -1);
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
        mesh.material = material;
        mesh.visible = descriptor.body_observed[current];
        axes.visible = true;
        renderer.render(scene, orbitCamera);
        return;
      }
      const config = descriptor.cameras[index - 1],
        camera = cameras[index - 1];
      if (config.source_observed[current])
        renderer.render(backgrounds[index - 1], ortho);
      renderer.clearDepth();
      if (config.baked || !config.T_world_from_camera || !config.K) return;
      const rows =
        typeof config.T_world_from_camera[0][0] === "number"
          ? (config.T_world_from_camera as number[][])
          : (config.T_world_from_camera as number[][][])[current];
      pose.set(
        ...(rows.flat() as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ]),
      );
      camera.matrixAutoUpdate = false;
      camera.matrix.copy(pose).multiply(flip);
      camera.matrixWorld.copy(camera.matrix);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const [w, h] = config.image_size,
        K = config.K,
        n = 0.01,
        f = 1000;
      camera.projectionMatrix.set(
        (2 * K[0][0]) / w,
        (-2 * K[0][1]) / w,
        1 - (2 * K[0][2]) / w,
        0,
        0,
        (2 * K[1][1]) / h,
        (2 * K[1][2]) / h - 1,
        0,
        0,
        0,
        -(f + n) / (f - n),
        (-2 * f * n) / (f - n),
        0,
        0,
        -1,
        0,
      );
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      mesh.material = overlayMaterial;
      mesh.visible =
        descriptor.body_observed[current] &&
        config.pose_valid?.[current] === true &&
        config.source_observed[current];
      axes.visible = false;
      renderer.autoClear = false;
      renderer.render(scene, camera);
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
      vertices: Float32Array,
      index: number,
      images: HTMLCanvasElement[],
    ) {
      const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
      (attr.array as Float32Array).set(vertices);
      attr.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      current = index;
      if (!fitted && descriptor.body_observed[index]) {
        const sphere = geometry.boundingSphere!;
        const direction = new THREE.Vector3(2, orbitCamera.up.y, 3);
        if (initialRows) {
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
      textures.forEach((t) => t.dispose());
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
      overlayMaterial.dispose();
      axes.geometry.dispose();
      (axes.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
