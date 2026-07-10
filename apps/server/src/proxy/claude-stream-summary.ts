import {
  DEFAULT_OPENAI_SUMMARY_LIMITS,
  type OpenAiSummaryLimits,
  type StreamSummary,
} from "./openai-stream-summary.js";
import { sanitizeJsonValue, type SanitizedJsonValue } from "./redaction.js";
import { SseParser, type SseEvent, type SseParserDiagnostic } from "./sse-parser.js";

interface ClaudeToolCall {
  index: number;
  type: "tool_use";
  id?: string;
  name?: string;
  input?: SanitizedJsonValue;
  input_json?: string;
}

const MAX_SUMMARY_ITEMS = 20;

export class ClaudeStreamSummarizer {
  readonly #parser = new SseParser();
  readonly #limits: OpenAiSummaryLimits;
  readonly #content: string[] = [];
  readonly #reasoning: string[] = [];
  readonly #finishReasons: string[] = [];
  readonly #tools = new Map<number, ClaudeToolCall>();
  readonly #warnings: string[] = [];
  #contentChars = 0;
  #reasoningChars = 0;
  #summaryChars = 0;
  #eventCount = 0;
  #doneSeen = false;
  #truncated = false;
  #usage: Record<string, SanitizedJsonValue> | undefined;
  #response: Record<string, SanitizedJsonValue> | undefined;
  #finished = false;

  public constructor(limits: OpenAiSummaryLimits = DEFAULT_OPENAI_SUMMARY_LIMITS) {
    assertLimits(limits);
    this.#limits = limits;
  }

  public push(chunk: Uint8Array): void {
    if (!this.#finished) this.#consume(this.#parser.push(chunk));
  }

  public finish(): StreamSummary {
    if (!this.#finished) {
      this.#consume(this.#parser.finish());
      this.#finished = true;
    }
    return this.summary();
  }

  public summary(): StreamSummary {
    const summary: Record<string, unknown> = { event_count: this.#eventCount, done_seen: this.#doneSeen };
    if (this.#reasoning.length > 0) summary.reasoning = this.#reasoning.join("");
    if (this.#content.length > 0) summary.content = this.#content.join("");
    const tools = [...this.#tools.values()].sort((left, right) => left.index - right.index).map(finalizeTool);
    if (tools.length > 0) summary.claude_tool_calls = tools;
    if (this.#finishReasons.length > 0) summary.finish_reasons = this.#finishReasons;
    if (this.#usage) summary.usage = this.#usage;
    if (this.#response) summary.response = this.#response;
    if (this.#truncated) summary.truncated = true;
    if (this.#warnings.length > 0) summary.warnings = this.#warnings;
    return { stream_summary: summary };
  }

  #consume(output: Readonly<{ events: readonly SseEvent[]; diagnostics: readonly SseParserDiagnostic[] }>): void {
    for (const diagnostic of output.diagnostics) this.#warn(`sse_${diagnostic.code}`);
    for (const event of output.events) {
      if (event.done) {
        this.#doneSeen = true;
        continue;
      }
      if (this.#eventCount >= this.#limits.maxEvents) {
        this.#truncate("event_limit");
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data) as unknown;
      } catch {
        this.#warn("invalid_json_event");
        continue;
      }
      this.#eventCount += 1;
      const payload = asObject(value);
      if (!payload || typeof payload.type !== "string") continue;
      this.#addEvent(payload.type, payload);
    }
  }

  #addEvent(type: string, event: Record<string, unknown>): void {
    if (type === "message_start") this.#messageStart(event);
    else if (type === "content_block_start") this.#blockStart(event);
    else if (type === "content_block_delta") this.#blockDelta(event);
    else if (type === "message_delta") this.#messageDelta(event);
    else if (!["content_block_stop", "message_stop", "ping"].includes(type)) this.#warn("unknown_claude_event");
  }

  #messageStart(event: Record<string, unknown>): void {
    const message = asObject(event.message);
    if (!message) return;
    const response: Record<string, SanitizedJsonValue> = Object.create(null) as Record<string, SanitizedJsonValue>;
    for (const key of ["id", "type", "role", "model", "stop_reason", "stop_sequence"])
      if (message[key] !== undefined) response[key] = boundedJson(message[key]);
    const usage = boundedObject(message.usage);
    if (usage) {
      response.usage = usage;
      this.#usage = { ...usage };
    }
    if (Object.keys(response).length > 0) this.#response = response;
  }

  #blockStart(event: Record<string, unknown>): void {
    const block = asObject(event.content_block);
    if (!block) return;
    if (block.type === "text") this.#append(this.#content, "content", block.text);
    else if (block.type === "thinking") this.#append(this.#reasoning, "reasoning", block.thinking);
    else if (block.type === "tool_use") {
      const tool = this.#tool(event.index);
      if (!tool) return;
      if (typeof block.id === "string") tool.id = block.id.slice(0, 2_000);
      if (typeof block.name === "string") tool.name = block.name.slice(0, 2_000);
      if (block.input !== undefined) tool.input = boundedJson(block.input);
    } else this.#warn("unknown_content_block");
  }

  #blockDelta(event: Record<string, unknown>): void {
    const delta = asObject(event.delta);
    if (!delta) return;
    if (delta.type === "text_delta") this.#append(this.#content, "content", delta.text);
    else if (delta.type === "thinking_delta") this.#append(this.#reasoning, "reasoning", delta.thinking);
    else if (delta.type === "input_json_delta") {
      const tool = this.#tool(event.index);
      if (tool && typeof delta.partial_json === "string") {
        tool.input_json = this.#appendArgument(tool.input_json ?? "", delta.partial_json);
      }
    } else this.#warn("unknown_content_delta");
  }

  #messageDelta(event: Record<string, unknown>): void {
    const delta = asObject(event.delta);
    if (typeof delta?.stop_reason === "string" && delta.stop_reason) this.#addFinishReason(delta.stop_reason);
    const usage = boundedObject(event.usage);
    if (usage) this.#usage = { ...(this.#usage ?? {}), ...usage };
  }

  #tool(rawIndex: unknown): ClaudeToolCall | null {
    const index = typeof rawIndex === "number" && Number.isInteger(rawIndex) ? rawIndex : 0;
    const existing = this.#tools.get(index);
    if (existing) return existing;
    if (this.#tools.size >= MAX_SUMMARY_ITEMS) {
      this.#truncate("tool_call_item_limit");
      return null;
    }
    const tool: ClaudeToolCall = { index, type: "tool_use" };
    this.#tools.set(index, tool);
    return tool;
  }

  #append(parts: string[], kind: "content" | "reasoning", value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    const used = kind === "content" ? this.#contentChars : this.#reasoningChars;
    const allowed = Math.min(this.#limits.maxTextChars - used, this.#limits.maxSummaryChars - this.#summaryChars);
    const piece = value.slice(0, Math.max(0, allowed));
    if (piece) parts.push(piece);
    if (kind === "content") this.#contentChars += piece.length;
    else this.#reasoningChars += piece.length;
    this.#summaryChars += piece.length;
    if (piece.length < value.length) this.#truncate(`${kind}_limit`);
  }

  #appendArgument(current: string, delta: string): string {
    const allowed = Math.min(
      this.#limits.maxToolArgumentChars - current.length,
      this.#limits.maxSummaryChars - this.#summaryChars,
    );
    const piece = delta.slice(0, Math.max(0, allowed));
    this.#summaryChars += piece.length;
    if (piece.length < delta.length) this.#truncate("tool_argument_limit");
    return current + piece;
  }

  #addFinishReason(value: string): void {
    if (this.#finishReasons.length >= MAX_SUMMARY_ITEMS) this.#truncate("finish_reason_item_limit");
    else this.#finishReasons.push(value.slice(0, 2_000));
  }

  #truncate(code: string): void {
    this.#truncated = true;
    this.#warn(code);
  }

  #warn(code: string): void {
    if (this.#warnings.length < this.#limits.maxWarnings && !this.#warnings.includes(code)) this.#warnings.push(code);
  }
}

function finalizeTool(tool: ClaudeToolCall): ClaudeToolCall {
  if (tool.input_json) {
    try {
      tool.input = boundedJson(JSON.parse(tool.input_json) as unknown);
      delete tool.input_json;
    } catch {
      // Keep the bounded partial JSON string when the stream ended before the value was complete.
    }
  }
  return tool;
}

function boundedJson(value: unknown): SanitizedJsonValue {
  return sanitizeJsonValue(value, { maxDepth: 16, maxItems: 1_000, maxStringBytes: 256 * 1024 });
}

function boundedObject(value: unknown): Record<string, SanitizedJsonValue> | null {
  const bounded = boundedJson(value);
  return bounded !== null && typeof bounded === "object" && !Array.isArray(bounded) ? bounded : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertLimits(limits: OpenAiSummaryLimits): void {
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}
