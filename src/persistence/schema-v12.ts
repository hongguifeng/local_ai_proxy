import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V12_VERSION = 12;
export const SCHEMA_V12_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V12_VERSION,
  migrate(database) {
    database.exec(`
      CREATE TABLE task_briefs (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
        brief_text TEXT,
        source_record_id TEXT,
        model TEXT,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_message TEXT
      );
    `);
  },
};
