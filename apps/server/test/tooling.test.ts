import { describe, expect, it } from "vitest";
import { ConfigV1Schema } from "@llm-proxy/contracts";

import { serverPackageName } from "../src/index.js";

describe("server toolchain", () => {
  it("loads an ESM TypeScript module", () => {
    expect(serverPackageName).toBe("@llm-proxy/server");
    expect(ConfigV1Schema.parse({ version: 1 }).proxies).toEqual([]);
  });
});
