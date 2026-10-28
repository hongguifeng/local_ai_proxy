import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V14_VERSION = 14;

export const SCHEMA_V14_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V14_VERSION,
  migrate(database) {
    // A task brief is no longer one paragraph: it is an overview plus a timeline whose
    // steps cite numbered events. The parsed timeline and the normalized evidence events
    // are stored beside the paragraph, and the three source columns say which request the
    // timeline was made from, so the console can tell a stale answer from a current one.
    // All five stay nullable: a brief stored before this version has no timeline to read.
    database.exec(`
      ALTER TABLE task_briefs ADD COLUMN timeline_json TEXT;
      ALTER TABLE task_briefs ADD COLUMN source_events_json TEXT;
      ALTER TABLE task_briefs ADD COLUMN source_sequence INTEGER;
      ALTER TABLE task_briefs ADD COLUMN source_fingerprint TEXT;
      ALTER TABLE task_briefs ADD COLUMN source_event_count INTEGER;
    `);
  },
};
