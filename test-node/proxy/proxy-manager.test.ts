import { describe, expect, it } from "vitest";

import path from "node:path";

import { createDefaultProxyPair, type ProxyPair } from "../../src/config/index.js";
import {
  assertNoEnabledListenConflicts,
  diffProxyPairs,
  ProxyListenConflictError,
  resolveRuntimeLogRoot,
} from "../../src/proxy/index.js";

describe("diffProxyPairs", () => {
  it("classifies add, update, remove, and unchanged pairs in stable order", () => {
    const removed = pair("removed", 4101);
    const updatedBefore = pair("updated", 4102);
    const unchanged = pair("unchanged", 4103);
    const updatedAfter = { ...updatedBefore, name: "Updated name", listen_port: 5102 };
    const added = pair("added", 4104);

    expect(
      diffProxyPairs([removed, updatedBefore, unchanged], [unchanged, updatedAfter, added]),
    ).toEqual({
      added: [added],
      removed: [removed],
      unchanged: [unchanged],
      updated: [{ before: updatedBefore, after: updatedAfter }],
    });
  });

  it("treats key-order-only object differences as unchanged", () => {
    const original = pair("same", 4201);
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as unknown as ProxyPair;
    expect(diffProxyPairs([original], [reordered])).toMatchObject({
      added: [],
      removed: [],
      updated: [],
      unchanged: [reordered],
    });
  });
});

describe("assertNoEnabledListenConflicts", () => {
  it("rejects equal and wildcard listen addresses on the same fixed port", () => {
    expect(() =>
      assertNoEnabledListenConflicts([pair("first", 4300), pair("second", 4300)]),
    ).toThrow(ProxyListenConflictError);
    expect(() =>
      assertNoEnabledListenConflicts([
        { ...pair("wildcard", 4301), listen_host: "0.0.0.0" },
        { ...pair("loopback", 4301), listen_host: "127.0.0.1" },
      ]),
    ).toThrow("loopback conflicts with wildcard");
  });

  it("allows dynamic ports, disabled pairs, and distinct fixed addresses", () => {
    expect(() =>
      assertNoEnabledListenConflicts([
        pair("dynamic-one", 0),
        pair("dynamic-two", 0),
        pair("enabled", 4302),
        { ...pair("disabled", 4302), enabled: false },
        { ...pair("ipv6", 4302), listen_host: "::1" },
      ]),
    ).not.toThrow();
  });
});

describe("resolveRuntimeLogRoot", () => {
  it("anchors relative log paths to the persistent application data directory", () => {
    expect(resolveRuntimeLogRoot("logs", "/portable/LLM Proxy")).toBe(
      path.resolve("/portable/LLM Proxy", "logs"),
    );
    expect(resolveRuntimeLogRoot("", "/portable/LLM Proxy")).toBeUndefined();
  });
});

function pair(id: string, port: number): ProxyPair {
  const value = createDefaultProxyPair("");
  return { ...value, id, name: id, enabled: true, listen_port: port };
}
