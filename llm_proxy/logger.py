"""流量日志记录器。

本项目只写 ``logs/readable``：人类友好的 Markdown/JSON 文件，方便直接打开查看请求和响应。

另外，日志器会尝试把同一个 LLM 任务中的多次请求归到同一个 ``tasks`` 目录。
"""

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
    """线程安全的流量日志写入器。

    代理服务器是多线程的，可能同时处理多个请求，所以所有写文件操作都用同一把锁保护。
    """

    def __init__(self, path: Path, readable_dir: Path | None) -> None:
        self.path = path
        self.readable_dir = readable_dir
        self.lock = threading.Lock()
        self.readable_paths: dict[str, Path] = {}
        # .task-index.json 保存“请求 ID/响应 ID/上下文 ID -> 任务”的索引，
        # 下次写日志时可以继续把相关请求放进同一个任务目录。
        self.task_index_path = readable_dir / ".task-index.json" if readable_dir else None
        self.task_index = self._load_task_index()
        if self.readable_dir:
            self.readable_dir.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict[str, object]) -> None:
        """写一条完整 readable 日志记录。"""
        with self.lock:
            self._prepare_task(record)
            self._write_readable(record)

    def update_readable(self, record: dict[str, object]) -> None:
        """更新 readable 日志。

        请求体读完但响应还没回来时会调用它，用来让 Markdown/JSON 文件先出现。
        """
        with self.lock:
            self._prepare_task(record)
            self._write_readable(record)

    def _write_readable(self, record: dict[str, object]) -> None:
        """写入或更新一条请求对应的 readable 目录。"""
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
        # 同一个请求在“等待响应”和“请求完成”时会生成不同文件名，
        # 这里删除旧 Markdown，保持目录里只有最新状态的一份摘要。
        for existing_markdown in readable_path.glob("*.md"):
            if existing_markdown.name != readable_filename:
                existing_markdown.unlink()
        (readable_path / readable_filename).write_text(self._render_markdown(record), encoding="utf-8")
        self._write_body_json_files(readable_path, record)
        self._write_task_readable(record, readable_filename)

    def _load_task_index(self) -> dict[str, object]:
        """读取任务索引；文件不存在或损坏时返回空索引。"""
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
        """把任务索引写回磁盘。"""
        if not self.task_index_path:
            return
        self.task_index_path.write_text(json.dumps(self.task_index, ensure_ascii=False, indent=2), encoding="utf-8")

    def _prepare_task(self, record: dict[str, object]) -> None:
        """为当前记录匹配或创建一个 LLM 任务。

        只有常见的模型请求端点会进入任务归档逻辑，例如 Responses API、
        Chat Completions 和 Completions。普通接口请求只写单次交互日志。
        """
        if not self.readable_dir:
            return
        request = record.get("request")
        if not isinstance(request, dict) or request.get("body_pending"):
            # body 还没读完时无法判断 payload 内容，所以先不做任务归档。
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
            # 一个任务里可能有多次请求，sequence 用来表示它们的先后顺序。
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
                # Responses API 常用 previous_response_id 串联上下文，这是最可靠的归组线索。
                response_to_task = self.task_index.setdefault("response_to_task", {})
                if isinstance(response_to_task, dict):
                    response_to_task.setdefault(previous_response_id, task_id)
            for context_key in self._context_keys(payload):
                # 某些客户端会传 conversation_id/thread_id/session_id，也可以作为归组线索。
                context_to_task = self.task_index.setdefault("context_to_task", {})
                if isinstance(context_to_task, dict):
                    context_to_task.setdefault(context_key, task_id)

        response_to_task = self.task_index.setdefault("response_to_task", {})
        if isinstance(response_to_task, dict):
            for response_id in response_ids_from_body(response_payload):
                # 把本次响应 ID 也登记起来，下一次请求引用它时就能找到同一个任务。
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
        """查找现有任务；找不到就创建新任务。"""
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
        """按多种线索匹配已有任务。

        匹配优先级从可靠到模糊：
        1. 请求 ID 已经登记过。
        2. previous_response_id 指向已知响应。
        3. conversation/thread/session 之类上下文 ID。
        4. 最后才使用启发式相似度。
        """
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
        """在任务列表里反查请求 ID，并顺手修复 request_to_task 索引。"""
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
        """用启发式评分匹配任务。

        这个方法用于没有明确上下文 ID 的情况。它会比较 endpoint、model、
        请求内容指纹和时间距离。为了避免误归组，阈值设置得比较保守。
        """
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
                # 间隔超过 30 分钟的请求通常不应被认为是同一轮任务。
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
                # 对对话类接口来说，必须有内容指纹匹配，否则只凭模型和时间太容易误判。
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
        """创建新的任务元数据。"""
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
        """生成任务目录名里的稳定锚点。

        锚点尽量来自 previous_response_id 或请求内容指纹，实在没有再退回请求 ID。
        """
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
        """从请求 payload 中提取可能代表同一会话的上下文键。"""
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
        """生成任务目录下单次请求的子目录名。"""
        request = record["request"]  # type: ignore[index]
        started_at = record.get("started_timestamp", record.get("timestamp"))
        time_part = local_time_from_timestamp_for_filename(started_at)
        path = safe_filename_part(request["path"], "root")  # type: ignore[index]
        return f"{sequence:03d}__{time_part}__{path}__{record['id']}"

    def _task_anchor_from_dir_name(self, dir_name: str) -> str | None:
        """从旧目录名中尽量恢复锚点，用于兼容已有日志目录。"""
        parts = str(dir_name).split("__")
        if len(parts) >= 4:
            return parts[-1]
        if len(parts) >= 3:
            return parts[-1]
        return None

    def _model_name_for_dir_name(self, task: Mapping[str, object]) -> str:
        """Extract model name for directory naming.

        Takes basename if path-like; truncates to 32 UTF-8 bytes.
        Preserves dots, hyphens, underscores common in model names.
        """
        raw = task.get("model") or ""
        if not isinstance(raw, str):
            raw = str(raw)
        # path format: take basename only (handle both / and \ separators)
        name = raw.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        # byte-level truncation to 32 bytes (UTF-8)
        encoded = name.encode("utf-8")[:32]
        truncated = encoded.decode("utf-8", errors="ignore")
        # preserve dots, hyphens, underscores; only replace truly unsafe chars
        safe = "".join(
            ch if ch.isalnum() or ch in "-_.~" else "-" for ch in truncated
        ).strip("-_")
        return safe or "unknown"

    def _task_dir_name(self, task: Mapping[str, object]) -> str:
        """生成任务目录名。

        目录名包含开始时间、最后响应时间、接口类型和锚点。最后响应时间变化时，
        目录名会跟着更新，方便从文件夹名看出任务持续到什么时候。
        """
        started_at = task.get("started_at") or task.get("last_seen_at") or utc_now_iso()
        last_response_at = task.get("last_response_at") or started_at
        start_part = local_datetime_for_filename(started_at)
        end_part = local_time_from_timestamp_for_filename(last_response_at)
        model_name = self._model_name_for_dir_name(task)
        kind = safe_filename_part(task.get("kind"), "task")
        anchor = safe_filename_part(
            task.get("anchor") or self._task_anchor_from_dir_name(str(task.get("dir_name") or "")),
            "task",
        )
        return f"{start_part}__{end_part}__{model_name}__{kind}__{anchor}"

    def _sync_task_dir_name(self, task: dict[str, object]) -> None:
        """如果任务目录名需要更新，就在磁盘上重命名目录。"""
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
        """生成任务目录下的 index.md，列出该任务的请求时间线。"""
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
        """确保目标是目录；如果同名文件已存在，先删除它。"""
        if path.is_file():
            path.unlink()
        path.mkdir(parents=True, exist_ok=True)

    def _write_json_file(self, path: Path, value: object) -> None:
        """用统一格式写 JSON 文件。"""
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def _write_body_json_files(self, path: Path, record: dict[str, object]) -> None:
        """在 readable 目录里写 request.json 和 response.json。"""
        request = record["request"]  # type: ignore[assignment]
        response = record["response"]  # type: ignore[assignment]
        self._write_json_file(path / "request.json", body_json_value(request["body"]))  # type: ignore[index]
        self._write_json_file(path / "response.json", body_json_value(response["body"]))  # type: ignore[index]

    def _readable_dir_name(self, record: dict[str, object]) -> str:
        """生成单次交互的 readable 目录名。"""
        timestamp = local_datetime_for_filename(readable_start_timestamp(record))
        method = str(record["request"]["method"])  # type: ignore[index]
        path = str(record["request"]["path"])  # type: ignore[index]
        safe_path = "".join(ch if ch.isalnum() else "-" for ch in path).strip("-")
        safe_path = safe_path[:80] or "root"
        return f"{timestamp}__{method}__{safe_path}__{record['id']}"

    def _readable_filename(self, record: dict[str, object]) -> str:
        """生成 Markdown 文件名，格式是 ``开始时间__结束时间.md``。"""
        start_time = readable_start_timestamp(record)
        duration_ms = record["duration_ms"]

        start_dt = dt.datetime.fromisoformat(str(start_time))
        end_dt = start_dt + dt.timedelta(milliseconds=duration_ms)

        start_str = local_time_from_timestamp_for_filename(start_time)
        end_str = end_dt.astimezone().strftime("%H-%M-%S.%f")[:-3]

        return f"{start_str}__{end_str}.md"

    def _render_markdown(self, record: dict[str, object]) -> str:
        """把一条记录渲染成 Markdown 摘要。"""
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
        """预留接口：未来可以在 readable 根目录生成总索引。"""
        if not self.readable_dir:
            return
