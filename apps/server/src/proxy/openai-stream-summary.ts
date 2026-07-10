import { sanitizeJsonValue, type SanitizedJsonValue } from "./redaction.js";
import { SseParser, type SseEvent, type SseParserDiagnostic } from "./sse-parser.js";

export type OpenAiSummaryLimits = Readonly<{
  maxEvents: number;
  maxTextChars: number;
  maxToolArgumentChars: number;
  maxSummaryChars: number;
  maxWarnings: number;
}>;

export const DEFAULT_OPENAI_SUMMARY_LIMITS: OpenAiSummaryLimits = Object.freeze({
  maxEvents: 10_000,
  maxTextChars: 256 * 1024,
  maxToolArgumentChars: 256 * 1024,
  maxSummaryChars: 1024 * 1024,
  maxWarnings: 100,
});

export type StreamSummary = Readonly<Record<string, unknown>>;
const MAX_SUMMARY_ITEMS = 20;

interface MutableToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string; arguments_json?: SanitizedJsonValue };
}

export class OpenAiStreamSummarizer {
  readonly #parser = new SseParser();
  readonly #limits: OpenAiSummaryLimits;
  readonly #content: string[] = [];
  readonly #reasoning: string[] = [];
  readonly #finishReasons: string[] = [];
  readonly #chatToolCalls = new Map<number, MutableToolCall>();
  readonly #responseToolCalls = new Map<string, Record<string, unknown>>();
  readonly #webSearchCalls = new Map<string, Record<string, unknown>>();
  readonly #warnings: string[] = [];
  #contentChars = 0;
  #reasoningChars = 0;
  #summaryChars = 0;
  #eventCount = 0;
  #doneSeen = false;
  #truncated = false;
  #usage: SanitizedJsonValue | undefined;
  #response: Record<string, SanitizedJsonValue> | undefined;
  #finished = false;

  public constructor(limits: OpenAiSummaryLimits = DEFAULT_OPENAI_SUMMARY_LIMITS) {
    assertLimits(limits);
    this.#limits = limits;
  }

  public push(chunk: Uint8Array): void {
    if (this.#finished) return;
    this.#consume(this.#parser.push(chunk));
  }

  public finish(): StreamSummary {
    if (!this.#finished) {
      this.#consume(this.#parser.finish());
      this.#finished = true;
    }
    return this.summary();
  }

  public summary(): StreamSummary {
    const summary: Record<string, unknown> = {
      event_count: this.#eventCount,
      done_seen: this.#doneSeen,
    };
    if (this.#reasoning.length > 0) summary.reasoning = this.#reasoning.join("");
    if (this.#content.length > 0) summary.content = this.#content.join("");
    const responseTools = [...this.#responseToolCalls.values()].map(finalizeArguments);
    if (responseTools.length > 0) summary.response_tool_calls = responseTools;
    const webSearch = [...this.#webSearchCalls.values()];
    if (webSearch.length > 0) summary.web_search_calls = webSearch;
    const chatTools = [...this.#chatToolCalls.values()].sort((left, right) => left.index - right.index);
    if (chatTools.length > 0) summary.tool_calls = chatTools.map(finalizeChatToolCall);
    if (this.#finishReasons.length > 0) summary.finish_reasons = this.#finishReasons;
    if (this.#usage !== undefined) summary.usage = this.#usage;
    if (this.#response !== undefined) summary.response = this.#response;
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
      let payload: unknown;
      try {
        payload = JSON.parse(event.data) as unknown;
      } catch {
        this.#warn("invalid_json_event");
        continue;
      }
      this.#eventCount += 1;
      const object = asObject(payload);
      if (!object) continue;
      const type = typeof object.type === "string" ? object.type : "";
      if (type.startsWith("response.")) this.#addResponseEvent(type, object);
      else this.#addChatEvent(object);
    }
  }

  #addResponseEvent(type: string, event: Record<string, unknown>): void {
    if (type === "response.output_text.delta") this.#append(this.#content, "content", event.delta);
    else if (type === "response.output_text.done" && this.#content.length === 0)
      this.#append(this.#content, "content", event.text);
    else if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta")
      this.#append(this.#reasoning, "reasoning", event.delta);
    else if (
      (type === "response.reasoning_text.done" || type === "response.reasoning_summary_text.done") &&
      this.#reasoning.length === 0
    )
      this.#append(this.#reasoning, "reasoning", event.text);
    else if (type === "response.function_call_arguments.delta") this.#addResponseToolDelta(event);
    else if (type === "response.function_call_arguments.done") this.#addResponseToolDone(event);
    else if (type === "response.created") this.#mergeResponse(event.response);
    else if (type === "response.completed" || type === "response.incomplete") this.#completeResponse(event.response);
    else if (this.#isWebSearch(type, event)) this.#addWebSearch(type, event);
  }

  #addChatEvent(event: Record<string, unknown>): void {
    if (event.usage !== undefined) this.#usage = boundedJson(event.usage);
    if (!Array.isArray(event.choices)) return;
    for (const rawChoice of event.choices.slice(0, 100)) {
      const choice = asObject(rawChoice);
      if (!choice) continue;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) this.#addFinishReason(choice.finish_reason);
      for (const candidate of [choice.delta, choice.message, choice]) {
        const payload = asObject(candidate);
        if (!payload) continue;
        for (const key of ["reasoning_content", "reasoning", "reasoning_text"])
          this.#append(this.#reasoning, "reasoning", payload[key]);
        this.#append(this.#content, "content", payload.content);
        this.#append(this.#content, "content", payload.text);
        if (Array.isArray(payload.tool_calls)) {
          for (const tool of payload.tool_calls.slice(0, 100)) this.#addChatTool(tool);
        }
      }
    }
  }

  #addChatTool(value: unknown): void {
    const tool = asObject(value);
    if (!tool) return;
    const index = typeof tool.index === "number" && Number.isInteger(tool.index) ? tool.index : 0;
    if (!this.#chatToolCalls.has(index) && this.#chatToolCalls.size >= MAX_SUMMARY_ITEMS) {
      this.#truncate("tool_call_item_limit");
      return;
    }
    const current = this.#chatToolCalls.get(index) ?? { index };
    if (typeof tool.id === "string" && tool.id) current.id = tool.id;
    if (typeof tool.type === "string" && tool.type) current.type = tool.type;
    const delta = asObject(tool.function);
    if (delta) {
      current.function ??= {};
      if (typeof delta.name === "string" && delta.name) current.function.name = delta.name;
      if (typeof delta.arguments === "string") {
        current.function.arguments = this.#appendArgument(current.function.arguments ?? "", delta.arguments);
      }
    }
    this.#chatToolCalls.set(index, current);
  }

  #addResponseToolDelta(event: Record<string, unknown>): void {
    const current = this.#responseTool(event);
    if (typeof event.delta === "string") {
      current.arguments = this.#appendArgument(
        typeof current.arguments === "string" ? current.arguments : "",
        event.delta,
      );
    }
  }

  #addResponseToolDone(event: Record<string, unknown>): void {
    const current = this.#responseTool(event);
    if (typeof event.arguments === "string") current.arguments = this.#boundedArgument(event.arguments);
  }

  #responseTool(event: Record<string, unknown>): Record<string, unknown> {
    const key = firstString(event.item_id, event.call_id, event.output_index) ?? "0";
    if (!this.#responseToolCalls.has(key) && this.#responseToolCalls.size >= MAX_SUMMARY_ITEMS) {
      this.#truncate("tool_call_item_limit");
      return {};
    }
    const current = this.#responseToolCalls.get(key) ?? {};
    for (const field of ["item_id", "call_id", "output_index"])
      if (event[field] !== undefined) current[field] = boundedJson(event[field]);
    this.#responseToolCalls.set(key, current);
    return current;
  }

  #completeResponse(value: unknown): void {
    this.#mergeResponse(value);
    const response = asObject(value);
    if (!response) return;
    if (response.usage !== undefined) this.#usage = boundedJson(response.usage);
    if (typeof response.status === "string" && response.status) this.#addFinishReason(response.status);
    if (Array.isArray(response.output))
      for (const [index, item] of response.output.slice(0, 100).entries())
        if (asObject(item)?.type === "web_search_call")
          this.#addWebSearch("response.completed", { item, output_index: index });
  }

  #mergeResponse(value: unknown): void {
    const response = asObject(value);
    if (!response) return;
    const keep = ["id", "object", "created_at", "status", "model", "parallel_tool_calls", "previous_response_id"];
    const compact = this.#response ?? (Object.create(null) as Record<string, SanitizedJsonValue>);
    for (const key of keep) if (response[key] !== undefined) compact[key] = boundedJson(response[key]);
    if (response.error) compact.error = boundedJson(response.error);
    if (response.incomplete_details) compact.incomplete_details = boundedJson(response.incomplete_details);
    if (Object.keys(compact).length > 0) this.#response = compact;
  }

  #isWebSearch(type: string, event: Record<string, unknown>): boolean {
    return type.startsWith("response.web_search_call.") || asObject(event.item)?.type === "web_search_call";
  }

  #addWebSearch(type: string, event: Record<string, unknown>): void {
    const item = asObject(event.item);
    const key =
      firstString(item?.id, event.item_id, event.call_id, event.output_index) ?? String(this.#webSearchCalls.size);
    if (!this.#webSearchCalls.has(key) && this.#webSearchCalls.size >= MAX_SUMMARY_ITEMS) {
      this.#truncate("web_search_item_limit");
      return;
    }
    const call = this.#webSearchCalls.get(key) ?? { type: "web_search_call" };
    if (item?.id !== undefined) {
      call.id = boundedJson(item.id);
      call.item_id ??= boundedJson(item.id);
    }
    for (const field of ["item_id", "call_id", "output_index"])
      if (event[field] !== undefined) call[field] = boundedJson(event[field]);
    if (item?.action !== undefined) call.action = boundedJson(item.action);
    if (event.action !== undefined) call.action = boundedJson(event.action);
    const status =
      firstString(event.status, item?.status) ??
      (type.startsWith("response.web_search_call.") ? type.split(".").at(-1) : null);
    if (status) call.status = status;
    this.#webSearchCalls.set(key, call);
  }

  #append(parts: string[], kind: "content" | "reasoning", value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    const used = kind === "content" ? this.#contentChars : this.#reasoningChars;
    const allowed = Math.min(this.#limits.maxTextChars - used, this.#limits.maxSummaryChars - this.#summaryChars);
    if (allowed <= 0) {
      this.#truncate(`${kind}_limit`);
      return;
    }
    const piece = value.slice(0, allowed);
    parts.push(piece);
    if (kind === "content") this.#contentChars += piece.length;
    else this.#reasoningChars += piece.length;
    this.#summaryChars += piece.length;
    if (piece.length < value.length) this.#truncate(`${kind}_limit`);
  }

  #addFinishReason(value: string): void {
    if (this.#finishReasons.length >= MAX_SUMMARY_ITEMS) {
      this.#truncate("finish_reason_item_limit");
      return;
    }
    this.#finishReasons.push(value.slice(0, 2_000));
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

  #boundedArgument(value: string): string {
    const allowed = Math.min(this.#limits.maxToolArgumentChars, this.#limits.maxSummaryChars - this.#summaryChars);
    const bounded = value.slice(0, Math.max(0, allowed));
    this.#summaryChars += bounded.length;
    if (bounded.length < value.length) this.#truncate("tool_argument_limit");
    return bounded;
  }

  #truncate(reason: string): void {
    this.#truncated = true;
    this.#warn(reason);
  }

  #warn(code: string): void {
    if (this.#warnings.length < this.#limits.maxWarnings && !this.#warnings.includes(code)) this.#warnings.push(code);
  }
}

function finalizeArguments(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  if (typeof result.arguments === "string") {
    const parsed = parseArgumentJson(result.arguments);
    if (parsed !== undefined) result.arguments_json = parsed;
  }
  return result;
}

function finalizeChatToolCall(value: MutableToolCall): MutableToolCall {
  if (value.function?.arguments) {
    const parsed = parseArgumentJson(value.function.arguments);
    if (parsed !== undefined) value.function.arguments_json = parsed;
  }
  return value;
}

function parseArgumentJson(value: string): SanitizedJsonValue | undefined {
  try {
    return boundedJson(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function boundedJson(value: unknown): SanitizedJsonValue {
  return sanitizeJsonValue(value, { maxDepth: 16, maxItems: 1_000, maxStringBytes: 256 * 1024 });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if ((typeof value === "string" || typeof value === "number") && String(value)) return String(value);
  }
  return null;
}

function assertLimits(limits: OpenAiSummaryLimits): void {
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}
