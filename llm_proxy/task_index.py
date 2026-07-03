from __future__ import annotations

import json
from pathlib import Path

from .file_io import atomic_write_text

TASK_MATCH_STRATEGY_VERSION = 3


def empty_task_index() -> dict[str, object]:
    return {
        "task_match_strategy_version": TASK_MATCH_STRATEGY_VERSION,
        "tasks": {},
        "request_to_task": {},
        "response_to_task": {},
        "context_to_task": {},
    }


class TaskIndexStore:
    def __init__(self, path: Path | None) -> None:
        self.path = path

    def load(self) -> dict[str, object]:
        if not self.path or not self.path.exists():
            return empty_task_index()
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty_task_index()
        if not isinstance(loaded, dict):
            return empty_task_index()
        loaded.setdefault("task_match_strategy_version", TASK_MATCH_STRATEGY_VERSION)
        loaded.setdefault("tasks", {})
        loaded.setdefault("request_to_task", {})
        loaded.setdefault("response_to_task", {})
        loaded.setdefault("context_to_task", {})
        return loaded

    def save(self, task_index: dict[str, object]) -> None:
        if not self.path:
            return
        task_index["task_match_strategy_version"] = TASK_MATCH_STRATEGY_VERSION
        payload = json.dumps(task_index, ensure_ascii=False, indent=2)
        atomic_write_text(self.path, payload)
