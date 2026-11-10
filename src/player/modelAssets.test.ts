import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPlaybackModel, sha256Hex } from "./modelAssets";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const model = bytes("builtin-model"), source = "c".repeat(64);
const catalog = { format: "synaexo-default-model", schema_version: 1,
  file: `smplx-${sha256Hex(model)}.npz`, sha256: sha256Hex(model), source_sha256: source,
  bytes: model.byteLength, num_betas: 300, num_expression: 100 };
const identity = { sha256: "a".repeat(64), sourceSha256: source, bytes: 999 };
const dimensions = { numBetas: 10, numExpression: 10 };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://example.invalid/synaexo-viewer/" });
  fetcher = vi.fn(async (url: URL) => url.pathname.endsWith("default.json")
    ? new Response(JSON.stringify(catalog)) : new Response(model));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

test("prefers the bundled model and never silently replaces a corrupt one", async () => {
  const bundled = bytes("bundled"), signal = new AbortController().signal;
  expect(await loadPlaybackModel({ sha256: sha256Hex(bundled), bytes: bundled.byteLength },
    dimensions, signal, async () => bundled)).toBe(bundled);
  await expect(loadPlaybackModel(identity, dimensions, signal, async () => bundled)).rejects.toThrow("包内模型");
  expect(fetcher).not.toHaveBeenCalled();
});

test("loads a matching source model relative to the Pages subpath, without requiring the cropped ZIP hash", async () => {
  const signal = new AbortController().signal;
  expect(await loadPlaybackModel(identity, dimensions, signal)).toEqual(model);
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
    "https://example.invalid/synaexo-viewer/models/default.json",
    `https://example.invalid/synaexo-viewer/models/${catalog.file}`,
  ]);
});

test("matches model-free legacy previews by their original source hash", async () => {
  expect(await loadPlaybackModel({ sha256: source }, dimensions, new AbortController().signal)).toEqual(model);
});

test("rejects another source or unsupported dimensions before downloading the model", async () => {
  for (const [request, shape] of [[{ ...identity, sourceSha256: "d".repeat(64) }, dimensions],
    [identity, { numBetas: 301, numExpression: 10 }]] as const) {
    fetcher.mockClear();
    await expect(loadPlaybackModel(request, shape, new AbortController().signal)).rejects.toThrow("不匹配");
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test("rejects modified model bytes and remote paths in the owned model catalog", async () => {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(catalog)))
    .mockResolvedValueOnce(new Response(bytes("corrupt model")));
  await expect(loadPlaybackModel(identity, dimensions, new AbortController().signal)).rejects.toThrow("内置模型");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...catalog, file: "https://untrusted.invalid/model.npz" })));
  await expect(loadPlaybackModel(identity, dimensions, new AbortController().signal)).rejects.toThrow("清单无效");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("reports unavailable assets and preserves cancellation", async () => {
  fetcher.mockResolvedValueOnce(new Response("not found", { status: 404 }));
  await expect(loadPlaybackModel(identity, dimensions, new AbortController().signal)).rejects.toThrow("加载失败");
  fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(loadPlaybackModel(identity, dimensions, new AbortController().signal)).rejects.toThrow("检查网络后重试");
  const controller = new AbortController();
  fetcher.mockImplementationOnce(async () => {
    controller.abort();
    return new Response(JSON.stringify(catalog));
  });
  await expect(loadPlaybackModel(identity, dimensions, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
