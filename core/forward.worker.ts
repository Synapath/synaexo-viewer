import { createForward } from "./forward";

let forward: Awaited<ReturnType<typeof createForward>> | undefined;
self.onmessage = async ({ data: r }: MessageEvent) => {
  try {
    if (r.type === "init") {
      forward = await createForward(r.model, r.motion, r.maps, r.contract);
      const { frames: _, ...ready } = forward;
      self.postMessage({ id: r.id, ...ready }, { transfer: [ready.faces.buffer] });
    } else if (r.type === "frames") {
      if (!forward) throw new Error("人体模型尚未就绪");
      const vertices = forward.frames(r.first, r.count);
      self.postMessage({ id: r.id, vertices }, { transfer: [vertices.buffer] });
    } else throw new Error("人体计算请求无效");
  } catch (error) {
    self.postMessage({ id: r.id, error: (error as Error).message });
  }
};
