import type { RecordDetail } from "@llm-proxy/contracts";

import { createSafeCapturedContent } from "../proxy/payload.js";

type Headers = Readonly<Record<string, readonly string[]>>;
type Client = RecordDetail["client"];
type ProxyIdentity = RecordDetail["proxy"];
type TargetIdentity = RecordDetail["target"];

interface EventBase {
  requestId: string;
  timestamp: string;
}

export type TrafficEvent =
  | (EventBase &
      Readonly<{
        kind: "accepted";
        method: string;
        path: string;
        client: Client;
        proxy: ProxyIdentity;
        requestHeaders: Headers;
      }>)
  | (EventBase & Readonly<{ kind: "body_read"; headers: Headers; captured: Uint8Array; observedBytes: number }>)
  | (EventBase & Readonly<{ kind: "routed"; target: TargetIdentity }>)
  | (EventBase & Readonly<{ kind: "headers"; status: number; headers: Headers }>)
  | (EventBase &
      Readonly<{
        kind: "finished";
        status: number;
        headers?: Headers;
        captured: Uint8Array;
        observedBytes: number;
        durationMs: number;
        messageCount?: number | null;
        tokenCount?: number | null;
      }>)
  | (EventBase &
      Readonly<{
        kind: "error";
        code: string;
        stage: string;
        safeMessage: string;
        durationMs: number;
        status?: number | null;
      }>);

interface FoldState {
  record: RecordDetail;
  stage: TrafficEvent["kind"];
}

const STAGE_ORDER: Readonly<Record<TrafficEvent["kind"], number>> = {
  accepted: 0,
  body_read: 1,
  routed: 2,
  headers: 3,
  finished: 4,
  error: 4,
};

export class TrafficEventReducer {
  readonly #states = new Map<string, FoldState>();

  public apply(event: TrafficEvent): RecordDetail | null {
    const existing = this.#states.get(event.requestId);
    if (event.kind === "accepted") {
      if (existing) return existing.record;
      const request = createSafeCapturedContent(event.requestHeaders, new Uint8Array(), 0);
      const record: RecordDetail = {
        id: event.requestId,
        taskId: `pending-${event.requestId}`,
        sequence: 1,
        event: "request_received",
        timestamp: event.timestamp,
        durationMs: 0,
        method: event.method,
        path: event.path,
        status: null,
        errorCode: null,
        messageCount: null,
        tokenCount: null,
        client: event.client,
        proxy: event.proxy,
        target: { id: "unrouted", name: "Unrouted", url: "http://unrouted.invalid" },
        request,
        response: null,
      };
      this.#states.set(event.requestId, { record, stage: event.kind });
      return record;
    }
    if (!existing) return null;
    if (STAGE_ORDER[event.kind] < STAGE_ORDER[existing.stage] || isTerminal(existing.stage)) return existing.record;

    let record = existing.record;
    if (event.kind === "body_read") {
      record = {
        ...record,
        request: createSafeCapturedContent(event.headers, event.captured, event.observedBytes),
      };
    } else if (event.kind === "routed") {
      record = { ...record, target: event.target };
    } else if (event.kind === "headers") {
      record = {
        ...record,
        status: event.status,
        response: createSafeCapturedContent(event.headers, new Uint8Array(), 0),
      };
    } else if (event.kind === "finished") {
      const headers = event.headers ?? record.response?.headers ?? {};
      record = {
        ...record,
        event: "request_finished",
        timestamp: event.timestamp,
        durationMs: event.durationMs,
        status: event.status,
        messageCount: event.messageCount ?? record.messageCount,
        tokenCount: event.tokenCount ?? record.tokenCount,
        response: createSafeCapturedContent(headers, event.captured, event.observedBytes),
      };
    } else {
      record = {
        ...record,
        event: "failed",
        timestamp: event.timestamp,
        durationMs: event.durationMs,
        status: event.status ?? record.status,
        errorCode: safeCode(event.code),
        errorStage: safeCode(event.stage),
        errorMessage: safeMessage(event.safeMessage),
      };
    }
    this.#states.set(event.requestId, { record, stage: event.kind });
    return record;
  }

  public forget(requestId: string): void {
    this.#states.delete(requestId);
  }
}

function isTerminal(stage: TrafficEvent["kind"]): boolean {
  return stage === "finished" || stage === "error";
}

function safeCode(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 80) || "UNKNOWN";
}

function safeMessage(value: string): string {
  let result = "";
  for (let index = 0; index < value.length && result.length < 2_000; index += 1) {
    const code = value.charCodeAt(index);
    result += code < 32 || code === 127 ? " " : value.charAt(index);
  }
  return result;
}
