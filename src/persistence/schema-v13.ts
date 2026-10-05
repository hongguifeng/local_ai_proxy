import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V13_VERSION = 13;

export const SCHEMA_V13_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V13_VERSION,
  migrate(database) {
    // The task brief also carries the environment facts the summary model read
    // out of the newest request (which agent, working directory, git branch,
    // OS), so the card can show them next to the summary paragraph.
    database.exec(`
      ALTER TABLE task_briefs ADD COLUMN context_json TEXT;
    `);
  },
};
