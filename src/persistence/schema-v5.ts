import { responseTokenCounts } from "../proxy/records.js";
import { loadRecordBody } from "./body-storage.js";
import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V5_VERSION = 5;
export const SCHEMA_VERSION = SCHEMA_V5_VERSION;

export const SCHEMA_V5_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V5_VERSION,
  migrate(database) {
    const columns = database.pragma("table_info(records)") as { name: string }[];
    if (!columns.some(({ name }) => name === "request_token_count")) {
      database.exec("ALTER TABLE records ADD COLUMN request_token_count INTEGER");
    }
    if (!columns.some(({ name }) => name === "response_token_count")) {
      database.exec("ALTER TABLE records ADD COLUMN response_token_count INTEGER");
    }
    backfillTokenCounts(database);
  },
};

function backfillTokenCounts(database: Parameters<DatabaseMigration["migrate"]>[0]): void {
  const recordIds = database
    .prepare(
      `
        SELECT id
        FROM records
        WHERE token_count IS NOT NULL
          AND (request_token_count IS NULL OR response_token_count IS NULL)
      `,
    )
    .pluck()
    .all() as string[];
  const update = database.prepare(
    `
      UPDATE records
      SET request_token_count = ?, response_token_count = ?
      WHERE id = ?
    `,
  );
  for (const recordId of recordIds) {
    const responseBody = loadRecordBody(database, recordId, "response");
    if (responseBody === null) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      continue;
    }
    const counts = responseTokenCounts(payload);
    if (counts.request !== undefined || counts.response !== undefined) {
      update.run(counts.request ?? null, counts.response ?? null, recordId);
    }
  }
}
