"""Traffic log recorder backed by SQLite."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .log_repository import LogRepository
from .models import TrafficRecord
from .payloads import body_json_value
from .records import display_endpoint, endpoint_kind, request_message_count, response_token_count
from .redaction import redact_record
from .task_matcher import TaskMatcher


class TrafficLogger:
    """Thread-safe traffic log writer."""

    def __init__(self, log_root: Path | None, *, redact_logs: bool = False) -> None:
        self.log_root = log_root
        self.redact_logs = redact_logs
        self.lock = threading.RLock()
        self.repository = LogRepository(log_root) if log_root else None
        self.task_matcher = TaskMatcher(self.repository) if self.repository else None

    def close(self) -> None:
        if self.repository:
            self.repository.close()

    def write(self, record: TrafficRecord) -> None:
        """Write a complete or final traffic log record."""
        self._save(record)

    def update(self, record: TrafficRecord) -> None:
        """Update a traffic log while the request is still in flight."""
        self._save(record)

    def _save(self, record: TrafficRecord) -> None:
        if not self.repository or not self.task_matcher:
            return
        with self.lock:
            record_to_write: Mapping[str, object] = redact_record(record) if self.redact_logs else record
            assignment = self.task_matcher.assign(record_to_write)
            if assignment is None:
                return
            self.repository.upsert_task(assignment.task)
            self.repository.upsert_record(self._record_row(record_to_write, assignment.task, assignment.sequence))
            for response_id in assignment.response_ids:
                self.repository.upsert_response_link(response_id, str(assignment.task["id"]))
            for context_key in assignment.context_keys:
                self.repository.upsert_context_link(context_key, str(assignment.task["id"]))

    def _record_row(self, record: Mapping[str, object], task: Mapping[str, object], sequence: int) -> dict[str, Any]:
        request = _mapping(record.get("request"))
        response = _mapping(record.get("response"))
        target = _mapping(record.get("target"))
        client = _mapping(record.get("client"))
        proxy = _mapping(record.get("proxy"))
        request_body = _body_json(request.get("upstream_body", request.get("body")))
        response_body = _body_json(response.get("body"))
        endpoint = display_endpoint(request.get("path", ""))
        kind = endpoint_kind(endpoint)
        return {
            "id": str(record["id"]),
            "task_id": str(task["id"]),
            "sequence": sequence,
            "event": str(record.get("event") or "request_finished"),
            "timestamp": str(record.get("timestamp") or ""),
            "started_at": str(record.get("started_timestamp") or record.get("timestamp") or ""),
            "duration_ms": record.get("duration_ms", 0),
            "proxy_id": proxy.get("id"),
            "proxy_name": proxy.get("name"),
            "client_host": client.get("host"),
            "client_port": client.get("port"),
            "target_id": target.get("id"),
            "target_name": target.get("name"),
            "target_url": _target_url(target),
            "method": str(request.get("method") or ""),
            "path": str(request.get("path") or ""),
            "endpoint": endpoint,
            "status": response.get("status"),
            "error": record.get("error"),
            "message_count": request_message_count(kind, request_body),
            "token_count": response_token_count(response_body),
            "request_headers": request.get("headers") if isinstance(request.get("headers"), Mapping) else {},
            "response_headers": response.get("headers") if isinstance(response.get("headers"), Mapping) else {},
            "request_body": request_body,
            "response_body": response_body,
            "model_route": request.get("model_route"),
            "stripped_fields": list(request.get("stripped_fields") or []),
            "injected_fields": list(request.get("injected_fields") or []),
            "added_upstream_headers": list(request.get("added_upstream_headers") or []),
        }


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _body_json(value: object) -> object:
    if isinstance(value, Mapping):
        return body_json_value(value)
    return None


def _target_url(target: Mapping[str, object]) -> str:
    scheme = target.get("scheme")
    host = target.get("host")
    port = target.get("port")
    path = target.get("path", "")
    if not scheme or not host or port in {None, ""}:
        return ""
    return f"{scheme}://{host}:{port}{path}"
