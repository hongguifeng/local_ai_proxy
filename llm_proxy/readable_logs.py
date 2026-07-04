from __future__ import annotations

import datetime as dt
import json
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from .file_io import atomic_write_text
from .payloads import body_json_value, render_headers
from .records import display_endpoint, endpoint_kind, request_message_count, response_token_count
from .time_utils import (
    format_duration_hms,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    readable_start_timestamp,
)


def ensure_readable_dir(path: Path) -> None:
    if path.is_file():
        path.unlink()
    path.mkdir(parents=True, exist_ok=True)


def readable_dir_name(record: Mapping[str, object]) -> str:
    timestamp = local_datetime_for_filename(readable_start_timestamp(record))
    request = cast(Mapping[str, object], record["request"])
    method = str(request["method"])
    path = str(request["path"])
    safe_path = "".join(ch if ch.isalnum() else "-" for ch in path).strip("-")
    safe_path = safe_path[:80] or "root"
    return f"{timestamp}__{method}__{safe_path}__{record['id']}"


def readable_filename(record: Mapping[str, object]) -> str:
    start_time = readable_start_timestamp(record)
    duration_ms = float(cast(str | int | float, record["duration_ms"]))

    start_dt = dt.datetime.fromisoformat(str(start_time))
    end_dt = start_dt + dt.timedelta(milliseconds=duration_ms)

    start_str = local_time_from_timestamp_for_filename(start_time)
    end_str = end_dt.astimezone().strftime("%H-%M-%S.%f")[:-3]
    return f"{start_str}__{end_str}.md"


def write_json_file(path: Path, value: object) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2))


def write_body_json_files(path: Path, record: Mapping[str, object]) -> None:
    request = cast(Mapping[str, object], record["request"])
    response = cast(Mapping[str, object], record["response"])
    request_body = cast(Mapping[str, object], request.get("upstream_body", request["body"]))
    response_body = cast(Mapping[str, object], response["body"])
    write_json_file(path / "request.json", body_json_value(request_body))
    write_json_file(path / "response.json", body_json_value(response_body))


def interaction_summary(record: Mapping[str, object]) -> dict[str, object]:
    request = cast(Mapping[str, object], record["request"])
    response = cast(Mapping[str, object], record["response"])
    endpoint = display_endpoint(request["path"])
    kind = endpoint_kind(endpoint)
    request_body = cast(Mapping[str, object], request.get("upstream_body", request["body"]))
    response_body = cast(Mapping[str, object], response["body"])
    return {
        "endpoint": endpoint,
        "message_count": request_message_count(kind, body_json_value(request_body)),
        "token_count": response_token_count(body_json_value(response_body)),
    }


def render_interaction_markdown(record: Mapping[str, object]) -> str:
    request = cast(Mapping[str, object], record["request"])
    response = cast(Mapping[str, object], record["response"])
    target = cast(Mapping[str, object], record["target"])
    client = cast(Mapping[str, object], record["client"])
    error = record.get("error")
    duration_ms = float(cast(str | int | float, record["duration_ms"]))
    summary = interaction_summary(record)
    parts = [
        f"# LLM Interaction {record['id']}",
        "",
        "## Summary",
        "",
        f"- Time: {record['timestamp']}",
        f"- Event: {record.get('event', 'interaction')}",
        f"- Duration: {format_duration_hms(duration_ms)} ({record['duration_ms']} ms)",
        f"- Client: {client['host']}:{client['port']}",
        f"- Target: {target['scheme']}://{target['host']}:{target['port']}{target['path']}",
        f"- Request: {request['method']} {request['path']}",
        f"- Endpoint: {summary['endpoint']}",
        f"- Message count: {summary['message_count']}",
        f"- Token count: {summary['token_count']}",
        f"- Response: {response['status']}",
    ]
    if error:
        parts.append(f"- Error: {error}")
    stripped_fields = request.get("stripped_fields") if isinstance(request, dict) else None
    if stripped_fields:
        parts.append(f"- Stripped request fields: {', '.join(str(field) for field in stripped_fields)}")
    injected_fields = request.get("injected_fields") if isinstance(request, dict) else None
    if injected_fields:
        parts.append(f"- Injected request fields: {', '.join(str(field) for field in injected_fields)}")
    added_headers = request.get("added_upstream_headers") if isinstance(request, dict) else None
    if added_headers:
        parts.append(f"- Added upstream headers: {', '.join(str(field) for field in added_headers)}")
    task = record.get("task")
    if isinstance(task, dict):
        parts.append(f"- Task: {task.get('kind')} / {task.get('id')} / request {task.get('request_sequence')}")
    parts.extend(
        [
            "",
            "## Request Headers",
            "",
            "```text",
            render_headers(cast(Mapping[str, list[str]], request["headers"])),
            "```",
            "",
            "## Request Body",
            "",
            "See `request.json`.",
        ]
    )
    parts.extend(
        [
            "",
            "## Response Headers",
            "",
            "```text",
            render_headers(cast(Mapping[str, list[str]], response["headers"])),
            "```",
            "",
            "## Response Body",
            "",
            "See `response.json`.",
            "",
        ]
    )
    return "\n".join(parts)


def write_task_index_markdown(task_path: Path, task: Mapping[str, object]) -> None:
    task_path.mkdir(parents=True, exist_ok=True)
    requests = task.get("requests")
    request_items = list(requests.items()) if isinstance(requests, dict) else []
    request_items.sort(key=lambda item: item[1].get("sequence", 0) if isinstance(item[1], dict) else 0)
    parts = [
        f"# LLM Task {task.get('id')}",
        "",
        "## Summary",
        "",
        f"- Kind: {task.get('kind')}",
        f"- Started: {task.get('started_at')}",
        f"- Last seen: {task.get('last_seen_at')}",
        f"- Requests: {task.get('request_count', len(request_items))}",
    ]
    if task.get("model"):
        parts.append(f"- Model: {task.get('model')}")
    if task.get("target"):
        parts.append(f"- Target: {task.get('target')}")
    parts.extend(["", "## Timeline", ""])
    for request_id, info in request_items:
        if not isinstance(info, dict):
            continue
        status = info.get("status")
        status_text = "pending" if status is None else str(status)
        method = info.get("method", "")
        path = info.get("path", "")
        duration = info.get("duration_ms", 0)
        dir_name = info.get("dir_name")
        parts.append(
            f"- {int(info.get('sequence', 0)):03d} `{method} {path}` -> {status_text} "
            f"({duration} ms) [{request_id}]({dir_name}/)"
        )
    parts.append("")
    atomic_write_text(task_path / "index.md", "\n".join(parts))
