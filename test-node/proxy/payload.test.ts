import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bodyJsonValue, bytesPayload } from "../../src/proxy/payload.js";

interface PayloadFixtureCase {
  readonly name: string;
  readonly bytes: readonly number[];
  readonly expected: {
    readonly size_bytes: number;
    readonly base64: string;
    readonly text: string;
  };
}

const payloadFixtureCases = JSON.parse(
  readFileSync(new URL("../../fixtures/parity/payload/bytes-cases.json", import.meta.url), "utf8"),
) as PayloadFixtureCase[];

describe("bytesPayload", () => {
  it("preserves bytes as size, base64, and readable UTF-8 text", () => {
    const data = Buffer.from('{"message":"你好"}', "utf8");

    expect(bytesPayload(data)).toEqual({
      size_bytes: data.byteLength,
      base64: data.toString("base64"),
      text: '{"message":"你好"}',
    });
  });

  it("represents an empty body", () => {
    expect(bytesPayload(Buffer.alloc(0))).toEqual({ size_bytes: 0, base64: "", text: "" });
  });

  it.each(payloadFixtureCases)("matches the $name parity fixture", ({ bytes, expected }) => {
    expect(bytesPayload(Uint8Array.from(bytes))).toEqual(expected);
  });
});

describe("bodyJsonValue", () => {
  it.each([
    ['{"model":"demo","stream":true}', { model: "demo", stream: true }],
    ["[1,2,3]", [1, 2, 3]],
    ["null", null],
  ])("parses JSON payload %s", (text, expected) => {
    expect(bodyJsonValue({ text, size_bytes: Buffer.byteLength(text) })).toEqual(expected);
  });

  it("converts an empty payload to null", () => {
    expect(bodyJsonValue({ text: "", size_bytes: 0 })).toBeNull();
  });

  it("uses an incrementally captured SSE summary without reparsing the raw stream", () => {
    expect(
      bodyJsonValue({
        text: "raw stream may be incomplete",
        size_bytes: 24,
        stream_summary: { content: "captured incrementally", event_count: 2 },
      }),
    ).toEqual({
      stream_summary: { content: "captured incrementally", event_count: 2 },
    });
  });

  it.each(["plain text response", "{malformed", "  not-json  "])(
    "wraps non-JSON text %j with its recorded byte size",
    (text) => {
      expect(bodyJsonValue({ text, size_bytes: 1234 })).toEqual({ text, size_bytes: 1234 });
    },
  );
});
