import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigRepository } from "../../src/config/config-repository.js";
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
});
