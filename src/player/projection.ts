import type { NdArray } from "../smplx/npy";
import { mask, numeric } from "./motion";

export function isExoProxy(kind: unknown, content: unknown) {
  return kind === "gopro" && content === "clean_proxy";
}

export function readProxyProjection(arrays: Record<string, NdArray>, camera: number, frames: number) {
  const prefix = `preview_camera_${camera}`;
  const keys = [`${prefix}_K`, `${prefix}_poses`, `${prefix}_pose_valid`] as const;
  if (!keys.every(key => arrays[key])) return {};

  const intrinsics = numeric(arrays, keys[0], [3, 3]);
  if (intrinsics[0] <= 0 || intrinsics[4] <= 0 || intrinsics[6] !== 0 || intrinsics[7] !== 0 || intrinsics[8] !== 1)
    throw new Error(`EXO 代理视频内参无效：${keys[0]}`);
  const poses = numeric(arrays, keys[1], [frames, 4, 4]);
  const pose_valid = mask(arrays, keys[2], [frames]);
  const T_world_from_camera = Array.from({ length: frames }, (_, frame) => {
    const offset = frame * 16;
    if (!poses.subarray(offset + 12, offset + 16).every((n, col) => Math.abs(n - Number(col === 3)) < 1e-6))
      throw new Error(`EXO 代理视频位姿无效：${keys[1]}`);
    return Array.from({ length: 4 }, (_, row) => Array.from(poses.subarray(offset + row * 4, offset + (row + 1) * 4)));
  });
  // These intrinsics are already expressed in proxy video pixels.
  const projectionK = Array.from({ length: 3 }, (_, row) => Array.from(intrinsics.subarray(row * 3, (row + 1) * 3)));
  return { projectionK, T_world_from_camera, pose_valid };
}
