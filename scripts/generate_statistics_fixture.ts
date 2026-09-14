import { mkdir, rm, writeFile } from "node:fs/promises";
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
      model = ["qwen3.8-27b", "qwen3.8-27b-fast", "deepseek-v4-flash"][i % 3] ?? "qwen3.8-27b";
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
      target_name: `Fixture target ${r}`,
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
await writeFile(
  path.join(base, "README.json"),
  JSON.stringify({ roots, generatedAt: new Date().toISOString() }, null, 2),
);
const target = (index: number) => ({
  id: `fixture-target-${index}`,
  name: `Fixture target ${index}`,
  enabled: true,
  target_url: "http://127.0.0.1:18020/v1",
  target_api_key: "",
  target_headers: [],
  strip_request_fields: "",
  inject_request_fields: "",
  log_root: roots[index],
  redact_logs: false,
  model_mappings: [],
  model_prices: [],
});
await writeFile(
  path.join(base, "proxies.json"),
  JSON.stringify(
    {
      pairs: [
        {
          id: "fixture",
          name: "Statistics fixture",
          enabled: false,
          listen_host: "127.0.0.1",
          listen_port: 1234,
          access_log: false,
          targets: [target(0), target(1)],
          default_target_id: "fixture-target-0",
        },
      ],
    },
    null,
    2,
  ),
);
