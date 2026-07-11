import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const expectedVersion = (process.env.LLM_PROXY_RELEASE_VERSION ?? "0.3.0-dev").replace(/^v/u, "");
const release = resolve("release/npm");
const archives = (await readdir(release)).filter((name) => name.endsWith(".tgz"));
const contracts = archives.find((name) => name.includes("contracts"));
const server = archives.find((name) => name.includes("server"));
if (!contracts || !server) throw new Error("Missing npm tarballs");
const root = await mkdtemp(join(tmpdir(), "llm proxy 安装测试 "));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const shell = process.platform === "win32";
  await writeFile(join(root, "package.json"), '{"name":"llm-proxy-install-smoke","private":true}\n', "utf8");
  await exec(npm, ["install", join(release, contracts), join(release, server)], { cwd: root, timeout: 120_000, shell });
  const cli = join(root, "node_modules", "@llm-proxy", "server", "dist", "cli.js");
  const help = await exec(process.execPath, [cli, "--help"], { cwd: root });
  const version = await exec(process.execPath, [cli, "--version"], { cwd: root });
  if (!help.stdout.includes("Usage: llm-proxy") || version.stdout.trim() !== expectedVersion)
    throw new Error("CLI smoke failed");
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      cli,
      "--port",
      String(port),
      "--no-browser",
      "--config-file",
      "数据 目录/config.json",
      "--log-root",
      "数据 目录/logs",
    ],
    { cwd: root, stdio: "pipe" },
  );
  try {
    const health = await waitForHealth(port);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    if (health.status !== "ok" || !html.includes("LLM Proxy")) throw new Error("Installed runtime smoke failed");
  } finally {
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    child.kill("SIGTERM");
    await exited;
  }
  console.log(
    JSON.stringify({ installed: true, help: true, version: version.stdout.trim(), health: true, staticAssets: true }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}
async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return response.json();
    } catch {
      // Retry until the installed server finishes startup.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Health did not become ready");
}
