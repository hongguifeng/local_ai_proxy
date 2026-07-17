import { describe, expect, it } from "vitest";

import { requestModelFromBody } from "../../src/proxy/routing.js";

describe("requestModelFromBody", () => {
  it("extracts only a top-level string model", () => {
    expect(requestModelFromBody(Buffer.from('{"model":"gpt-5","nested":{"model":"wrong"}}'))).toBe(
      "gpt-5",
    );
    expect(requestModelFromBody(Buffer.from('{"model":""}'))).toBe("");
  });

  it.each([
    ["missing model", Buffer.from('{"messages":[]}')],
    ["nested model", Buffer.from('{"request":{"model":"nested"}}')],
    ["numeric model", Buffer.from('{"model":123}')],
    ["null model", Buffer.from('{"model":null}')],
    ["array body", Buffer.from('[{"model":"gpt-5"}]')],
    ["scalar body", Buffer.from('"gpt-5"')],
    ["invalid JSON", Buffer.from("{invalid")],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
  ])("returns undefined for %s", (_name, body) => {
    expect(requestModelFromBody(body)).toBeUndefined();
  });
});
