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
    await archive.json("recording/manifest.json", controller().signal),
  ).toEqual({ recording_id: "example" });
  archive.close();
  await expect(
    archive.json("recording/manifest.json", controller().signal),
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
