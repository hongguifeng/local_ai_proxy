import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OpenAiStreamSummarizer } from "../src/proxy/openai-stream-summary.js";

const fixtures = ["openai-chat", "openai-completions", "openai-responses"] as const;

describe("OpenAI stream summary", () => {
  it("matches every language-neutral OpenAI fixture with incremental chunks", async () => {
    for (const name of fixtures) {
      const bytes = await readFile(new URL(`../../../packages/test-fixtures/streams/${name}.sse`, import.meta.url));
      const expected = JSON.parse(
        await readFile(
          new URL(`../../../packages/test-fixtures/streams/${name}.expected.json`, import.meta.url),
          "utf8",
        ),
      ) as { expected: unknown };
      const summarizer = new OpenAiStreamSummarizer();
      for (let offset = 0; offset < bytes.length; offset += 7) summarizer.push(bytes.subarray(offset, offset + 7));
      expect(summarizer.finish()).toEqual(expected.expected);
    }
  });

  it("merges Chat Completions tool call argument deltas", () => {
    const summary = summarize(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"city\\":"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Shanghai\\"}"}}]}}]}\n\n',
    );
    expect(summary).toMatchObject({
      stream_summary: {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            function: { name: "lookup", arguments: '{"city":"Shanghai"}', arguments_json: { city: "Shanghai" } },
          },
        ],
      },
    });
  });

  it("summarizes web search events and ignores unknown response events", () => {
    const summary = summarize(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}\n\n' +
        'data: {"type":"response.web_search_call.completed","item_id":"ws_1","output_index":0}\n\n' +
        'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"mcp_1","type":"mcp_call"}}\n\n',
    );
    expect(summary).toMatchObject({
      stream_summary: {
        event_count: 3,
        web_search_calls: [
          { type: "web_search_call", id: "ws_1", item_id: "ws_1", output_index: 0, status: "completed" },
        ],
      },
    });
  });

  it("bounds event text, arguments, warning count, and malformed events", () => {
    const summarizer = new OpenAiStreamSummarizer({
      maxEvents: 2,
      maxTextChars: 5,
      maxToolArgumentChars: 4,
      maxSummaryChars: 10,
      maxWarnings: 2,
    });
    summarizer.push(
      Buffer.from(
        'data: {"choices":[{"delta":{"content":"abcdefgh"}}]}\n\n' +
          "data: {bad}\n\n" +
          'data: {"choices":[{"delta":{"text":"more"}}]}\n\n' +
          'data: {"choices":[{"delta":{"text":"ignored"}}]}\n\n',
      ),
    );
    const result = summarizer.finish();
    expect(result).toMatchObject({ stream_summary: { event_count: 2, content: "abcde", truncated: true } });
    const streamSummary = result.stream_summary as Record<string, unknown>;
    expect(Array.isArray(streamSummary.warnings)).toBe(true);
    expect(JSON.stringify(summarizer.summary()).length).toBeLessThan(500);
  });

  it("preserves parser diagnostics and validates limits", () => {
    const summarizer = new OpenAiStreamSummarizer();
    summarizer.push(Uint8Array.from([0xff, 0x0a]));
    expect(summarizer.finish()).toMatchObject({ stream_summary: { warnings: ["sse_invalid_utf8"] } });
    expect(
      () =>
        new OpenAiStreamSummarizer({
          maxEvents: 0,
          maxTextChars: 1,
          maxToolArgumentChars: 1,
          maxSummaryChars: 1,
          maxWarnings: 1,
        }),
    ).toThrow(RangeError);
  });
});

function summarize(text: string): Readonly<Record<string, unknown>> {
  const summarizer = new OpenAiStreamSummarizer();
  summarizer.push(Buffer.from(text));
  return summarizer.finish();
}
