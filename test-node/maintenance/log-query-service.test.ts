import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LogQueryService } from "../../src/maintenance/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("LogQueryService", () => {
  it("searches and paginates task group summaries from one log root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-query-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask(task("task-1", "gpt-5", "2026-07-18T10:00:00.000+08:00"));
    repository.upsertTask(task("task-2", "claude", "2026-07-18T11:00:00.000+08:00"));
    repository.upsertTask(task("task-3", "gpt-5", "2026-07-18T12:00:00.000+08:00"));
    repository.close();

    const page = new LogQueryService([root]).listGroups("gpt-5", 1, 0);
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 0, next_offset: 1, has_more: true });
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0]).toMatchObject({
      id: "task-3",
      model: "gpt-5",
      request_count: 2,
      meta: "gpt-5 | 2 requests | fixture-target",
    });
  });

  it("returns an empty bounded page without log roots", () => {
    expect(new LogQueryService([]).listGroups("", 999, -1)).toEqual({
      groups: [],
      total: 0,
      limit: 500,
      offset: 0,
      next_offset: 0,
      has_more: false,
    });
  });

  it("falls back to the latest record target for task summaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-query-target-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({
      ...task("task-without-target", "gpt-5", "2026-07-18T12:00:00.000+08:00"),
      target: null,
    });
    repository.upsertRecord({
      id: "record-with-target",
      task_id: "task-without-target",
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      target_url: "https://api.example.com:443/v1/responses",
    });
    repository.close();

    expect(new LogQueryService([root]).listGroups().groups[0]).toMatchObject({
      target: "https://api.example.com:443/v1/responses",
      meta: "gpt-5 | 2 requests | https://api.example.com:443/v1/responses",
    });
  });

  it("merges, globally sorts, and paginates tasks from multiple log roots", async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-query-a-"));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-query-b-"));
    temporaryDirectories.push(firstRoot, secondRoot);
    const first = new TrafficRepository(firstRoot);
    first.upsertTask(task("task-a-old", "shared", "2026-07-18T09:00:00.000+08:00"));
    first.upsertTask(task("task-a-new", "shared", "2026-07-18T12:00:00.000+08:00"));
    first.close();
    const second = new TrafficRepository(secondRoot);
    second.upsertTask(task("task-b-middle", "shared", "2026-07-18T11:00:00.000+08:00"));
    second.upsertTask(task("task-b-other", "other", "2026-07-18T13:00:00.000+08:00"));
    second.close();

    const service = new LogQueryService([firstRoot, firstRoot, secondRoot]);
    const firstPage = service.listGroups("shared", 2, 0);
    expect(firstPage).toMatchObject({ total: 3, next_offset: 2, has_more: true });
    expect(firstPage.groups.map(({ id }) => id)).toEqual(["task-a-new", "task-b-middle"]);
    const secondPage = service.listGroups("shared", 2, 2);
    expect(secondPage).toMatchObject({ total: 3, offset: 2, next_offset: 3, has_more: false });
    expect(secondPage.groups.map(({ id }) => id)).toEqual(["task-a-old"]);
  });

  it("finds a task across roots and returns its searchable log items", async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-group-a-"));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-group-b-"));
    temporaryDirectories.push(firstRoot, secondRoot);
    const repository = new TrafficRepository(secondRoot);
    repository.upsertTask(task("group-task", "gpt-5", "2026-07-18T12:00:00.000+08:00"));
    repository.upsertRecord({
      id: "record-1",
      task_id: "group-task",
      sequence: 1,
      event: "request_finished",
      timestamp: "2026-07-18T12:00:01.000+08:00",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      status: 202,
      message_count: 1,
      token_count: 7,
      target_url: "http://fixture/v1/responses",
      request_body: { input: "searchable" },
    });
    repository.close();

    const service = new LogQueryService([firstRoot, secondRoot]);
    expect(service.getGroupLogs("group-task", "202")).toEqual({
      id: "group-task",
      total: 1,
      limit: 200,
      offset: 0,
      next_offset: 1,
      has_more: false,
      logs: [
        expect.objectContaining({
          id: "record-1",
          sequence: "1",
          endpoint: "/v1/responses",
          status: 202,
          token_count: 7,
        }),
      ],
    });
    expect(service.getGroupLogs("missing")).toBeUndefined();
  });

  it("paginates task records after the initial 200 items", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-record-limit-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask(task("large-task", "gpt-5", "2026-07-18T12:00:00.000+08:00"));
    for (let sequence = 1; sequence <= 201; sequence += 1) {
      repository.upsertRecord({
        id: `large-record-${sequence}`,
        task_id: "large-task",
        sequence,
        method: "POST",
        path: "/v1/responses",
      });
    }
    repository.close();

    const group = new LogQueryService([root]).getGroupLogs("large-task");
    expect(group).toMatchObject({
      total: 201,
      limit: 200,
      offset: 0,
      next_offset: 200,
      has_more: true,
    });
    expect(group?.logs).toHaveLength(200);
    expect(group?.logs[0]?.sequence).toBe("201");
    expect(group?.logs.at(-1)?.sequence).toBe("2");

    const nextPage = new LogQueryService([root]).getGroupLogs("large-task", "", 100, 200);
    expect(nextPage).toMatchObject({
      total: 201,
      limit: 100,
      offset: 200,
      next_offset: 201,
      has_more: false,
    });
    expect(nextPage?.logs.map(({ sequence }) => sequence)).toEqual(["1"]);
  });

  it("returns request and response detail with compact metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-detail-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask(task("detail-task", "gpt-5", "2026-07-18T12:00:00.000+08:00"));
    repository.upsertRecord({
      id: "detail-record",
      task_id: "detail-task",
      sequence: 2,
      timestamp: "2026-07-18T12:00:01.000+08:00",
      duration_ms: 15,
      first_byte_ms: 4.5,
      method: "POST",
      path: "/v1/responses?trace=1",
      endpoint: "/v1/responses",
      status: 200,
      token_count: 9,
      message_count: 1,
      client_host: "127.0.0.1",
      client_port: 43111,
      request_headers: { "Content-Type": "application/json" },
      response_headers: { "Content-Type": "application/json" },
      request_body: { input: "hello" },
      response_body: { output: "world" },
      stripped_fields: [],
    });
    repository.close();

    expect(new LogQueryService([root]).getRecordDetail("detail-record")).toMatchObject({
      id: "detail-record",
      pending: false,
      request: { input: "hello" },
      response: { output: "world" },
      request_meta: {
        task_id: "detail-task",
        method: "POST",
        endpoint: "/v1/responses",
        client: "127.0.0.1:43111",
        message_count: 1,
      },
      response_meta: { status: 200, first_byte_ms: 4.5, duration_ms: 15, token_count: 9 },
    });
  });

  it("returns fresh detail data while a pending record is completed in place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-detail-refresh-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask(task("refresh-task", "gpt-5", "2026-07-18T12:00:00.000+08:00"));
    repository.upsertRecord({
      id: "refresh-record",
      task_id: "refresh-task",
      sequence: 1,
      event: "request_pending_response",
      method: "POST",
      path: "/v1/responses",
      request_body: { input: "hello" },
    });

    const service = new LogQueryService([root]);
    const pendingDetail = service.getRecordDetail("refresh-record");
    expect(pendingDetail).toMatchObject({
      id: "refresh-record",
      pending: true,
      response: null,
    });
    expect(pendingDetail?.response_meta).toEqual({});

    repository.upsertRecord({
      id: "refresh-record",
      task_id: "refresh-task",
      sequence: 1,
      event: "request_finished",
      method: "POST",
      path: "/v1/responses",
      status: 200,
      response_body: { output: "done" },
    });
    repository.close();

    expect(service.getRecordDetail("refresh-record")).toMatchObject({
      id: "refresh-record",
      pending: false,
      response: { output: "done" },
      response_meta: { status: 200 },
    });
  });
});

function task(id: string, model: string, timestamp: string) {
  return {
    id,
    kind: "responses",
    model,
    target: "fixture-target",
    started_at: timestamp,
    last_seen_at: timestamp,
    last_response_at: timestamp,
    request_count: 2,
    pending_request_only: false,
  };
}
