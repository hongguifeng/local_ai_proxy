import { migrateLegacyRecordBodies } from "./body-storage.js";
import type { DatabaseMigration } from "./database.js";

export const SCHEMA_V3_VERSION = 3;

export const SCHEMA_V3_MIGRATION: DatabaseMigration = {
  version: SCHEMA_V3_VERSION,
  migrate(database) {
    database.exec(`
      CREATE TABLE body_chunks (
        hash BLOB PRIMARY KEY,
        codec TEXT NOT NULL,
        raw_size INTEGER NOT NULL,
        data BLOB NOT NULL,
        reference_count INTEGER NOT NULL CHECK(reference_count > 0)
      ) WITHOUT ROWID;

      CREATE TABLE record_body_chunks (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        body_kind TEXT NOT NULL CHECK(body_kind IN ('request', 'original_request', 'response')),
        chunk_index INTEGER NOT NULL,
        chunk_hash BLOB NOT NULL REFERENCES body_chunks(hash),
        PRIMARY KEY(record_id, body_kind, chunk_index)
      ) WITHOUT ROWID;
      CREATE INDEX idx_record_body_chunks_hash ON record_body_chunks(chunk_hash);
      CREATE TRIGGER trg_record_body_chunks_delete
      AFTER DELETE ON record_body_chunks
      BEGIN
        DELETE FROM body_chunks
        WHERE hash = OLD.chunk_hash AND reference_count = 1;
        UPDATE body_chunks
        SET reference_count = reference_count - 1
        WHERE hash = OLD.chunk_hash;
      END;

      CREATE TABLE record_search_map (
        search_rowid INTEGER PRIMARY KEY,
        record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_record_search_map_task ON record_search_map(task_id);

      CREATE VIRTUAL TABLE record_search_fts USING fts5(
        task_text,
        request_text,
        response_text,
        error_text,
        content='',
        contentless_delete=1
      );

      INSERT INTO record_search_map(search_rowid, record_id, task_id)
      SELECT rowid, record_id, task_id FROM record_search;
      INSERT INTO record_search_fts(rowid, task_text, request_text, response_text, error_text)
      SELECT rowid, task_text, request_text, response_text, error_text FROM record_search;
      DROP TABLE record_search;
    `);
    migrateLegacyRecordBodies(database);
  },
};
