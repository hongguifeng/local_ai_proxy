"""流量日志记录器。

本项目默认把单次请求写到 ``logs/readable``：人类友好的 Markdown/JSON 文件，方便直接打开查看请求和响应。

另外，日志器会尝试把同一个 LLM 任务中的多次请求归到同级的 ``tasks`` 目录。
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
    """线程安全的流量日志写入器。

    代理服务器是多线程的，可能同时处理多个请求，所以所有写文件操作都用同一把锁保护。
    """

    def __init__(self, readable_dir: Path | None, *, redact_logs: bool = False) -> None:
        self.readable_dir = readable_dir
        self.redact_logs = redact_logs
        self.lock = threading.Lock()
        self.readable_paths: dict[str, Path] = {}
        # .task-index.json 保存“请求 ID/响应 ID/上下文 ID -> 任务”的索引，
        # 下次写日志时可以继续把相关请求放进同一个任务目录。
        self.task_index_store = TaskIndexStore(readable_dir.parent / ".task-index.json" if readable_dir else None)
        self.task_index = self.task_index_store.load()
        self.task_grouper = TaskGrouper(self.task_index, self.task_index_store, readable_dir)
        if self.readable_dir:
            self.readable_dir.mkdir(parents=True, exist_ok=True)

    def write(self, record: TrafficRecord) -> None:
        """写一条完整 readable 日志记录。"""
        with self.lock:
            self.task_grouper.prepare(record)
            self._write_readable(record)

    def update_readable(self, record: TrafficRecord) -> None:
        """更新 readable 日志。

        请求体读完但响应还没回来时会调用它，用来让 Markdown/JSON 文件先出现。
        """
        with self.lock:
            self.task_grouper.prepare(record)
            self._write_readable(record)

    def _write_readable(self, record: Mapping[str, object]) -> None:
        """写入或更新一条请求对应的 readable 目录。"""
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
        # 同一个请求在“等待响应”和“请求完成”时会生成不同文件名，
        # 这里删除旧 Markdown，保持目录里只有最新状态的一份摘要。
        for existing_markdown in readable_path.glob("*.md"):
            if existing_markdown.name != current_readable_filename:
                existing_markdown.unlink()
        atomic_write_text(readable_path / current_readable_filename, render_interaction_markdown(record_to_write))
        write_body_json_files(readable_path, record_to_write)
        self._write_task_readable(record_to_write, current_readable_filename)

    def _write_task_readable(self, record: Mapping[str, object], readable_filename: str) -> None:
        """把当前请求也写进它所属的任务目录。"""
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
