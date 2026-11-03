import { sha256 } from "@noble/hashes/sha256";
import { RecordingArchive, safeEntryPath } from "../lib/archive";
import { ForwardEngine } from "./engine";
import { parseNpz } from "../smplx/npy";
import { readPreview } from "./preview";
import { cachedModel, sha256Hex } from "./models";

export type Camera = {
  camera_id: string;
  view_id: string;
  kind: "gopro" | "ego";
  image_size: [number, number];
  K?: number[][];
  T_world_from_camera?: number[][] | number[][][];
  pose_valid?: boolean[];
  source_observed: boolean[];
  video_pts_ns: number[];
  url: string;
  baked: boolean;
};
export type Recording = {
  frames: number;
  relative_timestamps_ns: number[];
  world_frame: string;
  body_observed: boolean[];
  faces: Uint32Array;
  cameras: Camera[];
  engine: ForwardEngine;
  qualityPassed: boolean;
  dispose: () => void;
};
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("录制包清单结构无效");
  return value as Record<string, any>;
};
const integer = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n);
export function validateTimes(
  value: unknown,
  frames: number,
  label: string,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== frames ||
    !value.every((n, i) => integer(n) && n >= 0 && (!i || n > value[i - 1]))
  )
    throw new Error(`${label} 必须是逐帧、严格递增的精确纳秒时间`);
  return value;
}
function booleans(value: unknown, frames: number, label: string): boolean[] {
  if (
    !Array.isArray(value) ||
    value.length !== frames ||
    !value.every((n) => typeof n === "boolean")
  )
    throw new Error(`${label} 观测状态无效`);
  return value;
}
function matrix(value: unknown, size: number) {
  return (
    Array.isArray(value) &&
    value.length === size &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === size &&
        row.every((n) => typeof n === "number" && Number.isFinite(n)),
    )
  );
}
function pose(value: unknown, frames: number): number[][] | number[][][] {
  const matrices = matrix(value, 4)
    ? [value]
    : Array.isArray(value) && value.length === frames
      ? value
      : [];
  if (
    !matrices.length ||
    !matrices.every(
      (m) =>
        matrix(m, 4) &&
        m[3].every(
          (n: number, i: number) => Math.abs(n - (i === 3 ? 1 : 0)) < 1e-6,
        ),
    )
  )
    throw new Error("相机世界坐标变换无效");
  return value as number[][] | number[][][];
}
async function prepareLegacyRecording(
  archive: RecordingArchive,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<Recording> {
  const urls: string[] = [],
    engine = new ForwardEngine();
  const abort = () => engine.dispose();
  signal.addEventListener("abort", abort, { once: true });
  try {
    progress("正在读取录制清单…");
    const m = object(await archive.json("manifest.json", signal));
    if (m.format !== "synaexo-viewer-package" || m.format_version !== 1)
      throw new Error("请使用包含 manifest.json 的 SynaExo 播放包");
    if (m.units !== "m" || typeof m.world_frame !== "string" || !m.world_frame)
      throw new Error("录制包缺少米制坐标系证据");
    if (!Array.isArray(m.files) || !m.files.length)
      throw new Error("录制包缺少文件校验清单");
    const files = new Map<string, { bytes: number; sha256: string }>();
    for (const value of m.files) {
      const f = object(value);
      if (
        typeof f.path !== "string" ||
        !integer(f.bytes) ||
        f.bytes < 0 ||
        typeof f.sha256 !== "string" ||
        !/^\p{ASCII_Hex_Digit}{64}$/u.test(f.sha256) ||
        files.has(f.path)
      )
        throw new Error("文件校验清单无效");
      files.set(safeEntryPath(f.path), {
        bytes: f.bytes,
        sha256: f.sha256.toLowerCase(),
      });
    }
    async function read(path: unknown): Promise<ArrayBuffer> {
      if (typeof path !== "string") throw new Error("录制包资源引用无效");
      safeEntryPath(path);
      const expected = files.get(path),
        asset = archive.assets.find((a) => a.path === path);
      if (!expected || !asset || asset.bytes !== expected.bytes)
        throw new Error(`录制包缺少或损坏：${path}`);
      const buffer = await (await archive.blob(path, signal)).arrayBuffer();
      signal.throwIfAborted();
      const digest =
        typeof crypto.subtle?.digest === "function"
          ? new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))
          : sha256(new Uint8Array(buffer));
      if (
        buffer.byteLength !== expected.bytes ||
        Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("") !==
          expected.sha256
      )
        throw new Error(`文件 SHA-256 校验失败：${path}`);
      return buffer;
    }
    const json = async (path: unknown) => {
      if (
        typeof path !== "string" ||
        (files.get(path)?.bytes ?? Infinity) > 8 * 1024 ** 2
      )
        throw new Error("录制包 JSON 超出解析预算或缺失");
      const buffer = await read(path);
      return object(JSON.parse(new TextDecoder().decode(buffer)));
    };
    const p = object(m.parameters),
      model = object(m.model);
    if (
      p.representation !== "legacy_smplx_axis_angle" ||
      p.use_pca !== false ||
      typeof p.flat_hand_mean !== "boolean" ||
      !integer(p.frames) ||
      p.frames < 1
    )
      throw new Error("此录制包需要完整的 SMPL-X 轴角参数、明确手部表示及帧数");
    if (
      !integer(model.num_betas) ||
      model.num_betas < 1 ||
      model.num_betas > 300 ||
      !integer(model.num_expression) ||
      model.num_expression < 1 ||
      model.num_expression > 100 ||
      model.expression_offset !== 300
    )
      throw new Error("模型参数维数或表情基底无效");
    const timeline = await json(p.timeline),
      times = validateTimes(
        timeline.relative_timestamps_ns,
        p.frames,
        "主时间轴",
      );
    if (
      timeline.frames !== p.frames ||
      times[0] !== 0 ||
      typeof timeline.reference_origin_ns !== "string" ||
      !/^[-]?\d{1,24}$/.test(timeline.reference_origin_ns)
    )
      throw new Error("录制包时间原点无效");
    // Legacy packages record a total only; a partial result requires its exact mask.
    const layer = await json("provenance/layer.json");
    let body: boolean[];
    if (Array.isArray(layer.body_observed))
      body = booleans(layer.body_observed, p.frames, "人体");
    else if (
      layer.frames === p.frames &&
      layer.body_observed_frames === p.frames
    )
      body = Array(p.frames).fill(true);
    else
      throw new Error("录制包缺少逐帧人体观测状态，不能将缺失帧当成有效人体");
    if (
      layer.frames !== p.frames ||
      layer.world_frame !== m.world_frame ||
      layer.units !== "m"
    )
      throw new Error("人体结果坐标系与清单不一致");
    const evidence = await json(m.cameras);
    if (
      evidence.world_frame !== m.world_frame ||
      evidence.units !== "m" ||
      !Array.isArray(evidence.cameras)
    )
      throw new Error("相机证据与录制坐标系不一致");
    const inputs = evidence.cameras.map(object);
    if (!inputs.length || inputs.length > 16)
      throw new Error("录制包需包含 1–16 路相机");
    if (
      inputs.some(
        (c: Record<string, unknown>) => c.kind !== "gopro" && c.kind !== "ego",
      )
    )
      throw new Error("相机类型须明确标记为 gopro 或 ego");
    const ids = new Set<string>(),
      views = new Set<string>(),
      paths = new Set<string>();
    const cameras: Camera[] = [],
      maps: ArrayBuffer[] = [];
    progress("正在校验相机与视频…");
    for (const value of inputs) {
      const c = object(value),
        calibration = object(c.calibration);
      if (
        typeof c.camera_id !== "string" ||
        !c.camera_id ||
        ids.has(c.camera_id) ||
        !new RegExp(
          "^" + (c.kind === "gopro" ? "EXO" : "EGO") + "\\d{2}$",
        ).test(c.view_id) ||
        views.has(c.view_id) ||
        typeof c.video !== "string" ||
        !c.video.endsWith(".mp4") ||
        paths.has(c.video)
      )
        throw new Error("相机身份或视频引用重复、无效");
      ids.add(c.camera_id);
      views.add(c.view_id);
      paths.add(c.video);
      if (
        !Array.isArray(c.image_size) ||
        c.image_size.length !== 2 ||
        !c.image_size.every(
          (n: unknown) =>
            integer(n) && (n as number) > 0 && (n as number) <= 8192,
        ) ||
        !matrix(calibration.K, 3) ||
        !Array.isArray(calibration.image_size) ||
        calibration.image_size.length !== 2 ||
        !calibration.image_size.every(
          (n: unknown) => integer(n) && (n as number) > 0,
        )
      )
        throw new Error("相机内参或分辨率无效");
      if (!["baked_projection", "clean_proxy"].includes(c.content))
        throw new Error("视频必须明确标记为已有叠加或干净代理");
      if (
        c.content === "clean_proxy" &&
        calibration.output_domain !== "undistorted"
      )
        throw new Error("干净代理叠加需要已去畸变的视频和内参");
      const [width, height] = c.image_size,
        scaleX = width / calibration.image_size[0],
        scaleY = height / calibration.image_size[1];
      const K = calibration.K.map((row: number[], i: number) =>
        row.map((n) => n * (i === 0 ? scaleX : i === 1 ? scaleY : 1)),
      );
      if (K[0][0] <= 0 || K[1][1] <= 0) throw new Error("相机焦距无效");
      const buffer = await read(c.video),
        url = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
      urls.push(url);
      maps.push(await read(c.source_frame_mapping));
      cameras.push({
        camera_id: c.camera_id,
        view_id: c.view_id,
        kind: c.kind,
        image_size: [width, height],
        K,
        T_world_from_camera: pose(c.T_world_from_camera, p.frames),
        pose_valid: booleans(c.pose_valid, p.frames, c.view_id),
        source_observed: [],
        video_pts_ns: validateTimes(c.video_pts_ns, p.frames, c.view_id),
        url,
        baked: c.content === "baked_projection",
      });
    }
    progress("正在加载 SMPL-X 模型…");
    const modelBuffer = await read(model.path),
      motionBuffer = await read(p.path);
    const initialized = await engine.init(modelBuffer, motionBuffer, maps, {
      frames: p.frames,
      numBetas: model.num_betas,
      numExpression: model.num_expression,
      flatHandMean: p.flat_hand_mean,
      worldFrame: m.world_frame,
      referenceOrigin: timeline.reference_origin_ns,
      times,
    });
    signal.throwIfAborted();
    cameras.forEach((camera, i) => {
      camera.source_observed = initialized.observed[i];
    });
    signal.removeEventListener("abort", abort);
    return {
      frames: p.frames,
      relative_timestamps_ns: times,
      world_frame: m.world_frame,
      body_observed: body,
      faces: initialized.faces,
      cameras,
      engine,
      qualityPassed: m.physical_accuracy_passed === true,
      dispose() {
        engine.dispose();
        urls.forEach(URL.revokeObjectURL);
        archive.close();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    engine.dispose();
    urls.forEach(URL.revokeObjectURL);
    throw error;
  }
}


export async function prepareRecording(
  archive: RecordingArchive, signal: AbortSignal, progress: (text: string) => void,
  resolveModel = cachedModel,
): Promise<Recording> {
  if (archive.assets.some(a => a.path === "manifest.json"))
    return prepareLegacyRecording(archive, signal, progress);
  const motions = archive.assets.filter(a => /^motions\/[^/]+\/smplx_parameters\.npz$/.test(a.path));
  if (motions.length !== 1 || archive.assets.some(a => a.path !== motions[0]?.path && !/^previews\/(exo|ego)\d{2}\.mp4$/.test(a.path)))
    throw new Error("预览包需包含一个 motions/<subject>/smplx_parameters.npz 和 previews/ 视频");
  if (motions[0].bytes > 128 * 1024 ** 2) throw new Error("动作参数超过浏览器预算");
  progress("正在读取动作参数…");
  const motionBuffer = await (await archive.blob(motions[0].path, signal)).arrayBuffer();
  const parsed = readPreview(await parseNpz(new Uint8Array(motionBuffer)));
  if (archive.assets.length !== 1 + parsed.cameras.length) throw new Error("视频清单与预览包文件不一致");
  progress("正在加载 SMPL-X 模型…");
  const model = await resolveModel(parsed.modelHash, signal);
  signal.throwIfAborted();
  if (sha256Hex(model) !== parsed.modelHash) throw new Error("模型与动作参数的摘要不一致");
  const engine = new ForwardEngine(), urls: string[] = [];
  const abort = () => engine.dispose();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const cameras: Camera[] = [];
    progress("正在校验视频…");
    for (const video of parsed.cameras) {
      const asset = archive.assets.find(a => a.path === video.path);
      if (!asset || asset.bytes !== video.bytes) throw new Error(`视频缺失或大小不符：${video.path}`);
      const blob = await archive.blob(video.path, signal);
      if (sha256Hex(await blob.arrayBuffer()) !== video.sha256) throw new Error(`视频校验失败：${video.path}`);
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob); urls.push(url);
      cameras.push({ ...video, url, baked: true });
    }
    const initialized = await engine.init(model, motionBuffer, [], parsed.contract);
    signal.throwIfAborted();
    signal.removeEventListener("abort", abort);
    return { frames: parsed.contract.frames, relative_timestamps_ns: parsed.contract.times,
      world_frame: parsed.contract.worldFrame, body_observed: parsed.body, faces: initialized.faces,
      cameras, engine, qualityPassed: parsed.qualityPassed,
      dispose() { engine.dispose(); urls.forEach(URL.revokeObjectURL); archive.close(); } };
  } catch (error) {
    signal.removeEventListener("abort", abort); engine.dispose(); urls.forEach(URL.revokeObjectURL); throw error;
  }
}
