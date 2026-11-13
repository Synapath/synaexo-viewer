import { expect, test } from "vitest";
import { loadMotion, type MotionContract } from "./motion";
import { SmplxModel } from "../smplx/smplxModel";
import type { NdArray, NumericArray } from "../smplx/npy";
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
test.each(["smplx_axis_angle", "smplx_local_rotations"] as const)(
  "%s forward preserves shape, pose corrective, root rotation and world translation", representation => {
  const matrix = representation === "smplx_local_rotations";
  const shapeDims = matrix ? 10 : 301;
  const vertices = 10475,
    dirs = new Float32Array(vertices * 3 * shapeDims),
    posedirs = new Float32Array(vertices * 3 * 486),
    template = new Float32Array(vertices * 3),
    weights = new Float32Array(vertices * 55),
    parents = new Int32Array(110);
  template[3] = 1;
  dirs[4 * shapeDims] = 1;
  posedirs[5 * 486] = 3;
  parents[0] = -1;
  for (let v = 0; v < vertices; v++) weights[v * 55] = 1;
  const model = SmplxModel.fromArrays(
    {
      v_template: array([vertices, 3], template),
      shapedirs: array([vertices, 3, shapeDims], dirs),
      posedirs: array([vertices, 3, 486], posedirs),
      J_regressor: array([55, vertices], new Float32Array(55 * vertices)),
      weights: array([vertices, 55], weights),
      kintree_table: array([2, 55], parents),
      f: array([1, 3], new Int32Array([0, 1, 2])),
    },
    { numBetas: matrix ? 10 : 1, numExpr: matrix ? 0 : 1 },
  );
  const { arrays, contract } = clip();
  contract.representation = representation;
  if (matrix) {
    contract.numBetas = 10;
    contract.numExpression = 0;
    contract.referenceOrigin = String(2n ** 60n + 7n);
    arrays.reference_timestamps_ns.int64 = new BigInt64Array([
      BigInt(contract.referenceOrigin), BigInt(contract.referenceOrigin) + 41_000_000n,
    ]);
    arrays.betas = array([1, 10], new Float32Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    arrays.body_observed = array([2], new Int32Array([1, 1]));
    arrays.hand_accepted = array([2, 2], new Int32Array(4));
    arrays.hand_view_count = array([2, 2], new Int32Array(4));
    const rotations = new Float32Array(2 * 55 * 9);
    for (let i = 0; i < rotations.length; i += 9)
      rotations[i] = rotations[i + 4] = rotations[i + 8] = 1;
    for (const offset of [0, 9])
      rotations.set([0, -1, 0, 1, 0, 0, 0, 0, 1], offset);
    arrays.joint_rotations = array([2, 55, 3, 3], rotations);
    delete arrays.global_orient;
    delete arrays.body_pose;
    delete arrays.expression;
    expect(loadMotion(arrays, contract).times).toEqual([0, 41_000_000]);
    rotations[18] = -1;
    expect(() => loadMotion(arrays, contract)).toThrow("方向无效");
    rotations[18] = 1;
  }
  const point = loadMotion(arrays, contract).frame(model, 0).slice(3, 6);
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
