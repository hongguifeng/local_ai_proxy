import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SseParser, type SseEvent } from "../src/proxy/sse-parser.js";

const fixtureNames = ["openai-chat", "openai-completions", "openai-responses", "claude-messages"] as const;

describe("incremental SSE parser", () => {
  it("parses all stream fixtures identically at every deterministic random chunk boundary", async () => {
    for (const name of fixtureNames) {
      const bytes = await readFile(new URL(`../../../packages/test-fixtures/streams/${name}.sse`, import.meta.url));
      const expected = parseChunks([bytes]);
      for (let seed = 1; seed <= 50; seed += 1) {
        expect(parseChunks(randomChunks(bytes, seed))).toEqual(expected);
      }
      expect(parseChunks([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(expected);
      expect(expected.at(-1)?.done).toBe(true);
    }
  });

  it("supports CRLF, comments, metadata, unknown fields, and multiline data", () => {
    const bytes = Buffer.from(
      ": comment\r\nid: event-1\r\nevent: custom\r\nunknown: ignored\r\ndata: first\r\ndata: second\r\n\r\n",
    );
    expect(parseChunks([bytes.subarray(0, 17), bytes.subarray(17)])).toEqual([
      { event: "custom", id: "event-1", data: "first\nsecond", done: false },
    ]);
  });

  it("emits events spanning chunks and multiple events from one chunk", () => {
    const parser = new SseParser();
    expect(parser.push(Buffer.from("data: one\n\ndata: tw")).events).toEqual([
      { event: "message", id: null, data: "one", done: false },
    ]);
    expect(parser.push(Buffer.from("o\n\n")).events).toEqual([
      { event: "message", id: null, data: "two", done: false },
    ]);
  });

  it("reports malformed and oversized input without throwing or retaining it", () => {
    const parser = new SseParser({ maxLineChars: 8, maxEventChars: 10, maxBufferChars: 16, maxDiagnostics: 3 });
    const invalid = parser.push(Uint8Array.from([0xff, 0x0a]));
    expect(invalid.diagnostics.map((item) => item.code)).toContain("invalid_utf8");
    const line = parser.push(Buffer.from("data: line-too-long\n\n"));
    expect(line.events).toEqual([]);
    expect(line.diagnostics.map((item) => item.code)).toContain("line_too_large");

    const eventParser = new SseParser({ maxLineChars: 16, maxEventChars: 5, maxBufferChars: 16, maxDiagnostics: 3 });
    const event = eventParser.push(Buffer.from("data: 1234\ndata: 5\n\ndata: ok\n\n"));
    expect(event.events).toEqual([{ event: "message", id: null, data: "ok", done: false }]);
    expect(event.diagnostics.map((item) => item.code)).toContain("event_too_large");
    expect(() => new SseParser({ maxLineChars: 10, maxEventChars: 10, maxBufferChars: 5, maxDiagnostics: 1 })).toThrow(
      RangeError,
    );
  });

  it("flushes a final unterminated event and reports incomplete UTF-8", () => {
    const parser = new SseParser();
    parser.push(Buffer.from("data: final"));
    expect(parser.finish().events).toEqual([{ event: "message", id: null, data: "final", done: false }]);

    const malformed = new SseParser();
    malformed.push(Uint8Array.from([0xe2]));
    expect(malformed.finish().diagnostics.map((item) => item.code)).toContain("invalid_utf8");
  });
});

function parseChunks(chunks: readonly Uint8Array[]): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk).events);
  events.push(...parser.finish().events);
  return events;
}

function randomChunks(bytes: Uint8Array, seed: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let state = seed;
  while (offset < bytes.byteLength) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const size = 1 + (state % 31);
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
    offset += size;
  }
  return chunks;
}
