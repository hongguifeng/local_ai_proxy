import { readFile } from "node:fs/promises";

import { CapturedPayloadSchema } from "@llm-proxy/contracts";
import { describe, expect, it } from "vitest";

import { createCapturedPayload, createSafeCapturedContent } from "../src/proxy/payload.js";
import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  redactHeaders,
  sanitizeJsonValue,
} from "../src/proxy/redaction.js";

type RedactionFixture = Readonly<{
  redaction: Readonly<{
    headers: Readonly<Record<string, readonly string[]>>;
    expectedHeaders: Readonly<Record<string, readonly string[]>>;
    json: unknown;
    expectedJson: unknown;
  }>;
}>;

const fixture = await loadFixture();

describe("captured payload representation", () => {
  it("represents empty, JSON, text, binary, and truncated captures", () => {
    expect(createCapturedPayload(new Uint8Array(), 0)).toEqual({
      kind: "empty",
      observedBytes: 0,
      capturedBytes: 0,
      truncated: false,
    });
    expect(createCapturedPayload(Buffer.from('{"ok":true}'), 11)).toMatchObject({
      kind: "json",
      value: { ok: true },
    });
    expect(createCapturedPayload(Buffer.from("plain text"), 10)).toMatchObject({ kind: "text", text: "plain text" });
    expect(createCapturedPayload(Uint8Array.from([0xff, 0x00]), 2)).toMatchObject({ kind: "binary", base64: "/wA=" });
    expect(createCapturedPayload(Buffer.from("part"), 100)).toMatchObject({
      capturedBytes: 4,
      observedBytes: 100,
      truncated: true,
    });
  });

  it("produces payloads accepted by the shared runtime contract", () => {
    for (const input of [new Uint8Array(), Buffer.from("null"), Buffer.from("text"), Uint8Array.from([0xff])]) {
      expect(CapturedPayloadSchema.safeParse(createCapturedPayload(input, input.byteLength)).success).toBe(true);
    }
    expect(() => createCapturedPayload(Buffer.from("too long"), 1)).toThrow(RangeError);
    expect(() => createCapturedPayload(new Uint8Array(), Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("bounded redaction", () => {
  it("matches language-neutral header and JSON fixtures", () => {
    expect(redactHeaders(fixture.redaction.headers)).toEqual(fixture.redaction.expectedHeaders);
    expect(sanitizeJsonValue(fixture.redaction.json)).toEqual(fixture.redaction.expectedJson);
  });

  it("redacts common secrets case-insensitively before persistence", () => {
    const secret = "never-send-to-worker";
    const captured = Buffer.from(JSON.stringify({ API_KEY: secret, nested: { password: secret }, ok: true }));
    const safe = createSafeCapturedContent(
      { Authorization: [`Bearer ${secret}`], "X-API-KEY": [secret], Accept: ["application/json"] },
      captured,
      captured.byteLength,
    );
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(secret);
    expect(safe.headers.Authorization).toEqual([REDACTED_VALUE]);
    expect(safe.body).toMatchObject({
      kind: "json",
      value: { API_KEY: REDACTED_VALUE, nested: { password: REDACTED_VALUE }, ok: true },
    });
  });

  it("bounds depth, item count, and UTF-8 string bytes", () => {
    const value = { one: { two: { password: "hidden", value: "abcdef" } }, extra: [1, 2, 3] };
    expect(sanitizeJsonValue(value, { maxDepth: 1, maxItems: 100, maxStringBytes: 100 })).toEqual({
      one: { two: TRUNCATED_VALUE },
      extra: [TRUNCATED_VALUE, TRUNCATED_VALUE, TRUNCATED_VALUE],
    });
    expect(sanitizeJsonValue([1, 2, 3], { maxDepth: 10, maxItems: 2, maxStringBytes: 10 })).toEqual([
      1,
      TRUNCATED_VALUE,
    ]);
    expect(sanitizeJsonValue("你好世界", { maxDepth: 1, maxItems: 1, maxStringBytes: 7 })).toBe("你好");
  });

  it("handles cycles, non-JSON primitives, prototype keys, and invalid limits", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(sanitizeJsonValue(cyclic)).toEqual({ self: CIRCULAR_VALUE });
    expect(sanitizeJsonValue({ value: undefined, number: Number.POSITIVE_INFINITY })).toEqual({
      value: null,
      number: null,
    });
    const prototypeKey = JSON.parse('{"__proto__":{"secret":"hidden"}}') as unknown;
    const sanitized = sanitizeJsonValue(prototypeKey);
    expect(Object.hasOwn(sanitized as object, "__proto__")).toBe(true);
    expect(Reflect.get(sanitized as object, "__proto__") as unknown).toEqual({ secret: REDACTED_VALUE });
    expect(() => sanitizeJsonValue({}, { maxDepth: -1, maxItems: 1, maxStringBytes: 1 })).toThrow(RangeError);
  });
});

async function loadFixture(): Promise<RedactionFixture> {
  const input: unknown = JSON.parse(
    await readFile(new URL("../../../packages/test-fixtures/proxy/cases.json", import.meta.url), "utf8"),
  );
  if (!input || typeof input !== "object" || !("redaction" in input)) {
    throw new TypeError("Invalid proxy redaction fixture");
  }
  return input as RedactionFixture;
}
