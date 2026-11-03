import type { NdArray, NumericArray } from "../smplx/npy";
import type { SmplxModel } from "../smplx/smplxModel";

type Field = { data: NumericArray; width: number; rows: number };
export type MotionContract = {
  frames: number;
  numBetas: number;
  numExpression: number;
  flatHandMean: boolean;
  worldFrame: string;
  referenceOrigin: string;
  times: number[];
};

export function loadMotion(
  arrays: Record<string, NdArray>,
  contract: MotionContract,
) {
  const fields: Record<string, Field> = {};
  for (const [name, width, broadcast] of [
    ["global_orient", 3, false],
    ["body_pose", 63, false],
    ["jaw_pose", 3, false],
    ["leye_pose", 3, false],
    ["reye_pose", 3, false],
    ["left_hand_pose", 45, false],
    ["right_hand_pose", 45, false],
    ["transl", 3, false],
    ["betas", contract.numBetas, true],
    ["expression", contract.numExpression, true],
  ] as const) {
    const a = arrays[name];
    if (!a || Array.isArray(a.data))
      throw new Error(`动作参数缺少数值数组 ${name}`);
    const rows = a.shape.length === 1 && broadcast ? 1 : a.shape[0],
      columns = a.shape.length === 1 && broadcast ? a.shape[0] : a.shape[1];
    if (
      (a.shape.length !== 2 && !(broadcast && a.shape.length === 1)) ||
      columns !== width ||
      (rows !== contract.frames && !(broadcast && rows === 1)) ||
      a.data.length !== rows * width ||
      !a.data.every(Number.isFinite)
    )
      throw new Error(`动作参数 ${name} 维度、帧数或数值无效`);
    fields[name] = { data: a.data, width, rows };
  }
  if (
    arrays.flat_hand_mean?.data[0] !== Number(contract.flatHandMean) ||
    arrays.use_pca?.data[0] !== 0
  )
    throw new Error("动作参数的手部表示与清单不一致");
  if (
    arrays.coordinate_frame?.data[0] !== contract.worldFrame ||
    arrays.units?.data[0] !== "m"
  )
    throw new Error("动作参数坐标系或单位与清单不一致");
  const times = arrays.reference_timestamps_ns;
  if (
    !times ||
    Array.isArray(times.data) ||
    times.data.length !== contract.frames
  )
    throw new Error("动作参数缺少逐帧时间证据");
  for (let i = 0; i < contract.frames; i++)
    if (
      BigInt(times.data[i]) - BigInt(contract.referenceOrigin) !==
      BigInt(contract.times[i])
    )
      throw new Error("动作参数与主时间轴不一致");
  const slice = (key: string, frame: number) => {
    const f = fields[key],
      offset = (f.rows === 1 ? 0 : frame) * f.width;
    return f.data.subarray(offset, offset + f.width);
  };
  return {
    frame(model: SmplxModel, index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= contract.frames)
        throw new Error("人体帧号超出范围");
      const pose = new Float32Array(165);
      let offset = 0;
      for (const key of [
        "global_orient",
        "body_pose",
        "jaw_pose",
        "leye_pose",
        "reye_pose",
        "left_hand_pose",
        "right_hand_pose",
      ]) {
        const values = slice(key, index);
        pose.set(values, offset);
        offset += values.length;
      }
      if (!contract.flatHandMean)
        for (let i = 0; i < 90; i++) pose[75 + i] += model.handsMean[i];
      const positions = model
          .forward(
            {
              pose,
              betas: Float32Array.from(slice("betas", index)),
              expression: Float32Array.from(slice("expression", index)),
            },
            { poseBlendShapes: true },
          )
          .slice(),
        t = slice("transl", index);
      for (let i = 0; i < positions.length; i++) positions[i] += t[i % 3];
      if (!positions.every(Number.isFinite))
        throw new Error("人体前向包含无效坐标");
      return positions;
    },
  };
}
