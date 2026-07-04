from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from .log_roots import readable_roots
from .manager import ProxyManager
from .payloads import body_json_value
from .records import display_endpoint
from .task_index import TaskIndexStore


class LogStore:
    """Read and cache human-readable traffic logs for the admin UI."""

    # Language-neutral sentinel; frontend translates via i18n lookup
    UNGROUPED_TITLE = "__UNGROUPED__"

    def __init__(self, manager: ProxyManager) -> None:
        self.manager = manager
        self.cache_lock = threading.Lock()
        self.cache_signature: tuple[tuple[str, int, int], ...] | None = None
        self.cache: dict[str, Any] = {"groups": [], "ungrouped": [], "by_id": {}}
        self.record_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}

    def list_log_group_summary_page(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        return self._list_log_group_summary_page(query, limit, offset)

    def list_log_group_logs(self, group_id: str, query: str) -> dict[str, Any] | None:
        terms = query.lower().split()
        if group_id == "ungrouped":
            logs = self._load_ungrouped_log_items(terms)
            return {"id": "ungrouped", "logs": logs[:200]}

        for root in self._readable_roots():
            tasks_root = root.parent / "tasks"
            if not tasks_root.exists():
                continue
            task_dir = self._task_dir_for_group_id(root, group_id)
            task_path = tasks_root / task_dir
            if not task_path.is_dir() or task_path.name.startswith("."):
                continue
            task_meta = self._load_task_meta_map(root).get(task_path.name) or {}
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
        ungrouped_count = 0
        ungrouped_sort_key = ""
        for root in self._readable_roots():
            if not root.exists():
                continue
            task_record_ids = self._indexed_task_record_ids(root)
            for task_meta in self._load_task_meta_map(root).values():
                group = self._task_group_summary(task_meta)
                if int(group.get("_request_count") or 0) > 0 and self._group_matches_terms(group, terms):
                    groups.append(group)

            for path in self._iter_dirs(root):
                if path.name == "tasks":
                    continue
                record_id = self._record_id_from_dir(path)
                if record_id in task_record_ids:
                    continue
                if not self._ungrouped_dir_matches_terms(path, terms):
                    continue
                ungrouped_count += 1
                _, sort_key = self._timestamp_from_record_dir(path)
                ungrouped_sort_key = max(ungrouped_sort_key, sort_key or "")

        if ungrouped_count:
            groups.append(
                {
                    "id": "ungrouped",
                    "title": self.UNGROUPED_TITLE,
                    "meta": f"{ungrouped_count} requests",
                    "_sort_key": ungrouped_sort_key,
                    "_request_count": ungrouped_count,
                }
            )

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

    def _task_dir_for_group_id(self, root: Path, group_id: str) -> str:
        for task in self._load_task_meta_map(root).values():
            if task.get("id") == group_id and task.get("dir_name"):
                return str(task["dir_name"])
        return group_id

    def _indexed_task_record_ids(self, root: Path) -> set[str]:
        index_path = root.parent / ".task-index.json"
        data = TaskIndexStore(index_path).load()
        request_to_task = data.get("request_to_task")
        if isinstance(request_to_task, dict):
            return {str(request_id) for request_id in request_to_task}
        return set()

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

    def _ungrouped_dir_matches_terms(self, path: Path, terms: list[str]) -> bool:
        if not terms:
            return True
        haystack = " ".join([self.UNGROUPED_TITLE, path.name]).lower()
        return all(term in haystack for term in terms)

    def _record_id_from_dir(self, path: Path) -> str:
        parts = path.name.split("__")
        return parts[-1] if parts else ""

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

    def _load_ungrouped_log_items(self, terms: list[str]) -> list[dict[str, Any]]:
        logs: list[dict[str, Any]] = []
        for root in self._readable_roots():
            if not root.exists():
                continue
            task_record_ids = self._indexed_task_record_ids(root)
            for path in self._iter_dirs(root):
                if path.name == "tasks":
                    continue
                record = self._read_readable_record(path, include_body=False)
                if not record:
                    continue
                record_id = str(record.get("id"))
                if record_id in task_record_ids:
                    continue
                item = self._log_item(record)
                if self._log_item_matches_terms(item, {"id": "ungrouped", "title": self.UNGROUPED_TITLE}, terms):
                    logs.append(item)
        logs.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        return logs

    def find_log(self, record_id: str) -> dict[str, Any] | None:
        snapshot = self._snapshot()
        found = snapshot.get("by_id", {}).get(record_id)
        if isinstance(found, dict) and isinstance(found.get("path"), Path):
            record = self._read_readable_record(found["path"], include_body=True)
            if record and found.get("task_dir"):
                record["_task_dir"] = found["task_dir"]
            if record:
                return record

        for root in self._readable_roots():
            tasks_root = root.parent / "tasks"
            if not tasks_root.exists():
                continue
            for task_path in tasks_root.iterdir():
                if not task_path.is_dir() or task_path.name.startswith("."):
                    continue
                for request_path in task_path.iterdir():
                    if not request_path.is_dir() or request_path.name.startswith("."):
                        continue
                    record = self._read_readable_record(request_path)
                    if record and str(record.get("id")) == record_id:
                        record["_task_dir"] = task_path.name
                        return record

        for record in self._iter_finished_records():
            if str(record.get("id")) == record_id:
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
        return {"id": record.get("id"), "request": request, "response": response, "record": record}

    def clear_cache(self) -> None:
        with self.cache_lock:
            self.cache_signature = None
            self.cache = {"groups": [], "ungrouped": [], "by_id": {}}
            self.record_cache.clear()

    def _readable_roots(self) -> list[Path]:
        return readable_roots(self.manager)

    def _iter_finished_records(self) -> list[dict[str, Any]]:
        records = []
        for root in self._readable_roots():
            if not root.exists():
                continue
            for path in self._iter_dirs(root):
                if path.name == "tasks":
                    continue
                record = self._read_readable_record(path)
                if record:
                    records.append(record)
        return records

    def _signature(self) -> tuple[tuple[str, int, int], ...]:
        signature: list[tuple[str, int, int]] = []
        for root in self._readable_roots():
            if not root.exists():
                signature.append((str(root), 0, 0))
                continue
            candidates = [root, root.parent / "tasks"]
            try:
                candidates.extend(path for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))
            except OSError:
                pass
            tasks_root = root.parent / "tasks"
            index_path = root.parent / ".task-index.json"
            if index_path.exists():
                candidates.append(index_path)
            if tasks_root.exists():
                try:
                    for task_path in tasks_root.iterdir():
                        if not task_path.is_dir() or task_path.name.startswith("."):
                            continue
                        candidates.append(task_path)
                        candidates.extend(path for path in task_path.iterdir() if path.is_dir() and not path.name.startswith("."))
                except OSError:
                    pass
            for path in candidates:
                try:
                    stat = path.stat()
                except OSError:
                    continue
                signature.append((str(path), stat.st_mtime_ns, stat.st_size))
                if path.is_dir():
                    try:
                        newest_markdown = max(path.glob("*.md"), key=lambda item: item.stat().st_mtime_ns, default=None)
                    except OSError:
                        newest_markdown = None
                    if newest_markdown is not None:
                        try:
                            md_stat = newest_markdown.stat()
                        except OSError:
                            continue
                        signature.append((str(newest_markdown), md_stat.st_mtime_ns, md_stat.st_size))
        return tuple(sorted(signature))

    def _snapshot(self) -> dict[str, Any]:
        signature = self._signature()
        with self.cache_lock:
            if signature == self.cache_signature:
                return self.cache
            snapshot = self._build_snapshot()
            self.cache_signature = signature
            self.cache = snapshot
            return snapshot

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

    def _build_snapshot(self) -> dict[str, Any]:
        groups: list[dict[str, Any]] = []
        ungrouped_records: list[dict[str, Any]] = []
        task_record_ids: set[str] = set()
        by_id: dict[str, dict[str, Any]] = {}

        for root in self._readable_roots():
            if not root.exists():
                continue
            tasks_root = root.parent / "tasks"
            task_meta_map = self._load_task_meta_map(root) if tasks_root.exists() else {}
            if tasks_root.exists():
                for task_path in self._iter_dirs(tasks_root):
                    logs: list[dict[str, Any]] = []
                    for request_path in self._iter_dirs(task_path):
                        record = self._read_readable_record(request_path, include_body=False)
                        if not record:
                            continue
                        record["_task_dir"] = task_path.name
                        item = self._log_item(record)
                        logs.append(item)
                        record_id = str(item.get("id"))
                        task_record_ids.add(record_id)
                        by_id[record_id] = {"path": request_path, "task_dir": task_path.name}
                    if not logs:
                        continue
                    logs.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
                    task_meta = task_meta_map.get(task_path.name) or {}
                    group_id = str(task_meta.get("id") or task_path.name)
                    groups.append(
                        {
                            "id": group_id,
                            "dir": task_path.name,
                            "title": self._task_group_title(task_path.name),
                            "meta": f"{len(logs)} requests",
                            "endpoint": self._group_endpoint(logs),
                            "logs": logs,
                        }
                    )
            for path in self._iter_dirs(root):
                if path.name == "tasks":
                    continue
                record = self._read_readable_record(path, include_body=False)
                if not record:
                    continue
                record_id = str(record.get("id"))
                by_id.setdefault(record_id, {"path": path, "task_dir": None})
                if record_id not in task_record_ids:
                    ungrouped_records.append(record)

        groups.sort(
            key=lambda group: max(
                (
                    str(item.get("_sort_key") or item.get("timestamp") or "")
                    for item in group.get("logs", [])
                    if isinstance(item, dict)
                ),
                default="",
            ),
            reverse=True,
        )
        ungrouped = [self._log_item(record) for record in ungrouped_records]
        ungrouped.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        return {"groups": groups, "ungrouped": ungrouped, "by_id": by_id}

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

    def _record_dir_sequence(self, path: Path) -> str:
        if path.parent.parent.name != "tasks":
            return ""
        sequence, _, _ = path.name.partition("__")
        return sequence if sequence.isdigit() else ""

    def _timestamp_from_record_dir(self, path: Path) -> tuple[str | None, str | None]:
        parts = path.name.split("__")
        date_part: str | None = None
        time_part: str | None = None
        if path.parent.parent.name == "tasks":
            task_parts = path.parent.name.split("__")
            if task_parts:
                date_part = task_parts[0]
            if len(parts) >= 2:
                time_part = parts[1]
        elif len(parts) >= 2:
            date_part = parts[0]
            time_part = parts[1]
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
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

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

    def _group_endpoint(self, logs: list[dict[str, Any]]) -> str:
        endpoints = {
            str(item.get("endpoint") or "")
            for item in logs
            if item.get("endpoint")
        }
        if len(endpoints) == 1:
            return next(iter(endpoints))
        if len(endpoints) > 1:
            return "mixed"
        return ""

    def _group_target(self, logs: list[dict[str, Any]]) -> str:
        targets = {
            str(item.get("target") or "")
            for item in logs
            if item.get("target")
        }
        if len(targets) == 1:
            return next(iter(targets))
        if len(targets) > 1:
            return "mixed"
        return ""

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
