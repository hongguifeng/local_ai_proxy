import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export const STORAGE_SCHEMA_VERSION = 1;

export type SqlMigration = Readonly<{ version: number; name: string; sql: string }>;

export class DatabaseMigrationError extends Error {
  public readonly code:
    "DATABASE_OPEN_FAILED" | "DATABASE_CORRUPT" | "DATABASE_VERSION_UNSUPPORTED" | "DATABASE_MIGRATION_FAILED";

  public constructor(code: DatabaseMigrationError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseMigrationError";
    this.code = code;
  }
}

export function loadMigrations(): readonly SqlMigration[] {
  return [
    {
      version: 1,
      name: "001_initial.sql",
      sql: readFileSync(new URL("./migrations/001_initial.sql", import.meta.url), "utf8"),
    },
  ];
}

export function openStorageDatabase(databasePath: string): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true });
  let database: Database.Database;
  try {
    database = new Database(databasePath);
  } catch (error) {
    throw new DatabaseMigrationError("DATABASE_OPEN_FAILED", "Unable to open the traffic database", { cause: error });
  }
  try {
    configureDatabase(database);
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError("DATABASE_CORRUPT", "The traffic database is unreadable", { cause: error });
  }
}

export function configureDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
}

export function readSchemaVersion(database: Database.Database): number {
  const metaExists = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get() as { present: number } | undefined;
  if (!metaExists) return 0;
  const row = database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  if (!row) return 0;
  const version = Number(row.value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new DatabaseMigrationError("DATABASE_CORRUPT", "The traffic database schema version is invalid");
  }
  return version;
}

export function migrateDatabase(
  database: Database.Database,
  migrations: readonly SqlMigration[] = loadMigrations(),
): number {
  const current = readSchemaVersion(database);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new DatabaseMigrationError(
      "DATABASE_VERSION_UNSUPPORTED",
      `Traffic database schema v${current.toString()} is newer than supported v${latest.toString()}`,
    );
  }
  let version = current;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) {
      throw new DatabaseMigrationError("DATABASE_MIGRATION_FAILED", "Traffic database migrations are not contiguous");
    }
    try {
      database.transaction(() => {
        database.exec(migration.sql);
        const timestamp = new Date().toISOString();
        database
          .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)")
          .run(migration.version.toString());
        database
          .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_migrated_at', ?)")
          .run(timestamp);
      })();
      version = migration.version;
    } catch (error) {
      throw new DatabaseMigrationError(
        "DATABASE_MIGRATION_FAILED",
        `Traffic database migration v${migration.version.toString()} failed`,
        { cause: error },
      );
    }
  }
  if (version === STORAGE_SCHEMA_VERSION) ensureMigrationTimestamp(database);
  return version;
}

function ensureMigrationTimestamp(database: Database.Database): void {
  database
    .prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_migrated_at', ?)")
    .run(new Date().toISOString());
}
