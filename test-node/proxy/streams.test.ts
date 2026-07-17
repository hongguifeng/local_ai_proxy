import { describe, expect, it } from "vitest";

import { parseSseEvents } from "../../src/proxy/streams.js";

describe("parseSseEvents", () => {
  it("parses JSON data lines and tracks the DONE marker", () => {
    expect(
      parseSseEvents(
        [
          "event: response.output_text.delta",
          ' data: {"type":"response.output_text.delta","delta":"Hello"} ',
          "",
          ": keep-alive",
          "data: [1,2,3]",
          "data: [DONE]",
          "",
        ].join("\r\n"),
      ),
    ).toEqual({
      events: [{ type: "response.output_text.delta", delta: "Hello" }, [1, 2, 3]],
      doneSeen: true,
    });
  });

  it("ignores empty data and non-data lines", () => {
    expect(parseSseEvents('id: 1\ndata:\ndata: {"ok":true}')).toEqual({
      events: [{ ok: true }],
      doneSeen: false,
    });
  });

  it.each(["", "data: [DONE]\n\n", "event: ping\n\n"])(
    "returns undefined when there are no JSON events for %j",
    (text) => {
      expect(parseSseEvents(text)).toBeUndefined();
    },
  );
});
