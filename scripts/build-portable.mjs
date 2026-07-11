import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
if (process.platform !== "win32" || process.version !== "v24.18.0")
  throw new Error("Portable build requires Windows Node v24.18.0");
const release = resolve("release");
const npmRelease = join(release, "npm");
const output = join(release, "portable");
const stage = join(output, "llm-proxy-portable");
await rm(output, { recursive: true, force: true });
await mkdir(join(stage, "runtime"), { recursive: true });
await mkdir(join(stage, "app"), { recursive: true });
await mkdir(join(stage, "data"), { recursive: true });
await copyFile(process.execPath, join(stage, "runtime", "node.exe"));
await writeFile(join(stage, "app", "package.json"), '{"name":"llm-proxy-portable","private":true}\n');
const archives = (await readdir(npmRelease))
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => join(npmRelease, name));
if (archives.length !== 2) throw new Error("Expected contracts and server tarballs");
const npm = "npm.cmd";
await exec(npm, ["install", "--omit=dev", ...archives], { cwd: join(stage, "app"), timeout: 120_000, shell: true });
await cp(resolve("LICENSE"), join(stage, "LICENSE"));
await cp(resolve("SECURITY.md"), join(stage, "SECURITY.md"));
await writeFile(
  join(stage, "start.cmd"),
  '@echo off\r\nset "ROOT=%~dp0"\r\n"%ROOT%runtime\\node.exe" "%ROOT%app\\node_modules\\@llm-proxy\\server\\dist\\cli.js" --config-file "%ROOT%data\\config.json" --log-root "%ROOT%data\\logs" %*\r\n',
);
const zip = join(output, `llm-proxy-windows-x64-node-${process.version.slice(1)}.zip`);
await exec("tar.exe", ["-a", "-c", "-f", zip, "llm-proxy-portable"], { cwd: output });
const digest = createHash("sha256")
  .update(await import("node:fs/promises").then(({ readFile }) => readFile(zip)))
  .digest("hex");
await writeFile(`${zip}.sha256`, `${digest}  ${zip.split(/[\\/]/u).at(-1)}\n`);
console.log(JSON.stringify({ zip, sha256: digest, node: process.version, nativeAddon: "better-sqlite3" }));
