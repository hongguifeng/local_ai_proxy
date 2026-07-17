import { isRecord } from "../shared/index.js";

export interface ParsedSseEvents {
  readonly events: readonly unknown[];
  readonly doneSeen: boolean;
}

export interface StreamSummary {
  readonly stream_summary: Record<string, unknown>;
}

export class StreamAccumulator {
  readonly #contentParts: string[] = [];
  readonly #reasoningParts: string[] = [];
  readonly #responseToolCalls = new Map<string, Record<string, unknown>>();
  readonly #responseWebSearchCalls = new Map<string, Record<string, unknown>>();
  readonly #finishReasons: string[] = [];
  readonly #doneSeen: boolean;
  readonly #eventCount: number;
  #responsePayload: Record<string, unknown> | undefined;
  #usage: unknown;

  constructor(eventCount: number, doneSeen: boolean) {
    this.#eventCount = eventCount;
    this.#doneSeen = doneSeen;
  }

  addEvent(event: unknown): void {
    if (!isRecord(event)) {
      return;
    }
    const eventType = event["type"];
    if (typeof eventType === "string" && eventType.startsWith("response.")) {
      this.#addResponseEvent(eventType, event);
      return;
    }
    this.#addChatEvent(event);
  }

  summary(): StreamSummary {
    const streamSummary: Record<string, unknown> = {
      event_count: this.#eventCount,
      done_seen: this.#doneSeen,
    };
    if (this.#reasoningParts.length > 0) {
      streamSummary["reasoning"] = this.#reasoningParts.join("");
    }
    if (this.#contentParts.length > 0) {
      streamSummary["content"] = this.#contentParts.join("");
    }
    if (this.#responseToolCalls.size > 0) {
      streamSummary["response_tool_calls"] = [...this.#responseToolCalls.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, toolCall]) => compactArguments(toolCall));
    }
    if (this.#responseWebSearchCalls.size > 0) {
      streamSummary["web_search_calls"] = [...this.#responseWebSearchCalls.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, call]) => call);
    }
    if (this.#finishReasons.length > 0) {
      streamSummary["finish_reasons"] = [...this.#finishReasons];
    }
    if (this.#usage) {
      streamSummary["usage"] = this.#usage;
    }
    if (this.#responsePayload !== undefined && Object.keys(this.#responsePayload).length > 0) {
      streamSummary["response"] = this.#responsePayload;
    }
    return { stream_summary: streamSummary };
  }

  #addResponseEvent(eventType: string, event: Readonly<Record<string, unknown>>): void {
    if (eventType === "response.output_text.delta") {
      appendString(this.#contentParts, event["delta"]);
    } else if (eventType === "response.output_text.done" && this.#contentParts.length === 0) {
      appendString(this.#contentParts, event["text"]);
    } else if (
      eventType === "response.reasoning_text.delta" ||
      eventType === "response.reasoning_summary_text.delta"
    ) {
      appendString(this.#reasoningParts, event["delta"]);
    } else if (
      (eventType === "response.reasoning_text.done" ||
        eventType === "response.reasoning_summary_text.done") &&
      this.#reasoningParts.length === 0
    ) {
      appendString(this.#reasoningParts, event["text"]);
    } else if (eventType === "response.function_call_arguments.delta") {
      const toolCall = this.#responseToolCall(event, true);
      const delta = event["delta"];
      if (typeof delta === "string") {
        toolCall["arguments"] = `${stringValue(toolCall["arguments"])}${delta}`;
      }
    } else if (eventType === "response.function_call_arguments.done") {
      const toolCall = this.#responseToolCall(event, false);
      if (typeof event["arguments"] === "string") {
        toolCall["arguments"] = event["arguments"];
      }
    } else if (eventType === "response.created") {
      const response = event["response"];
      if (isRecord(response) && this.#responsePayload === undefined) {
        this.#responsePayload = compactResponsePayload(response);
        this.#addResponseWebSearchItems(eventType, response);
      }
    } else if (eventType === "response.completed" || eventType === "response.incomplete") {
      const response = event["response"];
      if (isRecord(response)) {
        this.#responsePayload = {
          ...(this.#responsePayload ?? {}),
          ...compactResponsePayload(response),
        };
        if (response["usage"]) {
          this.#usage = response["usage"];
        }
        if (response["status"]) {
          this.#finishReasons.push(stringValue(response["status"]));
        }
        this.#addResponseWebSearchItems(eventType, response);
      }
    } else if (this.#isResponseWebSearchEvent(eventType, event)) {
      this.#addResponseWebSearchCall(eventType, event);
    }
  }

  #addResponseWebSearchItems(eventType: string, response: Readonly<Record<string, unknown>>): void {
    const output = response["output"];
    if (!Array.isArray(output)) {
      return;
    }
    for (const [outputIndex, item] of (output as unknown[]).entries()) {
      if (isRecord(item) && item["type"] === "web_search_call") {
        this.#addResponseWebSearchCall(eventType, { output_index: outputIndex, item });
      }
    }
  }

  #isResponseWebSearchEvent(eventType: string, event: Readonly<Record<string, unknown>>): boolean {
    if (eventType.startsWith("response.web_search_call.")) {
      return true;
    }
    const item = event["item"];
    return isRecord(item) && item["type"] === "web_search_call";
  }

  #addResponseWebSearchCall(eventType: string, event: Readonly<Record<string, unknown>>): void {
    const item = isRecord(event["item"]) ? event["item"] : undefined;
    const itemId = item?.["id"];
    const fallbackKey = firstPresent([event["item_id"], event["call_id"], event["output_index"]]);
    const key = stringValue(
      firstTruthy([itemId]) ?? fallbackKey ?? this.#responseWebSearchCalls.size,
    );
    let call = this.#responseWebSearchCalls.get(key);
    if (call === undefined) {
      call = { type: "web_search_call" };
      this.#responseWebSearchCalls.set(key, call);
    }
    if (itemId) {
      call["id"] = structuredClone(itemId);
      if (call["item_id"] === undefined) {
        call["item_id"] = structuredClone(itemId);
      }
    }
    if (item !== undefined) {
      if (isRecord(item["action"])) {
        call["action"] = structuredClone(item["action"]);
      }
      if (item["error"]) {
        call["error"] = structuredClone(item["error"]);
      }
    }
    for (const fieldName of ["item_id", "call_id", "output_index"] as const) {
      if (event[fieldName] !== null && event[fieldName] !== undefined) {
        call[fieldName] = structuredClone(event[fieldName]);
      }
    }
    if (isRecord(event["action"])) {
      call["action"] = structuredClone(event["action"]);
    }
    if (event["error"]) {
      call["error"] = structuredClone(event["error"]);
    }
    const status = responseWebSearchStatus(eventType, event, item);
    if (status !== undefined) {
      call["status"] = status;
    }
  }

  #responseToolCall(
    event: Readonly<Record<string, unknown>>,
    initializeArguments: boolean,
  ): Record<string, unknown> {
    const key = stringValue(
      firstTruthy([event["item_id"], event["call_id"], event["output_index"]]) ?? "0",
    );
    let toolCall = this.#responseToolCalls.get(key);
    if (toolCall === undefined) {
      toolCall = initializeArguments ? { arguments: "" } : {};
      this.#responseToolCalls.set(key, toolCall);
    }
    for (const idKey of ["item_id", "call_id", "output_index"] as const) {
      if (event[idKey] !== null && event[idKey] !== undefined) {
        toolCall[idKey] = event[idKey];
      }
    }
    return toolCall;
  }

  #addChatEvent(event: Readonly<Record<string, unknown>>): void {
    if (event["usage"]) {
      this.#usage = event["usage"];
    }
    const choices = event["choices"];
    if (!Array.isArray(choices)) {
      return;
    }
    for (const choice of choices as unknown[]) {
      if (!isRecord(choice)) {
        continue;
      }
      if (choice["finish_reason"]) {
        this.#finishReasons.push(stringValue(choice["finish_reason"]));
      }
      for (const payload of [choice["delta"], choice["message"], choice]) {
        if (!isRecord(payload)) {
          continue;
        }
        for (const key of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
          appendString(this.#reasoningParts, payload[key]);
        }
        appendString(this.#contentParts, payload["content"]);
        appendString(this.#contentParts, payload["text"]);
      }
    }
  }
}

export function parseSseEvents(text: string): ParsedSseEvents | undefined {
  const events: unknown[] = [];
  let doneSeen = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === "") {
      continue;
    }
    if (data === "[DONE]") {
      doneSeen = true;
      continue;
    }
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      return undefined;
    }
  }
  return events.length === 0 ? undefined : { events, doneSeen };
}

export function compactSseValue(text: string): StreamSummary | undefined {
  const parsed = parseSseEvents(text);
  if (parsed === undefined) {
    return undefined;
  }
  const accumulator = new StreamAccumulator(parsed.events.length, parsed.doneSeen);
  for (const event of parsed.events) {
    accumulator.addEvent(event);
  }
  return accumulator.summary();
}

export function compactSseJson(text: string): string | undefined {
  const compacted = compactSseValue(text);
  return compacted === undefined ? undefined : JSON.stringify(compacted, null, 2);
}

function appendString(parts: string[], value: unknown): void {
  if (typeof value === "string" && value !== "") {
    parts.push(value);
  }
}

function compactArguments(toolCall: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const compacted = { ...toolCall };
  if (typeof compacted["arguments"] === "string") {
    try {
      compacted["arguments_json"] = JSON.parse(compacted["arguments"]) as unknown;
    } catch {
      // Keep the original argument string when it is incomplete or not JSON.
    }
  }
  return compacted;
}

function compactResponsePayload(
  response: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const key of [
    "id",
    "object",
    "created_at",
    "status",
    "model",
    "parallel_tool_calls",
    "previous_response_id",
  ] as const) {
    if (Object.hasOwn(response, key)) {
      compacted[key] = response[key];
    }
  }
  for (const key of ["error", "incomplete_details"] as const) {
    if (response[key]) {
      compacted[key] = response[key];
    }
  }
  return compacted;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function firstTruthy(values: readonly unknown[]): unknown {
  return values.find((value) => Boolean(value));
}

function firstPresent(values: readonly unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function responseWebSearchStatus(
  eventType: string,
  event: Readonly<Record<string, unknown>>,
  item: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (typeof event["status"] === "string" && event["status"] !== "") {
    return event["status"];
  }
  if (typeof item?.["status"] === "string" && item["status"] !== "") {
    return item["status"];
  }
  return eventType.startsWith("response.web_search_call.")
    ? eventType.slice(eventType.lastIndexOf(".") + 1)
    : undefined;
}
