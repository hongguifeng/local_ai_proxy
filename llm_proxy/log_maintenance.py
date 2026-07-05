"""Export and cleanup helpers for SQLite traffic logs."""

from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path
from typing import Any

from .log_repository import LogRepository
from .log_roots import log_roots as _log_roots
from .manager import ProxyManager
from .records import safe_filename_part
from .time_utils import format_local_timestamp, local_datetime_from_timestamp


def log_roots(manager: ProxyManager) -> list[Path]:
    return _log_roots(manager)


def export_logs_zip(manager: ProxyManager) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for root in log_roots(manager):
            with LogRepository(root) as repository:
                for task in _all_tasks(repository):
                    task_dir = _task_export_dir(task)
                    records = _all_records(repository, str(task["id"]))
                    archive.writestr(f"tasks/{task_dir}/index.md", _render_task_markdown(task, records))
                    for record in records:
                        record_dir = _record_export_dir(record)
                        base = f"tasks/{task_dir}/{record_dir}"
                        archive.writestr(f"{base}/summary.md", _render_record_markdown(task, record))
                        archive.writestr(f"{base}/request.json", _json_bytes(record.get("request_body")))
                        archive.writestr(f"{base}/response.json", _json_bytes(record.get("response_body")))
    return buffer.getvalue()


def cleanup_logs(
    manager: ProxyManager,
    *,
    older_than_days: int | None = None,
    keep_latest: int | None = None,
    group_ids: list[str] | None = None,
) -> dict[str, Any]:
    if group_ids:
        return cleanup_log_groups(manager, group_ids)

    cutoff = time.time() - older_than_days * 86400 if older_than_days is not None else None
    keep_latest = max(0, keep_latest) if keep_latest is not None else None
    deleted: list[str] = []
    for root in log_roots(manager):
        with LogRepository(root) as repository:
            tasks = _all_tasks(repository)
            selected: set[str] = set()
            if cutoff is not None:
                for task in tasks:
                    task_epoch = _task_epoch(task)
                    if task_epoch is not None and task_epoch < cutoff:
                        selected.add(str(task["id"]))
            if keep_latest is not None:
                selected.update(str(task["id"]) for task in tasks[keep_latest:])
            if selected:
                repository.delete_tasks(sorted(selected))
                deleted.extend(sorted(selected))
    return {"deleted": deleted, "deleted_count": len(deleted)}


def cleanup_log_groups(manager: ProxyManager, group_ids: list[str]) -> dict[str, Any]:
    selected_ids = [str(group_id) for group_id in group_ids if str(group_id).strip()]
    deleted: list[str] = []
    if not selected_ids:
        return {"deleted": deleted, "deleted_count": 0}
    for root in log_roots(manager):
        with LogRepository(root) as repository:
            existing = [task_id for task_id in selected_ids if repository.get_task(task_id)]
            if not existing:
                continue
            repository.delete_tasks(existing)
            deleted.extend(existing)
    return {"deleted": deleted, "deleted_count": len(deleted)}


def _all_tasks(repository: LogRepository) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = repository.list_tasks("", limit=500, offset=offset)
        tasks.extend(page["tasks"])
        if not page["has_more"]:
            break
        offset = int(page["next_offset"])
    return tasks


def _all_records(repository: LogRepository, task_id: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = repository.list_task_records(task_id, limit=500, offset=offset)
        records.extend(page["records"])
        if not page["has_more"]:
            break
        offset = int(page["next_offset"])
    return records


def _task_export_dir(task: dict[str, Any]) -> str:
    stamp = _compact_timestamp(task.get("started_at")) or "unknown-time"
    model = safe_filename_part(task.get("model"), "unknown-model", limit=32)
    kind = safe_filename_part(task.get("kind"), "task", limit=24)
    task_id = safe_filename_part(task.get("id"), "task", limit=16)
    return f"{stamp}__{model}__{kind}__{task_id}"


def _record_export_dir(record: dict[str, Any]) -> str:
    sequence = int(record.get("sequence") or 0)
    endpoint = safe_filename_part(record.get("endpoint"), "request", limit=40)
    record_id = safe_filename_part(record.get("id"), "record", limit=24)
    return f"{sequence:03d}__{endpoint}__{record_id}"


def _render_task_markdown(task: dict[str, Any], records: list[dict[str, Any]]) -> str:
    parts = [
        f"# LLM Task {task.get('id')}",
        "",
        "## Summary",
        "",
        f"- Kind: {task.get('kind')}",
        f"- Started: {_display_timestamp(task.get('started_at'))}",
        f"- Last seen: {_display_timestamp(task.get('last_seen_at'))}",
        f"- Last response: {_display_timestamp(task.get('last_response_at'))}",
        f"- Requests: {task.get('request_count', len(records))}",
    ]
    if task.get("model"):
        parts.append(f"- Model: {task.get('model')}")
    if task.get("target"):
        parts.append(f"- Target: {task.get('target')}")
    parts.extend(["", "## Timeline", ""])
    for record in sorted(records, key=lambda item: int(item.get("sequence") or 0)):
        status = record.get("status")
        status_text = "pending" if status is None else str(status)
        parts.append(
            f"- {int(record.get('sequence') or 0):03d} `{record.get('method')} {record.get('path')}` "
            f"-> {status_text} ({record.get('duration_ms')} ms) [{record.get('id')}]({_record_export_dir(record)}/)"
        )
    parts.append("")
    return "\n".join(parts)


def _render_record_markdown(task: dict[str, Any], record: dict[str, Any]) -> str:
    parts = [
        f"# LLM Interaction {record.get('id')}",
        "",
        "## Summary",
        "",
        f"- Time: {_display_timestamp(record.get('timestamp'))}",
        f"- Event: {record.get('event')}",
        f"- Duration: {record.get('duration_ms')} ms",
        f"- Target: {record.get('target_url')}",
        f"- Request: {record.get('method')} {record.get('path')}",
        f"- Endpoint: {record.get('endpoint')}",
        f"- Message count: {record.get('message_count')}",
        f"- Token count: {record.get('token_count')}",
        f"- Response: {record.get('status')}",
        f"- Task: {task.get('kind')} / {task.get('id')} / request {record.get('sequence')}",
        "",
        "## Request Body",
        "",
        "See `request.json`.",
        "",
        "## Response Body",
        "",
        "See `response.json`.",
        "",
    ]
    if record.get("error"):
        parts.insert(13, f"- Error: {record.get('error')}")
    return "\n".join(parts)


def _json_bytes(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _compact_timestamp(value: object) -> str:
    if not isinstance(value, str) or not value:
        return ""
    try:
        return format_local_timestamp(value, "%Y-%m-%d__%H-%M-%S")
    except ValueError:
        return safe_filename_part(value, "time", limit=32)


def _display_timestamp(value: object) -> str:
    if not isinstance(value, str) or not value:
        return ""
    try:
        return format_local_timestamp(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return value


def _task_epoch(task: dict[str, Any]) -> float | None:
    value = task.get("last_response_at") or task.get("last_seen_at") or task.get("started_at")
    if not isinstance(value, str) or not value:
        return None
    try:
        return local_datetime_from_timestamp(value).timestamp()
    except ValueError:
        return None
