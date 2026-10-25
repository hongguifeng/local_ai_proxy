import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("src/admin/static");
const destination = path.resolve("dist-node/src/admin/static");
const bundleDirectory = path.resolve("dist-node/src/admin/static-bundle");
const compiledScriptsDirectory = path.resolve("dist-node/scripts");
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true, force: true });

// The built app serves whatever is in this directory, so an asset the source no
// longer has would keep being shipped (e.g. a pre-split single app.js).
const wanted = new Set(await readdir(source));
for (const name of await readdir(destination)) {
  if (wanted.has(name)) continue;
  await rm(path.join(destination, name), { recursive: true, force: true });
  console.log(`removed stale admin asset: ${name}`);
}

// Incremental TypeScript builds do not delete outputs for source files that were
// removed. Clean the retired bridge and concatenator outputs before packaging so a
// previous AI-17 build cannot survive beside the current bundle.
const staleGeneratedFiles = [
  path.join(bundleDirectory, "modules-bridge.js"),
  ...(await readdir(compiledScriptsDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.name.startsWith("concat_ui_parts."))
    .map((entry) => path.join(compiledScriptsDirectory, entry.name)),
];
for (const file of staleGeneratedFiles) {
  await rm(file, { force: true });
  console.log(`removed stale generated UI output: ${file}`);
}
