import { afterEach, expect, test, vi } from "vitest";
import type { RecordingArchive } from "../lib/archive";
import { prepareRecording } from "./package";
import { sha256Hex } from "./modelAssets";

const parsed = vi.hoisted(() => ({
  contract: { frames: 2, numBetas: 1, numExpression: 1, flatHandMean: true,
    worldFrame: "synthetic", referenceOrigin: "0", times: [0, 33333333] },
  cameras: [{ camera_id: "cam", view_id: "EXO01", kind: "gopro", image_size: [64, 64],
    video_pts_ns: [0, 33333333], source_observed: [true, true], path: "videos/exo01.mp4", bytes: 5, sha256: "" }],
  body: [true, true], modelHash: "", sourceModelHash: "c".repeat(64), modelBytes: 0,
}));
vi.mock("../smplx/npy", () => ({ parseNpz: vi.fn(async () => ({})) }));
vi.mock("./preview", () => ({ readPreview: vi.fn(() => parsed) }));
vi.mock("./engine", () => ({ ForwardEngine: class {
  init = vi.fn(async () => ({ faces: new Uint32Array([0, 1, 2]), observed: [] }));
  dispose = vi.fn();
} }));
afterEach(() => vi.unstubAllGlobals());

test.each(["videos", "previews"])("opens a model-free %s ZIP through the built-in model and releases the recording", async folder => {
  const model = new TextEncoder().encode("builtin").buffer;
  const video = new TextEncoder().encode("video").buffer;
  parsed.modelHash = "a".repeat(64); parsed.modelBytes = 123;
  parsed.cameras[0].path = `${folder}/exo01.mp4`; parsed.cameras[0].sha256 = sha256Hex(video);
  const catalog = { format: "synaexo-default-model", schema_version: 1,
    file: `smplx-${sha256Hex(model)}.npz`, sha256: sha256Hex(model), source_sha256: parsed.sourceModelHash,
    bytes: model.byteLength, num_betas: 300, num_expression: 100 };
  vi.stubGlobal("document", { baseURI: "https://example.invalid/synaexo-viewer/" });
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => url.pathname.endsWith("default.json")
    ? new Response(JSON.stringify(catalog)) : new Response(model)));
  const archive = {
    assets: [{ path: "motions/subject_01/smplx_parameters.npz", bytes: 1 },
      { path: parsed.cameras[0].path, bytes: video.byteLength }],
    blob: vi.fn(async (path: string) => new Blob([path.endsWith(".mp4") ? video : new ArrayBuffer(1)])),
    close: vi.fn(),
  } as unknown as RecordingArchive;
  const recording = await prepareRecording(archive, new AbortController().signal, () => {});
  expect(recording.engine.init).toHaveBeenCalledWith(model, expect.any(ArrayBuffer), [], parsed.contract);
  expect(archive.blob).not.toHaveBeenCalledWith("models/smplx.npz", expect.anything());
  expect(recording.cameras[0].view_id).toBe("EXO01");
  recording.dispose();
  expect(recording.engine.dispose).toHaveBeenCalledOnce();
  expect(archive.close).toHaveBeenCalledOnce();
});
