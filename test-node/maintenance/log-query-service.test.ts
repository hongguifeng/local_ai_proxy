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
