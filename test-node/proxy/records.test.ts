import { describe, expect, it } from "vitest";

import { responseTokenCount, responseTokenCounts } from "../../src/proxy/records.js";

describe("responseTokenCount", () => {
  it.each([
    [{ usage: { total_tokens: 9 } }, 9],
    [{ usage: { total_tokens: 9.0 } }, 9],
    [{ stream_summary: { usage: { input_tokens: 3, output_tokens: 2 } } }, 5],
    [{ response: { usage: { input_tokens: 4 } } }, 4],
    [
      {
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
      17,
    ],
    [{ usage: { input_tokens: 0 } }, 0],
  ])("reads %# as %i tokens", (payload, expected) => {
    expect(responseTokenCount(payload)).toBe(expected);
  });

  it("uses stream usage before top-level and nested response usage", () => {
    expect(
      responseTokenCount({
        stream_summary: { usage: { total_tokens: 1 } },
        usage: { total_tokens: 2 },
        response: { usage: { total_tokens: 3 } },
      }),
    ).toBe(1);
  });

  it.each([
    { ok: true },
    { usage: {} },
    { usage: { total_tokens: "9" } },
    { usage: { input_tokens: true, output_tokens: 1.5 } },
    null,
  ])("returns undefined for unsupported usage %#", (payload) => {
    expect(responseTokenCount(payload)).toBeUndefined();
  });

  it("derives display input from the same disjoint buckets used for pricing", () => {
    expect(
      responseTokenCounts(
        {
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        },
        "chat",
      ),
    ).toEqual({ request: 12, response: 3 });
  });
});

describe("responseTokenCounts", () => {
  it.each([
    [{ usage: { input_tokens: 6, output_tokens: 3 } }, { request: 6, response: 3 }],
    [{ usage: { prompt_tokens: 5, completion_tokens: 2 } }, { request: 5, response: 2 }],
    [
      {
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
      { request: 14, response: 3 },
    ],
    [{ usage: { input_tokens: 0, output_tokens: 0 } }, { request: 0, response: 0 }],
    [{ usage: { total_tokens: 9 } }, { request: undefined, response: undefined }],
  ])("splits request and response usage for %#", (payload, expected) => {
    expect(responseTokenCounts(payload)).toEqual(expected);
  });

  it("uses stream usage before top-level and nested response usage", () => {
    expect(
      responseTokenCounts({
        stream_summary: { usage: { input_tokens: 4, output_tokens: 2 } },
        usage: { input_tokens: 10, output_tokens: 5 },
        response: { usage: { input_tokens: 20, output_tokens: 10 } },
      }),
    ).toEqual({ request: 4, response: 2 });
  });
});
