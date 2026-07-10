import { describe, expect, it } from "vitest";

import { serverPackageName } from "../src/index.js";

describe("server toolchain", () => {
  it("loads an ESM TypeScript module", () => {
    expect(serverPackageName).toBe("@llm-proxy/server");
  });
});
