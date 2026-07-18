import { describe, expect, it } from "vitest";

import { parseTrayOptions } from "../../electron/tray-options.js";

describe("parseTrayOptions", () => {
  it("supports --open-on-start without passing it to the CLI parser", () => {
    const result = parseTrayOptions(["--open-on-start", "--port", "9090"], {});
    expect(result.openOnStart).toBe(true);
    expect(result.cli.port).toBe(9090);
  });

  it("supports LLM_PROXY_OPEN_ON_START", () => {
    expect(parseTrayOptions([], { LLM_PROXY_OPEN_ON_START: "1" }).openOnStart).toBe(true);
    expect(parseTrayOptions([], { LLM_PROXY_OPEN_ON_START: "0" }).openOnStart).toBe(false);
  });
});
