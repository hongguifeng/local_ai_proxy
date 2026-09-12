import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V9_VERSION = 9;
export const SCHEMA_V9_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V9_VERSION,
  migrate(database) {
    database.exec(`
      CREATE TABLE history_summaries (
        record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
        summary_json TEXT,
        source_hash TEXT,
        model TEXT,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_message TEXT
      );
    `);
  },
};
