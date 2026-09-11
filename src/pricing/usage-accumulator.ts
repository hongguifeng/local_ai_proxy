import { isRecord } from "../shared/index.js";

import {
  normalizeUsage,
  type NormalizedUsage,
  type PricingEndpointKind,
  type UsageNormalizationReason,
} from "./usage-normalizer.js";

export const DEFAULT_MAX_SSE_USAGE_EVENT_BYTES = 1024 * 1024;

export type UsageCaptureResult =
  | (UsageCaptureResultBase & { readonly status: "complete"; readonly usage: NormalizedUsage })
  | (UsageCaptureResultBase & {
      readonly reason: "incomplete_usage" | "missing_usage" | UsageNormalizationReason;
      readonly status: "unavailable";
    });

interface UsageCaptureResultBase {
  readonly eventTruncated: boolean;
  readonly terminalSeen: boolean;
}

/**
 * Bounded SSE observer for billing usage. It deliberately observes bytes
 * independently of log-summary capture, so a large response summary cannot
 * hide a final usage event.
 */
export class UsageAccumulator {
  readonly #decoder = new TextDecoder("utf-8");
  readonly #kind: PricingEndpointKind;
  readonly #maxEventBytes: number;
  #buffer = "";
  #chatUsage: unknown;
  #discardEvent = false;
  #eventBytes = 0;
  #eventLines: string[] = [];
  #eventTruncated = false;
  #finalized = false;
  #messagesDeltaUsage: unknown;
  #messagesStartUsage: unknown;
  #responsesUsage: unknown;
  #terminalSeen = false;

  constructor(kind: PricingEndpointKind, maxEventBytes = DEFAULT_MAX_SSE_USAGE_EVENT_BYTES) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) {
      throw new RangeError("SSE usage event buffer limit must be a positive safe integer.");
    }
    this.#kind = kind;
    this.#maxEventBytes = maxEventBytes;
  }

  addChunk(chunk: Uint8Array): void {
    if (this.#finalized) throw new Error("Cannot add an SSE usage chunk after finalize().");
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#processLines();
  }

  finalize(): UsageCaptureResult {
    if (this.#finalized) throw new Error("SSE usage accumulator has already been finalized.");
    this.#finalized = true;
    this.#buffer += this.#decoder.decode();
    if (this.#buffer !== "") this.#processLine(this.#buffer);
    this.#dispatchEvent();
    if (this.#eventTruncated) return unavailable("incomplete_usage", this.#terminalSeen, true);
    if (!this.#terminalSeen) return unavailable("incomplete_usage", false, false);
    const usagePayload = this.#usagePayload();
    if (usagePayload === undefined) return unavailable("missing_usage", true, false);
    const normalized = normalizeUsage(this.#kind, usagePayload);
    return normalized.status === "complete"
      ? { status: "complete", usage: normalized.usage, terminalSeen: true, eventTruncated: false }
      : unavailable(normalized.reason, true, false);
  }

  #processLines(): void {
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      this.#processLine(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #processLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      this.#dispatchEvent();
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    const bytes = new TextEncoder().encode(data).byteLength;
    this.#eventBytes += bytes;
    if (this.#eventBytes > this.#maxEventBytes) {
      this.#discardEvent = true;
      this.#eventTruncated = true;
      this.#eventLines = [];
      return;
    }
    if (!this.#discardEvent) this.#eventLines.push(data);
  }

  #dispatchEvent(): void {
    if (this.#eventLines.length > 0 && !this.#discardEvent) {
      const data = this.#eventLines.join("\n");
      if (data === "[DONE]") {
        this.#terminalSeen = true;
      } else {
        try {
          this.#observe(JSON.parse(data) as unknown);
        } catch {
          this.#eventTruncated = true;
        }
      }
    }
    this.#eventLines = [];
    this.#eventBytes = 0;
    this.#discardEvent = false;
  }

  #observe(event: unknown): void {
    if (!isRecord(event)) return;
    if (this.#kind === "responses") {
      const type = event["type"];
      if (
        (type === "response.completed" || type === "response.incomplete") &&
        isRecord(event["response"])
      ) {
        this.#responsesUsage = event["response"]["usage"];
        this.#terminalSeen = true;
      }
      return;
    }
    if (this.#kind === "messages") {
      if (event["type"] === "message_start" && isRecord(event["message"])) {
        this.#messagesStartUsage = event["message"]["usage"];
      } else if (event["type"] === "message_delta") {
        this.#messagesDeltaUsage = event["usage"];
      } else if (event["type"] === "message_stop") {
        this.#terminalSeen = true;
      }
      return;
    }
    if (this.#kind === "chat" && Object.hasOwn(event, "usage")) this.#chatUsage = event["usage"];
  }

  #usagePayload(): unknown {
    if (this.#kind === "responses") return { usage: this.#responsesUsage };
    if (this.#kind === "chat") return { usage: this.#chatUsage };
    if (
      this.#kind === "messages" &&
      isRecord(this.#messagesStartUsage) &&
      isRecord(this.#messagesDeltaUsage)
    ) {
      return { usage: { ...this.#messagesStartUsage, ...this.#messagesDeltaUsage } };
    }
    return undefined;
  }
}

function unavailable(
  reason: "incomplete_usage" | "missing_usage" | UsageNormalizationReason,
  terminalSeen: boolean,
  eventTruncated: boolean,
): UsageCaptureResult {
  return {
    status: "unavailable",
    reason,
    terminalSeen,
    eventTruncated,
  };
}
