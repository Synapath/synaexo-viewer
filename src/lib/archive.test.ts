import { afterEach, expect, test } from "vitest";
import { BlobWriter, TextReader, ZipWriter, configure } from "@zip.js/zip.js";
import { openArchive } from "./archive";

configure({ useWebWorkers: false });
const controller = () => new AbortController();
const opened: { close: () => void }[] = [];
afterEach(() => {
  opened.splice(0).forEach((value) => value.close());
});
async function zip(entries: [string, string][], level = 6) {
  const writer = new ZipWriter(new BlobWriter());
  for (const [name, value] of entries)
    await writer.add(name, new TextReader(value), { level });
  return new File([await writer.close()], "recording.zip", {
    type: "application/zip",
  });
}

test("reads nested manifests from a deflated local ZIP and releases its entry references", async () => {
  const archive = await openArchive(
    await zip([
      ["recording/manifest.json", '{"recording_id":"example"}'],
      ["recording/results/body.npz", "parameters"],
    ]),
    controller().signal,
    () => {},
  );
  opened.push(archive);
  expect(archive.assets.map((value) => value.kind)).toEqual([
    "json",
    "parameters",
  ]);
  expect(
    await archive.json("manifest.json", controller().signal),
  ).toEqual({ recording_id: "example" });
  archive.close();
  await expect(
    archive.json("manifest.json", controller().signal),
  ).rejects.toThrow("文件不在当前 ZIP 中");
});

test("rejects unsafe paths and aborted imports without expanding their entries", async () => {
  await expect(
    openArchive(
      await zip([["../outside.json", "{}"]]),
      controller().signal,
      () => {},
    ),
  ).rejects.toThrow(/不安全|Unsafe filename/);
  const aborted = controller();
  aborted.abort();
  await expect(
    openArchive(await zip([["manifest.json", "{}"]]), aborted.signal, () => {}),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("corrupt entry bytes fail checksum verification instead of displaying altered JSON", async () => {
  const source = await zip([["manifest.json", '{"proof":"UNIQUE-MARKER"}']], 0);
  const bytes = new Uint8Array(await source.arrayBuffer()),
    marker = new TextEncoder().encode("UNIQUE-MARKER");
  const at = bytes.findIndex((_, offset) =>
    marker.every((value, index) => bytes[offset + index] === value),
  );
  expect(at).toBeGreaterThan(0);
  bytes[at] = "X".charCodeAt(0);
  const archive = await openArchive(
    new File([bytes], "corrupt.zip"),
    controller().signal,
    () => {},
  );
  opened.push(archive);
  await expect(
    archive.json("manifest.json", controller().signal),
  ).rejects.toThrow();
});

async function zipPaths(paths: string[]) {
  return zip(paths.map(path => [path, path]));
}

test.each(["", "录制 11/", "导出/录制 11/"])("reads bundled models and videos below a common recording root: %s", async prefix => {
  const paths = ["models/smplx.npz", "motions/subject_01/smplx_parameters.npz", "videos/exo01.mp4"];
  const archive = await openArchive(await zipPaths(paths.map(path => prefix + path)), new AbortController().signal, () => {});
  expect(archive.assets.map(a => a.path).sort()).toEqual(paths.sort());
  expect(await (await archive.blob("models/smplx.npz", new AbortController().signal)).text())
    .toBe(prefix + "models/smplx.npz");
  archive.close();
});

test("normalizes legacy recording roots and ignores macOS metadata at either level", async () => {
  const archive = await openArchive(await zipPaths([".DS_Store", "包/.DS_Store", "包/__MACOSX/._manifest.json",
    "包/manifest.json", "包/models/smplx.npz", "包/previews/exo01.mp4"]), new AbortController().signal, () => {});
  expect(archive.assets.map(a => a.path).sort()).toEqual(["manifest.json", "models/smplx.npz", "previews/exo01.mp4"]);
  archive.close();
});

test("does not merge two recordings or strip the motions folder of an incomplete ZIP", async () => {
  for (const paths of [["A/motions/subject_01/smplx_parameters.npz", "B/models/smplx.npz"],
    ["motions/subject_01/smplx_parameters.npz"]]) {
    const archive = await openArchive(await zipPaths(paths), new AbortController().signal, () => {});
    expect(archive.assets.map(a => a.path).sort()).toEqual(paths.sort());
    archive.close();
  }
});
