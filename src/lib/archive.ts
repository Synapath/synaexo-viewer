import {
  BlobReader,
  BlobWriter,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js";

export type AssetKind = "video" | "image" | "json" | "parameters" | "file";
export type Asset = { path: string; bytes: number; kind: AssetKind };
const JSON_LIMIT = 8 * 1024 ** 2;
const MEDIA_LIMIT = 1024 ** 3;

export function assetKind(path: string): AssetKind {
  if (/\.(mp4|webm|mov)$/i.test(path)) return "video";
  if (/\.(png|jpe?g|webp)$/i.test(path)) return "image";
  if (/\.json$/i.test(path)) return "json";
  if (/\.(npz|npy|onnx)$/i.test(path)) return "parameters";
  return "file";
}

export function safeEntryPath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path)
  )
    throw new Error("ZIP 中存在无效文件路径");
  if (
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new Error("ZIP 中存在不安全或重复分隔的路径");
  return path;
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** power).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
}

export class RecordingArchive {
  private entries: Map<string, FileEntry>;
  readonly assets: Asset[];
  readonly name: string;
  constructor(name: string, entries: FileEntry[]) {
    this.name = name;
    const common = entries[0]?.filename.split("/").slice(0, -1) ?? [];
    while (common.length && !entries.every(e => e.filename.startsWith(common.join("/") + "/"))) common.pop();
    let prefix = "";
    while (common.length) {
      const candidate = common.join("/") + "/";
      if (entries.some(e => {
        const path = e.filename.slice(candidate.length);
        return path === "manifest.json" || /^motions\/[^/]+\/smplx_parameters\.npz$/.test(path);
      })) { prefix = candidate; break; }
      common.pop();
    }
    // Keep the original ZIP entries for reads; expose paths relative to the recording root.
    this.entries = new Map(entries.map(entry => [entry.filename.slice(prefix.length), entry]));
    this.assets = entries
      .map((entry) => ({
        path: entry.filename.slice(prefix.length),
        bytes: entry.uncompressedSize,
        kind: assetKind(entry.filename),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  private entry(path: string) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error("文件不在当前 ZIP 中");
    return entry;
  }
  async blob(path: string, signal: AbortSignal) {
    const entry = this.entry(path);
    if (entry.uncompressedSize > MEDIA_LIMIT)
      throw new Error("单文件超过浏览器预览预算（1 GiB）");
    const kind = assetKind(path);
    const mime =
      kind === "video"
        ? /\.webm$/i.test(path)
          ? "video/webm"
          : /\.mov$/i.test(path)
            ? "video/quicktime"
            : "video/mp4"
        : kind === "image"
          ? `image/${/\.jpe?g$/i.test(path) ? "jpeg" : path.split(".").at(-1)!.toLowerCase()}`
          : "application/octet-stream";
    return entry.getData(new BlobWriter(mime), { signal, checkCrc32: true });
  }
  async json(path: string, signal: AbortSignal): Promise<unknown> {
    if (this.entry(path).uncompressedSize > JSON_LIMIT)
      throw new Error("JSON 超过预览预算（8 MiB）");
    const blob = await this.blob(path, signal);
    signal.throwIfAborted();
    try {
      return JSON.parse(await blob.text());
    } catch {
      throw new Error(`${path} 不是有效的 JSON`);
    }
  }
  close() {
    this.entries.clear();
  }
}

export async function openArchive(
  file: File,
  signal: AbortSignal,
  progress: (count: number) => void,
) {
  if (!/\.zip$/i.test(file.name)) throw new Error("请选择 ZIP 录制包");
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries: FileEntry[] = [],
      seen = new Set<string>();
    for await (const entry of reader.getEntriesGenerator()) {
      signal.throwIfAborted();
      if (
        entry.directory ||
        /(^|\/)__MACOSX\//.test(entry.filename) ||
        entry.filename.split("/").at(-1) === ".DS_Store"
      )
        continue;
      const path = safeEntryPath(entry.filename);
      if (seen.has(path)) throw new Error(`ZIP 中有重名文件：${path}`);
      if (entry.encrypted) throw new Error("请使用未加密的 ZIP 录制包");
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0
      )
        throw new Error("ZIP 文件大小无效");
      seen.add(path);
      entries.push(entry);
      if (entries.length > 20_000)
        throw new Error("ZIP 文件数量超过浏览器清单预算（20,000）");
      progress(entries.length);
    }
    if (!entries.length) throw new Error("ZIP 中没有文件");
    return new RecordingArchive(file.name, entries);
  } finally {
    await reader.close();
  }
}
