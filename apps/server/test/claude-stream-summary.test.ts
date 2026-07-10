import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ClaudeStreamSummarizer } from "../src/proxy/claude-stream-summary.js";

describe("Claude stream summary", () => {
  it("matches the language-neutral Claude fixture across chunk boundaries", async () => {
    const bytes = await readFile(
      new URL("../../../packages/test-fixtures/streams/claude-messages.sse", import.meta.url),
    );
    const expected = JSON.parse(
      await readFile(
        new URL("../../../packages/test-fixtures/streams/claude-messages.expected.json", import.meta.url),
        "utf8",
      ),
    ) as { expected: unknown };
    const summarizer = new ClaudeStreamSummarizer();
    for (let offset = 0; offset < bytes.length; offset += 5) summarizer.push(bytes.subarray(offset, offset + 5));
    expect(summarizer.finish()).toEqual(expected.expected);
  });

  it("handles out-of-order tool deltas and incomplete JSON", () => {
    const complete = summarize(
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"docs\\"}"}}\n\n' +
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup"}}\n\n',
    );
    expect(complete).toMatchObject({
      stream_summary: { claude_tool_calls: [{ index: 2, type: "tool_use", id: "tool-1", input: { q: "docs" } }] },
    });

    const incomplete = summarize(
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"}}\n\n',
    );
    expect(incomplete).toMatchObject({
      stream_summary: { claude_tool_calls: [{ index: 1, type: "tool_use", input_json: "{" }] },
    });
  });

  it("merges message usage and tolerates unknown or missing events", () => {
    const result = summarize(
      'data: {"type":"message_start","message":{"id":"msg","usage":{"input_tokens":3}}}\n\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"image"}}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    );
    expect(result).toMatchObject({
      stream_summary: {
        usage: { input_tokens: 3, output_tokens: 2 },
        finish_reasons: ["end_turn"],
        warnings: ["unknown_content_block"],
      },
    });
  });

  it("applies shared text, event, argument, and diagnostic limits", () => {
    const summarizer = new ClaudeStreamSummarizer({
      maxEvents: 1,
      maxTextChars: 3,
      maxToolArgumentChars: 2,
      maxSummaryChars: 3,
      maxWarnings: 2,
    });
    summarizer.push(
      Buffer.from(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"abcdef"}}\n\n' +
          "data: {bad}\n\n" +
          'data: {"type":"message_stop"}\n\n',
      ),
    );
    expect(summarizer.finish()).toMatchObject({
      stream_summary: {
        event_count: 1,
        content: "abc",
        truncated: true,
        warnings: ["content_limit", "event_limit"],
      },
    });
  });
});

function summarize(text: string): Readonly<Record<string, unknown>> {
  const summarizer = new ClaudeStreamSummarizer();
  summarizer.push(Buffer.from(text));
  return summarizer.finish();
}
