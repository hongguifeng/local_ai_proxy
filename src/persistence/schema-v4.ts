import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V4_VERSION = 4;
export const SCHEMA_VERSION = SCHEMA_V4_VERSION;

export const SCHEMA_V4_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V4_VERSION,
  migrate(database) {
    const columns = database.pragma("table_info(records)") as { name: string }[];
    if (!columns.some(({ name }) => name === "first_byte_ms")) {
      database.exec("ALTER TABLE records ADD COLUMN first_byte_ms REAL");
    }
  },
};
