import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { SCHEMA_V1_MIGRATION } from "./schema-v1.js";

export const TRAFFIC_DB_NAME = "traffic.db";
export const SCHEMA_VERSION_KEY = "schema_version";

export interface DatabaseMigration {
  readonly version: number;
  readonly migrate: (database: Database.Database) => void;
}

export function logDatabasePath(logRoot: string | null | undefined): string | undefined {
  return logRoot === null || logRoot === undefined
    ? undefined
    : path.join(logRoot, TRAFFIC_DB_NAME);
}

export function openLogDatabase(logRoot: string): Database.Database {
  mkdirSync(logRoot, { recursive: true });
  const database = new Database(path.join(logRoot, TRAFFIC_DB_NAME));
  configureDatabase(database);
  return database;
}

export function connectLogDatabase(logRoot: string): Database.Database {
  const database = openLogDatabase(logRoot);
  try {
    verifyFts5(database);
    runMigrations(database, [SCHEMA_V1_MIGRATION]);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function verifyFts5(database: Database.Database): void {
  database.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(value)");
  database.exec("DROP TABLE temp.fts5_probe");
}

export function configureDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
}

export function readSchemaVersion(database: Database.Database): number {
  const table = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get() as { present: number } | undefined;
  if (table === undefined) {
    return 0;
  }
  const row = database
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
  if (row === undefined) {
    return 0;
  }
  const version = Number(row.value);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly DatabaseMigration[],
): number {
  const currentVersion = readSchemaVersion(database);
  const pending = [...migrations]
    .sort((left, right) => left.version - right.version)
    .filter(({ version }) => version > currentVersion);
  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    for (const migration of pending) {
      migration.migrate(database);
      database
        .prepare(
          `
          INSERT INTO schema_meta(key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(SCHEMA_VERSION_KEY, String(migration.version));
    }
  });
  migrate();
  return readSchemaVersion(database);
}
