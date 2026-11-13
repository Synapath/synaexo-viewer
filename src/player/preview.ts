import type { NdArray } from "../smplx/npy";
import { loadMotion, mask, numeric, readTimeline, type MotionContract } from "./motion";
import { parseDisplayUp } from "./orbitBasis";
import type { Camera } from "./package";

type PreviewCamera = Omit<Camera, "url" | "T_world_from_camera"> & {
  T_world_from_camera?: number[][][];
  path: string;
  bytes: number;
  sha256: string;
};
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
export function readPreview(arrays: Record<string, NdArray>) {
  const text = arrays.preview_metadata;
  if (!text || text.shape.length !== 0 || !Array.isArray(text.data)
    || typeof text.data[0] !== "string" || text.data[0].length > 65536)
    throw new Error("动作 NPZ 缺少预览信息，请使用新版打包脚本");
  const metadata = JSON.parse(text.data[0]);
  if (!["synaexo-visualization", "synaexo-preview"].includes(metadata?.format))
    throw new Error("不支持的可视化包格式，请使用新版打包脚本");
  const legacy = metadata.format === "synaexo-preview";
  const representation = metadata.representation === undefined ? "smplx_axis_angle" : metadata.representation;
  if (representation !== "smplx_axis_angle" && representation !== "smplx_local_rotations")
    throw new Error("可视化包动作表示不支持");
  const matrix = representation === "smplx_local_rotations";
  if (metadata.schema_version !== 1
    || typeof metadata.recording_id !== "string" || !metadata.recording_id
    || typeof metadata.result_id !== "string" || !metadata.result_id)
    throw new Error("可视化包身份无效");
  const model = metadata.model;
  if (!model || !hash(model.sha256) || arrays.model_sha256?.data[0] !== model.sha256
    || !integer(model.num_betas) || model.num_betas < 1 || model.num_betas > 300
    || !integer(model.num_expression) || model.num_expression < (matrix ? 0 : 1) || model.num_expression > 100)
    throw new Error("可视化包模型身份或维数无效");
  if (!legacy && (!hash(model.source_sha256) || arrays.source_model_sha256?.data[0] !== model.source_sha256
    || !integer(model.bytes) || model.bytes < 1 || model.bytes > 256 * 1024 ** 2))
    throw new Error("包内模型大小或来源摘要无效");
  const stamps = arrays.reference_timestamps_ns;
  if (!stamps || stamps.shape.length !== 1 || !stamps.shape[0]) throw new Error("缺少动作主时间轴");
  const frames = stamps.shape[0], { referenceOrigin, times } = readTimeline(stamps, frames);
  const flat = arrays.flat_hand_mean?.data[0];
  if (flat !== 0 && flat !== 1) throw new Error("缺少明确的手部表示");
  const world = arrays.coordinate_frame?.data[0];
  if (typeof world !== "string" || !world || arrays.units?.data[0] !== "m") throw new Error("动作坐标系或单位无效");
  const contract: MotionContract = { representation, frames, numBetas: model.num_betas, numExpression: model.num_expression,
    flatHandMean: flat === 1, worldFrame: world, referenceOrigin, times };
  loadMotion(arrays, contract);
  const body = mask(arrays, "body_observed", [frames]);
  const videos = metadata.videos;
  if (!Array.isArray(videos) || !videos.length || videos.length > 16) throw new Error("可视化包需包含 1–16 路视频");
  const pts = numeric(arrays, "preview_video_pts_ns", [videos.length, frames]),
    observed = numeric(arrays, "preview_source_observed", [videos.length, frames]);
  const ids = new Set<string>(), views = new Set<string>();
  const cameras: PreviewCamera[] = videos.map((v: any, i: number): PreviewCamera => {
    if (!v || typeof v.camera_id !== "string" || !v.camera_id || ids.has(v.camera_id)
      || !["gopro", "ego"].includes(v.kind)
      || typeof v.view_id !== "string" || !new RegExp("^" + (v.kind === "gopro" ? "EXO" : "EGO") + "\\d{2}$").test(v.view_id)
      || views.has(v.view_id) || !hash(v.sha256) || !integer(v.bytes) || v.bytes < 1
      || !Array.isArray(v.image_size) || v.image_size.length !== 2
      || !v.image_size.every((n: unknown) => integer(n) && n > 0 && n <= 8192))
      throw new Error("预览视频身份、大小或分辨率无效");
    ids.add(v.camera_id); views.add(v.view_id);
    const videoTimes = Array.from(pts.subarray(i * frames, (i + 1) * frames)),
      valid = observed.subarray(i * frames, (i + 1) * frames);
    if (!videoTimes.every((n, f) => integer(n) && n >= 0 && (!f || n > videoTimes[f - 1]) && Math.abs(n - times[f]) <= 11112)
      || !valid.every(n => n === 0 || n === 1)) throw new Error("视频时间轴或逐帧有效性与动作不一致");
    if (matrix && v.content !== "clean_proxy")
      throw new Error("最终矩阵包必须声明代理视频与投影");
    if (v.content !== undefined && v.content !== "clean_proxy" && v.content !== "baked_projection")
      throw new Error("可视化包视频类型不支持");
    const baked = v.content !== "clean_proxy";
    const projection = baked ? {} : readProjection(arrays, i, frames);
    return { ...projection, baked, camera_id: v.camera_id as string, view_id: v.view_id as string, kind: v.kind as "gopro" | "ego",
      image_size: v.image_size as [number, number], video_pts_ns: videoTimes, source_observed: Array.from(valid, Boolean),
      path: `${legacy ? "previews" : "videos"}/${v.view_id.toLowerCase()}.mp4`, bytes: v.bytes as number, sha256: v.sha256 as string };
  });
  return { contract, cameras, body, displayUp: parseDisplayUp(metadata.display_up),
    modelHash: model.sha256 as string,
    sourceModelHash: legacy ? undefined : model.source_sha256 as string,
    modelBytes: legacy ? undefined : model.bytes as number };
}

function readProjection(arrays: Record<string, NdArray>, camera: number, frames: number) {
  const prefix = `preview_camera_${camera}`;
  // Intrinsics in the NPZ already use the proxy video's pixel dimensions.
  const intrinsics = numeric(arrays, `${prefix}_K`, [3, 3]);
  if (intrinsics[0] <= 0 || intrinsics[4] <= 0 || intrinsics[6] !== 0 || intrinsics[7] !== 0 || intrinsics[8] !== 1)
    throw new Error(`相机投影 ${prefix}_K 无效`);
  const K = Array.from({ length: 3 }, (_, row) => Array.from(intrinsics.subarray(row * 3, (row + 1) * 3)));
  const poses = numeric(arrays, `${prefix}_poses`, [frames, 4, 4]);
  const pose_valid = mask(arrays, `${prefix}_pose_valid`, [frames]);
  const T_world_from_camera = Array.from({ length: frames }, (_, frame) => {
    const offset = frame * 16;
    const lastRow = poses.subarray(offset + 12, offset + 16);
    if (!lastRow.every((n, col) => Math.abs(n - Number(col === 3)) < 1e-6))
      throw new Error(`相机变换 ${prefix}_poses 无效`);
    return Array.from({ length: 4 }, (_, row) => Array.from(poses.subarray(offset + row * 4, offset + (row + 1) * 4)));
  });
  return { K, T_world_from_camera, pose_valid };
}
