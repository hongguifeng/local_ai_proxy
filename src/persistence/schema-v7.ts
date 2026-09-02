import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V7_VERSION = 7;
export const SCHEMA_VERSION = SCHEMA_V7_VERSION;

export const SCHEMA_V7_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V7_VERSION,
  migrate(database) {
    // Task list ordering now follows last_seen_at first: while a request is
    // in flight the task row is touched (last_seen_at = observation time) and
    // must bubble to the top before any response has completed, while
    // last_response_at still marks the last time the task actually finished a
    // response. last_seen_at is maintained as the monotonic maximum of its
    // previous value, record time, and observation time, and is always >=
    // last_response_at, so COALESCE prefers it.
    database.exec("DROP INDEX IF EXISTS idx_tasks_sort");
    database.exec(
      `
      CREATE INDEX idx_tasks_sort
        ON tasks(COALESCE(last_seen_at, last_response_at, started_at) DESC);
      `,
    );
  },
};
