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
