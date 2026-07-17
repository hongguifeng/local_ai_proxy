import { describe, expect, it } from "vitest";

import { bodyJsonValue } from "../../src/proxy/payload.js";
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

  it("falls back to an ordinary text payload when any data line is not JSON", () => {
    const text = 'data: {"ok":true}\n\ndata: not-json\n\n';

    expect(parseSseEvents(text)).toBeUndefined();
    expect(bodyJsonValue({ text, size_bytes: Buffer.byteLength(text) })).toEqual({
      text,
      size_bytes: Buffer.byteLength(text),
    });
  });
});
