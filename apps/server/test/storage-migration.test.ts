import { mkdtempSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  DatabaseMigrationError,
  STORAGE_SCHEMA_VERSION,
  configureDatabase,
  loadMigrations,
  migrateDatabase,
  openStorageDatabase,
  readSchemaVersion,
} from "../src/storage/migration.js";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("storage migrations", () => {
  it("creates an empty database at v1 with required tables, FTS, and pragmas", () => {
    const root = temporaryRoot();
    const database = openStorageDatabase(join(root, "traffic.db"));
    try {
      if (process.platform !== "win32") expect(statSync(join(root, "traffic.db")).mode & 0o777).toBe(0o600);
      expect(readSchemaVersion(database)).toBe(STORAGE_SCHEMA_VERSION);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
      expect(database.pragma("synchronous", { simple: true })).toBe(1);
      const names = database
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(names).toEqual(
        expect.arrayContaining(["schema_meta", "tasks", "records", "response_links", "context_links", "record_search"]),
      );
      database
        .prepare("INSERT INTO record_search(record_id, task_id, request_text) VALUES (?, ?, ?)")
        .run("record-1", "task-1", "hello world");
      expect(database.prepare("SELECT record_id FROM record_search WHERE record_search MATCH ?").get("hello")).toEqual({
        record_id: "record-1",
      });
    } finally {
      database.close();
    }
  });

  it("opens a Python-compatible v1 schema without replaying migration", () => {
    const database = new Database(":memory:");
    try {
      database.exec(loadMigrations()[0]?.sql ?? "");
      database.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();
      configureDatabase(database);
      expect(migrateDatabase(database)).toBe(2);
      expect(database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_migrated_at'").get()).toBeDefined();
      expect(database.prepare("SELECT error_code, error_stage FROM records LIMIT 1").columns()).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("rejects newer and malformed schema versions", () => {
    for (const value of ["999", "not-a-number"]) {
      const database = new Database(":memory:");
      try {
        database.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        database.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)").run(value);
        expect(() => migrateDatabase(database)).toThrow(DatabaseMigrationError);
      } finally {
        database.close();
      }
    }
  });

  it("rolls back a failed migration without partial schema or version state", () => {
    const database = new Database(":memory:");
    try {
      expect(() =>
        migrateDatabase(database, [
          { version: 1, name: "broken", sql: "CREATE TABLE partial(id INTEGER); INVALID SQL;" },
        ]),
      ).toThrow(expect.objectContaining({ code: "DATABASE_MIGRATION_FAILED" }));
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeUndefined();
      expect(readSchemaVersion(database)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects non-contiguous migrations and unreadable databases with safe errors", async () => {
    const memory = new Database(":memory:");
    try {
      expect(() => migrateDatabase(memory, [{ version: 2, name: "skip", sql: "SELECT 1" }])).toThrow(
        expect.objectContaining({ code: "DATABASE_MIGRATION_FAILED" }),
      );
    } finally {
      memory.close();
    }

    const root = temporaryRoot();
    const path = join(root, "corrupt.db");
    await writeFile(path, Buffer.from("not a sqlite database"));
    try {
      openStorageDatabase(path);
      throw new Error("Expected corrupt database to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseMigrationError);
      expect((error as DatabaseMigrationError).code).toMatch(/^DATABASE_/);
    }
  });

  it("loads immutable sequential SQL migration assets", () => {
    expect(loadMigrations().map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "001_initial.sql" },
      { version: 2, name: "002_error_details.sql" },
    ]);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "llm-proxy-storage-"));
  temporaryDirectories.push(root);
  return root;
}
