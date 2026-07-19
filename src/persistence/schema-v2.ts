import type { DatabaseMigration } from "./database.js";

export const SCHEMA_VERSION = 2;

export const SCHEMA_V2_MIGRATION: DatabaseMigration = {
  version: SCHEMA_VERSION,
  migrate(database) {
    const columns = database.pragma("table_info(records)") as { name: string }[];
    if (!columns.some(({ name }) => name === "original_request_body_json")) {
      database.exec("ALTER TABLE records ADD COLUMN original_request_body_json TEXT");
    }
  },
};
