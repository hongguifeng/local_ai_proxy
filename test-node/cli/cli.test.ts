import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../../src/cli/index.js";

describe("parseCliArgs", () => {
  it("uses the loopback host by default", () => {
    expect(parseCliArgs([]).host).toBe("127.0.0.1");
  });

  it("parses --host", () => {
    expect(parseCliArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
  });

  it("parses and validates --port", () => {
    expect(parseCliArgs([]).port).toBe(8088);
    expect(parseCliArgs(["--port", "9090"]).port).toBe(9090);
    expect(() => parseCliArgs(["--port", "abc"])).toThrow("integer TCP port");
    expect(() => parseCliArgs(["--port", "65536"])).toThrow("between 1 and 65535");
  });

  it("rejects a missing host", () => {
    expect(() => parseCliArgs(["--host"])).toThrow("Option --host requires a value.");
  });
});
