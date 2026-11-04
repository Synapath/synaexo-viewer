import { expect, test } from "vitest";
import type { NdArray, NumericArray } from "../../core/npy";
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
  arrays.reference_timestamps_ns.dtype = "<i8";
  arrays.flat_hand_mean = array([], new Int32Array([1]));
  arrays.use_pca = array([], new Int32Array([0]));
  arrays.coordinate_frame = array([], ["synthetic"]);
  arrays.units = array([], ["m"]);
  arrays.model_sha256 = array([], ["a".repeat(64)]);
  arrays.body_observed = array([2], new Int32Array([1, 0]));
  arrays.preview_video_pts_ns = array([2, 2], new Float64Array([0, 33_333_333, 0, 33_333_333]));
  arrays.preview_source_observed = array([2, 2], new Int32Array([0, 1, 1, 0]));
  const metadata = { format: "synaexo-preview", schema_version: 1, recording_id: "recording", result_id: "run",
    physical_accuracy_passed: false, model: { sha256: "a".repeat(64), num_betas: 1, num_expression: 1 },
    videos: ["gopro", "ego"].map((kind, i) => ({ camera_id: `cam${i}`, kind,
      view_id: kind === "gopro" ? "EXO01" : "EGO01", bytes: 42, sha256: "b".repeat(64), image_size: [64, 64] })) };
  const update = () => { arrays.preview_metadata = array([], [JSON.stringify(metadata)]); };
  update();
  return { arrays, metadata, update };
}
test("minimal preview preserves EXO/EGO identities, exact times and missing-frame masks", () => {
  const { arrays } = preview(), p = readPreview(arrays);
  expect(p.contract.times).toEqual([0, 33_333_333]);
  expect(p.body).toEqual([true, false]);
  expect(p.cameras.map(v => [v.path, v.source_observed])).toEqual([
    ["previews/exo01.mp4", [false, true]], ["previews/ego01.mp4", [true, false]],
  ]);
  expect(p.qualityPassed).toBe(false);
});
test("visualization package binds its included model and uses the videos directory", () => {
  const { arrays, metadata, update } = preview();
  metadata.format = "synaexo-visualization";
  Object.assign(metadata.model, { source_sha256: "c".repeat(64), bytes: 1234 });
  arrays.source_model_sha256 = array([], ["c".repeat(64)]);
  update();
  const result = readPreview(arrays);
  expect(result.bundledModel).toBe(true);
  expect(result.modelBytes).toBe(1234);
  expect(result.cameras.map(v => v.path)).toEqual(["videos/exo01.mp4", "videos/ego01.mp4"]);
  arrays.source_model_sha256.data[0] = "d".repeat(64);
  expect(() => readPreview(arrays)).toThrow("来源摘要");
});
test("rejects mismatched model, invalid identities and unsupported metadata", () => {
  const { arrays, metadata, update } = preview();
  arrays.model_sha256.data[0] = "c".repeat(64);
  expect(() => readPreview(arrays)).toThrow("模型");
  arrays.model_sha256.data[0] = "a".repeat(64);
  metadata.videos[1].view_id = "EXO01"; update();
  expect(() => readPreview(arrays)).toThrow("视频身份");
  metadata.schema_version = 2; update();
  expect(() => readPreview(arrays)).toThrow("身份或质量");
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

test("matrix preview carries calibrated projections and cannot disguise clean proxies as baked videos", () => {
  const { arrays, metadata, update } = preview();
  Object.assign(metadata, {representation:"smplx_local_rotations"});
  metadata.model.num_betas=10;metadata.model.num_expression=0;
  arrays.betas=array([1,10],new Float32Array(10));
  const R=new Float32Array(2*55*9);
  for(let i=0;i<R.length;i+=9)R[i]=R[i+4]=R[i+8]=1;
  arrays.joint_rotations=array([2,55,3,3],R);
  arrays.hand_accepted=array([2,2],new Int32Array(4));arrays.hand_view_count=array([2,2],new Int32Array(4));
  for(let i=0;i<2;i++){
    Object.assign(metadata.videos[i],{content:"clean_proxy"});
    arrays[`preview_camera_${i}_K`]=array([3,3],new Float64Array([30,0,32,0,30,32,0,0,1]));
    arrays[`preview_camera_${i}_poses`]=array([2,4,4],new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]));
    arrays[`preview_camera_${i}_pose_valid`]=array([2],new Int32Array([1,0]));
  }
  update();const p=readPreview(arrays);
  expect(p.cameras[0].baked).toBe(false);expect(p.cameras[0].K?.[0][0]).toBe(30);
  expect(p.cameras[1].pose_valid).toEqual([true,false]);
  delete arrays.preview_camera_0_K;expect(()=>readPreview(arrays)).toThrow("preview_camera_0_K");
  Object.assign(metadata.videos[0],{content:undefined});update();expect(()=>readPreview(arrays)).toThrow("必须声明");
});
