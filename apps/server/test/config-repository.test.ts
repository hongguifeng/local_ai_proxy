import { access, chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { atomicWriteText } from "../src/config/atomic-write.js";
import { ConfigFileError, ConfigRepository, type AtomicConfigWriter } from "../src/config/repository.js";

const temporaryDirectories: string[] = [];

async function temporaryPath(name = "proxies.json"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "llm-proxy-config-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfigRepository load", () => {
  it("returns schema defaults when the file does not exist", async () => {
    const repository = new ConfigRepository(await temporaryPath());
    await expect(repository.load()).resolves.toMatchObject({
      version: 1,
      proxies: [],
      capture: { requestBytes: 8 * 1024 * 1024, responseBytes: 8 * 1024 * 1024 },
      retention: { days: 30 },
    });
  });

  it("rejects malformed JSON, invalid config, and oversized files", async () => {
    const configPath = await temporaryPath();
    await writeFile(configPath, "{not-json", "utf8");
    await expect(new ConfigRepository(configPath).load()).rejects.toMatchObject({ code: "INVALID_JSON" });

    await writeFile(configPath, JSON.stringify({ version: 2 }), "utf8");
    await expect(new ConfigRepository(configPath).load()).rejects.toMatchObject({ name: "ConfigValidationError" });

    await writeFile(configPath, "x".repeat(33), "utf8");
    await expect(new ConfigRepository(configPath, { maxFileBytes: 32 }).load()).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("maps file-system read failures to a diagnostic error", async () => {
    if (process.platform === "win32") {
      return;
    }
    const configPath = await temporaryPath();
    await writeFile(configPath, "{}", "utf8");
    await chmod(configPath, 0o000);
    try {
      await expect(new ConfigRepository(configPath).load()).rejects.toMatchObject({ code: "READ_FAILED" });
    } finally {
      await chmod(configPath, 0o600);
    }
  });
});

describe("atomic configuration writes", () => {
  it("writes valid JSON with restrictive Unix permissions", async () => {
    const configPath = await temporaryPath();
    const repository = new ConfigRepository(configPath);
    await repository.save({ version: 1, proxies: [] });
    await expect(repository.load()).resolves.toMatchObject({ version: 1, proxies: [] });
    expect((await readFile(configPath, "utf8")).endsWith("\n")).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves the original and removes temporary files when rename fails", async () => {
    const configPath = await temporaryPath();
    const original = '{"version":1,"proxies":[]}\n';
    await writeFile(configPath, original, "utf8");
    await expect(
      atomicWriteText(configPath, '{"version":1,"proxies":[1]}\n', {
        rename: vi.fn(() => Promise.reject(Object.assign(new Error("occupied"), { code: "EPERM" }))),
      }),
    ).rejects.toMatchObject({ code: "EPERM", targetPath: configPath });
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect((await readdir(join(configPath, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent saves and continues after a failed save", async () => {
    const configPath = await temporaryPath();
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const writer: AtomicConfigWriter = vi.fn(async (path: string, contents: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (calls === 1) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      await writeFile(path, contents, "utf8");
    });
    const repository = new ConfigRepository(configPath, { atomicWriter: writer });
    const first = repository.save({ version: 1, proxies: [] });
    const second = repository.save({ version: 1, proxies: [], retention: { days: 7 } });
    const firstError: unknown = await first.catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(ConfigFileError);
    if (!(firstError instanceof ConfigFileError)) {
      throw new Error("Expected ConfigFileError");
    }
    expect(firstError.code).toBe("WRITE_FAILED");
    expect(firstError.message).toContain("ENOSPC");
    await expect(second).resolves.toBeUndefined();
    expect(maximumActive).toBe(1);
    await expect(repository.load()).resolves.toMatchObject({ retention: { days: 7 } });
  });

  it("rejects invalid input asynchronously without replacing the file", async () => {
    const configPath = await temporaryPath();
    const original = '{"version":1,"proxies":[]}\n';
    await writeFile(configPath, original, "utf8");
    const repository = new ConfigRepository(configPath);
    await expect(repository.save({ version: 2 })).rejects.toMatchObject({ name: "ConfigValidationError" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("creates a missing parent directory", async () => {
    const configPath = await temporaryPath(join("nested", "proxies.json"));
    await new ConfigRepository(configPath).save({ version: 1 });
    await expect(access(configPath)).resolves.toBeUndefined();
  });
});
