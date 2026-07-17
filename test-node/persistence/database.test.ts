import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION_KEY,
  TRAFFIC_DB_NAME,
  connectLogDatabase,
  logDatabasePath,
  openLogDatabase,
  readSchemaVersion,
  runMigrations,
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

describe("runMigrations", () => {
  it("reads version zero, applies pending migrations in order, and skips applied migrations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-migrations-"));
    temporaryDirectories.push(root);
    const database = openLogDatabase(root);
    const calls: number[] = [];
    const migrations = [
      {
        version: 2,
        migrate: () => {
          calls.push(2);
          database.exec("CREATE TABLE fixture_two(id TEXT PRIMARY KEY)");
        },
      },
      {
        version: 1,
        migrate: () => {
          calls.push(1);
          database.exec("CREATE TABLE fixture_one(id TEXT PRIMARY KEY)");
        },
      },
    ];

    expect(readSchemaVersion(database)).toBe(0);
    expect(runMigrations(database, migrations)).toBe(2);
    expect(runMigrations(database, migrations)).toBe(2);
    expect(calls).toEqual([1, 2]);
    expect(
      database
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .pluck()
        .get(SCHEMA_VERSION_KEY),
    ).toBe("2");

    database.close();
  });
});

describe("connectLogDatabase", () => {
  it("creates the complete schema v1", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-schema-v1-"));
    temporaryDirectories.push(root);
    const database = connectLogDatabase(root);

    const objects = database
      .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[];
    const names = new Set(objects.map(({ name }) => name));
    expect(readSchemaVersion(database)).toBe(1);
    expect([...names]).toEqual(
      expect.arrayContaining([
        "schema_meta",
        "tasks",
        "records",
        "response_links",
        "context_links",
        "record_search",
        "idx_tasks_sort",
        "idx_records_task_sequence",
      ]),
    );

    database.close();
  });
});
