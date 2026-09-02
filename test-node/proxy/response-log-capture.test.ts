import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ResponseLogCapture } from "../../src/proxy/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ResponseLogCapture", () => {
  it("spools a complete response above the memory threshold and removes the file", async () => {
    const spoolDirectory = await temporaryDirectory("llm-proxy-response-spool-");
    const capture = new ResponseLogCapture(false, {
      memoryThresholdBytes: 4,
      maxBytes: 16,
      spoolDirectory,
    });

    capture.addChunk(Buffer.from("abc"));
    capture.addChunk(Buffer.from("def"));

    await expect(capture.finalize()).resolves.toEqual({
      size_bytes: 6,
      base64: Buffer.from("abcdef").toString("base64"),
      text: "abcdef",
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("bounds captured bytes while hashing the complete response", async () => {
    const spoolDirectory = await temporaryDirectory("llm-proxy-response-limit-");
    const complete = Buffer.from("abcdefgh");
    const capture = new ResponseLogCapture(false, {
      memoryThresholdBytes: 2,
      maxBytes: 6,
      spoolDirectory,
    });

    capture.addChunk(complete.subarray(0, 4));
    capture.addChunk(complete.subarray(4));

    await expect(capture.finalize()).resolves.toEqual({
      text: "abcdef",
      size_bytes: 8,
      captured_bytes: 6,
      sha256: createHash("sha256").update(complete).digest("hex"),
      truncated: true,
      truncation_reason: "log_body_limit",
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("bounds SSE parsing separately and records summary truncation", async () => {
    const first = 'data: {"type":"response.output_text.delta","delta":"first"}\n\n';
    const second = 'data: {"type":"response.output_text.delta","delta":"second"}\n\n';
    const capture = new ResponseLogCapture(true, {
      memoryThresholdBytes: 1_024,
      maxBytes: 1_024,
      maxSseSummaryInputBytes: Buffer.byteLength(first),
    });

    capture.addChunk(Buffer.from(first));
    capture.addChunk(Buffer.from(second));

    await expect(capture.finalize()).resolves.toMatchObject({
      size_bytes: Buffer.byteLength(first + second),
      stream_summary: {
        content: "first",
        event_count: 1,
        summary_truncated: true,
        summary_input_bytes: Buffer.byteLength(first),
        summary_limit_bytes: Buffer.byteLength(first),
      },
    });
  });

  it("validates configured limits", () => {
    expect(() => new ResponseLogCapture(false, { memoryThresholdBytes: 2, maxBytes: 1 })).toThrow(
      RangeError,
    );
    expect(() => new ResponseLogCapture(true, { maxSseSummaryInputBytes: 0 })).toThrow(RangeError);
  });

  it("tracks the first generated text token for SSE captures only", async () => {
    const plain = new ResponseLogCapture(false, { memoryThresholdBytes: 1_024 });
    const plainChunk = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
    plain.addChunk(Buffer.from(plainChunk));
    expect(plain.hasSeenTextToken()).toBe(false);
    await expect(plain.finalize()).resolves.toMatchObject({
      size_bytes: Buffer.byteLength(plainChunk),
    });

    const sse = new ResponseLogCapture(true, { memoryThresholdBytes: 1_024 });
    expect(sse.hasSeenTextToken()).toBe(false);
    sse.addChunk(Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
    expect(sse.hasSeenTextToken()).toBe(true);
    await sse.finalize();
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
