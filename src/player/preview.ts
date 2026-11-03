import type { NdArray, NumericArray } from "../smplx/npy";
import { loadMotion, type MotionContract } from "./motion";

const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
export function readPreview(arrays: Record<string, NdArray>) {
  const text = arrays.preview_metadata;
  if (!text || text.shape.length !== 0 || !Array.isArray(text.data)
    || typeof text.data[0] !== "string" || text.data[0].length > 65536)
    throw new Error("动作 NPZ 缺少预览信息，请使用新版打包脚本");
  const metadata = JSON.parse(text.data[0]);
  if (metadata?.format !== "synaexo-preview" || metadata.schema_version !== 1
    || typeof metadata.recording_id !== "string" || !metadata.recording_id
    || typeof metadata.result_id !== "string" || !metadata.result_id
    || typeof metadata.physical_accuracy_passed !== "boolean")
    throw new Error("预览包身份或质量状态无效");
  const model = metadata.model;
  if (!model || !hash(model.sha256) || arrays.model_sha256?.data[0] !== model.sha256
    || !integer(model.num_betas) || model.num_betas < 1 || model.num_betas > 300
    || !integer(model.num_expression) || model.num_expression < 1 || model.num_expression > 100)
    throw new Error("预览包模型身份或维数无效");
  const numeric = (key: string, shape: number[]): NumericArray => {
    const a = arrays[key];
    if (!a || Array.isArray(a.data) || a.shape.join() !== shape.join()
      || a.data.length !== shape.reduce((a, b) => a * b, 1) || !a.data.every(Number.isFinite))
      throw new Error(`预览数组 ${key} 维度或数值无效`);
    return a.data;
  };
  const stamps = arrays.reference_timestamps_ns;
  if (!stamps || stamps.shape.length !== 1 || !stamps.shape[0]) throw new Error("缺少动作主时间轴");
  const frames = stamps.shape[0], raw = numeric("reference_timestamps_ns", [frames]);
  if (!raw.every((n, i) => integer(n) && (!i || n > raw[i - 1]))) throw new Error("动作主时间轴必须精确且递增");
  const origin = raw[0], times = Array.from(raw, n => n - origin);
  if (!times.every(n => integer(n) && n >= 0)) throw new Error("动作时间跨度超出精确范围");
  const flat = arrays.flat_hand_mean?.data[0];
  if (flat !== 0 && flat !== 1) throw new Error("缺少明确的手部表示");
  const world = arrays.coordinate_frame?.data[0];
  if (typeof world !== "string" || !world || arrays.units?.data[0] !== "m") throw new Error("动作坐标系或单位无效");
  const contract: MotionContract = { frames, numBetas: model.num_betas, numExpression: model.num_expression,
    flatHandMean: flat === 1, worldFrame: world, referenceOrigin: String(origin), times };
  loadMotion(arrays, contract);
  const body = numeric("body_observed", [frames]);
  if (!body.every(v => v === 0 || v === 1)) throw new Error("人体有效性无效");
  const videos = metadata.videos;
  if (!Array.isArray(videos) || !videos.length || videos.length > 16) throw new Error("预览包需包含 1–16 路视频");
  const pts = numeric("preview_video_pts_ns", [videos.length, frames]),
    observed = numeric("preview_source_observed", [videos.length, frames]);
  const ids = new Set<string>(), views = new Set<string>();
  const cameras = videos.map((v: any, i: number) => {
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
    return { camera_id: v.camera_id as string, view_id: v.view_id as string, kind: v.kind as "gopro" | "ego",
      image_size: v.image_size as [number, number], video_pts_ns: videoTimes, source_observed: Array.from(valid, Boolean),
      path: `previews/${v.view_id.toLowerCase()}.mp4`, bytes: v.bytes as number, sha256: v.sha256 as string };
  });
  return { contract, cameras, body: Array.from(body, Boolean), modelHash: model.sha256 as string,
    qualityPassed: metadata.physical_accuracy_passed as boolean };
}
