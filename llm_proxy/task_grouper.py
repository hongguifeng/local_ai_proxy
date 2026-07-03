from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Mapping
from pathlib import Path

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
from .task_index import TASK_MATCH_STRATEGY_VERSION, TaskIndexStore
from .time_utils import (
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    utc_now_iso,
)


class TaskGrouper:
    def __init__(self, task_index: dict[str, object], task_index_store: TaskIndexStore, readable_dir: Path | None) -> None:
        self.task_index = task_index
        self.task_index_store = task_index_store
        self.readable_dir = readable_dir

    def prepare(self, record: dict[str, object]) -> None:
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
        task["fingerprints"] = request_fingerprints(kind, payload)
        task["boundary_fingerprints"] = request_boundary_fingerprints(kind, payload)
        task["last_user_messages"] = request_user_messages(kind, payload)
        self._sync_task_dir_name(task)

        task_id = str(task["id"])
        if isinstance(payload, dict):
            previous_response_id = payload.get("previous_response_id")
            if isinstance(previous_response_id, str) and previous_response_id:
                # Responses API 常用 previous_response_id 串联上下文，这是最可靠的归组线索。
                response_to_task = self.task_index.setdefault("response_to_task", {})
                if isinstance(response_to_task, dict):
                    response_to_task.setdefault(previous_response_id, task_id)
            for context_key in self._context_keys(payload, record):
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
        self.task_index_store.save(self.task_index)

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
                if isinstance(task_id, str) and self._task_matches_static_boundaries(task_id, record, kind, payload, include_user_boundary=False):
                    return task_id

            context_to_task = self.task_index.get("context_to_task")
            if isinstance(context_to_task, dict):
                for context_key in self._context_keys(payload, record):
                    task_id = context_to_task.get(context_key)
                    if isinstance(task_id, str) and self._task_matches_static_boundaries(task_id, record, kind, payload, include_user_boundary=False):
                        return task_id

        return self._best_heuristic_task(record, kind, payload)

    def _task_matches_static_boundaries(
        self,
        task_id: str,
        record: Mapping[str, object],
        kind: str,
        payload: Mapping[str, object],
        include_user_boundary: bool = True,
    ) -> bool:
        """Return False when fields that define a task identity changed."""
        tasks = self.task_index.get("tasks")
        task = tasks.get(task_id) if isinstance(tasks, dict) else None
        if not isinstance(task, dict):
            return True
        return self._task_static_boundaries_match(task, record, kind, payload, include_user_boundary=include_user_boundary)

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
        task_fingerprints = self._task_boundary_fingerprints(task, kind, include_user_boundary=include_user_boundary)
        request_fingerprints = self._request_boundary_fingerprints(kind, payload, include_user_boundary=include_user_boundary)
        return task_fingerprints == request_fingerprints

    def _request_boundary_fingerprints(
        self,
        kind: str,
        payload: Mapping[str, object],
        include_user_boundary: bool = True,
    ) -> dict[str, object]:
        fingerprints = request_boundary_fingerprints(kind, payload)
        if not include_user_boundary:
            fingerprints.pop("first_user", None)
        return fingerprints

    def _task_boundary_fingerprints(
        self,
        task: Mapping[str, object],
        kind: str,
        include_user_boundary: bool = True,
    ) -> dict[str, object]:
        boundary_fingerprints = task.get("boundary_fingerprints")
        if isinstance(boundary_fingerprints, dict):
            result = dict(boundary_fingerprints)
            result.pop("tools", None)
            if not include_user_boundary:
                result.pop("first_user", None)
            return result

        fingerprints = task.get("fingerprints")
        if not isinstance(fingerprints, dict):
            return {}
        if kind == "responses":
            boundary_keys = {"instructions", "first_user"}
        elif kind == "chat":
            boundary_keys = {"system", "first_user"}
        elif kind == "completions":
            boundary_keys = {"prompt"}
        else:
            boundary_keys = set()
        if not include_user_boundary:
            boundary_keys.discard("first_user")
        return {key: value for key, value in fingerprints.items() if key in boundary_keys}

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
        """在没有明确上下文 ID 时，用保守规则匹配任务。"""
        if not isinstance(payload, dict):
            return None
        tasks = self.task_index.get("tasks")
        if not isinstance(tasks, dict):
            return None
        now = dt.datetime.fromisoformat(str(record.get("timestamp", utc_now_iso())))
        best_id: str | None = None
        best_age_seconds: float | None = None
        current_user_messages = request_user_messages(kind, payload)

        for task_id, task in tasks.items():
            if not isinstance(task, dict):
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
                # 间隔超过 24 小时的请求通常不应被认为是同一轮任务。
                continue

            if kind in {"chat", "responses"} and not self._task_user_messages_are_contained(task, current_user_messages):
                # 对对话类接口来说，上一轮 user 序列必须仍在当前请求中，避免只凭模型和时间误判。
                continue
            if kind in {"chat", "responses"} and not self._task_has_continuation_evidence(task, kind, payload, current_user_messages):
                continue
            if best_age_seconds is None or age_seconds < best_age_seconds:
                best_age_seconds = age_seconds
                best_id = str(task_id)

        if best_id:
            task = tasks.get(best_id)
            if isinstance(task, dict):
                task["last_match_confidence"] = 0.95
            return best_id
        return None

    def _task_user_messages_are_contained(
        self,
        task: Mapping[str, object],
        current_user_messages: list[object],
    ) -> bool:
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
            "match_strategy_version": TASK_MATCH_STRATEGY_VERSION,
            "fingerprints": request_fingerprints(kind, payload),
            "boundary_fingerprints": request_boundary_fingerprints(kind, payload),
            "last_user_messages": request_user_messages(kind, payload),
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

    def _context_keys(self, payload: Mapping[str, object], record: Mapping[str, object] | None = None) -> list[str]:
        """从请求 payload 中提取可能代表同一会话的上下文键。"""
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

    def _task_request_dir_name(self, record: Mapping[str, object], sequence: int) -> str:
        """生成任务目录下单次请求的子目录名。"""
        request = record["request"]  # type: ignore[index]
        started_at = record.get("started_timestamp", record.get("timestamp"))
        time_part = local_time_from_timestamp_for_filename(started_at)
        path = safe_filename_part(request["path"], "root")  # type: ignore[index]
        return f"{sequence:03d}__{time_part}__{path}__{record['id']}"

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
        anchor = safe_filename_part(task.get("anchor"), "task")
        return f"{start_part}__{end_part}__{model_name}__{kind}__{anchor}"

    def _sync_task_dir_name(self, task: dict[str, object]) -> None:
        """如果任务目录名需要更新，就在磁盘上重命名目录。"""
        new_dir_name = self._task_dir_name(task)
        old_dir_name = str(task.get("dir_name") or "")
        if new_dir_name == old_dir_name:
            return
        if self.readable_dir and old_dir_name:
            old_task_path = self.readable_dir.parent / "tasks" / old_dir_name
            new_task_path = self.readable_dir.parent / "tasks" / new_dir_name
            if old_task_path.exists() and not new_task_path.exists():
                old_task_path.rename(new_task_path)
        task["dir_name"] = new_dir_name
