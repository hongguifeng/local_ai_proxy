import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TRAFFIC_DB_NAME,
  logDatabasePath,
  openLogDatabase,
} from "../../src/persistence/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("logDatabasePath", () => {
  it.each([undefined, null])("disables persistence for %s", (logRoot) => {
    expect(logDatabasePath(logRoot)).toBeUndefined();
  });

  it("places traffic.db directly below the configured log root", () => {
    expect(logDatabasePath(path.join("workspace", "日志"))).toBe(
      path.join("workspace", "日志", "traffic.db"),
    );
    expect(TRAFFIC_DB_NAME).toBe("traffic.db");
  });
});

describe("openLogDatabase", () => {
  it("creates a missing nested log directory before opening traffic.db", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-database-"));
    temporaryDirectories.push(root);
    const logRoot = path.join(root, "nested", "日志");

    const database = openLogDatabase(logRoot);
    database.close();

    expect(existsSync(logRoot)).toBe(true);
    expect(existsSync(path.join(logRoot, TRAFFIC_DB_NAME))).toBe(true);
  });

  it("configures WAL, foreign keys, busy timeout, and NORMAL synchronous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-database-"));
    temporaryDirectories.push(root);
    const database = openLogDatabase(root);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(database.pragma("synchronous", { simple: true })).toBe(1);

    database.close();
  });
});
