import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V8_VERSION = 8;
export const SCHEMA_VERSION = SCHEMA_V8_VERSION;

/** Adds immutable per-request pricing data without reading historical bodies. */
export const SCHEMA_V8_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V8_VERSION,
  migrate(database) {
    database.exec(`
      ALTER TABLE records ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'unpriced';
      ALTER TABLE records ADD COLUMN pricing_reason TEXT;
      ALTER TABLE records ADD COLUMN billing_model TEXT;
      ALTER TABLE records ADD COLUMN pricing_snapshot_json TEXT;
      ALTER TABLE records ADD COLUMN billing_usage_json TEXT;
      ALTER TABLE records ADD COLUMN cost_nano_cny INTEGER;
      CREATE INDEX idx_records_task_pricing ON records(task_id, pricing_status);
      UPDATE records
      SET pricing_reason = 'legacy_record'
      WHERE pricing_reason IS NULL;
    `);
  },
};
