import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildImportedPriceRules,
  convertUsdPrice,
  fetchModelsDevCatalog,
  fetchUpstreamModelIds,
  importModelPrices,
  numberToDecimalString,
  resetCatalogCache,
  type ModelsDevCost,
} from "../../src/pricing/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCatalogCache();
});

interface StubRoute {
  readonly status?: number;
  readonly body: string;
}

function stubFetch(routes: [string, StubRoute][]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      const route = routes.find(([prefix]) => url.startsWith(prefix));
      if (route === undefined) {
        throw new Error(`No stub route for ${url}.`);
      }
      return Promise.resolve(new Response(route[1].body, { status: route[1].status ?? 200 }));
    }),
  );
  return calls;
}

const CATALOG = JSON.stringify({
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus": {
        name: "Claude Opus",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      tiny: { name: "Tiny", cost: { input: 0.00001, output: 0.00001 } },
    },
  },
  openai: {
    name: "OpenAI",
    models: {
      "gpt-5": { name: "GPT-5", cost: { input: 0.3, output: 1.25, cache_read: 0.03 } },
    },
  },
  "ds-main": { name: "DeepSeek", models: { "ds-chat": { cost: { input: 1, output: 2 } } } },
  "ds-relay": {
    name: "DeepSeek Relay",
    models: { "ds-chat": { cost: { input: 3, output: 4 } } },
  },
});

describe("numberToDecimalString", () => {
  it.each([
    [3, "3"],
    [0.003, "0.003"],
    [0.0001, "0.0001"],
    [0.00001, "0.00001"],
    [0.000015, "0.000015"],
    [123456, "123456"],
  ])("renders %s without exponent form", (input, expected) => {
    expect(numberToDecimalString(input)).toBe(expected);
  });

  it("rejects negative and non-finite values", () => {
    expect(() => numberToDecimalString(-1)).toThrow(RangeError);
    expect(() => numberToDecimalString(Number.NaN)).toThrow(RangeError);
  });
});

describe("convertUsdPrice", () => {
  it("multiplies exact decimal values with the rate", () => {
    expect(convertUsdPrice("0.3", "7.1")).toBe("2.13");
    expect(convertUsdPrice("0.003", "7.25")).toBe("0.02175");
    expect(convertUsdPrice("3", "7.1")).toBe("21.3");
    expect(convertUsdPrice("0.00001", "7.1")).toBe("0.000071");
  });

  it("rounds half-up to six decimal places", () => {
    expect(convertUsdPrice("0.0001", "7.1234")).toBe("0.000712");
    expect(convertUsdPrice("0.000001", "1.5")).toBe("0.000002");
  });

  it("keeps zero prices as zero", () => {
    expect(convertUsdPrice("0", "7.1")).toBe("0");
  });

  it("rejects values that cannot be stored", () => {
    expect(() => convertUsdPrice("0.3", "7.1234567")).toThrow(RangeError);
    expect(() => convertUsdPrice("1000", "2000")).toThrow(RangeError);
  });
});

describe("fetchUpstreamModelIds", () => {
  it("parses the OpenAI-style data list and deduplicates and sorts", async () => {
    const calls = stubFetch([
      [
        "http://127.0.0.1:1235/v1/models",
        { body: JSON.stringify({ object: "list", data: [{ id: "b" }, { id: "a" }, { id: "b" }] }) },
      ],
    ]);
    expect(await fetchUpstreamModelIds("http://127.0.0.1:1235/v1")).toEqual(["a", "b"]);
    expect(calls).toHaveLength(1);
  });

  it("accepts a top-level array of strings", async () => {
    stubFetch([["http://127.0.0.1:1235/models", { body: JSON.stringify(["y", "x"]) }]]);
    expect(await fetchUpstreamModelIds("http://127.0.0.1:1235")).toEqual(["x", "y"]);
  });

  it("accepts the Gemini-style models list", async () => {
    stubFetch([
      [
        "http://127.0.0.1:1235/models",
        { body: JSON.stringify({ models: [{ id: "g2" }, { id: "g1" }] }) },
      ],
    ]);
    expect(await fetchUpstreamModelIds("http://127.0.0.1:1235")).toEqual(["g1", "g2"]);
  });

  it("sends the key as both bearer and x-api-key headers", async () => {
    const calls = stubFetch([
      ["http://127.0.0.1:1235/models", { body: JSON.stringify({ data: [{ id: "a" }] }) }],
    ]);
    await fetchUpstreamModelIds("http://127.0.0.1:1235", "sk-test");
    const first = calls[0];
    expect(first?.headers["authorization"]).toBe("Bearer sk-test");
    expect(first?.headers["x-api-key"]).toBe("sk-test");
    expect(first?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("falls back to the Anthropic-style /v1/models path after a 404", async () => {
    const calls = stubFetch([
      ["http://127.0.0.1:1235/models", { status: 404, body: "{}" }],
      ["http://127.0.0.1:1235/v1/models", { body: JSON.stringify({ data: [{ id: "c1" }] }) }],
    ]);
    expect(await fetchUpstreamModelIds("http://127.0.0.1:1235")).toEqual(["c1"]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry on non-404/405 errors", async () => {
    const calls = stubFetch([
      ["http://127.0.0.1:1235/v1/models", { status: 401, body: "unauthorized" }],
    ]);
    await expect(fetchUpstreamModelIds("http://127.0.0.1:1235/v1", "sk-test")).rejects.toThrow(
      /401/,
    );
    expect(calls).toHaveLength(1);
  });

  it("rejects when no path serves a model list", async () => {
    stubFetch([
      ["http://127.0.0.1:1235/models", { status: 404, body: "{}" }],
      ["http://127.0.0.1:1235/v1/models", { status: 404, body: "{}" }],
    ]);
    await expect(fetchUpstreamModelIds("http://127.0.0.1:1235")).rejects.toThrow(
      /no model list endpoint/,
    );
  });

  it("rejects an invalid target url with a TypeError", async () => {
    stubFetch([]);
    await expect(fetchUpstreamModelIds("ftp://example.test")).rejects.toThrow(TypeError);
  });

  it("rejects an empty model list", async () => {
    stubFetch([["http://127.0.0.1:1235/models", { body: JSON.stringify({ data: [] }) }]]);
    await expect(fetchUpstreamModelIds("http://127.0.0.1:1235")).rejects.toThrow(
      /did not contain any model ids/,
    );
  });
});

describe("fetchModelsDevCatalog", () => {
  it("indexes every priced model with its provider", async () => {
    stubFetch([["https://models.dev/api.json", { body: CATALOG }]]);
    const catalog = await fetchModelsDevCatalog();
    const opus = catalog.entries.get("claude-opus");
    expect(opus).toEqual([
      {
        cost: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" },
        provider: "Anthropic",
      },
    ]);
    const tiny = catalog.entries.get("tiny");
    expect(tiny?.[0]?.cost).toEqual({ input: "0.00001", output: "0.00001" });
  });

  it("serves a fresh cache without refetching", async () => {
    const calls = stubFetch([["https://models.dev/api.json", { body: CATALOG }]]);
    await fetchModelsDevCatalog();
    await fetchModelsDevCatalog();
    expect(calls.filter((call) => call.url.startsWith("https://models.dev/"))).toHaveLength(1);
  });

  it("fails without a cache when the catalog is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await expect(fetchModelsDevCatalog()).rejects.toThrow(/offline/);
  });
});

describe("buildImportedPriceRules", () => {
  function catalogWith(entries: Record<string, { cost: ModelsDevCost; provider: string }>) {
    const map = new Map<string, { cost: ModelsDevCost; provider: string }[]>();
    for (const [id, entry] of Object.entries(entries)) {
      map.set(id, [{ cost: entry.cost, provider: entry.provider }]);
    }
    return map;
  }

  it("converts every priced model with the rate", () => {
    const catalog = catalogWith({
      "claude-opus": {
        cost: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" },
        provider: "Anthropic",
      },
    });
    const { rules, unmatched } = buildImportedPriceRules(
      ["claude-opus"],
      { entries: catalog },
      "7.1",
      "api.anthropic.com",
    );
    expect(unmatched).toEqual([]);
    expect(rules).toEqual([
      {
        model_pattern: "claude-opus",
        input_per_million: "21.3",
        output_per_million: "106.5",
        cache_read_per_million: "2.13",
        cache_write_per_million: "26.625",
      },
    ]);
  });

  it("defaults missing cache prices to zero", () => {
    const catalog = catalogWith({
      "gpt-5": { cost: { input: "0.3", output: "1.25", cacheRead: "0.03" }, provider: "OpenAI" },
    });
    const { rules } = buildImportedPriceRules(
      ["gpt-5"],
      { entries: catalog },
      "7.1",
      "api.openai.com",
    );
    expect(rules[0]?.cache_write_per_million).toBe("0");
    expect(rules[0]?.cache_read_per_million).toBe("0.213");
  });

  it("marks unpriced models unmatched and keeps the order", () => {
    const catalog = catalogWith({
      "gpt-5": { cost: { input: "1", output: "2" }, provider: "OpenAI" },
    });
    const { rules, unmatched } = buildImportedPriceRules(
      ["zzz", "gpt-5", "aaa"],
      { entries: catalog },
      "1",
      "x",
    );
    expect(rules).toHaveLength(1);
    expect(unmatched).toEqual(["zzz", "aaa"]);
  });

  it("prefers the provider whose name matches the host when ids collide", () => {
    const map = new Map<string, { cost: ModelsDevCost; provider: string }[]>();
    map.set("ds-chat", [
      { cost: { input: "1", output: "2" }, provider: "DeepSeek" },
      { cost: { input: "3", output: "4" }, provider: "DeepSeek Relay" },
    ]);
    const { rules } = buildImportedPriceRules(
      ["ds-chat"],
      { entries: map },
      "1",
      "api.deepseek.com",
    );
    expect(rules[0]?.input_per_million).toBe("1");
  });
});

describe("importModelPrices", () => {
  it("fetches the upstream models and models.dev once each, and builds converted rules", async () => {
    const calls = stubFetch([
      [
        "http://127.0.0.1:1235/v1/models",
        {
          body: JSON.stringify({
            data: [{ id: "claude-opus" }, { id: "gpt-5" }, { id: "unknown-model" }, { id: "tiny" }],
          }),
        },
      ],
      ["https://models.dev/api.json", { body: CATALOG }],
    ]);
    const result = await importModelPrices({
      targetUrl: "http://127.0.0.1:1235/v1",
      targetApiKey: "sk-test",
      priceRate: "7.1",
    });
    expect(calls.filter((call) => call.url.startsWith("https://models.dev/"))).toHaveLength(1);
    expect(result.models).toEqual(["claude-opus", "gpt-5", "tiny", "unknown-model"]);
    expect(result.unmatched).toEqual(["unknown-model"]);
    expect(result.catalog.source).toBe("models.dev");
    const gpt = result.rules.find((rule) => rule.model_pattern === "gpt-5");
    expect(gpt).toEqual({
      model_pattern: "gpt-5",
      input_per_million: "2.13",
      output_per_million: "8.875",
      cache_read_per_million: "0.213",
      cache_write_per_million: "0",
    });
    const tiny = result.rules.find((rule) => rule.model_pattern === "tiny");
    expect(tiny?.input_per_million).toBe("0.000071");
  });

  it("defaults the rate to 1 for raw USD prices", async () => {
    stubFetch([
      ["http://127.0.0.1:1235/v1/models", { body: JSON.stringify({ data: [{ id: "gpt-5" }] }) }],
      ["https://models.dev/api.json", { body: CATALOG }],
    ]);
    const result = await importModelPrices({ targetUrl: "http://127.0.0.1:1235/v1" });
    expect(result.rules[0]?.input_per_million).toBe("0.3");
  });
});
