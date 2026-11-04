import { expect, test } from "vitest";
import { loadMotion, type MotionContract } from "../../core/motion";
import { SmplxModel } from "../../core/smplxModel";
import type { NdArray, NumericArray } from "../../core/npy";
const array = (shape: number[], data: NumericArray | string[]): NdArray => ({
  dtype: "<f4",
  shape,
  fortranOrder: false,
  data,
});
function clip() {
  const arrays: Record<string, NdArray> = {};
  for (const [key, width] of [
    ["global_orient", 3],
    ["body_pose", 63],
    ["jaw_pose", 3],
    ["leye_pose", 3],
    ["reye_pose", 3],
    ["left_hand_pose", 45],
    ["right_hand_pose", 45],
    ["transl", 3],
  ] as const)
    arrays[key] = array([2, width], new Float32Array(2 * width));
  (arrays.global_orient.data as Float32Array)[2] = Math.PI / 2;
  (arrays.body_pose.data as Float32Array)[2] = Math.PI / 2;
  (arrays.transl.data as Float32Array).set([5, 6, 7, 6, 7, 8]);
  arrays.betas = array([1, 1], new Float32Array([2]));
  arrays.expression = array([1, 1], new Float32Array([0]));
  arrays.reference_timestamps_ns = array(
    [2],
    new Float64Array([2 ** 40, 2 ** 40 + 41_000_000]),
  );
  arrays.reference_timestamps_ns.dtype = "<i8";
  arrays.flat_hand_mean = array([], new Int32Array([1]));
  arrays.use_pca = array([], new Int32Array([0]));
  arrays.coordinate_frame = array([], ["test_world"]);
  arrays.units = array([], ["m"]);
  const contract: MotionContract = {
    frames: 2,
    numBetas: 1,
    numExpression: 1,
    flatHandMean: true,
    worldFrame: "test_world",
    referenceOrigin: String(2 ** 40),
    times: [0, 41_000_000],
  };
  return { arrays, contract };
}
test("full forward preserves shape, pose corrective, root rotation and world translation", () => {
  const vertices = 10475,
    dirs = new Float32Array(vertices * 3 * 301),
    posedirs = new Float32Array(vertices * 3 * 486),
    template = new Float32Array(vertices * 3),
    weights = new Float32Array(vertices * 55),
    parents = new Int32Array(110);
  template[3] = 1;
  dirs[4 * 301] = 1;
  posedirs[5 * 486] = 3;
  parents[0] = -1;
  for (let v = 0; v < vertices; v++) weights[v * 55] = 1;
  const model = SmplxModel.fromArrays(
    {
      v_template: array([vertices, 3], template),
      shapedirs: array([vertices, 3, 301], dirs),
      posedirs: array([vertices, 3, 486], posedirs),
      J_regressor: array([55, vertices], new Float32Array(55 * vertices)),
      weights: array([vertices, 55], weights),
      kintree_table: array([2, 55], parents),
      f: array([1, 3], new Int32Array([0, 1, 2])),
    },
    { numBetas: 1, numExpr: 1 },
  );
  const { arrays, contract } = clip(),
    motion = loadMotion(arrays, contract),
    point = motion.frame(model, 0).slice(3, 6);
  expect(point[0]).toBeCloseTo(3, 5);
  expect(point[1]).toBeCloseTo(7, 5);
  expect(point[2]).toBeCloseTo(4, 5);
});
test("rejects time or coordinate evidence mismatches instead of assuming an FPS or a frame", () => {
  const { arrays, contract } = clip();
  expect(() =>
    loadMotion(arrays, { ...contract, times: [0, 40_000_000] }),
  ).toThrow("主时间轴不一致");
  expect(() =>
    loadMotion(arrays, { ...contract, worldFrame: "another_world" }),
  ).toThrow("坐标系");
});

test("final matrices stay exact, retain masks and subtract the int64 origin before conversion", () => {
  const { arrays, contract } = clip();
  const R = new Float32Array(2 * 55 * 9);
  for (let i = 0; i < R.length; i += 9) R[i] = R[i + 4] = R[i + 8] = 1;
  R.set([0,-1,0,1,0,0,0,0,1], 9);
  arrays.joint_rotations = array([2,55,3,3], R);
  arrays.betas = array([1,10], new Float32Array(10));
  arrays.body_observed = array([2], new Int32Array([1,0]));
  arrays.hand_accepted = array([2,2], new Int32Array([1,0,0,0]));
  arrays.hand_view_count = array([2,2], new Int32Array([2,0,0,0]));
  arrays.reference_timestamps_ns.int64 = new BigInt64Array([2n**60n+123n,2n**60n+41_000_123n]);
  arrays.model_sha256 = array([], ["a".repeat(64)]);
  const c: MotionContract = {...contract, representation:"smplx_local_rotations", numBetas:10, numExpression:0, referenceOrigin:String(2n**60n+123n), modelSha256:"a".repeat(64)};
  const motion = loadMotion(arrays,c);
  let rotations: Float32Array | undefined;
  const model = {forward: (params:{rotations:Float32Array}) => { rotations=params.rotations;return new Float32Array(3); }} as unknown as SmplxModel;
  expect(motion.referenceOrigin).toBe(String(2n**60n+123n));expect(motion.times).toEqual([0,41_000_000]);
  expect([...motion.frame(model,0)]).toEqual([5,6,7]);expect(rotations).toEqual(R.slice(0,495));
  R[0] = -1;
  expect(()=>loadMotion(arrays,c)).toThrow("方向");
  R[0] = 1;arrays.hand_accepted.data[0]=2;
  expect(()=>loadMotion(arrays,c)).toThrow("有效性");
});
