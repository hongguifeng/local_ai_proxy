"""SQLite-backed task matching for traffic records."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .log_repository import LogRepository
from .records import (
    endpoint_kind,
    first_string,
    get_nested_value,
    request_body_json,
    request_boundary_fingerprints,
    request_fingerprints,
    request_path,
    request_user_messages,
    response_body_json,
    response_ids_from_body,
    safe_filename_part,
)
from .time_utils import utc_now_iso

TASK_MATCH_STRATEGY_VERSION = 4
MODEL_TASK_KINDS = {"responses", "chat", "messages", "completions"}


@dataclass(frozen=True)
class TaskAssignment:
    task: dict[str, Any]
    sequence: int
    kind: str
    request_payload: object
    response_payload: object
    response_ids: list[str]
    context_keys: list[str]


class TaskMatcher:
    def __init__(self, repository: LogRepository) -> None:
        self.repository = repository

    def assign(self, record: Mapping[str, object]) -> TaskAssignment | None:
        request = record.get("request")
        if not isinstance(request, Mapping):
            return None
        kind = endpoint_kind(request_path(record))
        request_id = str(record["id"])
        if request.get("body_pending"):
            task = self._pending_task(record, kind or "request")
            return TaskAssignment(
                task=task,
                sequence=self._sequence_for_record(request_id, str(task["id"])),
                kind=str(task["kind"]),
                request_payload={},
                response_payload=None,
                response_ids=[],
                context_keys=[],
            )

        payload = request_body_json(record)
        response_payload = response_body_json(record)
        pending_task = self._task_for_existing_record(request_id)
        matched_task: dict[str, Any] | None = self._promote_or_match_pending(pending_task, record, kind, payload)
        if matched_task is None:
            matched_task = (
                self._find_or_new_model_task(record, kind, payload)
                if kind in MODEL_TASK_KINDS
                else self._find_or_new_single_request_task(record, kind)
            )
        if matched_task is None:
            return None

        task = self._updated_task(matched_task, record, kind, payload, response_payload)
        sequence = self._sequence_for_record(request_id, str(task["id"]))
        context_keys = self._context_keys(payload, record) if isinstance(payload, Mapping) else []
        return TaskAssignment(
            task=task,
            sequence=sequence,
            kind=kind,
            request_payload=payload,
            response_payload=response_payload,
            response_ids=response_ids_from_body(response_payload),
            context_keys=context_keys,
        )

    def _task_for_existing_record(self, request_id: str) -> dict[str, Any] | None:
        task_id = self.repository.task_id_for_record(request_id)
        return self.repository.get_task(task_id) if task_id else None

    def _pending_task(self, record: Mapping[str, object], kind: str) -> dict[str, Any]:
        existing = self._task_for_existing_record(str(record["id"]))
        if existing and existing.get("pending_request_only"):
            return existing
        task = self._new_task(record, kind, {})
        task["pending_request_only"] = True
        task["anchor"] = f"pending-{safe_filename_part(record['id'], limit=32)}"
        task["request_count"] = 1
        return task

    def _promote_or_match_pending(
        self,
        pending_task: dict[str, Any] | None,
        record: Mapping[str, object],
        kind: str,
        payload: object,
    ) -> dict[str, Any] | None:
        if not pending_task:
            return None
        if kind in MODEL_TASK_KINDS:
            matched = self._match_existing_task(record, kind, payload)
            if matched and matched.get("id") != pending_task.get("id"):
                return matched
        self._promote_pending_task(pending_task, record, kind, payload)
        return pending_task

    def _promote_pending_task(
        self,
        task: dict[str, Any],
        record: Mapping[str, object],
        kind: str,
        payload: object,
    ) -> None:
        task["pending_request_only"] = False
        task["kind"] = kind
        task["endpoint"] = request_path(record)
        task["anchor"] = self._task_anchor(record, kind, payload)
        task["match_confidence"] = 1.0

    def _find_or_new_model_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, Any]:
        matched = self._match_existing_task(record, kind, payload)
        if matched:
            matched["match_confidence"] = 1.0 if kind == "responses" else matched.get("match_confidence", 0.8)
            return matched
        return self._new_task(record, kind, payload)

    def _find_or_new_single_request_task(self, record: Mapping[str, object], kind: str) -> dict[str, Any]:
        existing = self._task_for_existing_record(str(record["id"]))
        if existing and not existing.get("pending_request_only"):
            return existing
        task = self._new_task(record, kind or "request", {})
        task["anchor"] = f"req-{safe_filename_part(record['id'], limit=32)}"
        return task

    def _match_existing_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, Any] | None:
        existing = self._task_for_existing_record(str(record["id"]))
        if existing and not existing.get("pending_request_only"):
            return existing

        if isinstance(payload, Mapping):
            previous_response_id = payload.get("previous_response_id")
            if kind == "responses" and isinstance(previous_response_id, str):
                task = self._task_for_response(previous_response_id)
                if task and self._task_static_boundaries_match(task, record, kind, payload, include_user_boundary=False):
                    return task

            for context_key in self._context_keys(payload, record):
                task = self._task_for_context(context_key)
                if task and self._task_static_boundaries_match(task, record, kind, payload, include_user_boundary=False):
                    return task

        return self._best_heuristic_task(record, kind, payload)

    def _task_for_response(self, response_id: str) -> dict[str, Any] | None:
        task_id = self.repository.task_id_for_response(response_id)
        return self.repository.get_task(task_id) if task_id else None

    def _task_for_context(self, context_key: str) -> dict[str, Any] | None:
        task_id = self.repository.task_id_for_context(context_key)
        return self.repository.get_task(task_id) if task_id else None

    def _task_static_boundaries_match(
        self,
        task: Mapping[str, object],
        record: Mapping[str, object],
        kind: str,
        payload: Mapping[str, object],
        include_user_boundary: bool = True,
    ) -> bool:
        if task.get("kind") != kind:
            return False
        endpoint = task.get("endpoint")
        if endpoint and endpoint != request_path(record):
            return False
        if payload.get("model") != task.get("model"):
            return False
        task_fingerprints = self._task_boundary_fingerprints(task, include_user_boundary=include_user_boundary)
        request_fingerprints = self._request_boundary_fingerprints(kind, payload, include_user_boundary=include_user_boundary)
        return task_fingerprints == request_fingerprints

    def _request_boundary_fingerprints(
        self,
        kind: str,
        payload: Mapping[str, object],
        include_user_boundary: bool = True,
    ) -> dict[str, object]:
        fingerprints: dict[str, object] = dict(request_boundary_fingerprints(kind, payload))
        if not include_user_boundary:
            fingerprints.pop("first_user", None)
        return fingerprints

    def _task_boundary_fingerprints(
        self,
        task: Mapping[str, object],
        include_user_boundary: bool = True,
    ) -> dict[str, object]:
        boundary_fingerprints = task.get("boundary_fingerprints")
        if not isinstance(boundary_fingerprints, dict):
            return {}
        result = dict(boundary_fingerprints)
        if not include_user_boundary:
            result.pop("first_user", None)
        return result

    def _best_heuristic_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, Any] | None:
        if not isinstance(payload, Mapping):
            return None
        try:
            now = dt.datetime.fromisoformat(str(record.get("timestamp", utc_now_iso())))
        except ValueError:
            now = dt.datetime.fromisoformat(utc_now_iso())
        best_task: dict[str, Any] | None = None
        best_age_seconds: float | None = None
        current_user_messages = request_user_messages(kind, payload)

        for task in self.repository.recent_tasks():
            if task.get("pending_request_only"):
                continue
            if not self._task_static_boundaries_match(task, record, kind, payload):
                continue
            last_seen_raw = task.get("last_seen_at", task.get("started_at"))
            try:
                last_seen = dt.datetime.fromisoformat(str(last_seen_raw))
            except ValueError:
                continue
            age_seconds = abs((now - last_seen).total_seconds())
            if age_seconds > 24 * 60 * 60:
                continue
            if kind in {"chat", "messages", "responses"} and not self._task_user_messages_match(task, current_user_messages):
                continue
            if kind in {"chat", "messages", "responses"} and not self._task_has_continuation_evidence(task, kind, payload, current_user_messages):
                continue
            if best_age_seconds is None or age_seconds < best_age_seconds:
                best_age_seconds = age_seconds
                best_task = task
        if best_task:
            best_task["match_confidence"] = 0.95
        return best_task

    def _task_user_messages_match(self, task: Mapping[str, object], current_user_messages: list[object]) -> bool:
        previous_user_messages = task.get("last_user_messages")
        if not isinstance(previous_user_messages, list):
            return False
        if not previous_user_messages or not current_user_messages:
            return False
        return self._sequence_starts_with(current_user_messages, previous_user_messages)

    def _task_has_continuation_evidence(
        self,
        task: Mapping[str, object],
        kind: str,
        payload: Mapping[str, object],
        current_user_messages: list[object],
    ) -> bool:
        previous_user_messages = task.get("last_user_messages")
        if isinstance(previous_user_messages, list) and len(current_user_messages) > len(previous_user_messages):
            return True
        previous_fingerprints = task.get("fingerprints")
        if not isinstance(previous_fingerprints, dict):
            return False
        current_fingerprints = request_fingerprints(kind, payload)
        evidence_keys = ("input", "messages")
        return any(
            isinstance(previous_fingerprints.get(key), str)
            and isinstance(current_fingerprints.get(key), str)
            and previous_fingerprints.get(key) != current_fingerprints.get(key)
            for key in evidence_keys
        )

    def _sequence_starts_with(self, sequence: list[object], prefix: list[object]) -> bool:
        if len(prefix) > len(sequence):
            return False
        return sequence[: len(prefix)] == prefix

    def _new_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, Any]:
        now = utc_now_iso()
        task = {
            "id": uuid.uuid4().hex,
            "kind": kind,
            "anchor": self._task_anchor(record, kind, payload),
            "started_at": record.get("started_timestamp", record.get("timestamp", now)),
            "last_seen_at": record.get("timestamp", now),
            "endpoint": request_path(record),
            "match_strategy_version": TASK_MATCH_STRATEGY_VERSION,
            "fingerprints": request_fingerprints(kind, payload),
            "boundary_fingerprints": request_boundary_fingerprints(kind, payload),
            "last_user_messages": request_user_messages(kind, payload),
            "request_count": 0,
            "match_confidence": 1.0,
            "created_at": now,
            "updated_at": now,
        }
        if isinstance(payload, Mapping) and payload.get("model"):
            task["model"] = payload.get("model")
        target_text = self._target_text(record)
        if target_text:
            task["target"] = target_text
        return task

    def _updated_task(
        self,
        task: dict[str, Any],
        record: Mapping[str, object],
        kind: str,
        payload: object,
        response_payload: object,
    ) -> dict[str, Any]:
        request_id = str(record["id"])
        existing_record = self.repository.get_record(request_id)
        task = dict(task)
        task["pending_request_only"] = False
        task["kind"] = kind
        task["endpoint"] = request_path(record)
        task["last_seen_at"] = record.get("timestamp", task.get("last_seen_at", utc_now_iso()))
        status = get_nested_value(record, ("response", "status"))
        if status is not None:
            task["last_response_at"] = record.get("timestamp", task.get("last_response_at"))
        if isinstance(payload, Mapping) and payload.get("model"):
            task["model"] = payload.get("model")
        task["fingerprints"] = request_fingerprints(kind, payload)
        task["boundary_fingerprints"] = request_boundary_fingerprints(kind, payload)
        task["last_user_messages"] = request_user_messages(kind, payload)
        target_text = self._target_text(record)
        if target_text:
            task["target"] = target_text
        task["request_count"] = self.repository.record_count(str(task["id"])) + (0 if existing_record else 1)
        task["updated_at"] = utc_now_iso()
        if response_ids_from_body(response_payload):
            task["last_response_at"] = record.get("timestamp", task.get("last_response_at"))
        return task

    def _sequence_for_record(self, request_id: str, task_id: str) -> int:
        existing = self.repository.get_record(request_id)
        if existing and existing.get("task_id") == task_id:
            return int(existing.get("sequence") or 1)
        return self.repository.next_record_sequence(task_id)

    def _task_anchor(self, record: Mapping[str, object], kind: str, payload: object) -> str:
        if kind == "responses" and isinstance(payload, Mapping):
            previous_response_id = payload.get("previous_response_id")
            if isinstance(previous_response_id, str) and previous_response_id:
                return f"prev-{safe_filename_part(previous_response_id, limit=32)}"
        fingerprints = request_fingerprints(kind, payload)
        if fingerprints:
            first_key = sorted(fingerprints)[0]
            return f"fp-{fingerprints[first_key]}"
        return f"req-{str(record['id'])[:12]}"

    def _context_keys(self, payload: Mapping[str, object], record: Mapping[str, object] | None = None) -> list[str]:
        keys: list[str] = []
        seen: set[str] = set()

        def add_key(prefix: str, value: object) -> None:
            if isinstance(value, str) and value.strip():
                key = f"{prefix}:{value.strip()}"
                if key not in seen:
                    seen.add(key)
                    keys.append(key)

        conversation = payload.get("conversation")
        conversation_id = first_string(
            conversation,
            get_nested_value(conversation, ("id",)),
            payload.get("conversation_id"),
            payload.get("thread_id"),
            get_nested_value(payload, ("metadata", "conversation_id")),
            get_nested_value(payload, ("metadata", "thread_id")),
            get_nested_value(payload, ("metadata", "session_id")),
        )
        if conversation_id:
            add_key("conversation", conversation_id)
        add_key("prompt_cache", payload.get("prompt_cache_key"))
        if record is not None:
            add_key("prompt_cache", record.get("prompt_cache_key"))
            add_key("client_thread", get_nested_value(record, ("client_metadata", "thread_id")))
            add_key("client_session", get_nested_value(record, ("client_metadata", "session_id")))
        return keys

    def _target_text(self, record: Mapping[str, object]) -> str:
        target = record.get("target")
        if not isinstance(target, Mapping):
            return ""
        scheme = target.get("scheme")
        host = target.get("host")
        port = target.get("port")
        path = target.get("path", "")
        if not scheme or not host or port in {None, ""}:
            return ""
        return f"{scheme}://{host}:{port}{path}"
