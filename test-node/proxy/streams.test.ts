import { describe, expect, it } from "vitest";

import { bodyJsonValue } from "../../src/proxy/payload.js";
import { compactSseValue, parseSseEvents } from "../../src/proxy/streams.js";

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

describe("compactSseValue Responses text", () => {
  it("combines output text and reasoning deltas", () => {
    const text = [
      'data: {"type":"response.reasoning_text.delta","delta":"Think "}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"carefully"}',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      'data: {"type":"response.output_text.delta","delta":" world"}',
      "data: [DONE]",
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 4,
        done_seen: true,
        reasoning: "Think carefully",
        content: "Hello world",
      },
    });
    expect(bodyJsonValue({ text, size_bytes: Buffer.byteLength(text) })).toEqual(
      compactSseValue(text),
    );
  });

  it("uses done text only when no deltas were accumulated", () => {
    const text = [
      'data: {"type":"response.reasoning_text.done","text":"final reasoning"}',
      'data: {"type":"response.output_text.done","text":"final answer"}',
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 2,
        done_seen: false,
        reasoning: "final reasoning",
        content: "final answer",
      },
    });
  });
});

describe("compactSseValue Responses function calls", () => {
  it("merges argument deltas and parses completed JSON arguments", () => {
    const text = [
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","call_id":"call_1","output_index":0,"delta":"{\\"q\\":"}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"\\"docs\\"}"}',
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 2,
        done_seen: false,
        response_tool_calls: [
          {
            arguments: '{"q":"docs"}',
            item_id: "item_1",
            call_id: "call_1",
            output_index: 0,
            arguments_json: { q: "docs" },
          },
        ],
      },
    });
  });

  it("uses the done event's complete arguments", () => {
    const text = [
      'data: {"type":"response.function_call_arguments.delta","call_id":"call_2","delta":"partial"}',
      'data: {"type":"response.function_call_arguments.done","call_id":"call_2","arguments":"{\\"value\\":2}"}',
    ].join("\n\n");

    expect(compactSseValue(text)?.stream_summary["response_tool_calls"]).toEqual([
      {
        arguments: '{"value":2}',
        call_id: "call_2",
        arguments_json: { value: 2 },
      },
    ]);
  });
});

describe("compactSseValue Responses web search", () => {
  it("merges web search lifecycle events by item ID", () => {
    const text = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}',
      'data: {"type":"response.web_search_call.searching","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.web_search_call.completed","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"latest docs","queries":["latest docs"]}}}',
    ].join("\n\n");

    expect(compactSseValue(text)?.stream_summary["web_search_calls"]).toEqual([
      {
        type: "web_search_call",
        id: "ws_1",
        item_id: "ws_1",
        status: "completed",
        output_index: 0,
        action: { type: "search", query: "latest docs", queries: ["latest docs"] },
      },
    ]);
  });
});

describe("compactSseValue Responses metadata", () => {
  it("compacts response metadata, usage, and completion status", () => {
    const text = [
      'data: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":123,"status":"in_progress","model":"gpt-5","previous_response_id":"resp_0","output":[{"type":"message","content":"large"}],"extra":"discard"}}',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}',
      "data: [DONE]",
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 3,
        done_seen: true,
        content: "Hello",
        finish_reasons: ["completed"],
        usage: { input_tokens: 3, output_tokens: 2 },
        response: {
          id: "resp_1",
          object: "response",
          created_at: 123,
          status: "completed",
          model: "gpt-5",
          previous_response_id: "resp_0",
        },
      },
    });
  });

  it("retains incomplete details and web searches found in response output", () => {
    const text =
      'data: {"type":"response.incomplete","response":{"id":"resp_2","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"id":"ws_2","type":"web_search_call","status":"completed","action":{"type":"search","query":"docs"}}]}}';

    const summary = compactSseValue(text)?.stream_summary;
    expect(summary?.["response"]).toEqual({
      id: "resp_2",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(summary?.["web_search_calls"]).toEqual([
      {
        type: "web_search_call",
        id: "ws_2",
        item_id: "ws_2",
        output_index: 0,
        action: { type: "search", query: "docs" },
        status: "completed",
      },
    ]);
  });
});
