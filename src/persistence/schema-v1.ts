import type { DatabaseMigration } from "./database.js";

export const SCHEMA_VERSION = 1;

export const SCHEMA_V1_MIGRATION: DatabaseMigration = {
  version: SCHEMA_VERSION,
  migrate(database) {
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        endpoint TEXT,
        anchor TEXT,
        model TEXT,
        target TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_response_at TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        pending_request_only INTEGER NOT NULL DEFAULT 0,
        match_confidence REAL NOT NULL DEFAULT 1.0,
        match_strategy_version INTEGER NOT NULL,
        fingerprints_json TEXT NOT NULL DEFAULT '{}',
        boundary_fingerprints_json TEXT NOT NULL DEFAULT '{}',
        last_user_messages_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_sort
        ON tasks(COALESCE(last_response_at, last_seen_at, started_at) DESC);
      CREATE INDEX idx_tasks_model ON tasks(model);
      CREATE INDEX idx_tasks_kind ON tasks(kind);
      CREATE INDEX idx_tasks_target ON tasks(target);

      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms REAL NOT NULL DEFAULT 0,
        proxy_id TEXT,
        proxy_name TEXT,
        client_host TEXT,
        client_port INTEGER,
        target_id TEXT,
        target_name TEXT,
        target_url TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status INTEGER,
        error TEXT,
        message_count INTEGER,
        token_count INTEGER,
        request_headers_json TEXT NOT NULL DEFAULT '{}',
        response_headers_json TEXT NOT NULL DEFAULT '{}',
        request_body_json TEXT,
        response_body_json TEXT,
        model_route_json TEXT,
        stripped_fields_json TEXT NOT NULL DEFAULT '[]',
        injected_fields_json TEXT NOT NULL DEFAULT '[]',
        added_upstream_headers_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, sequence)
      );

      CREATE INDEX idx_records_task_sequence ON records(task_id, sequence);
      CREATE INDEX idx_records_timestamp ON records(timestamp DESC);
      CREATE INDEX idx_records_endpoint ON records(endpoint);
      CREATE INDEX idx_records_status ON records(status);
      CREATE INDEX idx_records_target_url ON records(target_url);

      CREATE TABLE response_links (
        response_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_response_links_task ON response_links(task_id);

      CREATE TABLE context_links (
        context_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_context_links_task ON context_links(task_id);

      CREATE VIRTUAL TABLE record_search USING fts5(
        record_id UNINDEXED,
        task_id UNINDEXED,
        task_text,
        request_text,
        response_text,
        error_text
      );
    `);
  },
};
