import { describe, expect, it } from "vitest";

import { normalizeUsage } from "../../src/pricing/index.js";

describe("normalizeUsage", () => {
  it.each([
    ["responses", { usage: { input_tokens: 30, output_tokens: 5 } }, 30, 5, 0, 0],
    [
      "chat",
      {
        usage: {
          prompt_tokens: 30,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 7 },
        },
      },
      23,
      5,
      7,
      0,
    ],
    ["completions", { usage: { prompt_tokens: 30, completion_tokens: 5 } }, 30, 5, 0, 0],
    [
      "messages",
      {
        usage: {
          input_tokens: 30,
          output_tokens: 5,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 4,
        },
      },
      30,
      5,
      7,
      4,
    ],
  ] as const)(
    "normalizes %s JSON usage into disjoint buckets",
    (kind, payload, input, output, read, write) => {
      expect(normalizeUsage(kind, payload)).toEqual({
        status: "complete",
        usage: {
          source: kind,
          inputUncachedTokens: input,
          outputTokens: output,
          cacheReadTokens: read,
          cacheWriteTokens: write,
          totalInputTokens: input + read + write,
        },
      });
    },
  );

  it("accepts absent optional caches, but rejects missing and malformed required counts", () => {
    expect(
      normalizeUsage("chat", { usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    ).toMatchObject({
      status: "complete",
    });
    expect(normalizeUsage("chat", { usage: { total_tokens: 3 } })).toMatchObject({
      reason: "missing_usage",
    });
    for (const value of [-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        normalizeUsage("chat", { usage: { prompt_tokens: value, completion_tokens: 2 } }),
      ).toMatchObject({ reason: "invalid_usage" });
    }
    expect(
      normalizeUsage("chat", {
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }),
    ).toMatchObject({ reason: "invalid_usage" });
  });

  it("handles Anthropic cache write totals and TTL subitems without double counting", () => {
    expect(
      normalizeUsage("messages", {
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          cache_creation_input_tokens: 7,
          cache_creation_input_tokens_5m: 3,
          cache_creation_input_tokens_1h: 4,
        },
      }),
    ).toMatchObject({ status: "complete", usage: { cacheWriteTokens: 7 } });
    expect(
      normalizeUsage("messages", {
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          cache_creation_input_tokens_5m: 3,
          cache_creation_input_tokens_1h: 4,
        },
      }),
    ).toMatchObject({ status: "complete", usage: { cacheWriteTokens: 7 } });
    expect(
      normalizeUsage("messages", {
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          cache_creation_input_tokens: 8,
          cache_creation_input_tokens_5m: 3,
        },
      }),
    ).toMatchObject({ reason: "invalid_usage" });
  });

  it("does not guess mixed or unknown endpoint protocols", () => {
    expect(
      normalizeUsage("chat", {
        usage: { prompt_tokens: 2, completion_tokens: 1, cache_read_input_tokens: 1 },
      }),
    ).toMatchObject({ reason: "unsupported_usage" });
    expect(normalizeUsage("other", { usage: { input_tokens: 2, output_tokens: 1 } })).toMatchObject(
      {
        reason: "unsupported_usage",
      },
    );
  });
});
