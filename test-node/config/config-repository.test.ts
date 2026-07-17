import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigLoadError,
  ConfigRepository,
  type ConfigFileSystem,
} from "../../src/config/config-repository.js";
import { createDefaultProxyPair } from "../../src/config/defaults.js";

const temporaryDirectories: string[] = [];
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ConfigRepository.load", () => {
  it("returns one default pair when the config file does not exist", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-"));
    temporaryDirectories.push(directory);
    const repository = new ConfigRepository(path.join(directory, "missing.json"), "custom-logs");

    await expect(repository.load()).resolves.toEqual({
      pairs: [createDefaultProxyPair("custom-logs")],
    });
  });

  it("reports invalid JSON separately from an invalid schema", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "proxies.json");
    const repository = new ConfigRepository(configPath);

    await writeFile(configPath, "{invalid", "utf8");
    await expect(repository.load()).rejects.toMatchObject({
      kind: "invalid_json",
      issues: undefined,
    });

    await writeFile(configPath, JSON.stringify({ pairs: "not-an-array" }), "utf8");
    await expect(repository.load()).rejects.toMatchObject({
      kind: "invalid_schema",
    });

    await writeFile(
      configPath,
      JSON.stringify({
        pairs: [
          {
            id: "invalid-target",
            targets: [{ id: "target-1", target_url: "ftp://invalid.example" }],
          },
        ],
      }),
      "utf8",
    );
    try {
      await repository.load();
      expect.unreachable("invalid target schema should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigLoadError);
      const loadError = error as ConfigLoadError;
      expect(loadError.kind).toBe("invalid_schema");
      expect(loadError.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "pairs.0.targets.0.target_url" })]),
      );
    }
  });
});

describe("ConfigRepository.save", () => {
  it("writes through a sibling temporary file and replaces the destination", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "nested", "proxies.json");
    const repository = new ConfigRepository(configPath, "logs", { createId: () => "fixture-id" });
    const config = { pairs: [createDefaultProxyPair()] };

    await repository.save(config);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
    expect(await repository.load()).toEqual(config);
    expect(await readdir(path.dirname(configPath))).toEqual(["proxies.json"]);
  });

  it("flushes and fsyncs the temporary file before rename", async () => {
    const calls: string[] = [];
    const handle = {
      writeFile: () => {
        calls.push("write");
        return Promise.resolve();
      },
      sync: () => {
        calls.push("sync");
        return Promise.resolve();
      },
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
    };
    const fileSystem = {
      mkdir: () => Promise.resolve(undefined),
      open: () => Promise.resolve(handle),
      readFile: () => Promise.resolve(""),
      rename: () => {
        calls.push("rename");
        return Promise.resolve();
      },
      unlink: () => Promise.resolve(undefined),
    } as unknown as ConfigFileSystem;
    const repository = new ConfigRepository("/fixture/proxies.json", "logs", {
      createId: () => "fixture-id",
      fileSystem,
    });

    await repository.save({ pairs: [createDefaultProxyPair()] });

    expect(calls).toEqual(["write", "sync", "close", "rename"]);
  });

  it("preserves the existing file and removes the temp file after a failed save", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "proxies.json");
    await writeFile(configPath, "old configuration", "utf8");
    const fileSystem = {
      mkdir,
      open,
      readFile,
      rename: () => Promise.reject(new Error("fixture rename failure")),
      unlink,
    } as ConfigFileSystem;
    const repository = new ConfigRepository(configPath, "logs", {
      createId: () => "fixture-id",
      fileSystem,
    });

    await expect(repository.save({ pairs: [createDefaultProxyPair()] })).rejects.toThrow(
      "fixture rename failure",
    );

    expect(await readFile(configPath, "utf8")).toBe("old configuration");
    expect(await readdir(directory)).toEqual(["proxies.json"]);
  });

  it("round-trips a Python config through Node and back to Python", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-roundtrip-"));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(
      projectRoot,
      "fixtures",
      "parity",
      "config",
      "proxies-comprehensive.json",
    );
    const configPath = path.join(directory, "proxies.json");
    const sourceRepository = new ConfigRepository(sourcePath);
    const destinationRepository = new ConfigRepository(configPath);
    const normalizedConfig = await sourceRepository.load();

    await destinationRepository.save(normalizedConfig);

    const result = spawnSync(
      findPython(),
      [path.join(projectRoot, "scripts", "check_config_roundtrip.py"), configPath],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PYTHONPATH: [projectRoot, process.env["PYTHONPATH"]].filter(Boolean).join(path.delimiter),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(normalizedConfig);
  });

  it.runIf(process.platform === "win32")(
    "replaces an existing config file on Windows",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-windows-"));
      temporaryDirectories.push(directory);
      const configPath = path.join(directory, "proxies.json");
      const repository = new ConfigRepository(configPath, "logs", {
        createId: () => "windows-fixture-id",
      });
      const first = { pairs: [createDefaultProxyPair()] };
      const second = {
        pairs: [{ ...createDefaultProxyPair(), id: "replacement", name: "Replacement" }],
      };

      await repository.save(first);
      await repository.save(second);

      expect(await repository.load()).toEqual(second);
      expect(await readdir(directory)).toEqual(["proxies.json"]);
    },
  );
});

function findPython(): string {
  const candidates = [process.env["PYTHON"], "python3", "python"].filter(
    (candidate): candidate is string => candidate !== undefined && candidate !== "",
  );
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) {
      return candidate;
    }
  }
  throw new Error("Python 3 is required for the configuration round-trip test.");
}
