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
  readonly #doneSeen: boolean;
  readonly #eventCount: number;

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
    }
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
