import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packages = [
  "react",
  "react-dom",
  "scheduler",
  "@zip.js/zip.js",
  "lucide-react",
  "three",
  "@noble/hashes",
];
const notices = packages.map((name) => {
  let directory = dirname(require.resolve(name));
  while (
    !existsSync(join(directory, "package.json")) ||
    JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name !==
      name
  ) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`License directory missing: ${name}`);
    directory = parent;
  }
  return `${name}\n${readFileSync(join(directory, "LICENSE"), "utf8").trim()}`;
});
notices.push(
  "SMPL-X forward adaptation\n" +
    readFileSync(
      new URL("../licenses/smplx-viewer-MIT.txt", import.meta.url),
      "utf8",
    ).trim(),
);
writeFileSync(
  new URL("../public/third-party-licenses.txt", import.meta.url),
  notices.join("\n\n---\n\n") + "\n",
);
