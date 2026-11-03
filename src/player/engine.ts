import type { MotionContract } from "./motion";
export class ForwardEngine {
  private worker = new Worker(new URL("./forward.worker.ts", import.meta.url), {
    type: "module",
  });
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      clearTimeout(job.timer);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data);
    };
    this.worker.onerror = () =>
      this.dispose("人体计算线程运行失败，请重新打开录制包");
  }
  private call(
    value: object,
    transfer: Transferable[] = [],
    timeout = 30000,
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("人体计算线程已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.dispose("人体计算超时，请重新打开录制包"),
        timeout,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...value, id }, transfer);
    });
  }
  init(
    model: ArrayBuffer,
    motion: ArrayBuffer,
    maps: ArrayBuffer[],
    contract: MotionContract,
  ): Promise<{ faces: Uint32Array; observed: boolean[][] }> {
    return this.call(
      { type: "init", model, motion, maps, contract },
      [model, motion, ...maps],
      120000,
    );
  }
  async frames(first: number, count: number): Promise<Float32Array> {
    return (await this.call({ type: "frames", first, count })).vertices;
  }
  dispose(message = "人体计算线程已关闭") {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(message));
    }
    this.pending.clear();
  }
}
