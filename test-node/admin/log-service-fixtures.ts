import { Readable } from "node:stream";

import { createDefaultProxyPair } from "../../src/config/defaults.js";
import type { PublicProxyPair } from "../../src/config/index.js";
import type {
  HistorySummary,
  LogCleanupResult,
  LogGroupPage,
  LogGroupSummary,
  LogPendingRecord,
  LogRecordDetail,
  TaskBrief,
  TaskTimeline,
  TimelineEvent,
} from "../../src/maintenance/index.js";
import type { ModelPriceImportResult } from "../../src/pricing/index.js";

/**
 * Typed payloads the admin route tests answer with. Each builder returns exactly the
 * contract type, so a renamed or forgotten service field stops the test from compiling
 * instead of reaching the browser as `undefined`.
 */

/** The group page an application with no log root answers with. */
export function emptyGroupPage(limit = 100, offset = 0): LogGroupPage {
  return { groups: [], total: 0, limit, offset, next_offset: offset, has_more: false };
}

/** One row of the group page, with the cost block the console shows. */
export function groupSummary(groupId = "task-1"): LogGroupSummary {
  return {
    id: groupId,
    cost: {
      currency: "CNY",
      known_amount: "0.041125",
      pending_request_count: 0,
      priced_request_count: 2,
      unpriced_request_count: 1,
    },
    last_activity_at: "2026-07-18 12:00:05",
    model: "fixture-model",
    request_count: 3,
    started_at: "2026-07-18 11:55:00",
    target: "fixture-target",
  };
}

/** A cleanup answer; `deleted` is what the caller asked to remove. */
export function cleanupResult(deleted: readonly string[] = []): LogCleanupResult {
  return { deleted, deleted_count: deleted.length };
}

/** A ZIP body for the export route, whose response is not JSON. */
export function exportStream(text = "zip-fixture"): Readable {
  return Readable.from([Buffer.from(text)]);
}

/** One row of the body-free batch read: a pending row has no status or cost yet. */
export function listRecord(id: string, pending: boolean): LogPendingRecord {
  return {
    id,
    pending,
    timestamp: pending ? "pending" : "2026-07-18 12:00:05",
    sequence: "1",
    method: "POST",
    path: "/v1/responses",
    endpoint: "/v1/responses",
    message_count: null,
    status: pending ? null : 200,
    request_token_count: null,
    response_token_count: null,
    target: "fixture-target",
    has_summary: false,
    cost: pending
      ? { currency: "CNY", amount: null, status: "pending", reason: null }
      : { currency: "CNY", amount: "0.041125", status: "priced", reason: null },
  };
}

/** The batch answer the console reads while requests are still in flight. */
export function recordBatch(records: readonly LogPendingRecord[] = []): {
  readonly records: readonly LogPendingRecord[];
} {
  return { records };
}

/** A finished record detail, including the pricing block the console shows. */
export function recordDetail(id: string): LogRecordDetail {
  return {
    id,
    pending: false,
    request: { input: "hello" },
    response: { output: "world" },
    request_meta: { method: "POST" },
    response_meta: { status: 200 },
    pricing: { pricing_status: "priced", cost_nano_cny: "41125000" },
  };
}

/** The task brief the console shows for a task that has one. */
export function taskBrief(groupId = "task-1"): TaskBrief {
  return {
    task_id: groupId,
    text: "Relaying a coding session through the local proxy.",
    timeline: taskTimeline(),
    events: taskTimelineEvents(),
    context: { agent: "pi 0.39", cwd: "d:/code/local_ai_proxy" },
    model: "summary-model",
    generated_at: "2026-07-18T12:05:00.000+08:00",
    source_record_id: "record-1",
    source_sequence: 11,
    source_event_count: 4,
    stale: false,
  };
}

/** The timeline that goes with the task brief fixture. */
export function taskTimeline(): TaskTimeline {
  return {
    overview: "Relaying a coding session through the local proxy.",
    steps: [
      {
        order: 1,
        evidence: [1, 2],
        operation: "Read the loader",
        purpose: ["Confirm path resolution"],
        approach: ["Compare the loader and test setup before changing the path rule."],
        result: ["Found a mismatch with the tests"],
        basis: "observed",
      },
      {
        order: 2,
        evidence: [3],
        operation: "Ran the test suite",
        purpose: ["Check the relay still works"],
        result: [],
        basis: "unknown",
      },
    ],
    gaps: [{ evidence: [3], description: "The log has no result for the second call." }],
  };
}

/** The evidence events that go with the task brief fixture. */
export function taskTimelineEvents(): readonly TimelineEvent[] {
  return [
    { event_no: 1, kind: "user_message", role: "user", text: "Fix the relay." },
    { event_no: 2, kind: "reasoning_summary", text: "Check the loader first." },
    {
      event_no: 3,
      kind: "tool_call",
      operation_id: "op-3",
      call_id: "call-1",
      tool: "read",
      arguments_preview: '{"path":"loader.ts"}',
      result_event_no: 4,
    },
    {
      event_no: 4,
      kind: "tool_result",
      operation_id: "op-3",
      call_id: "call-1",
      call_event_no: 3,
      result_preview: "Relative paths resolve against the log root.",
    },
  ];
}

/** A summary payload: the summary model's own JSON, extra keys included. */
export function historySummary(): HistorySummary {
  return {
    title: "Build stages",
    overview: "Six stages, build was the longest.",
    segments: [{ range: "1-6", summary: "Install and build", key_points: [], evidence: [1, 6] }],
    decisions: ["keep the image"],
    issues: [],
    model_note: "kept verbatim",
  };
}

/** The model-price catalog answer of an import that fetched nothing new. */
export function modelPriceImportResult(): ModelPriceImportResult {
  return {
    models: [],
    rules: [],
    unmatched: [],
    catalog: { source: "fixture", fetchedAt: 1_700_000_000_000 },
  };
}

/** A pair the console can switch on and off, built from the default pair. */
export function enabledPair(id = "pair-1"): PublicProxyPair {
  return {
    ...structuredClone(createDefaultProxyPair()),
    id,
    enabled: true,
    actual_listen_port: 18_080,
    running: true,
  };
}
