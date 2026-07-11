import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const version = releaseVersion(process.env.LLM_PROXY_RELEASE_VERSION ?? "0.3.0-dev");
const manifests = [resolve("packages/contracts/package.json"), resolve("apps/server/package.json")];
const originals = await Promise.all(manifests.map(async (path) => readFile(path, "utf8")));
const release = resolve("release/npm");
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });
try {
  for (const [index, path] of manifests.entries()) {
    const original = originals[index];
    if (!original) throw new Error("Package manifest is missing");
    const manifest = JSON.parse(original);
    manifest.version = version;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await exec(pnpm, ["--filter", "@llm-proxy/contracts", "pack", "--pack-destination", release], {
    shell: process.platform === "win32",
  });
  await exec(pnpm, ["--filter", "@llm-proxy/server", "pack", "--pack-destination", release], {
    shell: process.platform === "win32",
  });
} finally {
  await Promise.all(manifests.map(async (path, index) => writeFile(path, originals[index])));
}

function releaseVersion(value) {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(normalized))
    throw new Error("Invalid release version");
  return normalized;
}
