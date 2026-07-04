"""Traffic log recorder.

By default, this project writes individual requests to ``logs/readable``: human-friendly Markdown/JSON files, making it easy to directly open and view requests and responses.

Additionally, the logger attempts to group multiple requests from the same LLM task into a sibling ``tasks`` directory.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from pathlib import Path

from .file_io import atomic_write_text
from .models import TrafficRecord
from .readable_logs import (
    ensure_readable_dir,
    readable_dir_name,
    readable_filename,
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

    def __init__(self, readable_dir: Path | None, *, redact_logs: bool = False) -> None:
        self.readable_dir = readable_dir
        self.redact_logs = redact_logs
        self.lock = threading.Lock()
        self.readable_paths: dict[str, Path] = {}
        # .task-index.json stores the index of "request ID/response ID/context ID -> task",
        # so when writing logs next time, related requests can be placed in the same task directory.
        self.task_index_store = TaskIndexStore(readable_dir.parent / ".task-index.json" if readable_dir else None)
        self.task_index = self.task_index_store.load()
        self.task_grouper = TaskGrouper(self.task_index, self.task_index_store, readable_dir)
        if self.readable_dir:
            self.readable_dir.mkdir(parents=True, exist_ok=True)

    def write(self, record: TrafficRecord) -> None:
        """Write a complete readable log record."""
        with self.lock:
            self.task_index_store.refresh_into(self.task_index)
            self.task_grouper.prepare(record)
            self._write_readable(record)

    def update_readable(self, record: TrafficRecord) -> None:
        """Update the readable log.

        Called when the request body is read but the response has not yet arrived, so that the Markdown/JSON file appears earlier.
        """
        with self.lock:
            self.task_index_store.refresh_into(self.task_index)
            self.task_grouper.prepare(record)
            self._write_readable(record)

    def _write_readable(self, record: Mapping[str, object]) -> None:
        """Write or update the readable directory for a request."""
        if not self.readable_dir:
            return
        record_to_write = record
        if self.redact_logs:
            record_to_write = redact_record(record)
        record_id = str(record_to_write["id"])
        readable_path = self.readable_paths.get(record_id)
        if readable_path is None:
            readable_path = self.readable_dir / readable_dir_name(record_to_write)
            ensure_readable_dir(readable_path)
            self.readable_paths[record_id] = readable_path
        current_readable_filename = readable_filename(record_to_write)
        # The same request generates different filenames for "waiting for response" and "request completed",
        # here we remove old Markdown files to keep only the latest summary in the directory.
        for existing_markdown in readable_path.glob("*.md"):
            if existing_markdown.name != current_readable_filename:
                existing_markdown.unlink()
        atomic_write_text(readable_path / current_readable_filename, render_interaction_markdown(record_to_write))
        write_body_json_files(readable_path, record_to_write)
        self._write_task_readable(record_to_write, current_readable_filename)

    def _write_task_readable(self, record: Mapping[str, object], readable_filename: str) -> None:
        """Also write the current request into its parent task directory."""
        task_ref = record.get("task")
        if not isinstance(task_ref, dict) or not self.readable_dir:
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

        task_path = self.readable_dir.parent / "tasks" / str(task_dir_name)
        request_path_in_task = task_path / str(request_info["dir_name"])
        ensure_readable_dir(request_path_in_task)
        for existing_markdown in request_path_in_task.glob("*.md"):
            if existing_markdown.name != readable_filename:
                existing_markdown.unlink()
        atomic_write_text(request_path_in_task / readable_filename, render_interaction_markdown(record))
        write_body_json_files(request_path_in_task, dict(record))
        write_task_index_markdown(task_path, task)
