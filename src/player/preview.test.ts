import { expect, test } from "vitest";
import type { NdArray, NumericArray } from "../smplx/npy";
import { readPreview } from "./preview";

const array = (shape: number[], data: NumericArray | string[]): NdArray => ({
  dtype: "<f4", shape, fortranOrder: false, data,
});
function preview() {
  const arrays: Record<string, NdArray> = {};
  for (const [key, width] of [
    ["global_orient", 3], ["body_pose", 63], ["jaw_pose", 3], ["leye_pose", 3],
    ["reye_pose", 3], ["left_hand_pose", 45], ["right_hand_pose", 45], ["transl", 3],
  ] as const) arrays[key] = array([2, width], new Float32Array(2 * width));
  arrays.betas = array([1, 1], new Float32Array(1));
  arrays.expression = array([2, 1], new Float32Array(2));
  arrays.reference_timestamps_ns = array([2], new Float64Array([2 ** 40, 2 ** 40 + 33_333_333]));
  arrays.flat_hand_mean = array([], new Int32Array([1]));
  arrays.use_pca = array([], new Int32Array([0]));
  arrays.coordinate_frame = array([], ["synthetic"]);
  arrays.units = array([], ["m"]);
  arrays.model_sha256 = array([], ["a".repeat(64)]);
  arrays.source_model_sha256 = array([], ["c".repeat(64)]);
  arrays.body_observed = array([2], new Int32Array([1, 0]));
  arrays.preview_video_pts_ns = array([2, 2], new Float64Array([0, 33_333_333, 0, 33_333_333]));
  arrays.preview_source_observed = array([2, 2], new Int32Array([0, 1, 1, 0]));
  const metadata = { format: "synaexo-visualization", schema_version: 1, recording_id: "recording", result_id: "run",
    model: { sha256: "a".repeat(64), source_sha256: "c".repeat(64), bytes: 1234, num_betas: 1, num_expression: 1 },
    videos: ["gopro", "ego"].map((kind, i) => ({ camera_id: `cam${i}`, kind,
      view_id: kind === "gopro" ? "EXO01" : "EGO01", bytes: 42, sha256: "b".repeat(64), image_size: [64, 64] })) };
  const update = (extra = {}) => { arrays.preview_metadata = array([], [JSON.stringify({ ...metadata, ...extra })]); };
  update();
  return { arrays, metadata, update };
}
test("bundled preview preserves EXO/EGO identities, exact times and missing-frame masks without a quality status", () => {
  const { arrays } = preview(), p = readPreview(arrays);
  expect(p.displayUp).toBeUndefined();
  expect(p.contract.times).toEqual([0, 33_333_333]);
  expect(p.contract.representation).toBe("smplx_axis_angle");
  expect(p.body).toEqual([true, false]);
  expect(p.cameras.map(v => [v.path, v.source_observed])).toEqual([
    ["videos/exo01.mp4", [false, true]], ["videos/ego01.mp4", [true, false]],
  ]);
});
test.each([
  { supplied: [-2, 0, 0], normalized: [-1, 0, 0] },
  { supplied: [0, 1, 0], normalized: [0, 1, 0] },
])("reads $supplied without changing motion or camera timing", ({ supplied, normalized }) => {
  const { arrays, update } = preview(), before = readPreview(arrays);
  update({ display_up: supplied });
  expect(readPreview(arrays)).toEqual({ ...before, displayUp: normalized });
});
test.each([null, [0, 0, 0], [0, 1], [0, "-1", 0]].map(display_up => ({ display_up })))(
  "rejects invalid display up: $display_up", ({ display_up }) => {
    const { arrays, update } = preview();
    update({ display_up });
    expect(() => readPreview(arrays)).toThrow("三维显示向上轴");
  },
);
test("visualization package binds its included model and uses the videos directory", () => {
  const { arrays } = preview();
  const result = readPreview(arrays);
  expect(result.modelBytes).toBe(1234);
  expect(result.cameras.map(v => v.path)).toEqual(["videos/exo01.mp4", "videos/ego01.mp4"]);
  arrays.source_model_sha256.data[0] = "d".repeat(64);
  expect(() => readPreview(arrays)).toThrow("来源摘要");
});
test("model-free legacy previews retain their model identity and original video paths", () => {
  const { arrays, metadata, update } = preview();
  metadata.format = "synaexo-preview"; update();
  delete arrays.source_model_sha256;
  const parsed = readPreview(arrays);
  expect(parsed.modelHash).toBe("a".repeat(64));
  expect(parsed.sourceModelHash).toBeUndefined();
  expect(parsed.modelBytes).toBeUndefined();
  expect(parsed.cameras.map(v => v.path)).toEqual(["previews/exo01.mp4", "previews/ego01.mp4"]);
});
test("rejects mismatched model, invalid identities and unsupported metadata", () => {
  const { arrays, metadata, update } = preview();
  arrays.model_sha256.data[0] = "c".repeat(64);
  expect(() => readPreview(arrays)).toThrow("模型");
  arrays.model_sha256.data[0] = "a".repeat(64);
  metadata.videos[1].view_id = "EXO01"; update();
  expect(() => readPreview(arrays)).toThrow("视频身份");
  metadata.schema_version = 2; update();
  expect(() => readPreview(arrays)).toThrow("身份");
});
test("rejects guessed or imprecise video timing and fabricated validity", () => {
  const { arrays } = preview();
  arrays.preview_video_pts_ns.data[3] = 40_000_000;
  expect(() => readPreview(arrays)).toThrow("视频时间轴");
  arrays.preview_video_pts_ns.data[3] = 33_333_333;
  arrays.preview_source_observed.data[2] = 2;
  expect(() => readPreview(arrays)).toThrow("逐帧有效性");
  arrays.reference_timestamps_ns.data[1] = 2 ** 53;
  expect(() => readPreview(arrays)).toThrow("时间证据");
});

test("reads zero-expression matrices and both MP4 types without projection data", () => {
  const { arrays, metadata, update } = preview();
  metadata.model.num_betas = 10;
  metadata.model.num_expression = 0;
  arrays.betas = array([1, 10], new Float32Array(10));
  delete arrays.global_orient;
  delete arrays.expression;
  const rotations = new Float32Array(2 * 55 * 9);
  for (let i = 0; i < rotations.length; i += 9)
    rotations[i] = rotations[i + 4] = rotations[i + 8] = 1;
  arrays.joint_rotations = array([2, 55, 3, 3], rotations);
  arrays.hand_accepted = array([2, 2], new Int32Array(4));
  arrays.hand_view_count = array([2, 2], new Int32Array(4));
  Object.assign(metadata.videos[0], { content: "clean_proxy" });
  Object.assign(metadata.videos[1], { content: "baked_projection" });
  const representation = "smplx_local_rotations";
  update({ representation, display_up: [-1, 0, 0] });
  const parsed = readPreview(arrays);
  expect(parsed.contract).toMatchObject({ representation, numExpression: 0 });
  expect(parsed.displayUp).toEqual([-1, 0, 0]);
  expect(parsed.cameras.every(camera => !camera.projectionK)).toBe(true);
  expect(parsed.cameras.map(v => [v.path, v.video_pts_ns, v.source_observed])).toEqual([
    ["videos/exo01.mp4", [0, 33_333_333], [false, true]],
    ["videos/ego01.mp4", [0, 33_333_333], [true, false]],
  ]);
  update({ representation: "unsupported" });
  expect(() => readPreview(arrays)).toThrow("动作表示不支持");
});

test("uses native-pixel calibration only for EXO proxy videos", () => {
  const { arrays, metadata, update } = preview();
  const pose = [1, 0, 0, 0.125, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 2; i++) {
    Object.assign(metadata.videos[i], { content: "clean_proxy" });
    arrays[`preview_camera_${i}_K`] = array([3, 3], new Float64Array([30.123456789, 0, 32, 0, 30, 32, 0, 0, 1]));
    arrays[`preview_camera_${i}_poses`] = array([2, 4, 4], new Float64Array([...pose, ...pose]));
    arrays[`preview_camera_${i}_pose_valid`] = array([2], new Int32Array([true, false].map(Number)));
  }
  update();
  const [exo, ego] = readPreview(arrays).cameras;
  expect(exo.projectionK?.[0][0]).toBe(30.123456789);
  expect(exo.T_world_from_camera?.[0]).toEqual([[1, 0, 0, 0.125], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  expect(exo.pose_valid).toEqual([true, false]);
  expect(ego.projectionK).toBeUndefined();

  arrays.preview_camera_0_K.data[0] = 0;
  expect(() => readPreview(arrays)).toThrow("EXO 代理视频内参无效");
  Object.assign(metadata.videos[0], { content: "baked_projection" });
  update();
  expect(readPreview(arrays).cameras[0].projectionK).toBeUndefined();
});
