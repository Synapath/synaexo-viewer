import { sha256 } from "@noble/hashes/sha256";
import { parseNpz } from "../smplx/npy";

export class MissingModel extends Error {
  readonly hash: string;
  constructor(hash: string) { super("请导入此预览包对应的 SMPL-X 模型，导入后自动继续"); this.hash = hash; }
}
export function sha256Hex(buffer: ArrayBuffer) {
  return Array.from(sha256(new Uint8Array(buffer)), v => v.toString(16).padStart(2, "0")).join("");
}
function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("synaexo-models", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("models");
    opening.onblocked = () => reject(new Error("模型缓存被其他页面占用，请关闭旧版 Viewer 页面后重试"));
    opening.onerror = () => reject(new Error("无法打开模型缓存，请检查浏览器存储权限"));
    opening.onsuccess = () => {
      const db = opening.result;
      db.onversionchange = () => db.close();
      try {
        const tx = db.transaction("models", mode), result = run(tx.objectStore("models"));
        tx.oncomplete = () => { db.close(); resolve(result.result); };
        tx.onabort = () => { db.close(); reject(new Error("模型缓存失败，请检查浏览器存储空间与权限")); };
      } catch {
        db.close(); reject(new Error("无法读取模型缓存，请检查浏览器存储权限"));
      }
    };
  });
}
export async function cachedModel(hash: string, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const value = await request<ArrayBuffer | undefined>("readonly", store => store.get(hash));
  signal.throwIfAborted();
  if (!value) throw new MissingModel(hash);
  if (!(value instanceof ArrayBuffer) || sha256Hex(value) !== hash) throw new Error("模型缓存校验失败，请重新导入模型");
  return value;
}
export async function importModel(file: File, signal: AbortSignal, expected?: string) {
  if (!/\.npz$/i.test(file.name) || file.size > 256 * 1024 ** 2) throw new Error("请选择不超过 256 MiB 的 SMPL-X 模型 NPZ");
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const hash = sha256Hex(bytes);
  if (expected && hash !== expected) throw new Error("模型与此预览包不匹配，请选择打包时使用的模型");
  const arrays = await parseNpz(new Uint8Array(bytes), new Set(["v_template", "shapedirs", "posedirs", "J_regressor", "weights", "kintree_table", "f"]));
  if (arrays.v_template?.shape.join() !== "10475,3" || arrays.posedirs?.shape.join() !== "10475,3,486"
    || arrays.J_regressor?.shape.join() !== "55,10475" || arrays.weights?.shape.join() !== "10475,55"
    || arrays.kintree_table?.shape.join() !== "2,55" || !arrays.shapedirs || !arrays.f)
    throw new Error("所选 NPZ 不是完整的 SMPL-X 模型");
  signal.throwIfAborted();
  await request("readwrite", store => store.put(bytes, hash));
  signal.throwIfAborted();
  return hash;
}
