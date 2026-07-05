"""SQLite-backed traffic log repository."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .log_db import connect_log_db
from .time_utils import local_now_iso


class LogRepository:
    def __init__(self, log_root: Path) -> None:
        self.connection = connect_log_db(log_root)
        self.lock = threading.RLock()

    def __enter__(self) -> LogRepository:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def upsert_task(self, task: Mapping[str, Any]) -> dict[str, Any]:
        now = local_now_iso()
        values = {
            "id": str(task["id"]),
            "kind": str(task.get("kind") or "request"),
            "endpoint": _optional_str(task.get("endpoint")),
            "anchor": _optional_str(task.get("anchor")),
            "model": _optional_str(task.get("model")),
            "target": _optional_str(task.get("target")),
            "started_at": str(task.get("started_at") or task.get("last_seen_at") or now),
            "last_seen_at": str(task.get("last_seen_at") or task.get("started_at") or now),
            "last_response_at": _optional_str(task.get("last_response_at")),
            "request_count": _int_value(task.get("request_count"), 0),
            "pending_request_only": 1 if task.get("pending_request_only") else 0,
            "match_confidence": _float_value(task.get("match_confidence", task.get("last_match_confidence")), 1.0),
            "match_strategy_version": _int_value(task.get("match_strategy_version"), 1),
            "fingerprints_json": _json_text(task.get("fingerprints"), {}),
            "boundary_fingerprints_json": _json_text(task.get("boundary_fingerprints"), {}),
            "last_user_messages_json": _json_text(task.get("last_user_messages"), []),
            "created_at": str(task.get("created_at") or now),
            "updated_at": str(task.get("updated_at") or now),
        }
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT INTO tasks(
                  id, kind, endpoint, anchor, model, target, started_at, last_seen_at, last_response_at,
                  request_count, pending_request_only, match_confidence, match_strategy_version,
                  fingerprints_json, boundary_fingerprints_json, last_user_messages_json,
                  created_at, updated_at
                )
                VALUES (
                  :id, :kind, :endpoint, :anchor, :model, :target, :started_at, :last_seen_at, :last_response_at,
                  :request_count, :pending_request_only, :match_confidence, :match_strategy_version,
                  :fingerprints_json, :boundary_fingerprints_json, :last_user_messages_json,
                  :created_at, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                  kind = excluded.kind,
                  endpoint = excluded.endpoint,
                  anchor = excluded.anchor,
                  model = excluded.model,
                  target = excluded.target,
                  started_at = excluded.started_at,
                  last_seen_at = excluded.last_seen_at,
                  last_response_at = excluded.last_response_at,
                  request_count = excluded.request_count,
                  pending_request_only = excluded.pending_request_only,
                  match_confidence = excluded.match_confidence,
                  match_strategy_version = excluded.match_strategy_version,
                  fingerprints_json = excluded.fingerprints_json,
                  boundary_fingerprints_json = excluded.boundary_fingerprints_json,
                  last_user_messages_json = excluded.last_user_messages_json,
                  updated_at = excluded.updated_at
                """,
                values,
            )
        loaded = self.get_task(str(values["id"]))
        if loaded is None:
            raise RuntimeError(f"Task {values['id']} was not saved.")
        return loaded

    def upsert_record(self, record: Mapping[str, Any]) -> dict[str, Any]:
        now = local_now_iso()
        values = {
            "id": str(record["id"]),
            "task_id": str(record["task_id"]),
            "sequence": _int_value(record.get("sequence"), 1),
            "event": str(record.get("event") or "request_finished"),
            "timestamp": str(record.get("timestamp") or now),
            "started_at": str(record.get("started_at") or record.get("started_timestamp") or record.get("timestamp") or now),
            "duration_ms": _float_value(record.get("duration_ms"), 0.0),
            "proxy_id": _optional_str(record.get("proxy_id")),
            "proxy_name": _optional_str(record.get("proxy_name")),
            "client_host": _optional_str(record.get("client_host")),
            "client_port": _optional_int(record.get("client_port")),
            "target_id": _optional_str(record.get("target_id")),
            "target_name": _optional_str(record.get("target_name")),
            "target_url": _optional_str(record.get("target_url")),
            "method": str(record.get("method") or ""),
            "path": str(record.get("path") or ""),
            "endpoint": str(record.get("endpoint") or record.get("path") or ""),
            "status": _optional_int(record.get("status")),
            "error": _optional_str(record.get("error")),
            "message_count": _optional_int(record.get("message_count")),
            "token_count": _optional_int(record.get("token_count")),
            "request_headers_json": _json_text(record.get("request_headers"), {}),
            "response_headers_json": _json_text(record.get("response_headers"), {}),
            "request_body_json": _optional_json_text(record.get("request_body")),
            "response_body_json": _optional_json_text(record.get("response_body")),
            "model_route_json": _optional_json_text(record.get("model_route")),
            "stripped_fields_json": _json_text(record.get("stripped_fields"), []),
            "injected_fields_json": _json_text(record.get("injected_fields"), []),
            "added_upstream_headers_json": _json_text(record.get("added_upstream_headers"), []),
            "created_at": str(record.get("created_at") or now),
            "updated_at": str(record.get("updated_at") or now),
        }
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT INTO records(
                  id, task_id, sequence, event, timestamp, started_at, duration_ms,
                  proxy_id, proxy_name, client_host, client_port,
                  target_id, target_name, target_url, method, path, endpoint,
                  status, error, message_count, token_count,
                  request_headers_json, response_headers_json, request_body_json, response_body_json,
                  model_route_json, stripped_fields_json, injected_fields_json, added_upstream_headers_json,
                  created_at, updated_at
                )
                VALUES (
                  :id, :task_id, :sequence, :event, :timestamp, :started_at, :duration_ms,
                  :proxy_id, :proxy_name, :client_host, :client_port,
                  :target_id, :target_name, :target_url, :method, :path, :endpoint,
                  :status, :error, :message_count, :token_count,
                  :request_headers_json, :response_headers_json, :request_body_json, :response_body_json,
                  :model_route_json, :stripped_fields_json, :injected_fields_json, :added_upstream_headers_json,
                  :created_at, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                  task_id = excluded.task_id,
                  sequence = excluded.sequence,
                  event = excluded.event,
                  timestamp = excluded.timestamp,
                  started_at = excluded.started_at,
                  duration_ms = excluded.duration_ms,
                  proxy_id = excluded.proxy_id,
                  proxy_name = excluded.proxy_name,
                  client_host = excluded.client_host,
                  client_port = excluded.client_port,
                  target_id = excluded.target_id,
                  target_name = excluded.target_name,
                  target_url = excluded.target_url,
                  method = excluded.method,
                  path = excluded.path,
                  endpoint = excluded.endpoint,
                  status = excluded.status,
                  error = excluded.error,
                  message_count = excluded.message_count,
                  token_count = excluded.token_count,
                  request_headers_json = excluded.request_headers_json,
                  response_headers_json = excluded.response_headers_json,
                  request_body_json = excluded.request_body_json,
                  response_body_json = excluded.response_body_json,
                  model_route_json = excluded.model_route_json,
                  stripped_fields_json = excluded.stripped_fields_json,
                  injected_fields_json = excluded.injected_fields_json,
                  added_upstream_headers_json = excluded.added_upstream_headers_json,
                  updated_at = excluded.updated_at
                """,
                values,
            )
        loaded = self.get_record(str(values["id"]))
        if loaded is None:
            raise RuntimeError(f"Record {values['id']} was not saved.")
        return loaded

    def upsert_response_link(self, response_id: str, task_id: str) -> None:
        self._upsert_link("response_links", "response_id", response_id, task_id)

    def upsert_context_link(self, context_key: str, task_id: str) -> None:
        self._upsert_link("context_links", "context_key", context_key, task_id)

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        row = self._fetch_one("SELECT * FROM tasks WHERE id = ?", (task_id,))
        return _decode_task_row(row) if row is not None else None

    def get_record(self, record_id: str) -> dict[str, Any] | None:
        row = self._fetch_one("SELECT * FROM records WHERE id = ?", (record_id,))
        return _decode_record_row(row) if row is not None else None

    def task_id_for_record(self, record_id: str) -> str | None:
        row = self._fetch_one("SELECT task_id FROM records WHERE id = ?", (record_id,))
        return str(row["task_id"]) if row is not None else None

    def task_id_for_response(self, response_id: str) -> str | None:
        row = self._fetch_one("SELECT task_id FROM response_links WHERE response_id = ?", (response_id,))
        return str(row["task_id"]) if row is not None else None

    def task_id_for_context(self, context_key: str) -> str | None:
        row = self._fetch_one("SELECT task_id FROM context_links WHERE context_key = ?", (context_key,))
        return str(row["task_id"]) if row is not None else None

    def next_record_sequence(self, task_id: str) -> int:
        row = self._fetch_one(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM records WHERE task_id = ?",
            (task_id,),
        )
        return int(row["next_sequence"]) if row is not None else 1

    def record_count(self, task_id: str) -> int:
        row = self._fetch_one("SELECT COUNT(*) AS count FROM records WHERE task_id = ?", (task_id,))
        return int(row["count"]) if row is not None else 0

    def list_tasks(self, query: str = "", limit: int = 100, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        where_sql, params = self._task_filter(query)
        count_row = self._fetch_one(f"SELECT COUNT(*) AS count FROM tasks {where_sql}", params)
        rows = self._fetch_all(
            f"""
            SELECT *
            FROM tasks
            {where_sql}
            ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC
            LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        )
        total = int(count_row["count"]) if count_row is not None else 0
        next_offset = offset + len(rows)
        return {
            "tasks": [_decode_task_row(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "next_offset": next_offset,
            "has_more": next_offset < total,
        }

    def list_task_records(self, task_id: str, query: str = "", limit: int = 200, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        where_sql, params = self._record_filter(task_id, query)
        count_row = self._fetch_one(f"SELECT COUNT(*) AS count FROM records {where_sql}", params)
        rows = self._fetch_all(
            f"""
            SELECT *
            FROM records
            {where_sql}
            ORDER BY sequence DESC
            LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        )
        total = int(count_row["count"]) if count_row is not None else 0
        next_offset = offset + len(rows)
        return {
            "records": [_decode_record_row(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "next_offset": next_offset,
            "has_more": next_offset < total,
        }

    def recent_tasks(self, limit: int = 200) -> list[dict[str, Any]]:
        rows = self._fetch_all(
            """
            SELECT *
            FROM tasks
            WHERE pending_request_only = 0
            ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC
            LIMIT ?
            """,
            (max(1, min(int(limit), 1000)),),
        )
        return [_decode_task_row(row) for row in rows]

    def delete_tasks(self, task_ids: list[str]) -> int:
        selected = [str(task_id) for task_id in task_ids if str(task_id).strip()]
        if not selected:
            return 0
        placeholders = ",".join("?" for _ in selected)
        with self.lock, self.connection:
            self.connection.execute(f"DELETE FROM record_search WHERE task_id IN ({placeholders})", selected)
            cursor = self.connection.execute(f"DELETE FROM tasks WHERE id IN ({placeholders})", selected)
            return int(cursor.rowcount if cursor.rowcount is not None else 0)

    def _upsert_link(self, table: str, id_column: str, value: str, task_id: str) -> None:
        if not str(value).strip():
            return
        now = local_now_iso()
        with self.lock, self.connection:
            self.connection.execute(
                f"""
                INSERT INTO {table}({id_column}, task_id, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT({id_column}) DO UPDATE SET task_id = excluded.task_id
                """,
                (str(value), str(task_id), now),
            )

    def _task_filter(self, query: str) -> tuple[str, tuple[Any, ...]]:
        terms = [term.lower() for term in query.split() if term.strip()]
        if not terms:
            return "", ()
        clauses: list[str] = []
        params: list[Any] = []
        for term in terms:
            like = f"%{term}%"
            clauses.append(
                """
                (
                  lower(id) LIKE ?
                  OR lower(kind) LIKE ?
                  OR lower(COALESCE(endpoint, '')) LIKE ?
                  OR lower(COALESCE(model, '')) LIKE ?
                  OR lower(COALESCE(target, '')) LIKE ?
                )
                """
            )
            params.extend([like, like, like, like, like])
        return "WHERE " + " AND ".join(clauses), tuple(params)

    def _record_filter(self, task_id: str, query: str) -> tuple[str, tuple[Any, ...]]:
        terms = [term.lower() for term in query.split() if term.strip()]
        clauses = ["task_id = ?"]
        params: list[Any] = [task_id]
        for term in terms:
            like = f"%{term}%"
            clauses.append(
                """
                (
                  lower(id) LIKE ?
                  OR lower(method) LIKE ?
                  OR lower(path) LIKE ?
                  OR lower(endpoint) LIKE ?
                  OR lower(COALESCE(target_url, '')) LIKE ?
                  OR CAST(status AS TEXT) LIKE ?
                )
                """
            )
            params.extend([like, like, like, like, like, like])
        return "WHERE " + " AND ".join(clauses), tuple(params)

    def _fetch_one(self, sql: str, params: tuple[Any, ...]) -> sqlite3.Row | None:
        with self.lock:
            return self.connection.execute(sql, params).fetchone()

    def _fetch_all(self, sql: str, params: tuple[Any, ...]) -> list[sqlite3.Row]:
        with self.lock:
            return list(self.connection.execute(sql, params).fetchall())


def _decode_task_row(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["pending_request_only"] = bool(result["pending_request_only"])
    result["fingerprints"] = _json_value(result.pop("fingerprints_json"), {})
    result["boundary_fingerprints"] = _json_value(result.pop("boundary_fingerprints_json"), {})
    result["last_user_messages"] = _json_value(result.pop("last_user_messages_json"), [])
    return result


def _decode_record_row(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["request_headers"] = _json_value(result.pop("request_headers_json"), {})
    result["response_headers"] = _json_value(result.pop("response_headers_json"), {})
    result["request_body"] = _json_value(result.pop("request_body_json"), None)
    result["response_body"] = _json_value(result.pop("response_body_json"), None)
    result["model_route"] = _json_value(result.pop("model_route_json"), None)
    result["stripped_fields"] = _json_value(result.pop("stripped_fields_json"), [])
    result["injected_fields"] = _json_value(result.pop("injected_fields_json"), [])
    result["added_upstream_headers"] = _json_value(result.pop("added_upstream_headers_json"), [])
    return result


def _json_text(value: object, default: object) -> str:
    if value is None:
        value = default
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _optional_json_text(value: object) -> str | None:
    if value is None:
        return None
    return _json_text(value, None)


def _json_value(value: object, default: object) -> object:
    if value in {None, ""}:
        return default
    try:
        return json.loads(str(value))
    except json.JSONDecodeError:
        return default


def _optional_str(value: object) -> str | None:
    if value in {None, ""}:
        return None
    return str(value)


def _optional_int(value: object) -> int | None:
    if value in {None, ""}:
        return None
    try:
        return int(str(value))
    except ValueError:
        return None


def _int_value(value: object, default: int) -> int:
    parsed = _optional_int(value)
    return default if parsed is None else parsed


def _float_value(value: object, default: float) -> float:
    if value in {None, ""}:
        return default
    try:
        return float(str(value))
    except ValueError:
        return default
