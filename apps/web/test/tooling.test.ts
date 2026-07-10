import { describe, expect, it } from "vitest";

import { webPackageName } from "../src/index.js";

describe("web toolchain", () => {
  it("loads an ESM TypeScript module", () => {
    expect(webPackageName).toBe("@llm-proxy/web");
  });
});
