import type { NdArray, NumericArray } from "../smplx/npy";
import type { SmplxModel, SmplxPose } from "../smplx/smplxModel";
import { SMPLX_NUM_JOINTS } from "../smplx/skeleton";

type Field = { data: NumericArray; width: number; rows: number };
const axisAngleFields = [
  ["global_orient", 3, false],
  ["body_pose", 63, false],
  ["jaw_pose", 3, false],
  ["leye_pose", 3, false],
  ["reye_pose", 3, false],
  ["left_hand_pose", 45, false],
  ["right_hand_pose", 45, false],
] as const;
const rotationsPerFrame = SMPLX_NUM_JOINTS * 9;
export type MotionContract = {
  representation?: "smplx_axis_angle" | "smplx_local_rotations";
  frames: number;
  numBetas: number;
  numExpression: number;
  flatHandMean: boolean;
  worldFrame: string;
  referenceOrigin: string;
  times: number[];
};

export function readTimeline(a: NdArray | undefined, frames: number) {
  if (!a || frames < 1 || a.shape.length !== 1 || a.shape[0] !== frames
    || Array.isArray(a.data) || a.data.length !== frames)
    throw new Error("动作参数缺少精确逐帧时间证据");
  const clock = a.int64 ?? a.data;
  const maxDelta = BigInt(Number.MAX_SAFE_INTEGER);
  let origin = 0n;
  const times = new Array<number>(frames);
  for (let i = 0; i < frames; i++) {
    const value = clock[i];
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new Error("时间证据不能截断");
    const exact = BigInt(value);
    if (i === 0) origin = exact;
    const delta = exact - origin;
    if (delta < 0n || delta > maxDelta || (i > 0 && delta <= BigInt(times[i - 1])))
      throw new Error("动作时间跨度超出精确范围或未递增");
    times[i] = Number(delta);
  }
  return { referenceOrigin: String(origin), times };
}

export function numeric(arrays: Record<string, NdArray>, key: string, shape: number[]) {
  const a = arrays[key];
  if (!a || Array.isArray(a.data) || a.shape.join() !== shape.join()
    || a.data.length !== shape.reduce((a, b) => a * b, 1) || !a.data.every(Number.isFinite))
    throw new Error(`动作参数 ${key} 维度或数值无效`);
  return a.data;
}
export function mask(arrays: Record<string, NdArray>, key: string, shape: number[]) {
  const data = numeric(arrays, key, shape);
  if (!data.every(v => v === 0 || v === 1)) throw new Error(`动作参数 ${key} 有效性无效`);
  return Array.from(data, Boolean);
}

export function loadMotion(arrays: Record<string, NdArray>, contract: MotionContract) {
  const matrix = contract.representation === "smplx_local_rotations";
  if (!Number.isSafeInteger(contract.frames) || contract.frames < 1
    || !Number.isInteger(contract.numBetas) || contract.numBetas < 1 || contract.numBetas > 300
    || !Number.isInteger(contract.numExpression) || contract.numExpression < (matrix ? 0 : 1) || contract.numExpression > 100)
    throw new Error("动作参数契约无效");
  const timeline = readTimeline(arrays.reference_timestamps_ns, contract.frames);
  if (BigInt(timeline.referenceOrigin) !== BigInt(contract.referenceOrigin)
    || contract.times.length !== contract.frames
    || timeline.times.some((t, i) => t !== contract.times[i]))
    throw new Error("动作参数与主时间轴不一致");
  const fields: Record<string, Field> = {};
  const specs: (readonly [string, number, boolean])[] = [
    ["transl", 3, false],
    ["betas", contract.numBetas, true],
    ...(matrix ? [] : axisAngleFields),
  ];
  if (!matrix) specs.push(["expression", contract.numExpression, true]);
  for (const [name, width, broadcast] of specs) {
    const a = arrays[name];
    if (!a || Array.isArray(a.data)) throw new Error(`动作参数缺少数值数组 ${name}`);
    const rows = a.shape.length === 1 && broadcast ? 1 : a.shape[0],
      columns = a.shape.length === 1 && broadcast ? a.shape[0] : a.shape[1];
    if ((a.shape.length !== 2 && !(broadcast && a.shape.length === 1)) || columns !== width
      || (rows !== contract.frames && !(broadcast && rows === 1))
      || a.data.length !== rows * width || !a.data.every(Number.isFinite))
      throw new Error(`动作参数 ${name} 维度、帧数或数值无效`);
    fields[name] = { data: a.data, width, rows };
  }
  if (arrays.flat_hand_mean?.data[0] !== Number(contract.flatHandMean) || arrays.use_pca?.data[0] !== 0)
    throw new Error("动作参数的手部表示与清单不一致");
  if (arrays.coordinate_frame?.data[0] !== contract.worldFrame || arrays.units?.data[0] !== "m")
    throw new Error("动作参数坐标系或单位与清单不一致");
  let rotations: Float32Array | undefined;
  if (matrix) {
    if (!contract.flatHandMean || contract.numBetas !== 10 || contract.numExpression !== 0)
      throw new Error("最终矩阵参数的模型配置无效");
    const values = numeric(arrays, "joint_rotations", [contract.frames, SMPLX_NUM_JOINTS, 3, 3]);
    if (arrays.joint_rotations.dtype !== "<f4" || !(values instanceof Float32Array))
      throw new Error("最终旋转矩阵必须使用 float32");
    rotations = values;
    for (let at = 0; at < rotations.length; at += 9) {
      const r = rotations.subarray(at, at + 9);
      for (let i = 0; i < 3; i++) {
        for (let j = i; j < 3; j++) {
          let dot = 0;
          for (let k = 0; k < 3; k++) dot += r[i * 3 + k] * r[j * 3 + k];
          if (Math.abs(dot - Number(i === j)) > 2e-5)
            throw new Error("最终旋转矩阵不正交");
        }
      }
      const det = r[0] * (r[4] * r[8] - r[5] * r[7])
        - r[1] * (r[3] * r[8] - r[5] * r[6])
        + r[2] * (r[3] * r[7] - r[4] * r[6]);
      if (Math.abs(det - 1) > 2e-5) throw new Error("最终旋转矩阵方向无效");
    }
    mask(arrays, "body_observed", [contract.frames]);
    mask(arrays, "hand_accepted", [contract.frames, 2]);
    if (!numeric(arrays, "hand_view_count", [contract.frames, 2]).every(n => Number.isSafeInteger(n) && n >= 0))
      throw new Error("手部观测数量无效");
  }
  const slice = (key: string, frame: number) => {
    const f = fields[key], offset = (f.rows === 1 ? 0 : frame) * f.width;
    return f.data.subarray(offset, offset + f.width);
  };
  return {
    ...timeline,
    frame(model: SmplxModel, index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= contract.frames) throw new Error("人体帧号超出范围");
      let poseParams: SmplxPose;
      if (rotations) {
        const offset = index * rotationsPerFrame;
        poseParams = { rotations: rotations.subarray(offset, offset + rotationsPerFrame) };
      } else {
        const pose = new Float32Array(SMPLX_NUM_JOINTS * 3);
        let offset = 0;
        for (const [key] of axisAngleFields) {
          const values = slice(key, index);
          pose.set(values, offset);
          offset += values.length;
        }
        if (!contract.flatHandMean)
          for (let i = 0; i < 90; i++) pose[75 + i] += model.handsMean[i];
        poseParams = { pose };
      }
      const positions = model.forward({
        ...poseParams,
        betas: Float32Array.from(slice("betas", index)),
        expression: contract.numExpression ? Float32Array.from(slice("expression", index)) : new Float32Array(),
      }, { poseBlendShapes: true }).slice(), t = slice("transl", index);
      for (let i = 0; i < positions.length; i++) positions[i] += t[i % 3];
      if (!positions.every(Number.isFinite)) throw new Error("人体前向包含无效坐标");
      return positions;
    },
  };
}
