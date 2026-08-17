import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
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
import { TrafficRepository } from "../../src/persistence/repository.js";
import { SCHEMA_V1_MIGRATION } from "../../src/persistence/schema-v1.js";

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
  it("creates the complete current schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-schema-current-"));
    temporaryDirectories.push(root);
    const database = connectLogDatabase(root);

    const objects = database
      .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[];
    const names = new Set(objects.map(({ name }) => name));
    expect(readSchemaVersion(database)).toBe(5);
    expect([...names]).toEqual(
      expect.arrayContaining([
        "schema_meta",
        "tasks",
        "records",
        "response_links",
        "context_links",
        "body_chunks",
        "record_body_chunks",
        "record_search_map",
        "record_search_fts",
        "idx_tasks_sort",
        "idx_records_task_sequence",
      ]),
    );
    expect(
      (database.pragma("table_info(records)") as { name: string }[]).map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        "original_request_body_json",
        "first_byte_ms",
        "request_token_count",
        "response_token_count",
      ]),
    );

    database.close();
  });

  it("provides working FTS5 search", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-fts5-"));
    temporaryDirectories.push(root);
    const database = connectLogDatabase(root);

    expect(() => verifyFts5(database)).not.toThrow();
    database.exec(`
      INSERT INTO tasks(
        id, kind, started_at, last_seen_at, match_strategy_version, created_at, updated_at
      ) VALUES ('task-1', 'request', '2026-07-18', '2026-07-18', 4, '2026-07-18', '2026-07-18');
      INSERT INTO records(
        id, task_id, sequence, event, timestamp, started_at, method, path, endpoint,
        created_at, updated_at
      ) VALUES (
        'record-1', 'task-1', 1, 'request_finished', '2026-07-18', '2026-07-18',
        'POST', '/v1/responses', '/v1/responses', '2026-07-18', '2026-07-18'
      );
      INSERT INTO record_search_map(search_rowid, record_id, task_id)
      VALUES (1, 'record-1', 'task-1');
    `);
    database
      .prepare(
        "INSERT INTO record_search_fts(rowid, task_text, request_text, response_text, error_text) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, "fixture task", "hello searchable world", "", "");
    expect(
      database
        .prepare(
          `SELECT record_id FROM record_search_map
           JOIN record_search_fts ON record_search_fts.rowid = record_search_map.search_rowid
           WHERE record_search_fts MATCH ?`,
        )
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

    expect(existsSync(path.join(root, "live", `${TRAFFIC_DB_NAME}-wal`))).toBe(true);
    expect(checkpointDatabase(database, "PASSIVE").busy).toBe(0);
    const destination = path.join(root, "nested", "backup", TRAFFIC_DB_NAME);
    await backupDatabase(database, destination);
    database.close();

    const backup = new Database(destination, { readonly: true });
    expect(backup.prepare("SELECT value FROM backup_fixture").pluck().get()).toBe(
      "persisted through WAL",
    );
    expect(readSchemaVersion(backup)).toBe(5);
    backup.close();
  });

  it("rehearses a small v1 database migration, write, query, and rollback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-small-migration-"));
    temporaryDirectories.push(root);
    const database = openLogDatabase(root);
    runMigrations(database, [SCHEMA_V1_MIGRATION]);
    database.exec(`
      INSERT INTO tasks(
        id, kind, started_at, last_seen_at, match_strategy_version, created_at, updated_at
      ) VALUES (
        'task-old-token-counts', 'responses', '2026-07-18', '2026-07-18', 4,
        '2026-07-18', '2026-07-18'
      );
      INSERT INTO records(
        id, task_id, sequence, event, timestamp, started_at, method, path, endpoint,
        token_count, response_body_json, created_at, updated_at
      ) VALUES (
        'record-old-token-counts', 'task-old-token-counts', 1, 'request_finished',
        '2026-07-18', '2026-07-18', 'POST', '/v1/responses', '/v1/responses', 9,
        '{"usage":{"input_tokens":6,"output_tokens":3,"total_tokens":9}}',
        '2026-07-18', '2026-07-18'
      );
    `);
    database.close();
    const databasePath = path.join(root, TRAFFIC_DB_NAME);
    const rollbackPath = path.join(root, "traffic.v1.rollback.db");
    await copyFile(databasePath, rollbackPath);

    const migrated = new TrafficRepository(root, { now: () => "2026-07-18T06:00:00.000Z" });
    migrated.upsertTask({
      id: "task-migration-rehearsal",
      kind: "responses",
      model: "fixture-model",
      match_strategy_version: 4,
    });
    expect(migrated.getTask("task-migration-rehearsal")).toMatchObject({
      id: "task-migration-rehearsal",
      model: "fixture-model",
    });
    expect(migrated.getRecord("record-old-token-counts")).toMatchObject({
      token_count: 9,
      request_token_count: 6,
      response_token_count: 3,
    });
    migrated.close();

    await copyFile(rollbackPath, databasePath);
    const restored = new TrafficRepository(root);
    expect(restored.getTask("task-migration-rehearsal")).toBeUndefined();
    restored.close();
  });
});
