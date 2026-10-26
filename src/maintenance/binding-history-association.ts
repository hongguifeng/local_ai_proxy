import { existsSync } from "node:fs";

import {
  logDatabasePath,
  TrafficRepository,
  type TaskAssociationRow,
  type TaskCandidatePage,
  type TaskLinkRow,
} from "../persistence/index.js";
import { tryCanonicalNodeKey } from "../proxy/node-identity.js";
import type { EndpointKind } from "../proxy/protocol/analysis.js";
import {
  boundaryWithoutUser,
  storedBoundaryFingerprints,
} from "../proxy/protocol/task-identity.js";
import { isRecord, stableJsonStringify, StructuredLogger } from "../shared/index.js";

/**
 * The read-only join between a routing binding and the task history that names it.
 *
 * This module changes when the way a binding is recognised in the traffic log changes -
 * the exact-key direction, the boundary candidate rule, the caps a console poll must
 * respect, or which coverage state a missing history reports. It reads through
 * `TrafficRepository` and nothing else, never writes, and is never called from the request
 * path: a binding list is assembled from memory and only a management reader asks this
 * service what the log says about a binding.
 *
 * What it never does: create or touch a binding, read a request or response body, read
 * stored user messages, hand out an exact key, or claim that a candidate association
 * identifies a task. A task it returns is history for display, never an object the proxy
 * can move - there are no migration fields here because only the runtime owns a binding.
 */

/** How many exact keys of one binding a query looks up before reporting the rest. */
export const DEFAULT_EXACT_KEYS_PER_QUERY = 64;
/** How many tasks named by exact keys one query reads. */
export const DEFAULT_LINKED_TASKS_PER_QUERY = 64;
/** How many boundary rows the candidate scan reads before reporting truncation. */
export const DEFAULT_CANDIDATE_SCAN_ROWS = 100;
/** How many associated tasks one result returns at most. */
export const DEFAULT_RETURNED_TASKS_PER_QUERY = 50;
/** How long the read connection may wait for a write lock before it reports busy. */
export const DEFAULT_HISTORY_LOCK_WAIT_MS = 500;

/** The exact-key prefix the router learns from response bodies; the log stores the bare id. */
const RESPONSE_KEY_PREFIX = "response:";

/** Hard ceilings a caller may raise a limit to, so one poll cannot grow without bound. */
const MAX_EXACT_KEYS_CEILING = 256;
const MAX_LINKED_TASKS_CEILING = 256;
const MAX_CANDIDATE_SCAN_CEILING = 500;
const MAX_RETURNED_TASKS_CEILING = 200;
const MAX_LOCK_WAIT_CEILING_MS = 5_000;

export interface BindingHistoryQueryLimits {
  readonly maxExactKeys: number;
  readonly maxLinkedTasks: number;
  readonly candidateScanRows: number;
  readonly maxReturnedTasks: number;
}

export const DEFAULT_BINDING_HISTORY_LIMITS: BindingHistoryQueryLimits = Object.freeze({
  maxExactKeys: DEFAULT_EXACT_KEYS_PER_QUERY,
  maxLinkedTasks: DEFAULT_LINKED_TASKS_PER_QUERY,
  candidateScanRows: DEFAULT_CANDIDATE_SCAN_ROWS,
  maxReturnedTasks: DEFAULT_RETURNED_TASKS_PER_QUERY,
});

/**
 * How firmly the log ties a binding to a task. `high` means an exact key of the binding is
 * stored in a link table beside that task and the static boundary still agrees;
 * `candidate` means only that boundary agrees. A candidate is never an identity, so it
 * never collapses into one representative task.
 */
export type HistoryAssociationLevel = "high" | "candidate";
export type HistoryAssociationConfidence = "high" | "candidate" | "none";

/** Why an association ended up the way it did, in machine-readable form. */
export type HistoryAssociationReason =
  | "exact_key_links"
  | "several_linked_tasks"
  | "key_without_link"
  | "key_without_task"
  | "link_boundary_mismatch"
  | "key_limit_exceeded"
  | "boundary_candidates"
  | "candidate_scan_truncated"
  | "task_list_truncated"
  | "no_log_configured"
  | "no_traffic_database"
  | "history_query_failed"
  | "log_write_may_be_pending";

/** Whether the history could be read at all, and why not when it could not. */
export type HistoryCoverageState =
  "no_log_configured" | "no_traffic_database" | "available" | "failed";

/** What went wrong reading the log. A failure is reported as itself, never as `none`. */
export interface HistoryQueryFailure {
  readonly phase: "open" | "read";
  readonly errorName: string;
  readonly message: string;
  readonly code: string | null;
}

/** What the reader had to stop at, and what it actually looked at. */
export interface BindingHistoryCoverage {
  readonly state: HistoryCoverageState;
  readonly logRoot: string | null;
  readonly exactLinkRowsRead: number;
  readonly linkedTasksRead: number;
  readonly candidateRowsRead: number;
  readonly historyRowsRead: number;
  readonly historyTruncated: boolean;
  readonly exactKeysRequested: number;
  readonly exactKeysExamined: number;
  readonly exactKeysOmitted: number;
  readonly exactKeysLinked: number;
  readonly exactKeysWithoutLink: number;
  readonly candidateScanLimit: number;
  readonly returnedTaskLimit: number;
  readonly latestStoredRecordAt: string | null;
  readonly logWriteMayBePending: boolean;
  readonly failure: HistoryQueryFailure | null;
}

/** One task the history connects to this binding. No body, no key, no user text. */
export interface AssociatedTask {
  readonly taskId: string;
  readonly level: HistoryAssociationLevel;
  /** How many of the binding's exact keys named this task; zero for a boundary candidate. */
  readonly exactKeyMatches: number;
  readonly kind: string;
  readonly endpoint: string | null;
  readonly model: string | null;
  readonly requestCount: number;
  readonly lastSeenAt: string;
  readonly lastResponseAt: string | null;
  /** True while only a pending row backs this task: the finished log has not landed. */
  readonly pendingRequestOnly: boolean;
  /** The address the task's newest record went to, as stored; not a physical key. */
  readonly historyTargetUrl: string | null;
  /** How that address relates to the node this binding currently points at. */
  readonly historyTargetNode: "same" | "different" | "unknown";
}

/** The answer for one binding: a grade, the tasks behind it, and the limits that shaped it. */
export interface BindingHistoryAssociation {
  readonly confidence: HistoryAssociationConfidence;
  /** True when the association does not identify one task: several tasks or candidate grade. */
  readonly ambiguous: boolean;
  readonly tasks: readonly AssociatedTask[];
  readonly reasons: readonly HistoryAssociationReason[];
  readonly coverage: BindingHistoryCoverage;
}

/**
 * The identity evidence of one binding. The exact keys are handed in, not returned: the
 * key text never comes back out of this service, so a caller cannot leak it onward.
 */
export interface BindingHistoryBindingEvidence {
  readonly exactKeys: readonly string[];
  readonly kind: EndpointKind;
  readonly endpoint: string;
  readonly model: string | undefined;
  readonly boundaryWithoutUser: Readonly<Record<string, string>>;
}

export interface BindingHistoryQuery {
  /** The log root the binding's group writes to, already resolved; undefined for no log. */
  readonly logRoot: string | undefined;
  readonly targetId: string;
  /** The node's canonical physical key, as `LoadBalancer` computes it. */
  readonly canonicalKey: string;
  readonly binding: Readonly<BindingHistoryBindingEvidence>;
  /** The binding's last request start on the pair clock, used only for log coverage. */
  readonly lastRequestStartedAt: number | undefined;
  readonly limits?: Partial<BindingHistoryQueryLimits> | undefined;
}

export interface BindingHistoryServiceOptions {
  /** Opens the read connection for one log root. Tests pass their own to watch the shape. */
  readonly openRepository?: ((logRoot: string) => TrafficRepository) | undefined;
  readonly limits?: Partial<BindingHistoryQueryLimits> | undefined;
  readonly lockWaitMs?: number | undefined;
  readonly logger?: Pick<StructuredLogger, "warn"> | undefined;
}

/**
 * Everything the console needs to say what the traffic log knows about one binding. One
 * query opens one read connection and closes it; nothing is cached, so a log that changed
 * since the last poll is read again.
 */
export class BindingHistoryService {
  readonly #lockWaitMs: number;
  readonly #openRepository: (logRoot: string) => TrafficRepository;
  readonly #limits: Partial<BindingHistoryQueryLimits>;
  readonly #logger: Pick<StructuredLogger, "warn">;

  constructor(options: BindingHistoryServiceOptions = {}) {
    this.#lockWaitMs = resolveLockWait(options.lockWaitMs);
    this.#openRepository =
      options.openRepository ??
      ((logRoot) => new TrafficRepository(logRoot, { lockWaitMs: this.#lockWaitMs }));
    this.#limits = options.limits ?? {};
    this.#logger = options.logger ?? new StructuredLogger({ service: "llm-proxy-binding-history" });
  }

  queryBindingHistory(query: Readonly<BindingHistoryQuery>): BindingHistoryAssociation {
    const limits = resolveLimits(query.limits, this.#limits);
    const keys = splitExactKeys(query.binding.exactKeys, limits.maxExactKeys);
    const logRoot = normalizeLogRoot(query.logRoot);

    let state: HistoryCoverageState = "available";
    let failure: HistoryQueryFailure | null = null;
    let contextLinks: readonly TaskLinkRow[] = [];
    let responseLinks: readonly TaskLinkRow[] = [];
    let linkedTasks: readonly TaskAssociationRow[] = [];
    let namedTaskIdsTruncated = false;
    let candidates: TaskCandidatePage = { rows: [], truncated: false };
    let latestStoredRecordAt: string | null = null;

    if (logRoot === undefined) {
      state = "no_log_configured";
    } else if (!trafficDatabaseExists(logRoot)) {
      state = "no_traffic_database";
    } else {
      const repository = this.#openRepositoryWithFailureReporting(logRoot, (error) => {
        state = "failed";
        failure = describeFailure("open", error);
        this.#warnFailure(query.targetId, logRoot, failure);
      });
      if (repository !== undefined) {
        try {
          contextLinks = repository.contextLinksForKeys(keys.contextKeys);
          responseLinks = repository.responseLinksForIds(keys.responseIds);
          const namedIds = distinctTaskIds(contextLinks, responseLinks);
          namedTaskIdsTruncated = namedIds.length > limits.maxLinkedTasks;
          linkedTasks = repository.tasksForIds(namedIds.slice(0, limits.maxLinkedTasks));
          candidates = repository.taskBoundaryCandidates({
            kind: query.binding.kind,
            model: query.binding.model,
            limit: limits.candidateScanRows,
          });
          latestStoredRecordAt = repository.newestRecordTimestamp();
        } catch (error) {
          state = "failed";
          failure = describeFailure("read", error);
          this.#warnFailure(query.targetId, logRoot, failure);
        } finally {
          repository.close();
        }
      }
    }

    // Which task each exact key named, counted rather than listed so the key text stays
    // inside this function and cannot reach a response.
    const exactKeyMatches = new Map<string, number>();
    for (const link of [...contextLinks, ...responseLinks]) {
      exactKeyMatches.set(link.taskId, (exactKeyMatches.get(link.taskId) ?? 0) + 1);
    }

    const high: AssociatedTask[] = [];
    const mismatchedLinks: AssociatedTask[] = [];
    for (const row of linkedTasks) {
      const matches = exactKeyMatches.get(row.id) ?? 0;
      if (boundaryEvidenceMatches(row, query.binding)) {
        high.push(associatedTask(row, "high", matches, query.canonicalKey));
      } else {
        mismatchedLinks.push(associatedTask(row, "candidate", matches, query.canonicalKey));
      }
    }
    const linkedIds = new Set(linkedTasks.map((row) => row.id));
    const missingLinkedTasks = [...exactKeyMatches.keys()].filter((id) => !linkedIds.has(id));

    const boundaryCandidates: AssociatedTask[] = [];
    for (const row of candidates.rows) {
      if (exactKeyMatches.has(row.id)) {
        continue;
      }
      if (!boundaryEvidenceMatches(row, query.binding)) {
        continue;
      }
      boundaryCandidates.push(associatedTask(row, "candidate", 0, query.canonicalKey));
    }
    boundaryCandidates.sort(byTaskSortTime);

    const tasks = [...high, ...mismatchedLinks.sort(byTaskSortTime), ...boundaryCandidates];
    const returnedTasks = tasks.slice(0, limits.maxReturnedTasks);
    const taskListTruncated = returnedTasks.length < tasks.length;

    const confidence: HistoryAssociationConfidence =
      high.length > 0 ? "high" : tasks.length > 0 ? "candidate" : "none";
    // A candidate never identifies a task, however few there are, and several linked tasks
    // are equally not-one-task; the caller has to show the whole scope either way.
    const ambiguous = tasks.some((task) => task.level === "candidate") || high.length > 1;

    const exactKeysExamined = keys.contextKeys.length + keys.responseIds.length;
    const exactKeysOmitted = keys.requestedCount - exactKeysExamined;
    const exactKeysLinked = contextLinks.length + responseLinks.length;
    const logWriteMayBePending =
      state === "available" &&
      query.lastRequestStartedAt !== undefined &&
      (latestStoredRecordAt === null ||
        (recordMilliseconds(latestStoredRecordAt) ?? Number.POSITIVE_INFINITY) <
          query.lastRequestStartedAt);

    const reasons: HistoryAssociationReason[] = [];
    if (state === "no_log_configured") reasons.push("no_log_configured");
    if (state === "no_traffic_database") reasons.push("no_traffic_database");
    if (state === "failed") reasons.push("history_query_failed");
    if (exactKeysOmitted > 0) reasons.push("key_limit_exceeded");
    // Only what was actually read can be reported as a missing or mismatched link. After a
    // failed read every key looked unmatched, and saying so would turn a database error
    // into "this binding has no history".
    if (state === "available") {
      if (missingLinkedTasks.length > 0) reasons.push("key_without_task");
      if (mismatchedLinks.length > 0) reasons.push("link_boundary_mismatch");
      if (high.length > 0) reasons.push("exact_key_links");
      if (high.length > 1) reasons.push("several_linked_tasks");
      if (exactKeysExamined > exactKeysLinked) reasons.push("key_without_link");
      if (boundaryCandidates.length > 0) reasons.push("boundary_candidates");
    }
    if (candidates.truncated) reasons.push("candidate_scan_truncated");
    if (taskListTruncated) reasons.push("task_list_truncated");
    if (logWriteMayBePending) reasons.push("log_write_may_be_pending");

    const exactLinkRowsRead = contextLinks.length + responseLinks.length;
    const candidateRowsRead = candidates.rows.length;
    return {
      confidence,
      ambiguous,
      tasks: returnedTasks,
      reasons,
      coverage: {
        state,
        logRoot: logRoot ?? null,
        exactLinkRowsRead,
        linkedTasksRead: linkedTasks.length,
        candidateRowsRead,
        historyRowsRead: exactLinkRowsRead + linkedTasks.length + candidateRowsRead,
        historyTruncated:
          exactKeysOmitted > 0 ||
          namedTaskIdsTruncated ||
          candidates.truncated ||
          taskListTruncated,
        exactKeysRequested: keys.requestedCount,
        exactKeysExamined,
        exactKeysOmitted,
        exactKeysLinked,
        exactKeysWithoutLink: exactKeysExamined - exactKeysLinked,
        candidateScanLimit: limits.candidateScanRows,
        returnedTaskLimit: limits.maxReturnedTasks,
        latestStoredRecordAt,
        logWriteMayBePending,
        failure,
      },
    };
  }

  #warnFailure(targetId: string, logRoot: string, failure: HistoryQueryFailure): void {
    this.#logger.warn("Binding history query failed", {
      phase: "binding_history_query",
      target_id: targetId,
      log_root: logRoot,
      failure_phase: failure.phase,
      error_type: failure.errorName,
      code: failure.code,
    });
  }

  /** Opening is the one step whose failure must not escape the query unreported. */
  #openRepositoryWithFailureReporting(
    logRoot: string,
    report: (error: unknown) => void,
  ): TrafficRepository | undefined {
    try {
      return this.#openRepository(logRoot);
    } catch (error) {
      report(error);
      return undefined;
    }
  }
}

/** Blank means no log; a configured path is used exactly as the caller resolved it. */
function normalizeLogRoot(logRoot: string | undefined): string | undefined {
  const trimmed = logRoot?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

function trafficDatabaseExists(logRoot: string): boolean {
  const databasePath = logDatabasePath(logRoot);
  return databasePath !== undefined && existsSync(databasePath);
}

/**
 * Deduplicates the binding's keys and stops at the query cap. Response keys become the bare
 * ids the `response_links` table stores; every other key is looked up in `context_links`,
 * which holds the same `prefix:value` spelling the router uses.
 */
function splitExactKeys(
  exactKeys: readonly string[],
  maxExactKeys: number,
): {
  readonly requestedCount: number;
  readonly contextKeys: readonly string[];
  readonly responseIds: readonly string[];
} {
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const key of exactKeys) {
    const trimmed = key.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    requested.push(trimmed);
  }
  const examined = requested.slice(0, maxExactKeys);
  const contextKeys = examined.filter((key) => !key.startsWith(RESPONSE_KEY_PREFIX));
  const responseIds = examined
    .filter((key) => key.startsWith(RESPONSE_KEY_PREFIX))
    .map((key) => key.slice(RESPONSE_KEY_PREFIX.length).trim())
    .filter((responseId) => responseId !== "");
  return { requestedCount: requested.length, contextKeys, responseIds };
}

function distinctTaskIds(
  contextLinks: readonly TaskLinkRow[],
  responseLinks: readonly TaskLinkRow[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const link of [...contextLinks, ...responseLinks]) {
    if (!seen.has(link.taskId)) {
      seen.add(link.taskId);
      ids.push(link.taskId);
    }
  }
  return ids;
}

/** The task columns the reader returns, projected so no body or identity key is present. */
function associatedTask(
  row: Readonly<TaskAssociationRow>,
  level: HistoryAssociationLevel,
  exactKeyMatches: number,
  canonicalKey: string,
): AssociatedTask {
  return {
    taskId: row.id,
    level,
    exactKeyMatches,
    kind: row.kind,
    endpoint: row.endpoint,
    model: row.model,
    requestCount: row.request_count,
    lastSeenAt: row.last_seen_at,
    lastResponseAt: row.last_response_at,
    pendingRequestOnly: row.pending_request_only,
    historyTargetUrl: row.target,
    historyTargetNode: historyTargetNode(row.target, canonicalKey),
  };
}

/**
 * Whether the address the task last went to names the same physical engine as this node.
 * The stored address is a URL as the proxy wrote it, never a canonical key: ports and
 * loopback spellings are normalised on both sides before they are compared, and an address
 * that cannot be parsed stays unknown instead of being guessed into a match.
 */
function historyTargetNode(
  historyTargetUrl: string | null,
  canonicalKey: string,
): "same" | "different" | "unknown" {
  if (historyTargetUrl === null || canonicalKey === "") {
    return "unknown";
  }
  const canonical = tryCanonicalNodeKey(historyTargetUrl);
  if (canonical === undefined) {
    return "unknown";
  }
  return canonical === canonicalKey ? "same" : "different";
}

/**
 * The same static boundary test the matcher applies before it continues a task through a
 * context key: kind, model, endpoint and the boundary without the first user message. It is
 * applied to a linked task too, because a link row can outlive the conversation that wrote
 * it - the key may name a task whose boundary no longer matches this binding.
 */
function boundaryEvidenceMatches(
  row: Readonly<TaskAssociationRow>,
  binding: Readonly<BindingHistoryBindingEvidence>,
): boolean {
  if (row.kind !== binding.kind) {
    return false;
  }
  if ((row.model ?? null) !== (binding.model ?? null)) {
    return false;
  }
  const storedEndpoint = row.endpoint;
  if (
    storedEndpoint !== null &&
    storedEndpoint !== "" &&
    binding.endpoint !== "" &&
    storedEndpoint !== binding.endpoint
  ) {
    return false;
  }
  return (
    stableJsonStringify(
      boundaryWithoutUser(storedBoundaryFingerprints(row.boundary_fingerprints)),
    ) === stableJsonStringify(binding.boundaryWithoutUser)
  );
}

function byTaskSortTime(left: AssociatedTask, right: AssociatedTask): number {
  return taskSortTime(right) - taskSortTime(left);
}

/** The task list's own ordering key, the one the `tasks` table sorts by. */
function taskSortTime(task: Readonly<AssociatedTask>): number {
  const timestamp = Date.parse(task.lastSeenAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function recordMilliseconds(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/** A SQLite or connection error as it stands: name, message and code, never a guess. */
function describeFailure(phase: "open" | "read", error: unknown): HistoryQueryFailure {
  const code = isRecord(error) ? error["code"] : undefined;
  return {
    phase,
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    code: typeof code === "string" ? code : null,
  };
}

function resolveLimits(
  overrides: Partial<BindingHistoryQueryLimits> | undefined,
  base: Partial<BindingHistoryQueryLimits> | undefined,
): BindingHistoryQueryLimits {
  return {
    maxExactKeys: resolveLimit(
      overrides?.maxExactKeys ?? base?.maxExactKeys,
      DEFAULT_BINDING_HISTORY_LIMITS.maxExactKeys,
      1,
      MAX_EXACT_KEYS_CEILING,
    ),
    maxLinkedTasks: resolveLimit(
      overrides?.maxLinkedTasks ?? base?.maxLinkedTasks,
      DEFAULT_BINDING_HISTORY_LIMITS.maxLinkedTasks,
      1,
      MAX_LINKED_TASKS_CEILING,
    ),
    candidateScanRows: resolveLimit(
      overrides?.candidateScanRows ?? base?.candidateScanRows,
      DEFAULT_BINDING_HISTORY_LIMITS.candidateScanRows,
      1,
      MAX_CANDIDATE_SCAN_CEILING,
    ),
    maxReturnedTasks: resolveLimit(
      overrides?.maxReturnedTasks ?? base?.maxReturnedTasks,
      DEFAULT_BINDING_HISTORY_LIMITS.maxReturnedTasks,
      1,
      MAX_RETURNED_TASKS_CEILING,
    ),
  };
}

function resolveLockWait(lockWaitMs: number | undefined): number {
  return resolveLimit(lockWaitMs, DEFAULT_HISTORY_LOCK_WAIT_MS, 0, MAX_LOCK_WAIT_CEILING_MS);
}

function resolveLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const chosen = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(chosen, minimum), maximum);
}
