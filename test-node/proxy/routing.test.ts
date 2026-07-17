import { describe, expect, it } from "vitest";

import {
  requestModelFromBody,
  selectTargetByModel,
  type RoutingTarget,
} from "../../src/proxy/routing.js";

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

describe("selectTargetByModel", () => {
  it("selects the first matching target and first matching mapping in configuration order", () => {
    const first = target("first", true, [
      { listen: "demo", upstream: "first-upstream" },
      { listen: "demo", upstream: "ignored-duplicate" },
    ]);
    const second = target("second", true, [{ listen: "demo", upstream: "second-upstream" }]);

    const selection = selectTargetByModel(
      [first, second],
      "second",
      Buffer.from('{"model":"demo"}'),
    );

    expect(selection).toEqual({
      target: first,
      requestModel: "demo",
      upstreamModel: "first-upstream",
    });
    expect(selection.target).toBe(first);
  });

  it("requires at least one target", () => {
    expect(() => selectTargetByModel([], "missing", Buffer.from("{}"))).toThrow(
      "ProxyServer config must include at least one target.",
    );
  });

  it("skips a disabled matching target when it is not the default", () => {
    const disabled = target("disabled", false, [
      { listen: "demo", upstream: "disabled-upstream" },
    ]);
    const enabled = target("enabled", true, [{ listen: "demo", upstream: "enabled-upstream" }]);
    const fallback = target("fallback", true, []);

    const selection = selectTargetByModel(
      [disabled, enabled, fallback],
      "fallback",
      Buffer.from('{"model":"demo"}'),
    );

    expect(selection.target).toBe(enabled);
    expect(selection.upstreamModel).toBe("enabled-upstream");
  });
});

function target(
  id: string,
  enabled: boolean,
  modelMappings: RoutingTarget["model_mappings"],
): RoutingTarget {
  return { id, enabled, model_mappings: modelMappings };
}
