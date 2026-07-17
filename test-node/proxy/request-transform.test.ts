import { describe, expect, it } from "vitest";

import { parseStripRequestFields } from "../../src/proxy/request-transform.js";

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
