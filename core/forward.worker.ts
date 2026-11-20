import { createForward } from "./forward";

let forward: Awaited<ReturnType<typeof createForward>> | undefined;
self.onmessage = async ({ data: r }: MessageEvent) => {
  try {
    if (r.type === "init") {
      forward = await createForward(r.model, r.motion, r.maps, r.contract);
      const { frames: _, bodyFrames: _bodyFrames, ...ready } = forward;
      self.postMessage({ id: r.id, ...ready }, { transfer: [ready.faces.buffer, ready.parents.buffer] });
    } else if (r.type === "frames") {
      if (!forward) throw new Error("人体模型尚未就绪");
      const { vertices, joints } = forward.bodyFrames(r.first, r.count);
      self.postMessage({ id: r.id, vertices, joints }, { transfer: [vertices.buffer, joints.buffer] });
    } else throw new Error("人体计算请求无效");
  } catch (error) {
    self.postMessage({ id: r.id, error: (error as Error).message });
  }
};
