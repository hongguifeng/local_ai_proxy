import { describe, expect, it } from "vitest";

import { contractsPackageName } from "../src/index.js";

describe("contracts toolchain", () => {
  it("loads an ESM TypeScript module", () => {
    expect(contractsPackageName).toBe("@llm-proxy/contracts");
  });
});
