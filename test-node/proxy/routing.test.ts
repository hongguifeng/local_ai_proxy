import { describe, expect, it } from "vitest";

import {
  modelPatternMatches,
  requestModelFromBody,
  rewriteRequestModel,
  selectTargetByModel,
  type RoutingTarget,
} from "../../src/proxy/routing.js";

describe("modelPatternMatches", () => {
  it.each([
    ["gpt-5.5", "gpt-5.5", true],
    ["gpt-5.5", "hyper-gpt-5.5", false],
    ["*gpt-5.5*", "hyper-gpt-5.5", true],
    ["*gpt-5.5*", "hyper-gpt-5.5-test", true],
    ["gpt-*-mini", "gpt-5.5-mini", true],
    ["gpt-*-mini", "prefix-gpt-5.5-mini", false],
    ["*", "any-model", true],
    ["GPT-*", "gpt-5.5", false],
    ["model.*", "model.test", true],
    ["model.*", "model-test", false],
  ])("matches %j against %j as %s", (pattern, model, expected) => {
    expect(modelPatternMatches(pattern, model)).toBe(expected);
  });
});

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
    const disabled = target("disabled", false, [{ listen: "demo", upstream: "disabled-upstream" }]);
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

  it("always falls back to the configured default target", () => {
    const first = target("first", true, []);
    const fallback = target("fallback", false, []);

    expect(
      selectTargetByModel([first, fallback], "fallback", Buffer.from('{"model":"unknown"}')).target,
    ).toBe(fallback);
    expect(selectTargetByModel([first, fallback], "fallback", Buffer.from("{}")).target).toBe(
      fallback,
    );
    expect(
      selectTargetByModel([first, fallback], "missing", Buffer.from('{"model":"unknown"}')).target,
    ).toBe(first);
  });

  it("allows a disabled default target to match and rewrite a model", () => {
    const enabled = target("enabled", true, []);
    const fallback = target("fallback", false, [{ listen: "demo", upstream: "fallback-upstream" }]);

    const selection = selectTargetByModel(
      [enabled, fallback],
      "fallback",
      Buffer.from('{"model":"demo"}'),
    );

    expect(selection.target).toBe(fallback);
    expect(selection.upstreamModel).toBe("fallback-upstream");
  });

  it("routes wildcard mappings and rewrites them to the configured upstream model", () => {
    const wildcard = target("wildcard", true, [{ listen: "*gpt-5.5*", upstream: "gpt-5.5" }]);
    const fallback = target("fallback", true, []);

    for (const model of ["hyper-gpt-5.5", "hyper-gpt-5.5-test"]) {
      const selection = selectTargetByModel(
        [wildcard, fallback],
        "fallback",
        Buffer.from(JSON.stringify({ model })),
      );

      expect(selection.target).toBe(wildcard);
      expect(selection.upstreamModel).toBe("gpt-5.5");
    }
  });

  it("preserves the requested model when a wildcard mapping keeps the same name", () => {
    const wildcard = target("wildcard", true, [{ listen: "prefix-*", upstream: "prefix-*" }]);

    const selection = selectTargetByModel(
      [wildcard],
      "wildcard",
      Buffer.from('{"model":"prefix-model"}'),
    );

    expect(selection.upstreamModel).toBe("prefix-model");
  });
});

function target(
  id: string,
  enabled: boolean,
  modelMappings: RoutingTarget["model_mappings"],
): RoutingTarget {
  return { id, enabled, model_mappings: modelMappings };
}

describe("rewriteRequestModel", () => {
  it("rewrites the top-level model as compact UTF-8 JSON", () => {
    const rewritten = rewriteRequestModel(
      Buffer.from('{ "model": "本地", "messages": [] }'),
      "上游模型",
    );

    expect(Buffer.from(rewritten).toString("utf8")).toBe('{"model":"上游模型","messages":[]}');
  });

  it.each([
    ["no upstream model", Buffer.from('{"model":"local"}'), undefined],
    ["empty upstream model", Buffer.from('{"model":"local"}'), ""],
    ["invalid JSON", Buffer.from("{invalid"), "upstream"],
    ["JSON array", Buffer.from('[{"model":"local"}]'), "upstream"],
    ["JSON scalar", Buffer.from('"local"'), "upstream"],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "upstream"],
  ])("preserves %s unchanged", (_name, body, upstreamModel) => {
    expect(rewriteRequestModel(body, upstreamModel)).toBe(body);
  });
});
