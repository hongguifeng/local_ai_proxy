import type { DatabaseMigration } from "./database.js";
export const SCHEMA_V11_MIGRATION: DatabaseMigration = {
  version: 11,
  migrate(database) {
    database.exec("ALTER TABLE records ADD COLUMN decode_window_ms REAL");
  },
};
