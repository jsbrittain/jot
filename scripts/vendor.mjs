import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "ui", "vendor");

const markedPackage = require.resolve("marked/package.json");
const markedDir = path.dirname(markedPackage);
const markedUmd = path.join(markedDir, "lib", "marked.umd.js");

const purifyMin = require.resolve("dompurify/purify.min.js");
const purifyDir = path.resolve(path.dirname(purifyMin), "..");

await mkdir(out, { recursive: true });
await copyFile(markedUmd, path.join(out, "marked.js"));
await copyFile(purifyMin, path.join(out, "purify.min.js"));

for (const [source, name] of [
  [path.join(markedDir, "LICENSE"), "LICENSE-marked.txt"],
  [path.join(purifyDir, "LICENSE"), "LICENSE-dompurify.txt"],
]) {
  if (existsSync(source)) {
    await copyFile(source, path.join(out, name));
  }
}

console.log("vendored marked and dompurify into ui/vendor");
