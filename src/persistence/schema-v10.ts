import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V10_VERSION = 10;
export const SCHEMA_V10_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V10_VERSION,
  migrate(database) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_records_timestamp_pricing
        ON records(timestamp, pricing_status);
      CREATE INDEX IF NOT EXISTS idx_records_target_finished
        ON records(target_url, timestamp);
      CREATE INDEX IF NOT EXISTS idx_records_model_finished
        ON records(billing_model, timestamp);
    `);
  },
};
