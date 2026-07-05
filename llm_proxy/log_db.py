"""SQLite database setup for traffic logs."""

from __future__ import annotations

import sqlite3
from pathlib import Path

TRAFFIC_DB_NAME = "traffic.db"
SCHEMA_VERSION = "1"


def log_db_path(log_root: Path | None) -> Path | None:
    if log_root is None:
        return None
    return log_root / TRAFFIC_DB_NAME


def connect_log_db(log_root: Path) -> sqlite3.Connection:
    log_root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(
        log_root / TRAFFIC_DB_NAME,
        timeout=5,
        check_same_thread=False,
    )
    connection.row_factory = sqlite3.Row
    configure_connection(connection)
    initialize_schema(connection)
    return connection


def configure_connection(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA synchronous = NORMAL")


def initialize_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
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

        CREATE INDEX IF NOT EXISTS idx_tasks_sort
          ON tasks(COALESCE(last_response_at, last_seen_at, started_at) DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_model ON tasks(model);
        CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind);
        CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target);

        CREATE TABLE IF NOT EXISTS records (
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

        CREATE INDEX IF NOT EXISTS idx_records_task_sequence ON records(task_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_records_endpoint ON records(endpoint);
        CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
        CREATE INDEX IF NOT EXISTS idx_records_target_url ON records(target_url);

        CREATE TABLE IF NOT EXISTS response_links (
          response_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_response_links_task ON response_links(task_id);

        CREATE TABLE IF NOT EXISTS context_links (
          context_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_context_links_task ON context_links(task_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(
          record_id UNINDEXED,
          task_id UNINDEXED,
          task_text,
          request_text,
          response_text,
          error_text
        );
        """
    )
    connection.execute(
        """
        INSERT INTO schema_meta(key, value)
        VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (SCHEMA_VERSION,),
    )
    connection.commit()
