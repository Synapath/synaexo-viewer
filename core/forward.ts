import { parseNpz } from "./npy";
import { SmplxModel } from "./smplxModel";
import { loadMotion, mask, readTimeline, type MotionContract } from "./motion";

export async function createForward(modelBuffer: ArrayBuffer, motionBuffer: ArrayBuffer, maps: ArrayBuffer[], c: MotionContract) {
  const arrays = await parseNpz(
    new Uint8Array(modelBuffer),
    new Set([
      "v_template",
      "shapedirs",
      "posedirs",
      "J_regressor",
      "weights",
      "kintree_table",
      "f",
      "hands_meanl",
      "hands_meanr",
    ]),
  );
  for (const [name, shape] of [
    ["v_template", [10475, 3]],
    ["posedirs", [10475, 3, 486]],
    ["J_regressor", [55, 10475]],
    ["weights", [10475, 55]],
    ["kintree_table", [2, 55]],
  ] as const) {
    const a = arrays[name];
    if (
      !a ||
      a.shape.join() !== shape.join() ||
      Array.isArray(a.data) ||
      !a.data.every(Number.isFinite)
    )
      throw new Error(`模型数组 ${name} 无效`);
  }
  const shape = arrays.shapedirs,
    faces = arrays.f;
  if (
    !shape ||
    shape.shape.length !== 3 ||
    shape.shape[0] !== 10475 ||
    shape.shape[1] !== 3 ||
    shape.shape[2] < (c.numExpression ? 300 + c.numExpression : c.numBetas) ||
    Array.isArray(shape.data) ||
    !shape.data.every(Number.isFinite)
  )
    throw new Error("模型形状基底无效");
  if (
    !faces ||
    faces.shape.length !== 2 ||
    faces.shape[1] !== 3 || faces.shape[0] < 1 ||
    Array.isArray(faces.data) ||
    !faces.data.every((n) => Number.isInteger(n) && n >= 0 && n < 10475)
  )
    throw new Error("模型三角面无效");
  if (!c.flatHandMean)
    for (const name of ["hands_meanl", "hands_meanr"]) {
      const a = arrays[name];
      if (
        !a ||
        a.shape.join() !== "45" ||
        Array.isArray(a.data) ||
        !a.data.every(Number.isFinite)
      )
        throw new Error("模型缺少平均手势证据");
    }
  const model = SmplxModel.fromArrays(arrays, {
    numBetas: c.numBetas,
    numExpr: c.numExpression,
  });
  if (
    model.parents[0] !== -1 ||
    model.parents.some((p, i) => i > 0 && (p < 0 || p >= i))
  )
    throw new Error("模型关节层级无效");
  const motionArrays = await parseNpz(new Uint8Array(motionBuffer));
  const motion = loadMotion(motionArrays, c);
  const observed: boolean[][] = [];
  for (const buffer of maps) {
    const map = await parseNpz(new Uint8Array(buffer));
    const timeline = readTimeline(map.reference_timestamps_ns, c.frames);
    if (timeline.referenceOrigin !== motion.referenceOrigin || timeline.times.some((t, i) => t !== motion.times[i]))
      throw new Error("相机观测与主时间轴不一致");
    observed.push(mask(map, "source_observed", [c.frames]));
  }
  const data = motionArrays;
  const body = data.body_observed ? mask(data, "body_observed", [c.frames]) : undefined;
  const handAccepted = data.hand_accepted ? mask(data, "hand_accepted", [c.frames, 2]) : undefined;
  return {
    faces: model.faces.slice(), observed, body, handAccepted,
    times: motion.times, referenceOrigin: motion.referenceOrigin,
    frames(first: number, count: number) {
      if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || count > 8 || first + count > c.frames)
        throw new Error("人体帧请求无效");
      const vertices = new Float32Array(count * 10475 * 3);
      for (let i = 0; i < count; i++) vertices.set(motion.frame(model, first + i), i * 10475 * 3);
      return vertices;
    },
  };
}
export type ForwardReady = Omit<Awaited<ReturnType<typeof createForward>>, "frames">;
