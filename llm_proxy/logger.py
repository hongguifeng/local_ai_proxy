"""Traffic log recorder.

Traffic records are stored under ``logs/tasks``. Model requests are grouped into
conversation/task directories; other requests are kept as single-request tasks.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from pathlib import Path

from .file_io import atomic_write_text
from .models import TrafficRecord
from .log_files import (
    ensure_log_dir,
    log_markdown_filename,
    render_interaction_markdown,
    write_body_json_files,
    write_task_index_markdown,
)
from .redaction import redact_record
from .task_grouper import TaskGrouper
from .task_index import TaskIndexStore


class TrafficLogger:
    """Thread-safe traffic log writer.

    The proxy server is multi-threaded and may handle multiple requests simultaneously, so all file write operations are protected by a single lock.
    """

    def __init__(self, log_root: Path | None, *, redact_logs: bool = False) -> None:
        self.log_root = log_root
        self.redact_logs = redact_logs
        self.lock = threading.Lock()
        # .task-index.json stores the index of "request ID/response ID/context ID -> task",
        # so when writing logs next time, related requests can be placed in the same task directory.
        self.task_index_store = TaskIndexStore(log_root / ".task-index.json" if log_root else None)
        self.task_index = self.task_index_store.load()
        self.task_grouper = TaskGrouper(self.task_index, self.task_index_store, log_root)
        if self.log_root:
            self.log_root.mkdir(parents=True, exist_ok=True)

    def write(self, record: TrafficRecord) -> None:
        """Write a complete task log record."""
        with self.lock:
            self.task_index_store.refresh_into(self.task_index)
            self.task_grouper.prepare(record)
            self._write_task_log(record)

    def update(self, record: TrafficRecord) -> None:
        """Update the task log.

        Called when the request body is read but the response has not yet arrived, so that the Markdown/JSON file appears earlier.
        """
        with self.lock:
            self.task_index_store.refresh_into(self.task_index)
            self.task_grouper.prepare(record)
            self._write_task_log(record)

    def _write_task_log(self, record: Mapping[str, object]) -> None:
        """Write or update the request directory inside its task."""
        if not self.log_root:
            return
        record_to_write = record
        if self.redact_logs:
            record_to_write = redact_record(record)
        current_log_filename = log_markdown_filename(record_to_write)
        task_ref = record_to_write.get("task")
        if not isinstance(task_ref, dict):
            return
        task_dir_name = task_ref.get("dir")
        sequence = task_ref.get("request_sequence")
        if not task_dir_name or not sequence:
            return
        tasks = self.task_index.get("tasks")
        task = tasks.get(task_ref.get("id")) if isinstance(tasks, dict) else None
        if not isinstance(task, dict):
            return
        requests = task.get("requests")
        request_info = requests.get(str(record["id"])) if isinstance(requests, dict) else None
        if not isinstance(request_info, dict):
            return

        task_path = self.log_root / "tasks" / str(task_dir_name)
        request_path_in_task = task_path / str(request_info["dir_name"])
        ensure_log_dir(request_path_in_task)
        # The same request generates different filenames for pending and finished states;
        # keep only the latest Markdown summary in the request directory.
        for existing_markdown in request_path_in_task.glob("*.md"):
            if existing_markdown.name != current_log_filename:
                existing_markdown.unlink()
        atomic_write_text(request_path_in_task / current_log_filename, render_interaction_markdown(record_to_write))
        write_body_json_files(request_path_in_task, dict(record_to_write))
        write_task_index_markdown(task_path, task)
