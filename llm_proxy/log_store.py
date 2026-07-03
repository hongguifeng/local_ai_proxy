from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from .manager import ProxyManager, readable_dir_from_log_root
from .payloads import body_json_value


class LogStore:
    """Read and cache human-readable traffic logs for the admin UI."""

    def __init__(self, manager: ProxyManager) -> None:
        self.manager = manager
        self.cache_lock = threading.Lock()
        self.cache_signature: tuple[tuple[str, int, int], ...] | None = None
        self.cache: dict[str, Any] = {"groups": [], "ungrouped": [], "by_id": {}}
        self.record_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}

    def list_logs(self, query: str) -> list[dict[str, Any]]:
        terms = query.lower().split()
        snapshot = self._snapshot()
        items = [
            item
            for item in snapshot.get("ungrouped", [])
            if self._log_item_matches_terms(item, {"id": "ungrouped", "title": "未归组"}, terms)
        ]
        items.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        return items[:500]

    def list_log_groups(self, query: str, limit: int | None = None, offset: int = 0) -> list[dict[str, Any]]:
        if limit is not None:
            return self._list_log_groups_page(query, limit, offset)["groups"]
        return self._list_log_groups_all(query)

    def list_log_page(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        return self._list_log_groups_page(query, limit, offset)

    def _list_log_groups_all(self, query: str) -> list[dict[str, Any]]:
        terms = query.lower().split()
        snapshot = self._snapshot()
        task_meta_by_dir: dict[str, dict[str, Any]] = {}
        for root in self._readable_roots():
            if root.exists():
                task_meta_by_dir.update(self._load_task_meta_map(root))

        groups = []
        for group in snapshot.get("groups", []):
            filtered_logs = [
                item
                for item in group["logs"]
                if self._log_item_matches_terms(item, group, terms)
            ]
            if not filtered_logs:
                continue

            visible_group = {key: value for key, value in group.items() if not key.startswith("_")}
            visible_group["logs"] = filtered_logs[:200]
            meta_parts = [f"{len(filtered_logs)} requests"]
            task_meta = task_meta_by_dir.get(str(group.get("dir") or group.get("id") or "")) or {}
            model = task_meta.get("model")
            if isinstance(model, str) and model.strip():
                meta_parts.insert(0, model.rsplit("/", 1)[-1].rsplit(chr(92), 1)[-1])
            visible_group["meta"] = " | ".join(meta_parts)
            groups.append(visible_group)

        ungrouped = [
            item
            for item in snapshot.get("ungrouped", [])
            if self._log_item_matches_terms(item, {"id": "ungrouped", "title": "未归组"}, terms)
        ]
        ungrouped.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        if ungrouped:
            groups.append({"id": "ungrouped", "title": "未归组", "meta": f"{len(ungrouped)} requests", "logs": ungrouped[:200]})
        return groups[:100]

    def _list_log_groups_page(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        limit = max(1, min(limit, 500))
        offset = max(0, offset)
        all_groups = self._list_log_groups_all(query)
        total = len(all_groups)
        paged_groups = all_groups[offset : offset + limit]
        next_offset = offset + len(paged_groups)
        return {
            "groups": paged_groups,
            "total": total,
            "limit": limit,
            "offset": offset,
            "next_offset": next_offset,
            "has_more": next_offset < total,
        }

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
        return {"id": record.get("id"), "request": request, "response": response, "record": record}

    def clear_cache(self) -> None:
        with self.cache_lock:
            self.cache_signature = None
            self.cache = {"groups": [], "ungrouped": [], "by_id": {}}
            self.record_cache.clear()

    def _readable_roots(self) -> list[Path]:
        paths: list[Path] = []

        def add_log_root(raw_path: object) -> None:
            if not raw_path:
                return
            readable_root = readable_dir_from_log_root(str(raw_path))
            if readable_root:
                paths.append(readable_root)

        for pair in self.manager.list_pairs():
            targets = pair.get("targets")
            if isinstance(targets, list):
                for target in targets:
                    if isinstance(target, dict):
                        add_log_root(target.get("readable_log_dir"))
        if not paths:
            add_log_root(self.manager.readable_log_dir)
        return list(dict.fromkeys(paths))

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
        if index_path.exists():
            try:
                data = json.loads(index_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            else:
                tasks = data.get("tasks", {}) or {}
                for task_id, task in tasks.items():
                    if not isinstance(task, dict):
                        continue
                    dir_name = str(task.get("dir_name") or "")
                    result[dir_name] = {
                        "id": task_id,
                        "dir_name": dir_name,
                        "model": task.get("model"),
                        "kind": task.get("kind"),
                    }

        tasks_root = root.parent / "tasks"
        if tasks_root.exists():
            for task_path in self._iter_dirs(tasks_root):
                parts = task_path.name.split("__")
                if len(parts) >= 6 and not result.get(task_path.name):
                    model_candidate = parts[3]
                    if model_candidate and "/" not in model_candidate and chr(92) not in model_candidate:
                        result[task_path.name] = {
                            "id": task_path.name,
                            "dir_name": task_path.name,
                            "model": model_candidate,
                            "kind": parts[4],
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
        groups = []
        ungrouped_records = []
        task_record_ids: set[str] = set()
        by_id: dict[str, dict[str, Any]] = {}

        for root in self._readable_roots():
            if not root.exists():
                continue
            tasks_root = root.parent / "tasks"
            task_meta_map = self._load_task_meta_map(root) if tasks_root.exists() else {}
            if tasks_root.exists():
                for task_path in self._iter_dirs(tasks_root):
                    logs = []
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
            key=lambda group: max((str(item.get("_sort_key") or item.get("timestamp") or "") for item in group["logs"]), default=""),
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
            record = copy.deepcopy(cached[1])
        else:
            record = self._read_readable_record_metadata(path, markdown_path)
            if record is None:
                return None
            self.record_cache[cache_key] = (cache_signature, copy.deepcopy(record))
        if include_body:
            record["request"]["body_json"] = self._read_json_file(path / "request.json")
            record["response"]["body_json"] = self._read_json_file(path / "response.json")
        return record

    def _read_readable_record_metadata(self, path: Path, markdown_path: Path) -> dict[str, Any] | None:
        metadata = self._markdown_metadata(markdown_path)
        request_text = str(metadata.get("Request") or "")
        request_method, _, request_path = request_text.partition(" ")
        response_status = self._parse_status(metadata.get("Response"))
        dir_timestamp, dir_sort_key = self._timestamp_from_record_dir(path)
        record: dict[str, Any] = {
            "id": metadata.get("id") or path.name,
            "timestamp": dir_timestamp or metadata.get("Time"),
            "event": metadata.get("Event"),
            "request": {
                "method": request_method,
                "path": request_path,
            },
            "response": {
                "status": response_status,
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

    def _log_item(self, record: dict[str, Any]) -> dict[str, Any]:
        request = record.get("request") if isinstance(record.get("request"), dict) else {}
        response = record.get("response") if isinstance(record.get("response"), dict) else {}
        target = record.get("target") if isinstance(record.get("target"), dict) else {}
        target_text = str(record.get("_target_text") or f"{target.get('scheme')}://{target.get('host')}:{target.get('port')}{target.get('path')}")
        return {
            "id": record.get("id"),
            "timestamp": record.get("timestamp"),
            "_sort_key": record.get("_sort_key"),
            "sequence": record.get("_dir_sequence", ""),
            "method": request.get("method", ""),
            "path": request.get("path", ""),
            "status": response.get("status"),
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
                item.get("status"),
                item.get("target"),
            ]
        )
        return all(term in haystack for term in terms)
