from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from .log_roots import readable_roots
from .manager import ProxyManager
from .payloads import body_json_value
from .records import display_endpoint
from .task_index import TaskIndexStore


class LogStore:
    """Read and cache human-readable traffic logs for the admin UI."""

    def __init__(self, manager: ProxyManager) -> None:
        self.manager = manager
        self.record_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
        self.json_cache: dict[str, tuple[tuple[int, int], object]] = {}
        self.record_path_cache: dict[str, dict[str, Any]] = {}

    def list_log_group_summary_page(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        return self._list_log_group_summary_page(query, limit, offset)

    def list_log_group_logs(self, group_id: str, query: str) -> dict[str, Any] | None:
        terms = query.lower().split()
        for root in self._readable_roots():
            tasks_root = root.parent / "tasks"
            if not tasks_root.exists():
                continue
            task_meta_by_dir = self._load_task_meta_map(root)
            task_meta = self._task_meta_for_group_id(task_meta_by_dir, group_id)
            if task_meta is None:
                continue
            task_dir = str(task_meta.get("dir_name") or "")
            task_path = tasks_root / task_dir
            if not task_path.is_dir() or task_path.name.startswith("."):
                continue
            group = self._task_group_summary(task_meta)
            logs = self._load_task_log_items(task_path, group, terms, task_meta)
            return {"id": group_id, "logs": logs[:200]}
        return None

    def _list_log_group_summary_page(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        limit = max(1, min(limit, 500))
        offset = max(0, offset)
        groups = self._list_log_group_summaries(query)
        total = len(groups)
        paged_groups = groups[offset : offset + limit]
        next_offset = offset + len(paged_groups)
        return {
            "groups": paged_groups,
            "total": total,
            "limit": limit,
            "offset": offset,
            "next_offset": next_offset,
            "has_more": next_offset < total,
        }

    def _list_log_group_summaries(self, query: str) -> list[dict[str, Any]]:
        terms = query.lower().split()
        groups: list[dict[str, Any]] = []
        for root in self._readable_roots():
            if not root.exists():
                continue
            for task_meta in self._load_task_meta_map(root).values():
                group = self._task_group_summary(task_meta)
                if int(group.get("_request_count") or 0) > 0 and self._group_matches_terms(group, terms):
                    groups.append(group)

        groups.sort(key=lambda group: str(group.get("_sort_key") or ""), reverse=True)
        return [self._group_without_logs(group) for group in groups[:100]]

    def _task_group_summary(self, task_meta: dict[str, Any]) -> dict[str, Any]:
        dir_name = str(task_meta.get("dir_name") or "")
        group_id = str(task_meta.get("id") or dir_name)
        request_count = self._task_request_count(task_meta)
        meta_parts = [f"{request_count} requests"]
        model = task_meta.get("model")
        if isinstance(model, str) and model.strip():
            meta_parts.insert(0, model.rsplit("/", 1)[-1].rsplit(chr(92), 1)[-1])
        target = task_meta.get("target")
        if isinstance(target, str) and target.strip():
            meta_parts.append(target)
        return {
            "id": group_id,
            "dir": dir_name,
            "title": self._task_group_title(dir_name),
            "meta": " | ".join(meta_parts),
            "_sort_key": self._task_group_sort_key(task_meta),
            "_request_count": request_count,
        }

    def _task_request_count(self, task_meta: dict[str, Any]) -> int:
        try:
            return max(0, int(str(task_meta.get("request_count") or 0)))
        except ValueError:
            return 0

    def _task_group_sort_key(self, task_meta: dict[str, Any]) -> str:
        for key in ("last_response_at", "last_seen_at", "started_at"):
            value = task_meta.get(key)
            if isinstance(value, str) and value:
                return value
        return str(task_meta.get("dir_name") or "")

    def _group_without_logs(self, group: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in group.items() if not key.startswith("_") and key != "logs"}

    def _task_meta_for_group_id(self, task_meta_by_dir: dict[str, dict[str, Any]], group_id: str) -> dict[str, Any] | None:
        for task in task_meta_by_dir.values():
            if task.get("id") == group_id and task.get("dir_name"):
                return task
        return None

    def _group_matches_terms(self, group: dict[str, Any], terms: list[str]) -> bool:
        if not terms:
            return True
        haystack = " ".join(
            str(value).lower()
            for value in [
                group.get("id"),
                group.get("dir"),
                group.get("title"),
                group.get("meta"),
            ]
        )
        return all(term in haystack for term in terms)

    def _load_task_log_items(
        self,
        task_path: Path,
        group: dict[str, Any],
        terms: list[str],
        task_meta: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        logs: list[dict[str, Any]] = []
        request_meta = task_meta.get("requests") if isinstance(task_meta, dict) else None
        if not isinstance(request_meta, dict):
            request_meta = {}
        for request_path in self._iter_dirs(task_path):
            record = self._read_readable_record(request_path, include_body=False)
            if not record:
                continue
            record["_task_dir"] = task_path.name
            item = self._log_item(record)
            request_id = str(item.get("id") or "")
            item["_sort_key"] = self._task_request_sort_key(request_meta.get(request_id), item)
            self._cache_record_path(request_id, request_path, task_path.name)
            if self._log_item_matches_terms(item, group, terms):
                logs.append(item)
        logs.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        return logs

    def _task_request_sort_key(self, request_info: object, item: dict[str, Any]) -> str:
        if isinstance(request_info, dict):
            timestamp = request_info.get("timestamp") or request_info.get("started_at")
            sequence = request_info.get("sequence")
            if isinstance(timestamp, str) and timestamp:
                try:
                    sequence_number = int(str(sequence))
                except ValueError:
                    sequence_number = 0
                return f"{timestamp}|{sequence_number:09d}"
        return str(item.get("_sort_key") or item.get("timestamp") or "")

    def find_log(self, record_id: str) -> dict[str, Any] | None:
        record = self._record_from_cached_path(record_id, self.record_path_cache.get(record_id))
        if record:
            return record

        for root in self._readable_roots():
            record = self._find_task_log_by_index(root, record_id)
            if record:
                return record
        return None

    def record_detail(self, record: dict[str, Any]) -> dict[str, Any]:
        request = dict(record.get("request") or {})
        response = dict(record.get("response") or {})
        if "body_json" not in request and isinstance(request.get("body"), dict):
            request["body_json"] = body_json_value(request["body"])
        if "body_json" not in response and isinstance(response.get("body"), dict):
            response["body_json"] = body_json_value(response["body"])
        request.pop("path", None)
        return {"id": record.get("id"), "request": request, "response": response}

    def clear_cache(self) -> None:
        self.record_cache.clear()
        self.json_cache.clear()
        self.record_path_cache.clear()

    def _readable_roots(self) -> list[Path]:
        return readable_roots(self.manager)

    def _load_task_meta_map(self, root: Path) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        index_path = root.parent / ".task-index.json"
        data = TaskIndexStore(index_path).load()
        tasks = data.get("tasks")
        if not isinstance(tasks, dict):
            return result
        for task_id, task in tasks.items():
            if not isinstance(task, dict):
                continue
            dir_name = str(task.get("dir_name") or "")
            result[dir_name] = {
                "id": task_id,
                "dir_name": dir_name,
                "model": task.get("model"),
                "kind": task.get("kind"),
                "target": task.get("target"),
                "request_count": task.get("request_count"),
                "started_at": task.get("started_at"),
                "last_seen_at": task.get("last_seen_at"),
                "last_response_at": task.get("last_response_at"),
                "requests": task.get("requests") if isinstance(task.get("requests"), dict) else {},
            }

        return result

    def _task_group_title(self, dir_name: str) -> str:
        parts = dir_name.split("__")
        if len(parts) < 3:
            return dir_name
        date_part, start_time, end_time = parts[:3]
        if not self._looks_like_log_date(date_part) or not self._looks_like_log_time(start_time) or not self._looks_like_log_time(end_time):
            return dir_name
        return f"{date_part} {self._display_log_time(start_time)} - {self._display_log_time(end_time)}"

    def _looks_like_log_date(self, value: str) -> bool:
        parts = value.split("-")
        return len(parts) in {2, 3} and all(part.isdigit() and len(part) in {2, 4} for part in parts)

    def _looks_like_log_time(self, value: str) -> bool:
        time_part, dot, milliseconds = value.partition(".")
        parts = time_part.split("-")
        return len(parts) == 3 and all(part.isdigit() and len(part) == 2 for part in parts) and (not dot or milliseconds.isdigit())

    def _display_log_time(self, value: str) -> str:
        return value.replace("-", ":")

    def _iter_dirs(self, root: Path) -> list[Path]:
        try:
            return [path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")]
        except OSError:
            return []

    def _read_readable_record(self, path: Path, include_body: bool = True) -> dict[str, Any] | None:
        markdown_files = sorted(path.glob("*.md"), key=lambda item: item.stat().st_mtime, reverse=True)
        if not markdown_files:
            return None
        markdown_path = markdown_files[0]
        try:
            stat = markdown_path.stat()
        except OSError:
            return None
        cache_key = str(path)
        cache_signature = (stat.st_mtime_ns, stat.st_size)
        cached = self.record_cache.get(cache_key)
        if cached and cached[0] == cache_signature:
            record: dict[str, Any] = copy.deepcopy(cached[1])
        else:
            loaded_record = self._read_readable_record_metadata(path, markdown_path)
            if loaded_record is None:
                return None
            record = loaded_record
            self.record_cache[cache_key] = (cache_signature, copy.deepcopy(record))
        if include_body:
            request = record.get("request")
            if isinstance(request, dict):
                request["body_json"] = self._read_json_file(path / "request.json")
            response = record.get("response")
            if isinstance(response, dict):
                response["body_json"] = self._read_json_file(path / "response.json")
        return record

    def _read_readable_record_metadata(self, path: Path, markdown_path: Path) -> dict[str, Any] | None:
        metadata = self._markdown_metadata(markdown_path)
        request_text = str(metadata.get("Request") or "")
        request_method, _, request_path = request_text.partition(" ")
        endpoint = str(metadata.get("Endpoint") or display_endpoint(request_path))
        response_status = self._parse_status(metadata.get("Response"))
        dir_timestamp, dir_sort_key = self._timestamp_from_record_dir(path)
        record: dict[str, Any] = {
            "id": metadata.get("id") or path.name,
            "timestamp": dir_timestamp or metadata.get("Time"),
            "event": metadata.get("Event"),
            "request": {
                "method": request_method,
                "path": request_path,
                "endpoint": endpoint,
                "message_count": self._parse_optional_int(metadata.get("Message count")),
            },
            "response": {
                "status": response_status,
                "token_count": self._parse_optional_int(metadata.get("Token count")),
            },
            "_target_text": metadata.get("Target") or "",
            "_readable_path": str(path),
            "_dir_sequence": self._record_dir_sequence(path),
            "_sort_key": dir_sort_key or dir_timestamp or metadata.get("Time") or "",
        }
        return record

    def _cache_record_path(self, record_id: str, path: Path, task_dir: str | None) -> None:
        if not record_id:
            return
        self.record_path_cache[record_id] = {"path": path, "task_dir": task_dir}

    def _record_from_cached_path(self, record_id: str, cached: object) -> dict[str, Any] | None:
        if not isinstance(cached, dict) or not isinstance(cached.get("path"), Path):
            return None
        record = self._read_readable_record(cached["path"], include_body=True)
        if not record or str(record.get("id")) != record_id:
            self.record_path_cache.pop(record_id, None)
            return None
        task_dir = cached.get("task_dir")
        if task_dir:
            record["_task_dir"] = task_dir
        return record

    def _find_task_log_by_index(self, root: Path, record_id: str) -> dict[str, Any] | None:
        data = TaskIndexStore(root.parent / ".task-index.json").load()
        request_to_task = data.get("request_to_task")
        tasks = data.get("tasks")
        if not isinstance(request_to_task, dict) or not isinstance(tasks, dict):
            return None
        task_id = request_to_task.get(record_id)
        task = tasks.get(task_id) if isinstance(task_id, str) else None
        if not isinstance(task, dict):
            return None
        task_dir = task.get("dir_name")
        requests = task.get("requests")
        request_info = requests.get(record_id) if isinstance(requests, dict) else None
        request_dir = request_info.get("dir_name") if isinstance(request_info, dict) else None
        if not isinstance(task_dir, str) or not task_dir or not isinstance(request_dir, str) or not request_dir:
            return None
        request_path = root.parent / "tasks" / task_dir / request_dir
        if not request_path.is_dir():
            return None
        record = self._read_readable_record(request_path)
        if not record or str(record.get("id")) != record_id:
            return None
        record["_task_dir"] = task_dir
        self._cache_record_path(record_id, request_path, task_dir)
        return record

    def _record_dir_sequence(self, path: Path) -> str:
        if path.parent.parent.name != "tasks":
            return ""
        sequence, _, _ = path.name.partition("__")
        return sequence if sequence.isdigit() else ""

    def _timestamp_from_record_dir(self, path: Path) -> tuple[str | None, str | None]:
        if path.parent.parent.name != "tasks":
            return None, None
        parts = path.name.split("__")
        task_parts = path.parent.name.split("__")
        date_part = task_parts[0] if task_parts else None
        time_part = parts[1] if len(parts) >= 2 else None
        if not date_part or not time_part:
            return None, None
        display_time = time_part.replace("-", ":")
        return f"{date_part} {display_time}", f"{date_part}__{time_part}"

    def _markdown_metadata(self, path: Path) -> dict[str, object]:
        metadata: dict[str, object] = {}
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return metadata
        for line in lines:
            if line.startswith("# LLM Interaction "):
                metadata["id"] = line.removeprefix("# LLM Interaction ").strip()
            if not line.startswith("- "):
                continue
            key, separator, value = line[2:].partition(": ")
            if separator:
                metadata[key] = value
        return metadata

    def _read_json_file(self, path: Path) -> object:
        try:
            stat = path.stat()
        except OSError:
            return None
        cache_key = str(path)
        cache_signature = (stat.st_mtime_ns, stat.st_size)
        cached = self.json_cache.get(cache_key)
        if cached and cached[0] == cache_signature:
            return copy.deepcopy(cached[1])
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        self.json_cache[cache_key] = (cache_signature, copy.deepcopy(value))
        return value

    def _parse_status(self, value: object) -> object:
        if value in {None, "", "None"}:
            return None
        try:
            return int(str(value))
        except ValueError:
            return value

    def _parse_optional_int(self, value: object) -> int | None:
        if value in {None, "", "None"}:
            return None
        try:
            return int(str(value))
        except ValueError:
            return None

    def _log_item(self, record: dict[str, Any]) -> dict[str, Any]:
        request_obj = record.get("request")
        request = request_obj if isinstance(request_obj, dict) else {}
        response_obj = record.get("response")
        response = response_obj if isinstance(response_obj, dict) else {}
        target_obj = record.get("target")
        target = target_obj if isinstance(target_obj, dict) else {}
        target_text = str(record.get("_target_text") or f"{target.get('scheme')}://{target.get('host')}:{target.get('port')}{target.get('path')}")
        return {
            "id": record.get("id"),
            "timestamp": record.get("timestamp"),
            "_sort_key": record.get("_sort_key"),
            "sequence": record.get("_dir_sequence", ""),
            "method": request.get("method", ""),
            "path": request.get("path", ""),
            "endpoint": request.get("endpoint") or display_endpoint(request.get("path", "")),
            "message_count": request.get("message_count"),
            "status": response.get("status"),
            "token_count": response.get("token_count"),
            "target": target_text,
        }

    def _log_item_matches_terms(self, item: dict[str, Any], group: dict[str, Any], terms: list[str]) -> bool:
        if not terms:
            return True
        haystack = " ".join(
            str(value).lower()
            for value in [
                group.get("id"),
                group.get("dir"),
                group.get("title"),
                item.get("id"),
                item.get("method"),
                item.get("path"),
                item.get("endpoint"),
                item.get("status"),
                item.get("target"),
            ]
        )
        return all(term in haystack for term in terms)
