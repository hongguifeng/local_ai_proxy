import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TrafficRepository } from "../src/persistence/index.js";

const roots: string[] = [];
for (let r = 0; r < 2; r++) {
  const root = await mkdtemp(path.join(os.tmpdir(), `llm-proxy-real-stats-${r}-`));
  roots.push(root);
  const db = new TrafficRepository(root);
  for (let i = 0; i < 6; i++) {
    const taskId = `fixture-${r}-${i}`;
    const model = i % 2 ? "qwen3.8-27b" : "qwen3.8-27b-fast";
    const timestamp = `2026-09-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`;
    db.upsertTask({ id: taskId, model, started_at: timestamp, target: `target-${r}` });
    db.upsertRecord({
      id: `${taskId}-record`,
      task_id: taskId,
      sequence: 1,
      method: "POST",
      path: "/v1/chat/completions",
      timestamp,
      target_id: `target-${r}`,
      pricing: {
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
}
console.log(JSON.stringify({ roots }));
