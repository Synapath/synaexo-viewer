import { sha256 } from "@noble/hashes/sha256";
import type { MotionContract } from "./motion";

export const sha256Hex = (buffer: ArrayBuffer) =>
  Array.from(sha256(new Uint8Array(buffer)), n => n.toString(16).padStart(2, "0")).join("");

type ModelIdentity = { sha256: string; sourceSha256?: string; bytes?: number };
type ModelDimensions = Pick<MotionContract, "numBetas" | "numExpression">;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
const LIMIT = 256 * 1024 ** 2;

async function fetchAsset(url: URL, limit: number, signal: AbortSignal) {
  const downloadFailed = () => {
    signal.throwIfAborted();
    throw new Error("预览器内置模型下载失败，请检查网络后重试");
  };
  const response = await fetch(url, { signal }).catch(downloadFailed);
  if (!response.ok) throw new Error("预览器内置模型加载失败，请刷新页面重试");
  const length = Number(response.headers.get("content-length"));
  if (length > limit) throw new Error("预览器内置模型超过读取预算");
  const buffer = await response.arrayBuffer().catch(downloadFailed);
  signal.throwIfAborted();
  if (buffer.byteLength > limit) throw new Error("预览器内置模型超过读取预算");
  return buffer;
}

export async function loadPlaybackModel(
  identity: ModelIdentity, dimensions: ModelDimensions, signal: AbortSignal,
  readBundled?: () => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  if (readBundled) {
    const buffer = await readBundled();
    signal.throwIfAborted();
    if ((identity.bytes !== undefined && buffer.byteLength !== identity.bytes)
      || sha256Hex(buffer) !== identity.sha256)
      throw new Error("包内模型与动作参数的大小或摘要不一致");
    return buffer;
  }
  const catalogUrl = new URL("models/default.json", document.baseURI);
  const buffer = await fetchAsset(catalogUrl, 65536, signal);
  let model;
  try { model = JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new Error("预览器内置模型清单无效，请刷新页面重试"); }
  if (model?.format !== "synaexo-default-model" || model.schema_version !== 1
    || typeof model.file !== "string" || !/^smplx-[a-f0-9]{64}\.npz$/.test(model.file)
    || !hash(model.sha256) || model.file !== `smplx-${model.sha256}.npz`
    || !hash(model.source_sha256) || !positive(model.bytes, LIMIT)
    || !positive(model.num_betas, 300) || !positive(model.num_expression, 100))
    throw new Error("预览器内置模型清单无效，请刷新页面重试");
  const matches = identity.sourceSha256
    ? identity.sourceSha256 === model.source_sha256
    : identity.sha256 === model.sha256 || identity.sha256 === model.source_sha256;
  if (!matches || dimensions.numBetas > model.num_betas || dimensions.numExpression > model.num_expression)
    throw new Error("预览器内置模型与动作参数不匹配，请使用包含对应模型的 ZIP");
  const modelBuffer = await fetchAsset(new URL(model.file, catalogUrl), model.bytes, signal);
  if (modelBuffer.byteLength !== model.bytes || sha256Hex(modelBuffer) !== model.sha256)
    throw new Error("预览器内置模型校验失败，请刷新页面重试");
  return modelBuffer;
}
