import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION_KEY,
  TRAFFIC_DB_NAME,
  backupDatabase,
  checkpointDatabase,
  connectLogDatabase,
  logDatabasePath,
  openLogDatabase,
  readSchemaVersion,
  runMigrations,
  verifyFts5,
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

  it("rolls back every migration and schema version when a later migration fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-migration-rollback-"));
    temporaryDirectories.push(root);
    const database = openLogDatabase(root);

    expect(() =>
      runMigrations(database, [
        {
          version: 1,
          migrate: (connection) => {
            connection.exec("CREATE TABLE rollback_fixture(id TEXT PRIMARY KEY)");
            connection.prepare("INSERT INTO rollback_fixture(id) VALUES (?)").run("created");
          },
        },
        {
          version: 2,
          migrate: () => {
            throw new Error("fixture migration failure");
          },
        },
      ]),
    ).toThrow("fixture migration failure");
    expect(readSchemaVersion(database)).toBe(0);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('schema_meta', 'rollback_fixture')")
        .all(),
    ).toEqual([]);

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

  it("provides working FTS5 search", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-fts5-"));
    temporaryDirectories.push(root);
    const database = connectLogDatabase(root);

    expect(() => verifyFts5(database)).not.toThrow();
    database
      .prepare(
        "INSERT INTO record_search(record_id, task_id, task_text, request_text, response_text, error_text) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("record-1", "task-1", "fixture task", "hello searchable world", "", "");
    expect(
      database
        .prepare("SELECT record_id FROM record_search WHERE record_search MATCH ?")
        .pluck()
        .all("searchable"),
    ).toEqual(["record-1"]);

    database.close();
  });
});

describe("database backup", () => {
  it("checkpoints WAL data and creates a readable SQLite backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-backup-"));
    temporaryDirectories.push(root);
    const database = connectLogDatabase(path.join(root, "live"));
    database.exec("CREATE TABLE backup_fixture(value TEXT NOT NULL)");
    database.prepare("INSERT INTO backup_fixture(value) VALUES (?)").run("persisted through WAL");

    expect(checkpointDatabase(database, "PASSIVE").busy).toBe(0);
    const destination = path.join(root, "nested", "backup", TRAFFIC_DB_NAME);
    await backupDatabase(database, destination);
    database.close();

    const backup = new Database(destination, { readonly: true });
    expect(backup.prepare("SELECT value FROM backup_fixture").pluck().get()).toBe(
      "persisted through WAL",
    );
    expect(readSchemaVersion(backup)).toBe(1);
    backup.close();
  });
});
