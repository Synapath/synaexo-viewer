import { parseNpz } from "../smplx/npy";
import { SmplxModel } from "../smplx/smplxModel";
import { loadMotion, mask, readTimeline, type MotionContract } from "./motion";

let model: SmplxModel | null = null,
  motion: ReturnType<typeof loadMotion> | null = null;
self.onmessage = async (event: MessageEvent) => {
  const r = event.data;
  try {
    if (r.type === "init") {
      const c = r.contract as MotionContract;
      const arrays = await parseNpz(
        new Uint8Array(r.model),
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
        faces.shape[1] !== 3 ||
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
      model = SmplxModel.fromArrays(arrays, {
        numBetas: c.numBetas,
        numExpr: c.numExpression,
      });
      if (
        model.parents[0] !== -1 ||
        model.parents.some((p, i) => i > 0 && (p < 0 || p >= i))
      )
        throw new Error("模型关节层级无效");
      const loadedMotion = loadMotion(await parseNpz(new Uint8Array(r.motion)), c);
      const observed: boolean[][] = [];
      for (const buffer of r.maps as ArrayBuffer[]) {
        const map = await parseNpz(new Uint8Array(buffer), new Set(["reference_timestamps_ns", "source_observed"]));
        const timeline = readTimeline(map.reference_timestamps_ns, c.frames);
        if (
          timeline.referenceOrigin !== loadedMotion.referenceOrigin ||
          timeline.times.some((t, i) => t !== loadedMotion.times[i])
        )
          throw new Error("相机观测与主时间轴不一致");
        observed.push(mask(map, "source_observed", [c.frames]));
      }
      motion = loadedMotion;
      const indices = model.faces.slice();
      self.postMessage(
        { id: r.id, faces: indices, observed },
        { transfer: [indices.buffer] },
      );
    } else {
      if (!model || !motion) throw new Error("人体模型尚未就绪");
      if (
        !Number.isInteger(r.first) ||
        !Number.isInteger(r.count) ||
        r.count < 1 ||
        r.count > 8
      )
        throw new Error("人体帧请求无效");
      const vertices = new Float32Array(r.count * 10475 * 3);
      for (let i = 0; i < r.count; i++)
        vertices.set(motion.frame(model, r.first + i), i * 10475 * 3);
      self.postMessage({ id: r.id, vertices }, { transfer: [vertices.buffer] });
    }
  } catch (error) {
    self.postMessage({ id: r.id, error: (error as Error).message });
  }
};
