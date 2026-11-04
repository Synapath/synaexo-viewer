import type { NdArray, NumericArray } from "../../core/npy";
import { loadMotion, readTimeline, type MotionContract } from "../../core/motion";

const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
export function readPreview(arrays: Record<string, NdArray>) {
  const text = arrays.preview_metadata;
  if (!text || text.shape.length !== 0 || !Array.isArray(text.data)
    || typeof text.data[0] !== "string" || text.data[0].length > 65536)
    throw new Error("动作 NPZ 缺少预览信息，请使用新版打包脚本");
  const metadata = JSON.parse(text.data[0]);
  if (!["synaexo-preview", "synaexo-visualization"].includes(metadata?.format) || metadata.schema_version !== 1
    || typeof metadata.recording_id !== "string" || !metadata.recording_id
    || typeof metadata.result_id !== "string" || !metadata.result_id
    || typeof metadata.physical_accuracy_passed !== "boolean")
    throw new Error("可视化包身份或质量状态无效");
  if (metadata.representation !== undefined && !["smplx_axis_angle", "smplx_local_rotations"].includes(metadata.representation))
    throw new Error("动作表示无效");
  const model = metadata.model;
  const bundledModel = metadata.format === "synaexo-visualization";
  if (!model || !hash(model.sha256) || arrays.model_sha256?.data[0] !== model.sha256
    || !integer(model.num_betas) || model.num_betas < 1 || model.num_betas > 300
    || !integer(model.num_expression) || model.num_expression < (metadata.representation === "smplx_local_rotations" ? 0 : 1) || model.num_expression > 100)
    throw new Error("可视化包模型身份或维数无效");
  if (bundledModel && (!hash(model.source_sha256) || arrays.source_model_sha256?.data[0] !== model.source_sha256
    || !integer(model.bytes) || model.bytes < 1 || model.bytes > 256 * 1024 ** 2))
    throw new Error("包内模型大小或来源摘要无效");
  const numeric = (key: string, shape: number[]): NumericArray => {
    const a = arrays[key];
    if (!a || Array.isArray(a.data) || a.shape.join() !== shape.join()
      || a.data.length !== shape.reduce((a, b) => a * b, 1) || !a.data.every(Number.isFinite))
      throw new Error(`预览数组 ${key} 维度或数值无效`);
    return a.data;
  };
  const stamps = arrays.reference_timestamps_ns;
  if (!stamps || stamps.shape.length !== 1 || !stamps.shape[0]) throw new Error("缺少动作主时间轴");
  const frames = stamps.shape[0], { referenceOrigin, times } = readTimeline(stamps, frames);
  const flat = arrays.flat_hand_mean?.data[0];
  if (flat !== 0 && flat !== 1) throw new Error("缺少明确的手部表示");
  const world = arrays.coordinate_frame?.data[0];
  if (typeof world !== "string" || !world || arrays.units?.data[0] !== "m") throw new Error("动作坐标系或单位无效");
  const contract: MotionContract = { frames, numBetas: model.num_betas, numExpression: model.num_expression,
    flatHandMean: flat === 1, worldFrame: world, referenceOrigin, times, representation: metadata.representation ?? "smplx_axis_angle" };
  loadMotion(arrays, contract);
  const body = numeric("body_observed", [frames]);
  if (!body.every(v => v === 0 || v === 1)) throw new Error("人体有效性无效");
  const videos = metadata.videos;
  if (!Array.isArray(videos) || !videos.length || videos.length > 16) throw new Error("可视化包需包含 1–16 路视频");
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
    if (contract.representation === "smplx_local_rotations" && v.content !== "clean_proxy") throw new Error("最终矩阵包必须声明代理视频与投影");
    const baked = v.content !== "clean_proxy";
    if (v.content !== undefined && !["clean_proxy", "baked_projection"].includes(v.content)) throw new Error("视频内容类型无效");
    let projection: { K?: number[][]; T_world_from_camera?: number[][][]; pose_valid?: boolean[] } = {};
    if (!baked) {
      const K = numeric(`preview_camera_${i}_K`, [3, 3]),
        poses = numeric(`preview_camera_${i}_poses`, [frames, 4, 4]),
        poseValid = numeric(`preview_camera_${i}_pose_valid`, [frames]);
      if (K[0] <= 0 || K[4] <= 0 || K[6] !== 0 || K[7] !== 0 || K[8] !== 1
        || !poseValid.every(n => n === 0 || n === 1)) throw new Error("相机投影无效");
      const transforms = Array.from({length: frames}, (_, f) => Array.from({length: 4}, (_, r) => Array.from(poses.subarray(f*16+r*4, f*16+r*4+4))));
      if (!transforms.every(m => m[3].every((n, j) => Math.abs(n - Number(j === 3)) < 1e-6))) throw new Error("相机变换无效");
      projection = { K: [Array.from(K.subarray(0, 3)), Array.from(K.subarray(3, 6)), Array.from(K.subarray(6, 9))], T_world_from_camera: transforms, pose_valid: Array.from(poseValid, Boolean) };
    }
    return { ...projection, baked, camera_id: v.camera_id as string, view_id: v.view_id as string, kind: v.kind as "gopro" | "ego",
      image_size: v.image_size as [number, number], video_pts_ns: videoTimes, source_observed: Array.from(valid, Boolean),
      path: `${bundledModel ? "videos" : "previews"}/${v.view_id.toLowerCase()}.mp4`, bytes: v.bytes as number, sha256: v.sha256 as string };
  });
  return { contract, cameras, body: Array.from(body, Boolean), modelHash: model.sha256 as string,
    bundledModel, modelBytes: bundledModel ? model.bytes as number : undefined,
    qualityPassed: metadata.physical_accuracy_passed as boolean };
}
