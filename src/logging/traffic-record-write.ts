import type { RequestPricingResult } from "../pricing/index.js";
import type { EndpointKind, TrafficEventName, TrafficHeaderMap } from "../proxy/index.js";

export interface TrafficRecordWriteFields {
  readonly id: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly event: TrafficEventName;
  readonly timestamp: string;
  readonly started_at: string;
  readonly duration_ms?: number | undefined;
  readonly first_token_ms?: number | undefined;
  readonly decode_window_ms?: number | undefined;
  readonly proxy_id?: string | undefined;
  readonly proxy_name?: string | undefined;
  readonly client_host?: string | undefined;
  readonly client_port?: number | undefined;
  readonly target_id?: string | undefined;
  readonly target_name?: string | undefined;
  readonly target_url?: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly endpoint: string;
  readonly status?: number | null | undefined;
  readonly error?: string | undefined;
  readonly message_count?: number | undefined;
  readonly token_count?: number | undefined;
  readonly request_token_count?: number | undefined;
  readonly response_token_count?: number | undefined;
  readonly pricing?: RequestPricingResult | undefined;
  readonly request_headers: TrafficHeaderMap;
  readonly response_headers: TrafficHeaderMap;
  readonly request_body: unknown;
  readonly original_request_body?: unknown;
  readonly response_body: unknown;
  readonly model_route?: unknown;
  readonly stripped_fields: readonly unknown[];
  readonly injected_fields: readonly unknown[];
  readonly added_upstream_headers: readonly unknown[];
}

/**
 * One row the traffic log asks the repository to insert or replace. The names and types
 * here are the columns the repository reads, so a missing identifier or a mistyped timing
 * value fails to compile instead of becoming a row the console cannot use. The record half
 * carries columns a caller may fill in from an older row.
 */
export type TrafficRecordWrite = TrafficRecordWriteFields & Record<string, unknown>;

export interface TrafficTaskWriteFields {
  readonly id: string;
  readonly kind?: EndpointKind | undefined;
  readonly endpoint?: string | undefined;
  readonly anchor?: string | undefined;
  readonly model?: string | undefined;
  readonly target?: string | undefined;
  readonly started_at?: string | undefined;
  readonly last_seen_at?: string | undefined;
  readonly last_response_at?: string | undefined;
  readonly request_count?: number | undefined;
  readonly pending_request_only?: boolean | undefined;
  readonly match_confidence?: number | undefined;
  readonly match_strategy_version?: number | undefined;
  readonly fingerprints?: Readonly<Record<string, unknown>> | undefined;
  readonly boundary_fingerprints?: Readonly<Record<string, unknown>> | undefined;
  readonly last_user_messages?: readonly unknown[] | undefined;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
}

/**
 * The task row the matcher asks the repository to insert or replace. A matched task starts
 * from a stored row, so the record half carries the columns that row already had.
 */
export type TrafficTaskWrite = TrafficTaskWriteFields & Record<string, unknown>;
