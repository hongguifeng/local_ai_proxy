"""JSONL and human-readable traffic logging."""

from __future__ import annotations

import datetime as dt
import json
import threading
import uuid
from pathlib import Path
from typing import Mapping

from .payloads import body_json_value, render_headers
from .records import (
    endpoint_kind,
    first_string,
    get_nested_value,
    request_body_json,
    request_fingerprints,
    request_path,
    response_body_json,
    response_ids_from_body,
    safe_filename_part,
)
from .time_utils import (
    format_duration_hms,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    readable_start_timestamp,
    utc_now_iso,
)

class TrafficLogger:
    def __init__(self, path: Path, readable_dir: Path | None) -> None:
        self.path = path
        self.readable_dir = readable_dir
        self.lock = threading.Lock()
        self.readable_paths: dict[str, Path] = {}
        self.task_index_path = readable_dir / ".task-index.json" if readable_dir else None
        self.task_index = self._load_task_index()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.readable_dir:
            self.readable_dir.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict[str, object]) -> None:
        with self.lock:
            self._prepare_task(record)
            with self.path.open("a", encoding="utf-8") as file:
                json.dump(record, file, ensure_ascii=False, separators=(",", ":"))
                file.write("\n")
            self._write_readable(record)

    def update_readable(self, record: dict[str, object]) -> None:
        with self.lock:
            self._prepare_task(record)
            self._write_readable(record)

    def _write_readable(self, record: dict[str, object]) -> None:
        if not self.readable_dir:
            return
        record_id = str(record["id"])
        readable_path = self.readable_paths.get(record_id)
        if readable_path is None:
            readable_dir_name = self._readable_dir_name(record)
            readable_path = self.readable_dir / readable_dir_name
            self._ensure_readable_dir(readable_path)
            self.readable_paths[record_id] = readable_path
        readable_filename = self._readable_filename(record)
        for existing_markdown in readable_path.glob("*.md"):
            if existing_markdown.name != readable_filename:
                existing_markdown.unlink()
        (readable_path / readable_filename).write_text(self._render_markdown(record), encoding="utf-8")
        self._write_body_json_files(readable_path, record)
        self._write_task_readable(record, readable_filename)

    def _load_task_index(self) -> dict[str, object]:
        if not self.task_index_path or not self.task_index_path.exists():
            return {"tasks": {}, "request_to_task": {}, "response_to_task": {}, "context_to_task": {}}
        try:
            loaded = json.loads(self.task_index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"tasks": {}, "request_to_task": {}, "response_to_task": {}, "context_to_task": {}}
        if not isinstance(loaded, dict):
            return {"tasks": {}, "request_to_task": {}, "response_to_task": {}, "context_to_task": {}}
        loaded.setdefault("tasks", {})
        loaded.setdefault("request_to_task", {})
        loaded.setdefault("response_to_task", {})
        loaded.setdefault("context_to_task", {})
        return loaded

    def _save_task_index(self) -> None:
        if not self.task_index_path:
            return
        self.task_index_path.write_text(json.dumps(self.task_index, ensure_ascii=False, indent=2), encoding="utf-8")

    def _prepare_task(self, record: dict[str, object]) -> None:
        if not self.readable_dir:
            return
        request = record.get("request")
        if not isinstance(request, dict) or request.get("body_pending"):
            return
        kind = endpoint_kind(request_path(record))
        if kind not in {"responses", "chat", "completions"}:
            return

        payload = request_body_json(record)
        response_payload = response_body_json(record)
        task = self._find_or_create_task(record, kind, payload)
        if not task:
            return

        request_id = str(record["id"])
        requests = task.setdefault("requests", {})
        if not isinstance(requests, dict):
            requests = {}
            task["requests"] = requests
        request_info = requests.get(request_id)
        if not isinstance(request_info, dict):
            sequence = len(requests) + 1
            request_info = {
                "sequence": sequence,
                "dir_name": self._task_request_dir_name(record, sequence),
                "started_at": record.get("started_timestamp", record.get("timestamp")),
            }
            requests[request_id] = request_info
        request_to_task = self.task_index.setdefault("request_to_task", {})
        if isinstance(request_to_task, dict):
            request_to_task[request_id] = str(task["id"])

        response = record.get("response")
        status = response.get("status") if isinstance(response, dict) else None
        request_info["status"] = status
        request_info["event"] = record.get("event", "interaction")
        request_info["timestamp"] = record.get("timestamp")
        request_info["duration_ms"] = record.get("duration_ms")
        request_info["method"] = request.get("method")
        request_info["path"] = request.get("path")

        task["last_seen_at"] = record.get("timestamp")
        if status is not None:
            task["last_response_at"] = record.get("timestamp")
        task["request_count"] = len(requests)
        model = payload.get("model") if isinstance(payload, dict) else None
        if model:
            task["model"] = model
        self._sync_task_dir_name(task)

        task_id = str(task["id"])
        if isinstance(payload, dict):
            previous_response_id = payload.get("previous_response_id")
            if isinstance(previous_response_id, str) and previous_response_id:
                response_to_task = self.task_index.setdefault("response_to_task", {})
                if isinstance(response_to_task, dict):
                    response_to_task.setdefault(previous_response_id, task_id)
            for context_key in self._context_keys(payload):
                context_to_task = self.task_index.setdefault("context_to_task", {})
                if isinstance(context_to_task, dict):
                    context_to_task.setdefault(context_key, task_id)

        response_to_task = self.task_index.setdefault("response_to_task", {})
        if isinstance(response_to_task, dict):
            for response_id in response_ids_from_body(response_payload):
                response_to_task[response_id] = task_id

        record["task"] = {
            "id": task_id,
            "kind": task.get("kind"),
            "dir": task.get("dir_name"),
            "request_sequence": request_info.get("sequence"),
            "confidence": task.get("last_match_confidence", 1.0),
        }
        self._save_task_index()

    def _find_or_create_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, object] | None:
        tasks = self.task_index.setdefault("tasks", {})
        if not isinstance(tasks, dict):
            self.task_index["tasks"] = {}
            tasks = self.task_index["tasks"]  # type: ignore[assignment]
        if not isinstance(tasks, dict):
            return None

        matched_id = self._match_existing_task(record, kind, payload)
        if matched_id and isinstance(tasks.get(matched_id), dict):
            task = tasks[matched_id]
            task["last_match_confidence"] = 1.0 if kind == "responses" else task.get("last_match_confidence", 0.8)
            return task  # type: ignore[return-value]

        task = self._new_task(record, kind, payload)
        tasks[str(task["id"])] = task
        return task

    def _match_existing_task(self, record: Mapping[str, object], kind: str, payload: object) -> str | None:
        request_id = str(record["id"])
        request_to_task = self.task_index.get("request_to_task")
        if isinstance(request_to_task, dict):
            task_id = request_to_task.get(request_id)
            if isinstance(task_id, str):
                return task_id
        scanned_task_id = self._find_task_for_request_id(request_id)
        if scanned_task_id:
            return scanned_task_id

        if isinstance(payload, dict):
            response_to_task = self.task_index.get("response_to_task")
            previous_response_id = payload.get("previous_response_id")
            if kind == "responses" and isinstance(response_to_task, dict) and isinstance(previous_response_id, str):
                task_id = response_to_task.get(previous_response_id)
                if isinstance(task_id, str):
                    return task_id

            context_to_task = self.task_index.get("context_to_task")
            if isinstance(context_to_task, dict):
                for context_key in self._context_keys(payload):
                    task_id = context_to_task.get(context_key)
                    if isinstance(task_id, str):
                        return task_id

        return self._best_heuristic_task(record, kind, payload)

    def _find_task_for_request_id(self, request_id: str) -> str | None:
        tasks = self.task_index.get("tasks")
        if not isinstance(tasks, dict):
            return None
        for task_id, task in tasks.items():
            if not isinstance(task, dict):
                continue
            requests = task.get("requests")
            if isinstance(requests, dict) and request_id in requests:
                request_to_task = self.task_index.setdefault("request_to_task", {})
                if isinstance(request_to_task, dict):
                    request_to_task[request_id] = str(task_id)
                return str(task_id)
        return None

    def _best_heuristic_task(self, record: Mapping[str, object], kind: str, payload: object) -> str | None:
        if not isinstance(payload, dict):
            return None
        tasks = self.task_index.get("tasks")
        if not isinstance(tasks, dict):
            return None
        path = request_path(record)
        model = payload.get("model")
        fingerprints = request_fingerprints(kind, payload)
        now = dt.datetime.fromisoformat(str(record.get("timestamp", utc_now_iso())))
        best_id: str | None = None
        best_score = 0

        for task_id, task in tasks.items():
            if not isinstance(task, dict) or task.get("kind") != kind:
                continue
            last_seen_raw = task.get("last_seen_at", task.get("started_at"))
            try:
                last_seen = dt.datetime.fromisoformat(str(last_seen_raw))
            except ValueError:
                continue
            age_seconds = abs((now - last_seen).total_seconds())
            if age_seconds > 30 * 60:
                continue

            score = 0
            content_match = False
            if task.get("endpoint") == path:
                score += 20
            if model and task.get("model") == model:
                score += 30
            task_fingerprints = task.get("fingerprints")
            if isinstance(task_fingerprints, dict):
                for key, value in fingerprints.items():
                    if task_fingerprints.get(key) == value:
                        if key in {"messages_prefix", "first_user", "prompt", "input_prefix"}:
                            content_match = True
                            score += 50
                        else:
                            score += 35
            if age_seconds <= 2 * 60:
                score += 30
            elif age_seconds <= 10 * 60:
                score += 15

            if kind in {"chat", "responses"} and not content_match:
                continue
            if score > best_score:
                best_score = score
                best_id = str(task_id)

        threshold = 80 if kind == "chat" else 100 if kind == "responses" else 90
        if best_id and best_score >= threshold:
            task = tasks.get(best_id)
            if isinstance(task, dict):
                task["last_match_confidence"] = round(min(best_score / 120, 0.99), 2)
            return best_id
        return None

    def _new_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, object]:
        task_id = uuid.uuid4().hex
        anchor = self._task_anchor(record, kind, payload)
        task = {
            "id": task_id,
            "kind": kind,
            "anchor": anchor,
            "started_at": record.get("started_timestamp", record.get("timestamp")),
            "last_seen_at": record.get("timestamp"),
            "endpoint": request_path(record),
            "fingerprints": request_fingerprints(kind, payload),
            "requests": {},
            "request_count": 0,
            "last_match_confidence": 1.0,
        }
        task["dir_name"] = self._task_dir_name(task)
        if isinstance(payload, dict) and payload.get("model"):
            task["model"] = payload.get("model")
        return task

    def _task_anchor(self, record: Mapping[str, object], kind: str, payload: object) -> str:
        if kind == "responses" and isinstance(payload, dict):
            previous_response_id = payload.get("previous_response_id")
            if isinstance(previous_response_id, str) and previous_response_id:
                return f"prev-{safe_filename_part(previous_response_id, limit=32)}"
        fingerprints = request_fingerprints(kind, payload)
        if fingerprints:
            first_key = sorted(fingerprints)[0]
            return f"fp-{fingerprints[first_key]}"
        return f"req-{str(record['id'])[:12]}"

    def _context_keys(self, payload: Mapping[str, object]) -> list[str]:
        keys: list[str] = []
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
            keys.append(f"conversation:{conversation_id}")
        return keys

    def _task_request_dir_name(self, record: Mapping[str, object], sequence: int) -> str:
        request = record["request"]  # type: ignore[index]
        started_at = record.get("started_timestamp", record.get("timestamp"))
        time_part = local_time_from_timestamp_for_filename(started_at)
        path = safe_filename_part(request["path"], "root")  # type: ignore[index]
        return f"{sequence:03d}__{time_part}__{path}__{record['id']}"

    def _task_anchor_from_dir_name(self, dir_name: str) -> str | None:
        parts = str(dir_name).split("__")
        if len(parts) >= 4:
            return parts[-1]
        if len(parts) >= 3:
            return parts[-1]
        return None

    def _task_dir_name(self, task: Mapping[str, object]) -> str:
        started_at = task.get("started_at") or task.get("last_seen_at") or utc_now_iso()
        last_response_at = task.get("last_response_at") or started_at
        start_part = local_datetime_for_filename(started_at)
        end_part = local_time_from_timestamp_for_filename(last_response_at)
        kind = safe_filename_part(task.get("kind"), "task")
        anchor = safe_filename_part(
            task.get("anchor") or self._task_anchor_from_dir_name(str(task.get("dir_name") or "")),
            "task",
        )
        return f"{start_part}__{end_part}__{kind}__{anchor}"

    def _sync_task_dir_name(self, task: dict[str, object]) -> None:
        new_dir_name = self._task_dir_name(task)
        old_dir_name = str(task.get("dir_name") or "")
        if new_dir_name == old_dir_name:
            return
        if self.readable_dir and old_dir_name:
            old_task_path = self.readable_dir / "tasks" / old_dir_name
            new_task_path = self.readable_dir / "tasks" / new_dir_name
            if old_task_path.exists() and not new_task_path.exists():
                old_task_path.rename(new_task_path)
        task["dir_name"] = new_dir_name

    def _write_task_readable(self, record: Mapping[str, object], readable_filename: str) -> None:
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

        task_path = self.readable_dir / "tasks" / str(task_dir_name)
        request_path_in_task = task_path / str(request_info["dir_name"])
        self._ensure_readable_dir(request_path_in_task)
        for existing_markdown in request_path_in_task.glob("*.md"):
            if existing_markdown.name != readable_filename:
                existing_markdown.unlink()
        (request_path_in_task / readable_filename).write_text(self._render_markdown(record), encoding="utf-8")
        self._write_body_json_files(request_path_in_task, dict(record))
        self._write_task_index_markdown(task_path, task)

    def _write_task_index_markdown(self, task_path: Path, task: Mapping[str, object]) -> None:
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
        (task_path / "index.md").write_text("\n".join(parts), encoding="utf-8")

    def _ensure_readable_dir(self, path: Path) -> None:
        if path.is_file():
            path.unlink()
        path.mkdir(parents=True, exist_ok=True)

    def _write_json_file(self, path: Path, value: object) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def _write_body_json_files(self, path: Path, record: dict[str, object]) -> None:
        request = record["request"]  # type: ignore[assignment]
        response = record["response"]  # type: ignore[assignment]
        self._write_json_file(path / "request.json", body_json_value(request["body"]))  # type: ignore[index]
        self._write_json_file(path / "response.json", body_json_value(response["body"]))  # type: ignore[index]

    def _readable_dir_name(self, record: dict[str, object]) -> str:
        """Return directory name with __ separators, original format."""
        timestamp = local_datetime_for_filename(readable_start_timestamp(record))
        method = str(record["request"]["method"])  # type: ignore[index]
        path = str(record["request"]["path"])  # type: ignore[index]
        safe_path = "".join(ch if ch.isalnum() else "-" for ch in path).strip("-")
        safe_path = safe_path[:80] or "root"
        return f"{timestamp}__{method}__{safe_path}__{record['id']}"

    def _readable_filename(self, record: dict[str, object]) -> str:
        """Return MD filename with only time: {start_time}__{end_time}.md."""
        start_time = readable_start_timestamp(record)
        duration_ms = record["duration_ms"]

        start_dt = dt.datetime.fromisoformat(str(start_time))
        end_dt = start_dt + dt.timedelta(milliseconds=duration_ms)

        start_str = local_time_from_timestamp_for_filename(start_time)
        end_str = end_dt.astimezone().strftime("%H-%M-%S.%f")[:-3]

        return f"{start_str}__{end_str}.md"

    def _render_markdown(self, record: dict[str, object]) -> str:
        request = record["request"]  # type: ignore[assignment]
        response = record["response"]  # type: ignore[assignment]
        target = record["target"]  # type: ignore[assignment]
        client = record["client"]  # type: ignore[assignment]
        error = record.get("error")
        parts = [
            f"# LLM Interaction {record['id']}",
            "",
            "## Summary",
            "",
            f"- Time: {record['timestamp']}",
            f"- Event: {record.get('event', 'interaction')}",
            f"- Duration: {format_duration_hms(record['duration_ms'])} ({record['duration_ms']} ms)",
            f"- Client: {client['host']}:{client['port']}",  # type: ignore[index]
            f"- Target: {target['scheme']}://{target['host']}:{target['port']}{target['path']}",  # type: ignore[index]
            f"- Request: {request['method']} {request['path']}",  # type: ignore[index]
            f"- Response: {response['status']}",  # type: ignore[index]
        ]
        if error:
            parts.append(f"- Error: {error}")
        stripped_fields = request.get("stripped_fields") if isinstance(request, dict) else None
        if stripped_fields:
            parts.append(f"- Stripped request fields: {', '.join(str(field) for field in stripped_fields)}")
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
                render_headers(request["headers"]),  # type: ignore[index]
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
                render_headers(response["headers"]),  # type: ignore[index]
                "```",
                "",
                "## Response Body",
                "",
                "See `response.json`.",
                "",
            ]
        )
        return "\n".join(parts)

    def write_index(self, record: dict[str, object]) -> None:
        if not self.readable_dir:
            return


