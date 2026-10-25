import type { RequestPricingResult } from "../pricing/index.js";

import type { BytePayload } from "./payload.js";
import type { ResponseLogPayload } from "./response-log-capture.js";

/**
 * The three states a proxied request is logged in. A misspelled state does not compile,
 * which is what keeps a lifecycle name from drifting into a value the log cannot read.
 */
export const TRAFFIC_EVENT_NAMES = [
  "request_received",
  "request_pending_response",
  "request_finished",
] as const;

export type TrafficEventName = (typeof TRAFFIC_EVENT_NAMES)[number];

/** Who asked, as the socket reported it. */
export interface TrafficClientInfo {
  readonly host: string;
  readonly port: number;
}

/** Where the request was sent. A failover rewrites this block in place. */
export interface TrafficTargetInfo {
  id: string;
  name: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
}

/** The pair that accepted the request, when the pipeline knows one. */
export interface TrafficProxyInfo {
  readonly id: string;
  readonly name: string;
}

/** Header names as the client or upstream sent them, including duplicates. */
export type TrafficHeaderMap = Readonly<Record<string, readonly string[]>>;

/** How the model name travelled, including the load balancing decision behind it. */
export interface TrafficModelRoute {
  readonly requested_model?: string | undefined;
  readonly upstream_model?: string | undefined;
  readonly target_id?: string | undefined;
  readonly target_name?: string | undefined;
  readonly route_mode?: string | undefined;
  readonly logged_by?: string | undefined;
  readonly failover_from?: string | null | undefined;
  /** The balancer's own decision fields, which vary by strategy. */
  readonly load_balance?: Readonly<Record<string, unknown>> | undefined;
}

/** What the client sent and what the answering node received. */
export interface TrafficRequestInfo {
  /** The path as the client asked for it, query string included. */
  method: string;
  path: string;
  headers: TrafficHeaderMap;
  /** The bytes the proxy received, before any model rewrite or field injection. */
  body: BytePayload;
  /** True while the client is still sending; a body is complete once this is false. */
  body_pending: boolean;
  /** The bytes forwarded to the node that answered, when they differ from `body`. */
  upstream_body?: BytePayload | undefined;
  stripped_fields?: readonly string[] | undefined;
  injected_fields?: readonly string[] | undefined;
  added_upstream_headers?: readonly string[] | undefined;
  model_route?: TrafficModelRoute | undefined;
}

/** What came back, held as text plus the size and digest the capture measured. */
export interface TrafficResponseInfo {
  /** The upstream status, or null when no status line arrived at all. */
  readonly status: number | null;
  readonly headers: TrafficHeaderMap;
  /** The decoded answer, spooled to disk when it grew past the in-memory threshold. */
  readonly body: ResponseLogPayload;
}

/** The fields every lifecycle state carries about one request. */
export interface TrafficEventCoreFields {
  readonly id: string;
  /** When the request finished, as local wall-clock text. */
  readonly timestamp: string;
  /** When the request arrived, as local wall-clock text. */
  readonly started_timestamp: string;
  /** Milliseconds from arrival to finish, measured on one monotonic clock. */
  readonly duration_ms: number;
  readonly client: TrafficClientInfo;
  readonly target: TrafficTargetInfo;
  readonly proxy?: TrafficProxyInfo | undefined;
  readonly request: TrafficRequestInfo;
  /** The price frozen at request start, then completed with the measured usage. */
  readonly pricing?: RequestPricingResult | undefined;
  /** Milliseconds from arrival to the first answer token, when the answer streamed. */
  readonly first_token_ms?: number | undefined;
  /** Milliseconds between the first and the last generated token. */
  readonly decode_window_ms?: number | undefined;
  /** Why the proxy answered the client itself, when it did. */
  readonly error?: string | undefined;
}

/**
 * The shared part of every lifecycle state. The record half carries keys this model does
 * not name, which is how history and import fallbacks stay readable.
 */
export type TrafficEventCore = TrafficEventCoreFields & Record<string, unknown>;

/** The request reached the proxy; nothing was forwarded yet. */
export interface TrafficReceivedEvent extends TrafficEventCore {
  readonly event: "request_received";
  readonly response?: undefined;
}

/** The request left for the upstream and is waiting for an answer. */
export interface TrafficPendingEvent extends TrafficEventCore {
  readonly event: "request_pending_response";
  readonly response?: undefined;
}

/** The answer is complete, or the proxy gave up and answered the client itself. */
export interface TrafficFinishedEvent extends TrafficEventCore {
  readonly event: "request_finished";
  readonly response: TrafficResponseInfo;
}

/** What a log writer receives for one request. */
export type TrafficRecordEvent = TrafficReceivedEvent | TrafficPendingEvent | TrafficFinishedEvent;

/**
 * What the pipeline holds while a request advances. The blocks stay writable because a
 * failover retargets the request and the route after the first node refused, and because
 * pricing is frozen only once the body and the target are known.
 */
export interface TrafficRequestDraft {
  id: string;
  timestamp: string;
  started_timestamp: string;
  readonly client: TrafficClientInfo;
  target: TrafficTargetInfo;
  proxy?: TrafficProxyInfo | undefined;
  request: TrafficRequestInfo;
  pricing?: RequestPricingResult | undefined;
  error?: string | undefined;
  decode_window_ms?: number | undefined;
}

function eventCore(draft: Readonly<TrafficRequestDraft>, durationMs: number): TrafficEventCore {
  return {
    id: draft.id,
    timestamp: draft.timestamp,
    started_timestamp: draft.started_timestamp,
    duration_ms: durationMs,
    client: draft.client,
    target: draft.target,
    ...(draft.proxy === undefined ? {} : { proxy: draft.proxy }),
    request: draft.request,
    ...(draft.pricing === undefined ? {} : { pricing: draft.pricing }),
  };
}

/** The first state, written when a request arrives at the proxy. */
export function receivedEvent(
  draft: Readonly<TrafficRequestDraft>,
  durationMs = 0,
): TrafficReceivedEvent {
  return { event: "request_received", ...eventCore(draft, durationMs) };
}

/** The state between forwarding the request and receiving the whole answer. */
export function pendingResponseEvent(
  draft: Readonly<TrafficRequestDraft>,
  durationMs = 0,
): TrafficPendingEvent {
  return { event: "request_pending_response", ...eventCore(draft, durationMs) };
}

/** The last state, carrying the answer, the measured timings and any failure reason. */
export function finishedEvent(
  draft: Readonly<TrafficRequestDraft>,
  response: TrafficResponseInfo,
  durationMs: number,
  firstTokenMs?: number,
): TrafficFinishedEvent {
  return {
    event: "request_finished",
    ...eventCore(draft, durationMs),
    response,
    ...(firstTokenMs === undefined ? {} : { first_token_ms: firstTokenMs }),
    ...(draft.decode_window_ms === undefined ? {} : { decode_window_ms: draft.decode_window_ms }),
    ...(draft.error === undefined ? {} : { error: draft.error }),
  };
}
