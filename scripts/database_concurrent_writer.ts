import { TrafficRepository } from "../src/persistence/repository.js";

const [logRoot, writerId, countText] = process.argv.slice(2);
if (logRoot === undefined || writerId === undefined || countText === undefined) {
  throw new Error("Usage: database_concurrent_writer.ts <log-root> <writer-id> <count>");
}

const count = Number.parseInt(countText, 10);
if (!Number.isInteger(count) || count < 1) {
  throw new Error(`Invalid write count: ${countText}`);
}

const repository = new TrafficRepository(logRoot);
try {
  for (let index = 0; index < count; index += 1) {
    const taskId = `task-${writerId}-${index}`;
    repository.upsertTask({
      id: taskId,
      kind: "concurrent-write",
      model: writerId,
      request_count: 1,
      match_strategy_version: 4,
    });
    repository.upsertRecord({
      id: `record-${writerId}-${index}`,
      task_id: taskId,
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      request_body: { writer: writerId, index },
    });
  }
} finally {
  repository.close();
}
