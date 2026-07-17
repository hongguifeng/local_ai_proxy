import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigLoadError, ConfigRepository } from "../../src/config/config-repository.js";
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
