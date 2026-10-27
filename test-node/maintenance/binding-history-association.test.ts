import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  BindingHistoryService,
  type AssociatedTask,
  type BindingHistoryBindingEvidence,
} from "../../src/maintenance/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";
import { LoadAffinityTable } from "../../src/proxy/load-affinity.js";
import {
  requestBoundaryFingerprints,
  type EndpointKind,
} from "../../src/proxy/protocol/analysis.js";
import { boundaryWithoutUser, taskIdentity } from "../../src/proxy/protocol/task-identity.js";

/**
 * [TRI-04] the binding-to-history query: how an exact key becomes a task, what a candidate
 * is allowed to claim, which caps a console poll has to respect, and what the reader says
 * when the history is missing instead of pretending it looked.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // Windows can hold the log file for a moment after a connection that failed to
      // open closes, so the same retry the admin fixtures use is what makes cleanup land.
      rm(directory, { force: true, recursive: true, maxRetries: 6, retryDelay: 300 }),
    ),
  );
});

const BOUNDARY = Object.freeze({ instructions: "sha-instructions" });
const OTHER_BOUNDARY = Object.freeze({ instructions: "sha-something-else" });
const CANONICAL_KEY = "http://127.0.0.1:8000";
const SECRET_USER_TEXT = "the private prompt the console must never see";
const SECRET_BODY_TEXT = "the private request body the console must never see";

async function newLogRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-binding-history-"));
  temporaryDirectories.push(root);
  return root;
}

function evidence(
  overrides: {
    readonly exactKeys?: readonly string[];
    readonly kind?: EndpointKind;
    readonly endpoint?: string;
    readonly boundaryWithoutUser?: Readonly<Record<string, string>>;
  } = {},
): BindingHistoryBindingEvidence {
  return {
    exactKeys: overrides.exactKeys ?? ["conversation:conv-1"],
    kind: overrides.kind ?? "responses",
    endpoint: overrides.endpoint ?? "/v1/responses",
    model: "model-x",
    boundaryWithoutUser: overrides.boundaryWithoutUser ?? BOUNDARY,
    firstUserHash: "sha-first-user",
  };
}

function taskWrite(
  id: string,
  overrides: {
    readonly boundary?: Readonly<Record<string, string>>;
    readonly firstUserHash?: string;
    readonly lastSeenAt?: string;
    readonly target?: string;
    readonly pending?: boolean;
    readonly model?: string | null;
  } = {},
) {
  return {
    id,
    kind: "responses",
    endpoint: "/v1/responses",
    model: overrides.model === undefined ? "model-x" : overrides.model,
    anchor: `task-${id}`,
    started_at: "2026-07-18T08:00:00.000+08:00",
    last_seen_at: overrides.lastSeenAt ?? "2026-07-18T09:00:00.000+08:00",
    last_response_at: "2026-07-18T09:00:00.000+08:00",
    request_count: 3,
    pending_request_only: overrides.pending ?? false,
    match_strategy_version: 6,
    ...(overrides.target === undefined ? {} : { target: overrides.target }),
    boundary_fingerprints: {
      ...(overrides.boundary ?? BOUNDARY),
      first_user: overrides.firstUserHash ?? "sha-first-user",
    },
    fingerprints: { input: "sha-input" },
    last_user_messages: [SECRET_USER_TEXT],
    created_at: "2026-07-18T08:00:00.000+08:00",
    updated_at: "2026-07-18T09:00:00.000+08:00",
  };
}

function recordWrite(id: string, taskId: string, timestamp: string, targetUrl?: string) {
  return {
    id,
    task_id: taskId,
    sequence: 1,
    event: "request_finished",
    timestamp,
    method: "POST",
    path: "/v1/responses",
    endpoint: "/v1/responses",
    status: 200,
    ...(targetUrl === undefined ? {} : { target_url: targetUrl }),
    request_body: { text: SECRET_BODY_TEXT },
    response_body: { id: `resp-${id}`, output_text: "answer" },
  };
}

function taskIds(tasks: readonly AssociatedTask[]): string[] {
  return tasks.map((task) => task.taskId);
}

describe("BindingHistoryService", () => {
  it("[TRI-04] maps a binding exact key to the task the log linked it to", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertRecord(recordWrite("record-1", "task-1", "2026-07-18T09:30:00.000+08:00"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: Date.parse("2026-07-18T09:00:00.000+08:00"),
    });

    expect(result).toMatchObject({
      confidence: "high",
      ambiguous: false,
      reasons: ["exact_key_links"],
    });
    expect(taskIds(result.tasks)).toEqual(["task-1"]);
    expect(result.tasks[0]).toMatchObject({
      level: "high",
      exactKeyMatches: 1,
      kind: "responses",
      requestCount: 3,
      pendingRequestOnly: false,
    });
    expect(result.coverage).toMatchObject({
      state: "available",
      logRoot: root,
      historyTruncated: false,
      exactKeysRequested: 1,
      exactKeysExamined: 1,
      exactKeysOmitted: 0,
      exactKeysLinked: 1,
      exactKeysWithoutLink: 0,
      logWriteMayBePending: false,
      failure: null,
    });
  });

  it("[TRI-04] keeps every task when one binding's keys name several tasks", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { lastSeenAt: "2026-07-18T09:00:00.000+08:00" }));
    repository.upsertTask(taskWrite("task-2", { lastSeenAt: "2026-07-18T10:00:00.000+08:00" }));
    repository.upsertTask(taskWrite("task-3", { lastSeenAt: "2026-07-18T11:00:00.000+08:00" }));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.upsertContextLink("prompt_cache:pk-1", "task-2");
    repository.upsertResponseLink("resp-9", "task-3");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({
        exactKeys: ["conversation:conv-1", "prompt_cache:pk-1", "response:resp-9"],
      }),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("high");
    expect(result.ambiguous).toBe(true);
    expect(result.reasons).toContain("several_linked_tasks");
    expect(taskIds(result.tasks)).toEqual(["task-3", "task-2", "task-1"]);
    expect(result.tasks.map((task) => task.level)).toEqual(["high", "high", "high"]);
    expect(result.tasks.map((task) => task.exactKeyMatches)).toEqual([1, 1, 1]);
    expect(result.coverage.exactKeysLinked).toBe(3);
    expect(result.coverage.exactKeysWithoutLink).toBe(0);
  });

  it("[TRI-04] looks a response key up by the bare id the log stores", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertResponseLink("resp-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys: ["response:resp-1", "conversation:conv-1"] }),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("high");
    expect(taskIds(result.tasks)).toEqual(["task-1"]);
    expect(result.reasons).toEqual(["exact_key_links", "key_without_link"]);
    expect(result.coverage).toMatchObject({
      exactKeysRequested: 2,
      exactKeysExamined: 2,
      exactKeysLinked: 1,
      exactKeysWithoutLink: 1,
    });
  });

  it("[TRI-04] reports none, naming the keys that found nothing, when the log has no link", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-other", { boundary: OTHER_BOUNDARY }));
    repository.upsertRecord(recordWrite("record-1", "task-other", "2026-07-18T09:30:00.000+08:00"));
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys: ["conversation:conv-1", "prompt_cache:pk-1"] }),
      lastRequestStartedAt: Date.parse("2026-07-18T09:00:00.000+08:00"),
    });

    expect(result).toMatchObject({ confidence: "none", ambiguous: false, tasks: [] });
    expect(result.reasons).toEqual(["key_without_link"]);
    expect(result.coverage).toMatchObject({
      state: "available",
      exactKeysLinked: 0,
      exactKeysWithoutLink: 2,
      logWriteMayBePending: false,
      historyRowsRead: 1,
    });
  });

  it("[TRI-04] grades a boundary-only task as candidate and never as an identity", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("candidate");
    expect(result.ambiguous).toBe(true);
    expect(result.reasons).toEqual(["key_without_link", "boundary_candidates"]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      level: "candidate",
      exactKeyMatches: 0,
      taskId: "task-1",
    });
  });

  it("[TRI-04] matches a task that carries no model against a binding that carries none", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-no-model", { model: null }));
    repository.upsertTask(taskWrite("task-other-model", { model: "model-x" }));
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: {
        exactKeys: [],
        kind: "responses",
        endpoint: "/v1/responses",
        model: undefined,
        boundaryWithoutUser: BOUNDARY,
        firstUserHash: "sha-first-user",
      },
      lastRequestStartedAt: undefined,
    });

    expect(taskIds(result.tasks)).toEqual(["task-no-model"]);
    expect(result.confidence).toBe("candidate");
  });

  it("[TRI-04] keeps every boundary candidate instead of choosing a representative", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { lastSeenAt: "2026-07-18T09:00:00.000+08:00" }));
    repository.upsertTask(taskWrite("task-2", { lastSeenAt: "2026-07-18T10:00:00.000+08:00" }));
    repository.upsertTask(taskWrite("task-3", { boundary: OTHER_BOUNDARY }));
    repository.upsertTask(taskWrite("task-4", { model: "model-y" }));
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("candidate");
    expect(result.ambiguous).toBe(true);
    expect(taskIds(result.tasks)).toEqual(["task-2", "task-1"]);
    expect(result.tasks.map((task) => task.level)).toEqual(["candidate", "candidate"]);
  });

  it("[TRI-04 regression] does not turn same-boundary history into fifty tasks when an exact key identifies one", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-exact"));
    repository.upsertContextLink("conversation:conv-1", "task-exact");
    for (let index = 1; index < 70; index += 1) {
      repository.upsertTask(
        taskWrite(`task-noise-${index}`, {
          firstUserHash: `sha-noise-${index}`,
          lastSeenAt: `2026-07-18T09:${String(index).padStart(2, "0")}:00.000+08:00`,
          target: CANONICAL_KEY,
        }),
      );
    }
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(taskIds(result.tasks)).toEqual(["task-exact"]);
    expect(result.confidence).toBe("high");
    expect(result.ambiguous).toBe(false);
    expect(result.reasons).toEqual(["exact_key_links"]);
    expect(result.coverage.candidateRowsRead).toBe(70);
    expect(result.coverage.historyTruncated).toBe(false);
  });

  it("[TRI-04 regression] lowers aggregate confidence when an exact link and a candidate coexist", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-exact"));
    repository.upsertTask(taskWrite("task-candidate"));
    repository.upsertContextLink("conversation:conv-1", "task-exact");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("candidate");
    expect(result.ambiguous).toBe(true);
    expect(result.tasks.map((task) => task.level)).toEqual(["high", "candidate"]);
  });

  it("[TRI-04 regression] excludes candidates on another node and outside the activity window", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(
      taskWrite("task-current", {
        lastSeenAt: "2026-07-18T09:30:00.000+08:00",
        target: CANONICAL_KEY,
      }),
    );
    repository.upsertTask(
      taskWrite("task-other-node", {
        lastSeenAt: "2026-07-18T09:45:00.000+08:00",
        target: "http://127.0.0.1:9000",
      }),
    );
    repository.upsertTask(
      taskWrite("task-old", {
        lastSeenAt: "2026-07-18T07:00:00.000+08:00",
        target: CANONICAL_KEY,
      }),
    );
    repository.close();

    const result = new BindingHistoryService({
      limits: { candidateActivityWindowMs: 60 * 60 * 1_000 },
    }).queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: Date.parse("2026-07-18T10:00:00.000+08:00"),
    });

    expect(taskIds(result.tasks)).toEqual(["task-current"]);
    expect(result.tasks[0]?.historyTargetNode).toBe("same");
    expect(result.confidence).toBe("candidate");
    expect(result.reasons).toContain("boundary_candidates");
  });
  it("[TRI-04] drops a link to candidate grade when the task's boundary no longer matches", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { boundary: OTHER_BOUNDARY }));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("candidate");
    expect(result.ambiguous).toBe(true);
    expect(result.reasons).toEqual(["link_boundary_mismatch"]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ level: "candidate", exactKeyMatches: 1 });
  });

  it("[TRI-04] reports a link that names no task row rather than pretending there is none", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { boundary: OTHER_BOUNDARY }));
    repository.close();
    // A log an importer wrote without the foreign key: the link row survived, the task
    // row it names never existed. A reader must report that, not call it "no association".
    const raw = new Database(path.join(root, "traffic.db"));
    raw.pragma("foreign_keys = OFF");
    raw
      .prepare("INSERT INTO context_links(context_key, task_id, created_at) VALUES (?, ?, ?)")
      .run("conversation:conv-ghost", "task-gone", "2026-07-18T09:00:00.000+08:00");
    raw.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys: ["conversation:conv-ghost"] }),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("none");
    expect(result.tasks).toEqual([]);
    expect(result.reasons).toEqual(["key_without_task"]);
    expect(result.coverage).toMatchObject({
      state: "available",
      exactLinkRowsRead: 1,
      linkedTasksRead: 0,
      exactKeysLinked: 1,
      exactKeysWithoutLink: 0,
    });
  });

  it("[TRI-04] reports an unreadable log as a failure and never as no association", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const warnings: { message: string; context: Record<string, unknown> }[] = [];
    const service = new BindingHistoryService({
      openRepository: () => {
        throw new Error("cannot open the traffic log");
      },
      logger: {
        warn: (message: string, context?: Record<string, unknown>): void => {
          warnings.push({ message, context: context ?? {} });
        },
      },
    });

    const result = service.queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result).toMatchObject({ confidence: "none", ambiguous: false, tasks: [] });
    expect(result.reasons).toEqual(["history_query_failed"]);
    expect(result.coverage).toMatchObject({
      state: "failed",
      historyTruncated: false,
      logWriteMayBePending: false,
      failure: { phase: "open", errorName: "Error", message: "cannot open the traffic log" },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toMatchObject({
      phase: "binding_history_query",
      target_id: "node-a",
      failure_phase: "open",
    });
  });

  it("[TRI-04] reports a log file the driver cannot open as a failed open", async () => {
    const root = await newLogRoot();
    // Something is sitting where the traffic database should be, so the connection cannot
    // be made at all. The reader must report that, not "this binding has no history".
    await mkdir(path.join(root, "traffic.db"));

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("none");
    expect(result.tasks).toEqual([]);
    expect(result.reasons).toEqual(["history_query_failed"]);
    expect(result.coverage).toMatchObject({
      state: "failed",
      failure: { phase: "open", errorName: "SqliteError" },
    });
    // SQLite reports this condition with the primary code on the unix VFS and with the
    // extended ISDIR code on the Windows VFS, and the service records whichever one the
    // driver returned: opening a directory named traffic.db with better-sqlite3 12.11.1 gave
    // SQLITE_CANTOPEN_ISDIR on win32 and SQLITE_CANTOPEN on Linux, same message. Pinning the
    // extended code alone turned the ubuntu runner red, so what this pins is a cannot-open
    // code, not which VFS suffix it grew.
    expect(result.coverage.failure?.message).toContain("unable to open database file");
  });

  it("[TRI-04] reports a failing statement as a failed read, not as missing history", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();
    // The shape a log would have if the table it joins were gone: the reader must say the
    // read broke rather than report that the binding has no history.
    const raw = new Database(path.join(root, "traffic.db"));
    raw.exec("DROP TABLE context_links");
    raw.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("none");
    expect(result.reasons).toEqual(["history_query_failed"]);
    expect(result.coverage.failure).toMatchObject({ phase: "read", errorName: "SqliteError" });
    expect(result.coverage.failure?.message).toContain("no such table: context_links");
  });

  it("[TRI-04] tells an unconfigured log apart from a log that holds no database yet", async () => {
    const root = await newLogRoot();

    const withoutLog = new BindingHistoryService().queryBindingHistory({
      logRoot: undefined,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });
    expect(withoutLog.confidence).toBe("none");
    expect(withoutLog.reasons).toEqual(["no_log_configured"]);
    expect(withoutLog.coverage).toMatchObject({
      state: "no_log_configured",
      logRoot: null,
      latestStoredRecordAt: null,
    });

    const withoutDatabase = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });
    expect(withoutDatabase.reasons).toEqual(["no_traffic_database"]);
    expect(withoutDatabase.coverage.state).toBe("no_traffic_database");
    // Reading a history that is not there must not create one.
    expect(existsSync(path.join(root, "traffic.db"))).toBe(false);
  });

  it("[TRI-04] reads only the log root the binding's group writes to", async () => {
    const rootA = await newLogRoot();
    const rootB = await newLogRoot();
    const repositoryA = new TrafficRepository(rootA);
    repositoryA.upsertTask(taskWrite("task-in-a"));
    repositoryA.upsertContextLink("conversation:conv-1", "task-in-a");
    repositoryA.close();
    const repositoryB = new TrafficRepository(rootB);
    repositoryB.upsertTask(taskWrite("task-in-b"));
    repositoryB.upsertContextLink("conversation:conv-1", "task-in-b");
    repositoryB.close();

    const fromA = new BindingHistoryService().queryBindingHistory({
      logRoot: rootA,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });
    const fromB = new BindingHistoryService().queryBindingHistory({
      logRoot: rootB,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(taskIds(fromA.tasks)).toEqual(["task-in-a"]);
    expect(taskIds(fromB.tasks)).toEqual(["task-in-b"]);
    expect(fromA.coverage.logRoot).toBe(rootA);
    expect(fromB.coverage.logRoot).toBe(rootB);
  });

  it("[TRI-04] caps the exact keys of a binding and says which were not looked up", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertTask(taskWrite("task-2", { boundary: OTHER_BOUNDARY }));
    for (const taskId of ["task-1", "task-2"]) {
      for (let index = 0; index < 70; index += 1) {
        repository.upsertContextLink(`conversation:conv-${taskId}-${index}`, taskId);
      }
    }
    repository.close();

    const exactKeys: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      exactKeys.push("conversation:conv-task-1-" + String(index));
    }
    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys }),
      lastRequestStartedAt: undefined,
    });

    expect(result.coverage).toMatchObject({
      exactKeysRequested: 70,
      exactKeysExamined: 64,
      exactKeysOmitted: 6,
      exactKeysLinked: 64,
      historyTruncated: true,
    });
    expect(result.reasons).toContain("key_limit_exceeded");
    expect(taskIds(result.tasks)).toEqual(["task-1"]);
  });

  it("[TRI-04] truncates the candidate scan and says more candidates are waiting", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    for (let index = 0; index < 5; index += 1) {
      repository.upsertTask(
        taskWrite(`task-${index}`, { lastSeenAt: `2026-07-18T0${String(index)}:00:00.000+08:00` }),
      );
    }
    repository.close();

    const result = new BindingHistoryService({
      limits: { candidateScanRows: 2 },
    }).queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.reasons).toContain("candidate_scan_truncated");
    expect(result.coverage).toMatchObject({
      candidateScanLimit: 2,
      candidateRowsRead: 2,
      historyTruncated: true,
    });
    expect(taskIds(result.tasks)).toEqual(["task-4", "task-3"]);
  });

  it("[TRI-04] caps the task list it hands back", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    for (let index = 0; index < 5; index += 1) {
      repository.upsertTask(
        taskWrite(`task-${index}`, { lastSeenAt: `2026-07-18T1${String(index)}:00:00.000+08:00` }),
      );
      repository.upsertContextLink(`conversation:conv-${index}`, `task-${index}`);
    }
    repository.close();

    const exactKeys: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      exactKeys.push("conversation:conv-" + String(index));
    }
    const result = new BindingHistoryService({
      limits: { maxReturnedTasks: 2 },
    }).queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys }),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("high");
    expect(result.ambiguous).toBe(true);
    expect(result.reasons).toContain("task_list_truncated");
    expect(result.tasks).toHaveLength(2);
    expect(taskIds(result.tasks)).toEqual(["task-4", "task-3"]);
    expect(result.coverage).toMatchObject({ returnedTaskLimit: 2, historyTruncated: true });
  });

  it("[TRI-04] says a log write may still be pending when nothing stored is newer", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { boundary: OTHER_BOUNDARY }));
    repository.upsertRecord(
      recordWrite("record-1", "task-1", "2026-07-18T09:30:00.000+08:00", "http://127.0.0.1:8000"),
    );
    repository.close();

    const pending = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys: ["conversation:conv-new"] }),
      lastRequestStartedAt: Date.parse("2026-07-18T10:00:00.000+08:00"),
    });
    expect(pending.coverage).toMatchObject({
      state: "available",
      latestStoredRecordAt: "2026-07-18T09:30:00.000+08:00",
      logWriteMayBePending: true,
    });
    expect(pending.reasons).toContain("log_write_may_be_pending");

    const caughtUp = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys: ["conversation:conv-new"] }),
      lastRequestStartedAt: Date.parse("2026-07-18T09:00:00.000+08:00"),
    });
    expect(caughtUp.coverage.logWriteMayBePending).toBe(false);
    expect(caughtUp.reasons).not.toContain("log_write_may_be_pending");
  });

  it("[TRI-04] marks a task the log has only received, never finished", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { pending: true }));
    repository.upsertRecord({
      id: "record-1",
      task_id: "task-1",
      sequence: 1,
      event: "request_pending_response",
      timestamp: "2026-07-18T09:30:00.000+08:00",
      method: "POST",
      path: "/v1/responses",
    });
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: Date.parse("2026-07-18T09:00:00.000+08:00"),
    });

    expect(result.confidence).toBe("high");
    expect(result.tasks[0]).toMatchObject({ pendingRequestOnly: true, level: "high" });
    expect(result.coverage.logWriteMayBePending).toBe(false);
  });

  it("[TRI-04] compares history addresses by physical key, not by the stored spelling", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-same-spelling", { target: "http://localhost:8000" }));
    repository.upsertTask(taskWrite("task-other-node", { target: "http://127.0.0.1:9000" }));
    repository.upsertTask(taskWrite("task-unparsable", { target: "not a url" }));
    repository.upsertTask(taskWrite("task-no-address"));
    repository.upsertRecord(
      recordWrite(
        "record-1",
        "task-no-address",
        "2026-07-18T09:30:00.000+08:00",
        "http://127.0.0.1:8000",
      ),
    );
    repository.upsertContextLink("conversation:conv-1", "task-same-spelling");
    repository.upsertContextLink("prompt_cache:pk-1", "task-other-node");
    repository.upsertContextLink("claude_session:cs-1", "task-unparsable");
    repository.upsertContextLink("prompt_cache:pk-2", "task-no-address");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({
        exactKeys: [
          "conversation:conv-1",
          "prompt_cache:pk-1",
          "claude_session:cs-1",
          "prompt_cache:pk-2",
        ],
      }),
      lastRequestStartedAt: undefined,
    });

    const byId = new Map(result.tasks.map((task) => [task.taskId, task]));
    expect(byId.get("task-same-spelling")?.historyTargetNode).toBe("same");
    expect(byId.get("task-same-spelling")?.historyTargetUrl).toBe("http://localhost:8000");
    expect(byId.get("task-other-node")?.historyTargetNode).toBe("different");
    expect(byId.get("task-unparsable")?.historyTargetNode).toBe("unknown");
    // The task carries no address of its own, so the newest record's upstream answers.
    expect(byId.get("task-no-address")?.historyTargetUrl).toBe("http://127.0.0.1:8000");
    expect(byId.get("task-no-address")?.historyTargetNode).toBe("same");
  });

  it("[TRI-04] hands back no request body, no response body and no stored user text", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertRecord(recordWrite("record-1", "task-1", "2026-07-18T09:30:00.000+08:00"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    const serialised = JSON.stringify(result);
    expect(result.confidence).toBe("high");
    expect(serialised).not.toContain(SECRET_USER_TEXT);
    expect(serialised).not.toContain(SECRET_BODY_TEXT);
    expect(serialised).not.toContain("conversation:conv-1");
    expect(Object.keys(result.tasks[0] ?? {})).toEqual([
      "taskId",
      "level",
      "exactKeyMatches",
      "kind",
      "endpoint",
      "model",
      "requestCount",
      "lastSeenAt",
      "lastResponseAt",
      "pendingRequestOnly",
      "historyTargetUrl",
      "historyTargetNode",
    ]);
  });

  it("[TRI-04] reads the router's own exact keys without touching the affinity table", async () => {
    const root = await newLogRoot();
    const payload = {
      model: "model-x",
      instructions: "instructions",
      input: [{ role: "user", content: "hello" }],
      prompt_cache_key: "pk-7",
    };
    const identity = taskIdentity({ payload, path: "/v1/responses" });
    const table = new LoadAffinityTable();
    const binding = table.bind(identity, "node-a");

    const repository = new TrafficRepository(root);
    repository.upsertTask(
      taskWrite("task-1", { boundary: requestBoundaryFingerprints(identity.kind, payload) }),
    );
    repository.upsertContextLink("prompt_cache:pk-7", "task-1");
    repository.close();

    const before = table.bindingEntries();
    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: {
        exactKeys: [...binding.exactKeys],
        kind: binding.evidence.kind,
        endpoint: binding.evidence.endpoint,
        model: binding.evidence.model,
        boundaryWithoutUser: binding.evidence.boundaryWithoutUser,
        firstUserHash: binding.evidence.firstUserHash,
      },
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("high");
    expect(taskIds(result.tasks)).toEqual(["task-1"]);
    expect(result.tasks[0]?.exactKeyMatches).toBe(1);
    expect(identity.exactKeys).toContain("prompt_cache:pk-7");
    expect(result.coverage).toMatchObject({
      exactKeysRequested: identity.exactKeys.length,
      exactKeysLinked: identity.exactKeys.length,
      exactKeysWithoutLink: 0,
    });
    expect(table.bindingEntries()).toEqual(before);
    expect(boundaryWithoutUser(requestBoundaryFingerprints(identity.kind, payload))).toEqual(
      binding.evidence.boundaryWithoutUser,
    );
  });

  it("[TRI-04] shows cleaned-up history as a key that now names nothing", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.upsertRecord(recordWrite("record-1", "task-1", "2026-07-18T09:30:00.000+08:00"));
    expect(repository.deleteTasks(["task-1"])).toBe(1);
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.confidence).toBe("none");
    expect(result.tasks).toEqual([]);
    expect(result.reasons).toEqual(["key_without_link"]);
    expect(result.coverage).toMatchObject({ state: "available", failure: null });
  });

  it("[TRI-04] ignores blank and duplicate exact keys", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence({ exactKeys: ["", " ", "conversation:conv-1", "conversation:conv-1"] }),
      lastRequestStartedAt: undefined,
    });

    expect(result.coverage).toMatchObject({
      exactKeysRequested: 1,
      exactKeysExamined: 1,
      exactKeysOmitted: 0,
    });
    expect(result.confidence).toBe("high");
  });

  it("[TRI-04] does not list a task twice as candidate after an exact key named it", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.close();

    const result = new BindingHistoryService().queryBindingHistory({
      logRoot: root,
      targetId: "node-a",
      canonicalKey: CANONICAL_KEY,
      binding: evidence(),
      lastRequestStartedAt: undefined,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.reasons).not.toContain("boundary_candidates");
  });
});
