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

describe("compactSseValue Chat content", () => {
  it("combines content, reasoning, finish reasons, and usage", () => {
    const text = [
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
      'data: {"choices":[{"message":{"reasoning":"more ","content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"reasoning_text":"done","text":" world"},"finish_reason":"stop"}],"usage":{"total_tokens":9}}',
      "data: [DONE]",
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 3,
        done_seen: true,
        reasoning: "think more done",
        content: "Hello world",
        finish_reasons: ["stop"],
        usage: { total_tokens: 9 },
      },
    });
  });
});

describe("compactSseValue Chat tool calls", () => {
  it("merges indexed tool call deltas and parses argument JSON", () => {
    const text = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"city\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Shanghai\\"}"}}]}}]}',
    ].join("\n\n");

    expect(compactSseValue(text)?.stream_summary["tool_calls"]).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: {
          name: "lookup",
          arguments: '{"city":"Shanghai"}',
          arguments_json: { city: "Shanghai" },
        },
      },
    ]);
  });
});

describe("compactSseValue Claude content", () => {
  it("combines text, thinking, tool metadata, and input JSON deltas", () => {
    const text = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"plan "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"carefully"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":"Hello "}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"world"}}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"docs\\"}"}}',
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 7,
        done_seen: false,
        reasoning: "plan carefully",
        content: "Hello world",
        claude_tool_calls: [
          {
            index: 2,
            type: "tool_use",
            id: "toolu_1",
            name: "lookup",
            input: { q: "docs" },
          },
        ],
      },
    });
  });
});

describe("compactSseValue Claude metadata", () => {
  it("compacts message metadata and merges usage at stop", () => {
    const text = [
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","stop_reason":null,"usage":{"input_tokens":8},"content":[{"type":"text","text":"large"}]}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      "data: [DONE]",
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: {
        event_count: 3,
        done_seen: true,
        content: "Hello",
        finish_reasons: ["end_turn"],
        usage: { input_tokens: 8, output_tokens: 5 },
        response: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4",
          stop_reason: null,
          usage: { input_tokens: 8 },
        },
      },
    });
  });
});

describe("compactSseValue unknown events", () => {
  it("preserves unknown ordinary payloads and Claude errors", () => {
    const text = [
      'data: {"fixture_unknown":"preserved"}',
      'data: {"type":"error","error":{"type":"fixture_error"}}',
      'data: "scalar payload"',
    ].join("\n\n");

    expect(compactSseValue(text)?.stream_summary["other_payloads"]).toEqual([
      { fixture_unknown: "preserved" },
      { type: "error", error: { type: "fixture_error" } },
      "scalar payload",
    ]);
  });

  it("ignores unknown Responses and Claude housekeeping events", () => {
    const text = [
      'data: {"type":"response.future.event","value":"ignored"}',
      'data: {"type":"response.output_item.done","item":{"type":"mcp_call"}}',
      'data: {"type":"ping"}',
      'data: {"type":"message_stop"}',
      'data: {"type":"content_block_stop","index":0}',
    ].join("\n\n");

    expect(compactSseValue(text)).toEqual({
      stream_summary: { event_count: 5, done_seen: false },
    });
  });
});
