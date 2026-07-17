import { describe, expect, it } from "vitest";

import { HOP_BY_HOP_HEADERS } from "../../src/proxy/headers.js";

describe("HOP_BY_HOP_HEADERS", () => {
  it("matches the Python proxy hop-by-hop header set", () => {
    expect([...HOP_BY_HOP_HEADERS].sort()).toEqual([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
  });
});
