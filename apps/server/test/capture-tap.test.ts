import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { describe, expect, it } from "vitest";

import { CaptureTap } from "../src/proxy/capture-tap.js";

describe("bounded capture tap", () => {
  it("forwards bytes unchanged and records capture metadata", async () => {
    const input = [Buffer.from("hello"), Uint8Array.from([0, 255, 1]), Buffer.from("world")];
    const output: Buffer[] = [];
    const tap = new CaptureTap(7);
    await pipeline(
      Readable.from(input),
      tap,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    expect(Buffer.concat(output)).toEqual(Buffer.concat(input));
    expect(tap.result()).toMatchObject({
      captured: Buffer.concat(input).subarray(0, 7),
      observedBytes: 13,
      capturedBytes: 7,
      truncated: true,
    });
  });

  it("continues feeding the summarizer after raw capture truncation", async () => {
    let observed = 0;
    const observer = {
      push(chunk: Uint8Array) {
        observed += chunk.byteLength;
      },
      finish() {
        return { observed };
      },
    };
    const tap = new CaptureTap(2, observer);
    await pipeline(Readable.from([Buffer.from("one"), Buffer.from("two"), Buffer.from("three")]), tap, discard());
    expect(observed).toBe(11);
    expect(tap.result()).toMatchObject({ capturedBytes: 2, observedBytes: 11, summary: { observed: 11 } });
  });

  it("does not fail or await the main pipeline when a summarizer is slow or fails", async () => {
    const slowTap = new CaptureTap(0, {
      push() {
        return new Promise<void>(() => undefined);
      },
    });
    await pipeline(Readable.from([Buffer.from("forwarded")]), slowTap, discard());
    expect(slowTap.result().observedBytes).toBe(9);

    const failedTap = new CaptureTap(10, {
      push() {
        throw new Error("summary failed");
      },
    });
    await pipeline(Readable.from([Buffer.from("still forwarded")]), failedTap, discard());
    expect(failedTap.result().diagnostics).toEqual(["summarizer_push_failed"]);
  });

  it("streams 100 MiB with bounded capture and identical output hash", async () => {
    const totalBytes = 100 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const expected = createHash("sha256");
    const actual = createHash("sha256");
    let emitted = 0;
    const source = Readable.from(
      (function* () {
        while (emitted < totalBytes) {
          const next = chunk.subarray(0, Math.min(chunk.byteLength, totalBytes - emitted));
          emitted += next.byteLength;
          expected.update(next);
          yield next;
        }
      })(),
    );
    const tap = new CaptureTap(1024);
    await pipeline(
      source,
      tap,
      new Writable({
        write(data: Buffer, _encoding, callback) {
          actual.update(data);
          callback();
        },
      }),
    );
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    expect(tap.result()).toMatchObject({ observedBytes: totalBytes, capturedBytes: 1024, truncated: true });
    expect(tap.result().captured).toHaveLength(1024);
  });

  it("validates capture limits", () => {
    expect(() => new CaptureTap(-1)).toThrow(RangeError);
    expect(() => new CaptureTap(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
