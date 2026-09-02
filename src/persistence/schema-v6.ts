import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V6_VERSION = 6;
export const SCHEMA_VERSION = SCHEMA_V6_VERSION;

export const SCHEMA_V6_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V6_VERSION,
  migrate(database) {
    const columns = database.pragma("table_info(records)") as { name: string }[];
    if (!columns.some(({ name }) => name === "first_token_ms")) {
      database.exec("ALTER TABLE records ADD COLUMN first_token_ms REAL");
    }
    if (columns.some(({ name }) => name === "first_byte_ms")) {
      database.exec("ALTER TABLE records DROP COLUMN first_byte_ms");
    }
  },
};
