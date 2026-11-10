import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

type Snapshot = { generations: string[][]; files: Map<string, Buffer> };
const historyName = "asset-history.json";
const assetName = /^[\w.-]+$/;

export function snapshotAssets(outDir: string): Snapshot {
  const directory = resolve(outDir, "assets");
  const files = new Map(existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name)
      .filter(name => assetName.test(name))
      .map(name => [name, readFileSync(resolve(directory, name))] as const) : []);
  const path = resolve(outDir, historyName);
  const generations: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [Array.from(files.keys()).sort()];
  if (!Array.isArray(generations) || !generations.every(group => Array.isArray(group)
    && group.every(name => typeof name === "string" && assetName.test(name) && files.has(name))))
    throw new Error("构建资源历史无效，请检查 docs/asset-history.json");
  return { generations, files };
}

export function restoreAssets(outDir: string, previous: Snapshot) {
  const directory = resolve(outDir, "assets");
  mkdirSync(directory, { recursive: true });
  const current = readdirSync(directory).filter(name => assetName.test(name)).sort();
  const identity = JSON.stringify(current);
  // Keep two previous builds so cached pages can finish loading after publication.
  const generations = [current, ...previous.generations.filter(group => JSON.stringify(group) !== identity)].slice(0, 3);
  for (const name of new Set(generations.flat())) {
    const path = resolve(directory, name);
    if (!existsSync(path)) writeFileSync(path, previous.files.get(name)!);
  }
  writeFileSync(resolve(outDir, historyName), JSON.stringify(generations, null, 2) + "\n");
}

export function retainAssets(): Plugin {
  let outDir: string, previous: Snapshot;
  return {
    name: "retain-published-assets",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      previous = snapshotAssets(outDir);
    },
    writeBundle() {
      restoreAssets(outDir, previous);
      previous = snapshotAssets(outDir);
    },
  };
}
