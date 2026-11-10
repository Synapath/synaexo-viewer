import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { restoreAssets, snapshotAssets } from "./retainAssets";

test("keeps cached pages' JS, CSS and workers for two builds and expires older generations", () => {
  const root = mkdtempSync(join(tmpdir(), "viewer-assets-"));
  const assets = join(root, "assets");
  const build = (names: string[]) => {
    const previous = snapshotAssets(root);
    rmSync(assets, { force: true, recursive: true });
    mkdirSync(assets);
    for (const name of names) writeFileSync(join(assets, name), name);
    restoreAssets(root, previous);
  };
  try {
    build(["entry-A.js", "Player-A.js", "Player-A.css", "forward-A.js"]);
    build(["entry-B.js", "Player-B.js", "Player-A.css", "forward-A.js"]);
    build(["entry-C.js"]);
    expect(readFileSync(join(assets, "Player-A.js"), "utf8")).toBe("Player-A.js");
    const history = readFileSync(join(root, "asset-history.json"), "utf8");
    build(["entry-C.js"]);
    expect(readFileSync(join(root, "asset-history.json"), "utf8")).toBe(history);
    build(["entry-D.js"]);
    expect(readdirSync(assets).sort()).toEqual(["Player-A.css", "Player-B.js", "entry-B.js", "entry-C.js", "entry-D.js", "forward-A.js"]);
    expect(() => readFileSync(join(assets, "Player-A.js"))).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
