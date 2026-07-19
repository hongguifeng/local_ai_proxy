import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseTrayOptions } from "../../electron/tray-options.js";

describe("parseTrayOptions", () => {
  it("supports --open-on-start without passing it to the CLI parser", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-tray-options-"));
    try {
      const result = await parseTrayOptions(["--open-on-start", "--port", "9090"], {}, directory);
      expect(result.openOnStart).toBe(true);
      expect(result.cli.port).toBe(9090);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("supports LLM_PROXY_OPEN_ON_START", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-tray-env-"));
    try {
      await expect(
        parseTrayOptions([], { LLM_PROXY_OPEN_ON_START: "1" }, directory),
      ).resolves.toMatchObject({ openOnStart: true });
      await expect(
        parseTrayOptions([], { LLM_PROXY_OPEN_ON_START: "0" }, directory),
      ).resolves.toMatchObject({ openOnStart: false });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
