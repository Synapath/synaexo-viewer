import { expect, test } from "vitest";
import type { RecordingArchive } from "../lib/archive";
import { prepareRecording } from "./package";

test("a ZIP without its model fails with a repackaging instruction", async () => {
  const archive = {
    assets: [{ path: "motions/subject_01/smplx_parameters.npz", bytes: 1 }],
  } as RecordingArchive;
  await expect(
    prepareRecording(archive, new AbortController().signal, () => {}),
  ).rejects.toThrow("缺少 models/smplx.npz，请重新打包");
});
