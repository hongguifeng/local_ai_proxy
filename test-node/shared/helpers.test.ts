import path from "node:path";

import { describe, expect, it } from "vitest";

import { createRequestId, safeIdentifierPart } from "../../src/shared/ids.js";
import { parseJsonObject, stableJsonStringify } from "../../src/shared/json.js";
import { resolveConfiguredPath, toPosixPath } from "../../src/shared/paths.js";
import { formatLocalIso, formatLocalTimestamp } from "../../src/shared/time.js";

describe("shared helpers", () => {
  it("creates compact request IDs and safe identifier parts", () => {
    expect(createRequestId()).toMatch(/^[0-9a-f]{32}$/u);
    expect(safeIdentifierPart("  model/name:测试  ")).toBe("model-name-测试");
    expect(safeIdentifierPart("***", "fallback")).toBe("fallback");
  });

  it("parses JSON objects and stringifies objects with stable key order", () => {
    expect(parseJsonObject('{"value":1}')).toEqual({ value: 1 });
    expect(parseJsonObject("[]")).toBeUndefined();
    expect(parseJsonObject("invalid")).toBeUndefined();
    expect(stableJsonStringify({ z: 1, a: { d: 2, b: 3 } })).toBe('{"a":{"b":3,"d":2},"z":1}');
  });

  it("resolves configured paths and normalizes path separators", () => {
    expect(resolveConfiguredPath("", "/workspace")).toBeUndefined();
    expect(resolveConfiguredPath("logs", "/workspace")).toBe(path.resolve("/workspace", "logs"));
    expect(toPosixPath(path.join("one", "two", "three"))).toBe("one/two/three");
  });

  it("formats local ISO timestamps with milliseconds and an offset", () => {
    const date = new Date("2026-01-02T03:04:05.006Z");
    expect(formatLocalIso(date)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.006[+-]\d{2}:\d{2}$/u,
    );
    const expectedDisplay = [
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`,
    ].join(" ");
    expect(formatLocalTimestamp(date)).toBe(expectedDisplay);
    expect(() => formatLocalTimestamp("invalid")).toThrow(RangeError);
  });
});
