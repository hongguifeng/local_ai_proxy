import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function findPortableArtifact(releaseDirectory: string): Promise<string> {
  const names = await readdir(releaseDirectory);
  const name = names.find((candidate) => /portable.*\.exe$/iu.test(candidate));
  if (name === undefined) throw new Error(`Portable artifact not found in ${releaseDirectory}.`);
  return path.join(releaseDirectory, name);
}

export async function smokeWindowsArtifact(
  releaseDirectory = path.resolve("release"),
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Windows artifact smoke test must run on Windows.");
  }
  const executable = await findPortableArtifact(releaseDirectory);
  const port = await availablePort();
  const child = spawn(
    executable,
    ["--port", String(port), "--config-file", "smoke/proxies.json", "--log-root", "smoke/logs"],
    { cwd: releaseDirectory, stdio: "ignore" },
  );
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  } finally {
    child.kill();
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The packaged process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Packaged application did not become healthy: ${url}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeWindowsArtifact();
}
