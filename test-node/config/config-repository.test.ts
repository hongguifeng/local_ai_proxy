import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigLoadError,
  ConfigRepository,
  type ConfigFileSystem,
} from "../../src/config/config-repository.js";
import { createDefaultProxyPair } from "../../src/config/defaults.js";

const temporaryDirectories: string[] = [];

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
});
