from __future__ import annotations

import json
import threading
from pathlib import Path

from .file_io import atomic_write_text

TASK_MATCH_STRATEGY_VERSION = 3
_SAVE_LOCK = threading.Lock()


def empty_task_index() -> dict[str, object]:
    return {
        "task_match_strategy_version": TASK_MATCH_STRATEGY_VERSION,
        "tasks": {},
        "request_to_task": {},
        "response_to_task": {},
        "context_to_task": {},
    }


def _valid_task_index(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("task_match_strategy_version") != TASK_MATCH_STRATEGY_VERSION:
        return False
    return all(isinstance(value.get(key), dict) for key in ("tasks", "request_to_task", "response_to_task", "context_to_task"))


class TaskIndexStore:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._last_seen_mtime_ns: int | None = None

    def load(self) -> dict[str, object]:
        if not self.path or not self.path.exists():
            self._last_seen_mtime_ns = None
            return empty_task_index()
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty_task_index()
        if not _valid_task_index(loaded):
            return empty_task_index()
        self._last_seen_mtime_ns = self._mtime_ns()
        return loaded

    def refresh_into(self, task_index: dict[str, object]) -> None:
        """Refresh an in-memory index from disk without scanning task directories."""
        if not self.path:
            return
        mtime_ns = self._mtime_ns()
        if mtime_ns is None or mtime_ns == self._last_seen_mtime_ns:
            return
        with _SAVE_LOCK:
            merged = self._merge_indexes(self.load(), task_index)
            task_index.clear()
            task_index.update(merged)

    def save(self, task_index: dict[str, object]) -> None:
        if not self.path:
            return
        with _SAVE_LOCK:
            merged = self._merge_with_existing(task_index)
            merged["task_match_strategy_version"] = TASK_MATCH_STRATEGY_VERSION
            payload = json.dumps(merged, ensure_ascii=False, indent=2)
            atomic_write_text(self.path, payload)
            self._last_seen_mtime_ns = self._mtime_ns()

            task_index.clear()
            task_index.update(merged)

    def _merge_with_existing(self, task_index: dict[str, object]) -> dict[str, object]:
        """Preserve entries written by sibling loggers that share the same index file."""
        return self._merge_indexes(self.load(), task_index)

    def _merge_indexes(self, existing: dict[str, object], task_index: dict[str, object]) -> dict[str, object]:
        merged = dict(existing)
        for key in ("tasks", "request_to_task", "response_to_task", "context_to_task"):
            existing_values = existing.get(key)
            current_values = task_index.get(key)
            if key == "tasks" and isinstance(existing_values, dict) and isinstance(current_values, dict):
                merged[key] = self._merge_tasks(existing_values, current_values)
            elif isinstance(existing_values, dict) and isinstance(current_values, dict):
                merged[key] = {**existing_values, **current_values}
            elif isinstance(current_values, dict):
                merged[key] = dict(current_values)
            elif key not in merged:
                merged[key] = {}
        for key, value in task_index.items():
            if key not in {"tasks", "request_to_task", "response_to_task", "context_to_task"}:
                merged[key] = value
        return merged

    def _merge_tasks(self, existing_tasks: dict[object, object], current_tasks: dict[object, object]) -> dict[object, object]:
        merged = dict(existing_tasks)
        for task_id, current_task in current_tasks.items():
            existing_task = merged.get(task_id)
            if isinstance(existing_task, dict) and isinstance(current_task, dict):
                merged[task_id] = self._merge_task(existing_task, current_task)
            else:
                merged[task_id] = current_task
        return merged

    def _merge_task(self, existing_task: dict[object, object], current_task: dict[object, object]) -> dict[object, object]:
        base, newer = self._older_and_newer_task(existing_task, current_task)
        merged = dict(base)
        merged.update(newer)

        existing_requests = existing_task.get("requests")
        current_requests = current_task.get("requests")
        if isinstance(existing_requests, dict) or isinstance(current_requests, dict):
            requests: dict[object, object] = {}
            if isinstance(existing_requests, dict):
                requests.update(existing_requests)
            if isinstance(current_requests, dict):
                requests.update(current_requests)
            merged["requests"] = requests
            merged["request_count"] = len(requests)
        return merged

    def _older_and_newer_task(
        self,
        existing_task: dict[object, object],
        current_task: dict[object, object],
    ) -> tuple[dict[object, object], dict[object, object]]:
        existing_timestamp = self._task_sort_timestamp(existing_task)
        current_timestamp = self._task_sort_timestamp(current_task)
        if current_timestamp >= existing_timestamp:
            return existing_task, current_task
        return current_task, existing_task

    def _task_sort_timestamp(self, task: dict[object, object]) -> str:
        for key in ("last_seen_at", "last_response_at", "started_at"):
            value = task.get(key)
            if isinstance(value, str):
                return value
        return ""

    def _mtime_ns(self) -> int | None:
        if not self.path:
            return None
        try:
            return self.path.stat().st_mtime_ns
        except OSError:
            return None
