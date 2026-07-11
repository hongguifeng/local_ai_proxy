import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FAULT_POLICIES } from "../src/fault-policy.js";
import { openStorageDatabase } from "../src/storage/migration.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("production fault injection policy", () => {
  it("injects a real SQLite lock and preserves a recoverable database", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-proxy-fault-"));
    roots.push(root);
    const path = join(root, "traffic.db");
    const holder = openStorageDatabase(path);
    const contender = openStorageDatabase(path);
    try {
      contender.pragma("busy_timeout = 25");
      holder.exec("BEGIN EXCLUSIVE");
      expect(() => contender.exec("CREATE TABLE blocked(value TEXT)")).toThrow(/locked|busy/iu);
      holder.exec("ROLLBACK");
      contender.exec("CREATE TABLE recovered(value TEXT)");
      expect(contender.prepare("SELECT name FROM sqlite_master WHERE name='recovered'").get()).toBeDefined();
    } finally {
      if (holder.inTransaction) holder.exec("ROLLBACK");
      holder.close();
      contender.close();
    }
  });

  it("defines safe outcome, health, log code and recovery for every required fault", () => {
    expect(Object.keys(FAULT_POLICIES)).toHaveLength(7);
    for (const policy of Object.values(FAULT_POLICIES)) {
      expect(policy.outcome).not.toBe("");
      expect(policy.logCode).toMatch(/^[A-Z0-9_]+$/u);
      expect(policy.recovery).not.toBe("");
    }
  });
});
