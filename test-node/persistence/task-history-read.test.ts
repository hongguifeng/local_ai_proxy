import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { TrafficRepository } from "../../src/persistence/index.js";
import type { RepositoryRecord } from "../../src/persistence/access-contracts.js";

/**
 * [TRI-04] the bounded reads the binding-history query is built on: key lookups that
 * resolve in one statement, a candidate scan that says when it stopped, a projection that
 * carries no request content, and a read connection that waits only as long as its caller
 * allows. Everything here is checked against an isolated temporary log.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // Windows can hold a WAL file briefly after a connection closes; the retry the
      // admin fixtures use is what makes cleanup land.
      rm(directory, { force: true, recursive: true, maxRetries: 6, retryDelay: 300 }),
    ),
  );
});

const SECRET_USER_TEXT = "text a history read must never return";
const SECRET_BODY_TEXT = "a body a history read must never load";

async function newLogRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-history-"));
  temporaryDirectories.push(root);
  return root;
}

function taskWrite(
  id: string,
  overrides: {
    readonly kind?: string;
    readonly model?: string | null;
    readonly lastSeenAt?: string;
  } = {},
) {
  return {
    id,
    kind: overrides.kind ?? "responses",
    endpoint: "/v1/responses",
    model: overrides.model === undefined ? "model-x" : overrides.model,
    anchor: `task-${id}`,
    started_at: "2026-07-18T08:00:00.000+08:00",
    last_seen_at: overrides.lastSeenAt ?? "2026-07-18T09:00:00.000+08:00",
    last_response_at: "2026-07-18T09:00:00.000+08:00",
    request_count: 3,
    match_strategy_version: 6,
    boundary_fingerprints: { instructions: `sha-${id}` },
    fingerprints: { input: "sha-input" },
    last_user_messages: [SECRET_USER_TEXT],
    created_at: "2026-07-18T08:00:00.000+08:00",
    updated_at: "2026-07-18T09:00:00.000+08:00",
  };
}

describe("association reads", () => {
  it("[TRI-04] resolves context keys and response ids in one statement each", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertTask(taskWrite("task-2"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.upsertContextLink("prompt_cache:pk-1", "task-2");
    repository.upsertResponseLink("resp-1", "task-2");
    repository.close();

    const opened = new TrafficRepository(root);
    try {
      expect(opened.contextLinksForKeys(["conversation:conv-1", "prompt_cache:pk-1"])).toEqual([
        { key: "conversation:conv-1", taskId: "task-1" },
        { key: "prompt_cache:pk-1", taskId: "task-2" },
      ]);
      expect(opened.contextLinksForKeys(["conversation:missing"])).toEqual([]);
      expect(opened.contextLinksForKeys(["", "   "])).toEqual([]);
      expect(opened.responseLinksForIds(["resp-1", "resp-missing"])).toEqual([
        { key: "resp-1", taskId: "task-2" },
      ]);
    } finally {
      opened.close();
    }
  });

  it("[TRI-04] projects linked tasks without user messages, bodies or search text", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1", { lastSeenAt: "2026-07-18T09:00:00.000+08:00" }));
    repository.upsertTask(taskWrite("task-2", { lastSeenAt: "2026-07-18T10:00:00.000+08:00" }));
    repository.upsertRecord({
      id: "record-1",
      task_id: "task-1",
      sequence: 1,
      event: "request_finished",
      timestamp: "2026-07-18T09:30:00.000+08:00",
      method: "POST",
      path: "/v1/responses",
      target_url: "http://127.0.0.1:8000",
      request_body: { text: SECRET_BODY_TEXT },
      response_body: { text: "the answer" },
    });
    repository.close();

    const opened = new TrafficRepository(root);
    try {
      const rows = opened.tasksForIds(["task-1", "task-2", "task-missing"]);
      expect(rows.map((row) => row.id)).toEqual(["task-2", "task-1"]);
      expect(Object.keys(rows[0] ?? {})).toEqual([
        "id",
        "kind",
        "endpoint",
        "model",
        "target",
        "started_at",
        "last_seen_at",
        "last_response_at",
        "request_count",
        "pending_request_only",
        "boundary_fingerprints",
      ]);
      expect(JSON.stringify(rows)).not.toContain(SECRET_USER_TEXT);
      expect(JSON.stringify(rows)).not.toContain(SECRET_BODY_TEXT);
      expect(rows[0]).toMatchObject({
        id: "task-2",
        kind: "responses",
        model: "model-x",
        target: null,
        request_count: 3,
        pending_request_only: false,
        boundary_fingerprints: { instructions: "sha-task-2" },
      });
      expect(rows[1]).toMatchObject({ id: "task-1", target: "http://127.0.0.1:8000" });
    } finally {
      opened.close();
    }
  });

  it("[TRI-04] narrows boundary candidates by kind and model", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-responses"));
    repository.upsertTask(taskWrite("task-chat", { kind: "chat" }));
    repository.upsertTask(taskWrite("task-other-model", { model: "model-y" }));
    repository.upsertTask(taskWrite("task-no-model", { model: null }));
    repository.close();

    const opened = new TrafficRepository(root);
    try {
      expect(
        opened
          .taskBoundaryCandidates({ kind: "responses", model: "model-x", limit: 10 })
          .rows.map((row) => row.id),
      ).toEqual(["task-responses"]);
      expect(
        opened
          .taskBoundaryCandidates({ kind: "responses", model: undefined, limit: 10 })
          .rows.map((row) => row.id),
      ).toEqual(["task-no-model"]);
      expect(
        opened.taskBoundaryCandidates({ kind: "chat", model: "model-x", limit: 10 }).rows,
      ).toHaveLength(1);
    } finally {
      opened.close();
    }
  });

  it("[TRI-04] reads one row past the candidate cap so truncation is visible", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    for (let index = 0; index < 3; index += 1) {
      repository.upsertTask(
        taskWrite(`task-${index}`, { lastSeenAt: `2026-07-18T0${String(index)}:00:00.000+08:00` }),
      );
    }
    repository.close();

    const opened = new TrafficRepository(root);
    try {
      const partial = opened.taskBoundaryCandidates({
        kind: "responses",
        model: "model-x",
        limit: 2,
      });
      expect(partial.rows.map((row) => row.id)).toEqual(["task-2", "task-1"]);
      expect(partial.truncated).toBe(true);

      const complete = opened.taskBoundaryCandidates({
        kind: "responses",
        model: "model-x",
        limit: 3,
      });
      expect(complete.rows).toHaveLength(3);
      expect(complete.truncated).toBe(false);

      const clamped = opened.taskBoundaryCandidates({
        kind: "responses",
        model: "model-x",
        limit: 999_999,
      });
      expect(clamped.rows).toHaveLength(3);
      expect(clamped.truncated).toBe(false);
    } finally {
      opened.close();
    }
  });

  it("[TRI-04] reports the newest stored record, or nothing when the log is empty", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    expect(repository.newestRecordTimestamp()).toBeNull();
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertRecord({
      id: "record-old",
      task_id: "task-1",
      sequence: 1,
      event: "request_finished",
      timestamp: "2026-07-18T09:00:00.000+08:00",
      method: "POST",
      path: "/v1/responses",
    });
    repository.upsertRecord({
      id: "record-new",
      task_id: "task-1",
      sequence: 2,
      event: "request_finished",
      timestamp: "2026-07-18T10:00:00.000+08:00",
      method: "POST",
      path: "/v1/responses",
    });
    expect(repository.newestRecordTimestamp()).toBe("2026-07-18T10:00:00.000+08:00");
    repository.close();
  });

  it("[TRI-04] reads without writing anything the log could notice", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    repository.upsertTask(taskWrite("task-1"));
    repository.upsertContextLink("conversation:conv-1", "task-1");
    repository.upsertResponseLink("resp-1", "task-1");
    repository.upsertRecord({
      id: "record-1",
      task_id: "task-1",
      sequence: 1,
      event: "request_finished",
      timestamp: "2026-07-18T09:00:00.000+08:00",
      method: "POST",
      path: "/v1/responses",
    });
    repository.close();

    const opened = new TrafficRepository(root);
    try {
      const before = snapshotOf(opened);
      opened.contextLinksForKeys(["conversation:conv-1"]);
      opened.responseLinksForIds(["resp-1"]);
      opened.tasksForIds(["task-1"]);
      opened.taskBoundaryCandidates({ kind: "responses", model: "model-x", limit: 10 });
      opened.newestRecordTimestamp();
      expect(snapshotOf(opened)).toEqual(before);
    } finally {
      opened.close();
    }
  });

  it("[TRI-04] reads the history through key seeks that never reach the body tables", async () => {
    const root = await newLogRoot();
    const repository = new TrafficRepository(root);
    const firstMoment = Date.parse("2026-07-18T08:00:00.000Z");
    for (let index = 0; index < 120; index += 1) {
      const moment = new Date(firstMoment + index * 60_000).toISOString();
      repository.upsertTask(taskWrite(`task-${index}`, { lastSeenAt: moment }));
      repository.upsertContextLink(`conversation:conv-${index}`, `task-${index}`);
      repository.upsertRecord({
        id: `record-${index}`,
        task_id: `task-${index}`,
        sequence: 1,
        event: "request_finished",
        timestamp: moment,
        method: "POST",
        path: "/v1/responses",
        request_body: { text: SECRET_BODY_TEXT },
        response_body: { text: "answer" },
      });
    }
    repository.close();

    const opened = new TrafficRepository(root);
    try {
      const planOf = (sql: string, parameters: readonly unknown[]): string =>
        opened.database
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...parameters)
          .map((row) => String((row as RepositoryRecord)["detail"]))
          .join("\n");

      // Every mirror is run against the store's own answer first, so a drift in the real
      // statement shows up as a failed comparison instead of a plan nobody recognises.
      const linkKeys = ["conversation:conv-1", "conversation:conv-2", "conversation:conv-3"];
      const linkSql =
        "SELECT context_key AS key, task_id FROM context_links WHERE context_key IN (?, ?, ?)";
      expect(mirrorLinks(opened.database.prepare(linkSql).all(...linkKeys))).toEqual(
        opened.contextLinksForKeys(linkKeys),
      );
      const linkPlan = planOf(linkSql, linkKeys);
      expect(linkPlan).toContain("SEARCH context_links USING INDEX");

      const responseSql =
        "SELECT response_id AS key, task_id FROM response_links WHERE response_id IN (?)";
      expect(mirrorLinks(opened.database.prepare(responseSql).all("resp-missing"))).toEqual(
        opened.responseLinksForIds(["resp-missing"]),
      );
      expect(planOf(responseSql, ["resp-missing"])).toContain("SEARCH response_links USING INDEX");

      const taskColumns = `id, kind, endpoint, model, started_at, last_seen_at,
        last_response_at, request_count, pending_request_only, boundary_fingerprints_json`;
      const newestTarget = `COALESCE(NULLIF(tasks.target, ''), (SELECT records.target_url
        FROM records WHERE records.task_id = tasks.id AND records.target_url IS NOT NULL
        AND records.target_url != '' ORDER BY records.sequence DESC LIMIT 1))`;
      const byIdSql = `SELECT ${taskColumns}, ${newestTarget} AS target FROM tasks
        WHERE id IN (?, ?, ?) ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC`;
      const wantedIds = ["task-1", "task-2", "task-3"];
      expect(idsOf(opened.database.prepare(byIdSql).all(...wantedIds))).toEqual(
        opened.tasksForIds(wantedIds).map((row) => row.id),
      );
      const byIdPlan = planOf(byIdSql, wantedIds);
      expect(byIdPlan).toContain("SEARCH tasks USING INDEX");

      const candidateSql = `SELECT ${taskColumns}, ${newestTarget} AS target FROM tasks
        WHERE tasks.kind = ? AND tasks.model = ?
        ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC LIMIT ?`;
      const candidatePage = opened.taskBoundaryCandidates({
        kind: "responses",
        model: "model-x",
        limit: 3,
      });
      expect(candidatePage.rows).toHaveLength(3);
      expect(candidatePage.truncated).toBe(true);
      expect(
        idsOf(opened.database.prepare(candidateSql).all("responses", "model-x", 4).slice(0, 3)),
      ).toEqual(candidatePage.rows.map((row) => row.id));
      const candidatePlan = planOf(candidateSql, ["responses", "model-x", 4]);
      expect(candidatePlan).toContain("SEARCH tasks USING INDEX idx_tasks_kind");
      expect(candidatePlan).toContain("SEARCH records USING INDEX idx_records_task_sequence");

      // The only table the association read may join into is `records`, and only for the
      // upstream address. Content storage must not appear in any plan.
      const allPlans = [linkPlan, planOf(responseSql, ["resp-missing"]), byIdPlan, candidatePlan];
      for (const plan of allPlans) {
        expect(plan).not.toMatch(/SCAN|body_chunks|record_search|last_user_messages/);
      }
    } finally {
      opened.close();
    }
  });

  it("[TRI-04] gives a reader connection its own shorter lock wait", async () => {
    const defaultRoot = await newLogRoot();
    const untouched = new TrafficRepository(defaultRoot);
    expect(untouched.database.pragma("busy_timeout", { simple: true })).toBe(5000);
    untouched.close();

    const readerRoot = await newLogRoot();
    const reader = new TrafficRepository(readerRoot, { lockWaitMs: 250 });
    expect(reader.database.pragma("busy_timeout", { simple: true })).toBe(250);
    reader.close();

    const ignoredRoot = await newLogRoot();
    const ignored = new TrafficRepository(ignoredRoot, { lockWaitMs: 1.5 });
    expect(ignored.database.pragma("busy_timeout", { simple: true })).toBe(5000);
    ignored.close();
  });
});

function idsOf(rows: readonly unknown[]): string[] {
  return (rows as readonly RepositoryRecord[]).map((row) => String(row["id"]));
}

function mirrorLinks(rows: readonly unknown[]): { key: string; taskId: string }[] {
  return (rows as readonly RepositoryRecord[]).map((row) => ({
    key: String(row["key"]),
    taskId: String(row["task_id"]),
  }));
}

function snapshotOf(repository: TrafficRepository): Record<string, number> {
  const database = repository.database;
  return {
    tasks: countRows(database, "tasks"),
    contextLinks: countRows(database, "context_links"),
    responseLinks: countRows(database, "response_links"),
    records: countRows(database, "records"),
    bodyChunks: countRows(database, "body_chunks"),
    recordBodies: countRows(database, "record_body_chunks"),
  };
}

function countRows(database: Database.Database, table: string): number {
  return database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}
