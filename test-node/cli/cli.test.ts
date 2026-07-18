import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../../src/cli/index.js";

describe("parseCliArgs", () => {
  it("uses the loopback host by default", () => {
    expect(parseCliArgs([]).host).toBe("127.0.0.1");
  });

  it("parses --host", () => {
    expect(parseCliArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
  });

  it("rejects a missing host", () => {
    expect(() => parseCliArgs(["--host"])).toThrow("Option --host requires a value.");
  });
});
