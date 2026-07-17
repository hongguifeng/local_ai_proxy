import { describe, expect, it } from "vitest";

import { bodyJsonValue, bytesPayload } from "../../src/proxy/payload.js";

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
});
