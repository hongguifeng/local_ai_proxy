import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  const smokeDirectory = path.join(releaseDirectory, "smoke");
  await mkdir(smokeDirectory, { recursive: true });
  const startupErrorFile = path.join(smokeDirectory, `startup-error-${port}.txt`);
  const exitFile = path.join(smokeDirectory, `exit-${port}.signal`);
  const child = spawn(
    executable,
    ["--port", String(port), "--config-file", "smoke/proxies.json", "--log-root", "smoke/logs"],
    {
      cwd: releaseDirectory,
      env: {
        ...process.env,
        LLM_PROXY_SMOKE_EXIT_FILE: exitFile,
        LLM_PROXY_STARTUP_ERROR_FILE: startupErrorFile,
        LLM_PROXY_DATA_DIR: path.join(smokeDirectory, `user-data-${port}`),
      },
      stdio: "ignore",
    },
  );
  try {
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    await waitForHealth(healthUrl, startupErrorFile);
    await writeFile(exitFile, "exit\n", "utf8");
    await waitForShutdown(healthUrl);
  } finally {
    child.kill();
  }
}

async function waitForShutdown(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Packaged application did not release its admin port: ${url}`);
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

async function waitForHealth(url: string, startupErrorFile: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const startupError = await readFile(startupErrorFile, "utf8").catch((error: unknown) => {
      if (isMissingFile(error)) return undefined;
      throw error;
    });
    if (startupError !== undefined) {
      throw new Error(`Packaged application startup failed: ${startupError.trim()}`);
    }
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

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeWindowsArtifact();
}
