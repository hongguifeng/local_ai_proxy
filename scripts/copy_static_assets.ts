import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("src/admin/static");
const destination = path.resolve("dist-node/src/admin/static");
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
