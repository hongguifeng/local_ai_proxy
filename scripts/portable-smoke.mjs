import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const output = resolve("release/portable");
const zipName = (await readdir(output)).find((name) => name.endsWith(".zip"));
if (!zipName) throw new Error("Missing portable ZIP");
const zip = join(output, zipName);
const expected = (await readFile(`${zip}.sha256`, "utf8")).split(" ", 1)[0];
const actual = createHash("sha256")
  .update(await readFile(zip))
  .digest("hex");
if (actual !== expected) throw new Error("Checksum mismatch");
const root = await mkdtemp(join(tmpdir(), "便携 包 smoke "));
const upstream = createServer((incoming, response) => {
  incoming.resume();
  incoming.once("end", () => response.end('{"portable":true}'));
});
await listen(upstream);
const upstreamPort = upstream.address().port;
try {
  await exec("tar.exe", ["-x", "-f", zip, "-C", root]);
  const portable = join(root, "llm-proxy-portable");
  const proxyPort = await freePort();
  const adminPort = await freePort();
  await writeFile(
    join(portable, "data", "config.json"),
    JSON.stringify({
      version: 1,
      proxies: [
        {
          id: "portable",
          name: "Portable",
          enabled: true,
          listenHost: "127.0.0.1",
          listenPort: proxyPort,
          accessLog: false,
          defaultTargetId: "target",
          targets: [{ id: "target", name: "Target", url: `http://127.0.0.1:${upstreamPort}` }],
        },
      ],
    }),
  );
  const launcher = await readFile(join(portable, "start.cmd"), "utf8");
  if (!launcher.includes("%~dp0") || !launcher.includes("runtime\\node.exe"))
    throw new Error("Portable launcher is not location-independent");
  const tray = await readFile(join(portable, "tray.ps1"), "utf8");
  if (!tray.includes("NotifyIcon") || !tray.includes("Open Admin UI") || !tray.includes("/api/v1/health"))
    throw new Error("Tray shell is incomplete");
  for (const forbidden of ["ProxyServer", "better-sqlite3", "routeAndTransformRequest"])
    if (tray.includes(forbidden)) throw new Error("Tray shell contains server business logic");
  const bundledNode = join(portable, "runtime", "node.exe");
  const cli = join(portable, "app", "node_modules", "@llm-proxy", "server", "dist", "cli.js");
  const child = spawn(
    bundledNode,
    [
      cli,
      "--config-file",
      join(portable, "data", "config.json"),
      "--log-root",
      join(portable, "data", "logs"),
      "--port",
      String(adminPort),
      "--no-browser",
    ],
    { cwd: tmpdir(), stdio: "pipe" },
  );
  try {
    await waitForHealth(adminPort);
    const body = await proxyRequest(proxyPort);
    if (body !== '{"portable":true}') throw new Error("Proxy smoke mismatch");
  } finally {
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    child.kill("SIGTERM");
    setTimeout(() => child.kill(), 2_000).unref();
    await exited;
  }
  console.log(JSON.stringify({ checksum: true, bundledNode: true, health: true, proxy: true, unicodePath: true }));
} finally {
  await close(upstream);
  await rm(root, { recursive: true, force: true });
}
function listen(server) {
  return new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
}
function close(server) {
  return new Promise((resolvePromise) => server.close(resolvePromise));
}
async function freePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}
async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {
      /* startup retry */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Portable health timeout");
}
function proxyRequest(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = request({ host: "127.0.0.1", port, path: "/v1/responses" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    });
    outgoing.once("error", rejectPromise);
    outgoing.end();
  });
}
