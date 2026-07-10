import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot, type RuntimeProxy } from "../src/config/schema.js";
import {
  parseRequestJsonObject,
  requestModelFromParsedBody,
  transformParsedRequestBody,
} from "../src/proxy/request-transform.js";
import { routeAndTransformRequest, selectTargetByModel } from "../src/proxy/routing.js";

type ProxyFixture = Readonly<{
  modelExtraction: readonly Readonly<{ bodyBase64: string; expectedModel: string | null }>[];
  targetSelection: Readonly<{ requestModel: string; expectedTargetId: string; expectedUpstreamModel: string }>;
  modelRewrite: Readonly<{ inputBase64: string; upstreamModel: string; expectedBase64: string }>;
  fieldTransform: Readonly<{
    inputBase64: string;
    strip: readonly string[];
    inject: Readonly<Record<string, unknown>>;
    expectedBase64: string;
    expectedStripped: readonly string[];
    expectedInjected: readonly string[];
  }>;
}>;

const fixture = await loadFixture();

function proxyWithTargets(): RuntimeProxy {
  const snapshot = createRuntimeConfigSnapshot({
    version: 1,
    proxies: [
      {
        id: "proxy",
        name: "Proxy",
        enabled: true,
        targets: [
          {
            id: "disabled",
            name: "Disabled",
            enabled: false,
            url: "https://disabled.example/v1",
            modelMappings: [{ listen: "demo", upstream: "wrong" }],
          },
          {
            id: "mapped",
            name: "Mapped",
            url: "https://mapped.example/v1",
            stripRequestFields: ["temperature"],
            injectRequestFields: { metadata: { source: "fixture" }, stream: true },
            modelMappings: [{ listen: "demo", upstream: "upstream-demo" }],
          },
          { id: "default", name: "Default", url: "https://default.example/v1" },
        ],
        defaultTargetId: "default",
      },
    ],
  });
  const proxy = snapshot.proxies[0];
  if (!proxy) {
    throw new TypeError("Missing test proxy");
  }
  return proxy;
}

describe("request JSON parsing", () => {
  it("extracts only a top-level string model from every language-neutral fixture", () => {
    for (const testCase of fixture.modelExtraction) {
      const parsed = parseRequestJsonObject(Buffer.from(testCase.bodyBase64, "base64"));
      expect(requestModelFromParsedBody(parsed)).toBe(testCase.expectedModel);
    }
  });

  it("distinguishes invalid UTF-8, invalid JSON, and non-object JSON", () => {
    expect(parseRequestJsonObject(Uint8Array.from([0xff])).state).toBe("invalid-utf8");
    expect(parseRequestJsonObject(Buffer.from("not json")).state).toBe("invalid-json");
    for (const value of ["null", "[]", "1", '"text"']) {
      expect(parseRequestJsonObject(Buffer.from(value)).state).toBe("non-object");
    }
  });
});

describe("model routing", () => {
  it("matches enabled targets in order and returns the fixture rewrite", () => {
    const expected = fixture.targetSelection;
    const selection = selectTargetByModel(proxyWithTargets(), expected.requestModel);
    expect(selection.target.id).toBe(expected.expectedTargetId);
    expect(selection.upstreamModel).toBe(expected.expectedUpstreamModel);
  });

  it("falls back to the configured default and rejects a missing default", () => {
    const proxy = proxyWithTargets();
    expect(selectTargetByModel(proxy, "unmapped").target.id).toBe("default");
    expect(selectTargetByModel(proxy, null).target.id).toBe("default");
    expect(() => selectTargetByModel({ ...proxy, defaultTargetId: "missing" }, "demo")).toThrow("does not exist");
  });
});

describe("request transformation", () => {
  it("matches the language-neutral strip/inject fixture", () => {
    const expected = fixture.fieldTransform;
    const original = Buffer.from(expected.inputBase64, "base64");
    const transformed = transformParsedRequestBody(
      original,
      parseRequestJsonObject(original),
      expected.strip,
      expected.inject as never,
      null,
    );
    expect(Buffer.from(transformed.body).toString("base64")).toBe(expected.expectedBase64);
    expect(transformed.strippedFields).toEqual(expected.expectedStripped);
    expect(transformed.injectedFields).toEqual(expected.expectedInjected);
    expect(transformed.bodyChanged).toBe(true);
  });

  it("matches the language-neutral model rewrite fixture", () => {
    const expected = fixture.modelRewrite;
    const original = Buffer.from(expected.inputBase64, "base64");
    const transformed = transformParsedRequestBody(
      original,
      parseRequestJsonObject(original),
      [],
      {},
      expected.upstreamModel,
    );
    expect(Buffer.from(transformed.body).toString("base64")).toBe(expected.expectedBase64);
  });

  it("applies strip, inject, then model rewrite and returns structured metadata", () => {
    const original = Buffer.from('{"model":"demo","temperature":0.2,"metadata":{"old":true}}');
    const result = routeAndTransformRequest(proxyWithTargets(), original);
    expect(JSON.parse(Buffer.from(result.body).toString("utf8"))).toEqual({
      model: "upstream-demo",
      metadata: { source: "fixture" },
      stream: true,
    });
    expect(result.metadata).toEqual({
      parseState: "object",
      selectedTargetId: "mapped",
      requestedModel: "demo",
      upstreamModel: "upstream-demo",
      strippedFields: ["temperature"],
      injectedFields: ["metadata", "stream"],
      bodyChanged: true,
    });
  });

  it("preserves invalid and non-object bodies byte-for-byte", () => {
    const proxy = proxyWithTargets();
    for (const original of [
      Uint8Array.from([0xff]),
      Buffer.from("not json"),
      Buffer.from("[1,2]"),
      Buffer.from("null"),
    ]) {
      const result = routeAndTransformRequest(proxy, original);
      expect(result.body).toBe(original);
      expect(result.metadata.bodyChanged).toBe(false);
      expect(result.metadata.strippedFields).toEqual([]);
      expect(result.metadata.injectedFields).toEqual([]);
    }
  });

  it("does not reserialize an object when no configured operation changes it", () => {
    const original = Buffer.from('{ "model": "unmapped" }\n');
    const result = routeAndTransformRequest(proxyWithTargets(), original);
    expect(result.body).toBe(original);
    expect(result.metadata.bodyChanged).toBe(false);
  });

  it("handles prototype-named fields as ordinary JSON data", () => {
    const original = Buffer.from('{"model":"demo"}');
    const parsed = parseRequestJsonObject(original);
    const injected = JSON.parse('{"__proto__":null}') as never;
    const transformed = transformParsedRequestBody(original, parsed, [], injected, null);
    expect(JSON.parse(Buffer.from(transformed.body).toString("utf8"))).toHaveProperty("__proto__", null);
  });
});

async function loadFixture(): Promise<ProxyFixture> {
  const input: unknown = JSON.parse(
    await readFile(new URL("../../../packages/test-fixtures/proxy/cases.json", import.meta.url), "utf8"),
  );
  if (!input || typeof input !== "object") {
    throw new TypeError("Invalid proxy fixture");
  }
  return input as ProxyFixture;
}
