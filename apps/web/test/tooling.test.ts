import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "@llm-proxy/contracts";

import { webPackageName } from "../src/index.js";

describe("web toolchain", () => {
  it("loads an ESM TypeScript module", () => {
    expect(webPackageName).toBe("@llm-proxy/web");
    expect(
      ErrorEnvelopeSchema.parse({ error: { code: "TEST", message: "test" }, requestId: "request-1" }).requestId,
    ).toBe("request-1");
  });
});
