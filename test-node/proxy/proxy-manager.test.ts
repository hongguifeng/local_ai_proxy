import { describe, expect, it } from "vitest";

import { createDefaultProxyPair, type ProxyPair } from "../../src/config/index.js";
import { diffProxyPairs } from "../../src/proxy/index.js";

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

function pair(id: string, port: number): ProxyPair {
  const value = createDefaultProxyPair("");
  return { ...value, id, name: id, listen_port: port };
}
