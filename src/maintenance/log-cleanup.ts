import { TrafficRepository } from "../persistence/index.js";

export interface LogCleanupResult {
  readonly deleted: readonly string[];
  readonly deleted_count: number;
}

export function cleanupSelectedLogGroups(
  logRoots: readonly string[],
  groupIds: readonly string[],
): LogCleanupResult {
  const selected = [
    ...new Set(groupIds.map((value) => value.trim()).filter((value) => value !== "")),
  ];
  const deleted: string[] = [];
  if (selected.length === 0) {
    return { deleted, deleted_count: 0 };
  }
  for (const root of [...new Set(logRoots.filter((value) => value !== ""))]) {
    const repository = new TrafficRepository(root);
    try {
      const existing = selected.filter((taskId) => repository.getTask(taskId) !== undefined);
      if (existing.length > 0) {
        repository.deleteTasks(existing);
        deleted.push(...existing);
      }
    } finally {
      repository.close();
    }
  }
  return { deleted, deleted_count: deleted.length };
}

export function cleanupLogsOlderThan(
  logRoots: readonly string[],
  olderThanDays: number,
  now: () => number = Date.now,
): LogCleanupResult {
  const cutoff = now() - Math.max(0, Math.trunc(olderThanDays)) * 86_400_000;
  const deleted: string[] = [];
  for (const root of [...new Set(logRoots.filter((value) => value !== ""))]) {
    const repository = new TrafficRepository(root);
    try {
      const selected = allTasks(repository)
        .filter((task) => {
          const timestamp = task["last_response_at"] ?? task["last_seen_at"] ?? task["started_at"];
          const epoch = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
          return !Number.isNaN(epoch) && epoch < cutoff;
        })
        .map((task) => String(task["id"]));
      if (selected.length > 0) {
        repository.deleteTasks(selected);
        deleted.push(...selected);
      }
    } finally {
      repository.close();
    }
  }
  return { deleted, deleted_count: deleted.length };
}

export function cleanupLogsKeepLatest(
  logRoots: readonly string[],
  keepLatest: number,
): LogCleanupResult {
  const keep = Math.max(0, Math.trunc(keepLatest));
  const deleted: string[] = [];
  for (const root of [...new Set(logRoots.filter((value) => value !== ""))]) {
    const repository = new TrafficRepository(root);
    try {
      const selected = allTasks(repository)
        .slice(keep)
        .map((task) => String(task["id"]));
      if (selected.length > 0) {
        repository.deleteTasks(selected);
        deleted.push(...selected);
      }
    } finally {
      repository.close();
    }
  }
  return { deleted, deleted_count: deleted.length };
}

function allTasks(repository: TrafficRepository): Record<string, unknown>[] {
  const tasks: Record<string, unknown>[] = [];
  let page = repository.listTasks("", 500, 0);
  tasks.push(...page.items);
  while (page.hasMore) {
    page = repository.listTasks("", 500, page.nextOffset);
    tasks.push(...page.items);
  }
  return tasks;
}
