import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { collectBody } from "../../src/proxy/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("collectBody", () => {
  it("spools above the memory threshold and removes the temporary file", async () => {
    const spoolDirectory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-body-spool-"));
    temporaryDirectories.push(spoolDirectory);
    const collected = await collectBody(chunks("abc", "def"), {
      memoryThresholdBytes: 4,
      maxBytes: 16,
      spoolDirectory,
    });

    expect(collected).toMatchObject({ sizeBytes: 6, spooled: true });
    expect((await collected.bytes()).toString("utf8")).toBe("abcdef");
    expect(await readdir(spoolDirectory)).toHaveLength(1);
    await collected.cleanup();
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("rejects and cleans up bodies above the hard limit", async () => {
    const spoolDirectory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-body-limit-"));
    temporaryDirectories.push(spoolDirectory);
    await expect(
      collectBody(chunks("1234", "5678"), {
        memoryThresholdBytes: 2,
        maxBytes: 6,
        spoolDirectory,
      }),
    ).rejects.toMatchObject({
      name: "RequestBodyTooLargeError",
      limitBytes: 6,
      sizeBytes: 8,
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
  });
});

function chunks(...values: readonly string[]): Readable {
  return Readable.from(values);
}
