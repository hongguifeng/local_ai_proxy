import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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
      copyFile: () => Promise.reject(missingFileError()),
      mkdir: () => Promise.resolve(undefined),
      open: () => Promise.resolve(handle),
      readFile: () => Promise.resolve(""),
      readdir: () => Promise.resolve([]),
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
      copyFile,
      mkdir,
      open,
      readFile,
      readdir,
      rename: () => Promise.reject(new Error("fixture rename failure")),
      unlink,
    } as ConfigFileSystem;
    const repository = new ConfigRepository(configPath, "logs", {
      createId: () => "fixture-id",
      fileSystem,
      now: () => new Date("2026-07-18T01:02:03.456Z"),
    });

    await expect(repository.save({ pairs: [createDefaultProxyPair()] })).rejects.toThrow(
      "fixture rename failure",
    );

    expect(await readFile(configPath, "utf8")).toBe("old configuration");
    expect((await readdir(directory)).sort()).toEqual([
      "proxies.json",
      "proxies.json.before-node-2026-07-18T01-02-03.456Z.bak",
    ]);
  });

  it("creates one timestamped backup before replacing a pre-Node config", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-backup-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "proxies.json");
    const oldText = '{"pairs":[]}\n';
    await writeFile(configPath, oldText, "utf8");
    const repository = new ConfigRepository(configPath, "logs", {
      now: () => new Date("2026-07-18T01:02:03.456Z"),
    });
    const first = { pairs: [createDefaultProxyPair()] };
    const second = {
      pairs: [{ ...createDefaultProxyPair(), id: "replacement", name: "Replacement" }],
    };

    await repository.save(first);
    await repository.save(second);
    await new ConfigRepository(configPath).save(first);

    const backupName = "proxies.json.before-node-2026-07-18T01-02-03.456Z.bak";
    expect(await readFile(path.join(directory, backupName), "utf8")).toBe(oldText);
    expect((await readdir(directory)).sort()).toEqual(["proxies.json", backupName].sort());
    expect(await repository.load()).toEqual(first);
  });

  it("rehearses backup, save, and rollback with the comprehensive config fixture", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-config-rehearsal-"));
    temporaryDirectories.push(directory);
    const fixturePath = path.join(
      projectRoot,
      "fixtures",
      "parity",
      "config",
      "proxies-comprehensive.json",
    );
    const configPath = path.join(directory, "proxies.json");
    await copyFile(fixturePath, configPath);
    const repository = new ConfigRepository(configPath, "rehearsal-logs", {
      now: () => new Date("2026-07-18T06:00:00.000Z"),
    });
    const original = await repository.load();
    const changed = {
      pairs: original.pairs.map((pair, index) =>
        index === 0 ? { ...pair, name: `${pair.name} rehearsal` } : pair,
      ),
    };

    await repository.save(changed);
    expect(await repository.load()).toEqual(changed);
    const backupPath = path.join(
      directory,
      "proxies.json.before-node-2026-07-18T06-00-00.000Z.bak",
    );
    await copyFile(backupPath, configPath);
    expect(await new ConfigRepository(configPath, "rehearsal-logs").load()).toEqual(original);
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

function missingFileError(): NodeJS.ErrnoException {
  return Object.assign(new Error("fixture file does not exist"), { code: "ENOENT" });
}
