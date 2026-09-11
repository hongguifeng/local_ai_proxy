import { describe, expect, it } from "vitest";

import { UsageAccumulator } from "../../src/pricing/index.js";

function capture(kind: "responses" | "chat" | "messages", text: string, chunkSize = text.length) {
  const accumulator = new UsageAccumulator(kind);
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    accumulator.addChunk(Buffer.from(text.slice(offset, offset + chunkSize)));
  }
  return accumulator.finalize();
}

describe("UsageAccumulator", () => {
  it("captures Responses completed and incomplete terminal usage across arbitrary chunks", () => {
    for (const type of ["response.completed", "response.incomplete"]) {
      expect(
        capture(
          "responses",
          `data: {"type":"${type}","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n`,
          3,
        ),
      ).toMatchObject({
        status: "complete",
        terminalSeen: true,
        usage: { inputUncachedTokens: 3, outputTokens: 2 },
      });
    }
  });

  it("requires a Chat terminal marker and does not add repeated usage", () => {
    const event = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n';
    expect(capture("chat", `${event}${event}data: [DONE]\n\n`, 5)).toMatchObject({
      status: "complete",
      usage: { inputUncachedTokens: 3, outputTokens: 2 },
    });
    expect(capture("chat", event)).toMatchObject({ reason: "incomplete_usage" });
  });

  it("merges Anthropic start input with final delta output", () => {
    const stream = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":2}}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":4,"cache_creation_input_tokens":1}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");
    expect(capture("messages", stream, 7)).toMatchObject({
      status: "complete",
      usage: { inputUncachedTokens: 3, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
  });

  it("recovers after an oversized event and reports incomplete observation", () => {
    const accumulator = new UsageAccumulator("chat", 32);
    accumulator.addChunk(Buffer.from(`data: ${"x".repeat(40)}\n\ndata: [DONE]\n\n`));
    expect(accumulator.finalize()).toMatchObject({
      status: "unavailable",
      reason: "incomplete_usage",
      eventTruncated: true,
    });
  });
});
