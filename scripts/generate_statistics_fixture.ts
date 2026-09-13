import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { TrafficRepository } from "../src/persistence/index.js";
const base = path.resolve("test-fixtures/statistics");
await rm(base, { recursive: true, force: true });
await mkdir(base, { recursive: true });
const roots: string[] = [];
for (let r = 0; r < 2; r++) {
  const root = path.join(base, `logs-${r}`);
  await mkdir(root, { recursive: true });
  const db = new TrafficRepository(root);
  for (let i = 0; i < 10; i++) {
    const taskId = `fixture-${r}-${i}`,
      model = ["qwen3.8-27b", "qwen3.8-27b-fast", "deepseek-v4-flash"][i % 3]!;
    const timestamp = `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`;
    db.upsertTask({ id: taskId, model, started_at: timestamp, target: `target-${r}` });
    db.upsertRecord({
      id: `${taskId}-record`,
      task_id: taskId,
      sequence: 1,
      method: "POST",
      path: "/v1/chat/completions",
      timestamp,
      target_id: `target-${r}`,
      pricing:
        i === 9
          ? { pricing_status: "unpriced", pricing_reason: "missing_usage" }
          : {
              pricing_status: "priced",
              billing_model: model,
              usage: {
                inputUncachedTokens: 100 + i * 10,
                outputTokens: 40 + i * 5,
                cacheReadTokens: i * 3,
                cacheWriteTokens: i,
              },
              cost_nano_cny: String(100000 + i * 25000),
            },
    });
  }
  db.close();
  roots.push(root);
}
console.log(JSON.stringify({ roots }, null, 2));
