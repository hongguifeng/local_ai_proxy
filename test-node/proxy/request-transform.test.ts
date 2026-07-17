import { describe, expect, it } from "vitest";

import {
  parseInjectRequestFields,
  parseStripRequestFields,
} from "../../src/proxy/request-transform.js";

describe("parseStripRequestFields", () => {
  it.each([undefined, null, "", " , , "])("parses %j as an empty set", (rawFields) => {
    expect(parseStripRequestFields(rawFields)).toEqual(new Set());
  });

  it("trims, filters, and deduplicates comma-separated field names", () => {
    expect(parseStripRequestFields(" temperature, top_p ,,temperature, metadata ")).toEqual(
      new Set(["temperature", "top_p", "metadata"]),
    );
  });
});

describe("parseInjectRequestFields", () => {
  it.each([undefined, null, "", "   "])("parses %j as an empty object", (rawFields) => {
    expect(parseInjectRequestFields(rawFields)).toEqual({});
  });

  it("parses a JSON object string", () => {
    expect(parseInjectRequestFields('{"metadata":{"source":"proxy"},"stream":true}')).toEqual({
      metadata: { source: "proxy" },
      stream: true,
    });
  });

  it("copies an object input", () => {
    const input = { stream: true };
    const parsed = parseInjectRequestFields(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it.each(["[1,2]", '"text"', "123", "{invalid", 123, true, []])(
    "rejects non-object input %j",
    (rawFields) => {
      expect(() => parseInjectRequestFields(rawFields)).toThrow(
        "inject request fields must be a JSON object",
      );
    },
  );
});
