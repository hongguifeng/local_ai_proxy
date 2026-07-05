from __future__ import annotations

from pathlib import Path
from typing import Any

from .log_repository import LogRepository
from .log_roots import log_roots
from .manager import ProxyManager
from .time_utils import format_local_timestamp


class LogStore:
    """Read human-facing traffic logs for the admin UI."""

    def __init__(self, manager: ProxyManager) -> None:
        self.manager = manager

    def list_log_group_summary_page(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        limit = max(1, min(limit, 500))
        offset = max(0, offset)
        roots = self._log_roots()
        if len(roots) == 1:
            with self._repository(roots[0]) as repository:
                page = repository.list_tasks(query, limit=limit, offset=offset)
                groups = [self._task_group_summary(task) for task in page["tasks"]]
                return {
                    "groups": groups,
                    "total": page["total"],
                    "limit": page["limit"],
                    "offset": page["offset"],
                    "next_offset": page["next_offset"],
                    "has_more": page["has_more"],
                }

        collected: list[dict[str, Any]] = []
        total = 0
        fetch_limit = offset + limit
        for root in roots:
            with self._repository(root) as repository:
                page = repository.list_tasks(query, limit=fetch_limit, offset=0)
                total += int(page["total"])
                collected.extend(page["tasks"])
        collected.sort(key=self._task_sort_key, reverse=True)
        page_tasks = collected[offset : offset + limit]
        next_offset = offset + len(page_tasks)
        return {
            "groups": [self._task_group_summary(task) for task in page_tasks],
            "total": total,
            "limit": limit,
            "offset": offset,
            "next_offset": next_offset,
            "has_more": next_offset < total,
        }

    def list_log_group_logs(self, group_id: str, query: str) -> dict[str, Any] | None:
        for root in self._log_roots():
            with self._repository(root) as repository:
                task = repository.get_task(group_id)
                if not task:
                    continue
                page = repository.list_task_records(group_id, query, limit=200, offset=0)
                return {"id": group_id, "logs": [self._log_item(record) for record in page["records"]]}
        return None

    def find_log(self, record_id: str) -> dict[str, Any] | None:
        for root in self._log_roots():
            with self._repository(root) as repository:
                record = repository.get_record(record_id)
                if record:
                    return record
        return None

    def record_detail(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record.get("id"),
            "request": record.get("request_body"),
            "response": record.get("response_body"),
            "request_meta": self._request_meta(record),
            "response_meta": self._response_meta(record),
        }

    def clear_cache(self) -> None:
        return

    def _log_roots(self) -> list[Path]:
        return log_roots(self.manager)

    def _repository(self, root: Path) -> LogRepository:
        return LogRepository(root)

    def _task_group_summary(self, task: dict[str, Any]) -> dict[str, Any]:
        request_count = int(task.get("request_count") or 0)
        meta_parts = [f"{request_count} requests"]
        model = task.get("model")
        if isinstance(model, str) and model.strip():
            meta_parts.insert(0, model.rsplit("/", 1)[-1].rsplit(chr(92), 1)[-1])
        target = task.get("target")
        if isinstance(target, str) and target.strip():
            meta_parts.append(target)
        return {
            "id": task.get("id"),
            "title": self._task_title(task),
            "meta": " | ".join(meta_parts),
            "model": task.get("model"),
            "target": task.get("target"),
            "request_count": request_count,
        }

    def _task_title(self, task: dict[str, Any]) -> str:
        start = self._display_timestamp(task.get("started_at"))
        end = self._display_timestamp(task.get("last_response_at") or task.get("last_seen_at"))
        if start and end and start.split(" ", 1)[0] == end.split(" ", 1)[0]:
            return f"{start} - {end.split(' ', 1)[-1]}"
        if start and end:
            return f"{start} - {end}"
        return str(task.get("id") or "")

    def _display_timestamp(self, value: object) -> str:
        if not isinstance(value, str) or not value:
            return ""
        try:
            return format_local_timestamp(value, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return value

    def _task_sort_key(self, task: dict[str, Any]) -> str:
        return str(task.get("last_response_at") or task.get("last_seen_at") or task.get("started_at") or "")

    def _log_item(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record.get("id"),
            "timestamp": self._display_timestamp(record.get("timestamp")) or record.get("timestamp"),
            "sequence": str(record.get("sequence") or ""),
            "method": record.get("method") or "",
            "path": record.get("path") or "",
            "endpoint": record.get("endpoint") or "",
            "message_count": record.get("message_count"),
            "status": record.get("status"),
            "token_count": record.get("token_count"),
            "target": record.get("target_url") or "",
        }

    def _request_meta(self, record: dict[str, Any]) -> dict[str, Any]:
        return self._compact_meta(
            {
                "id": record.get("id"),
                "sequence": record.get("sequence"),
                "timestamp": self._display_timestamp(record.get("timestamp")) or record.get("timestamp"),
                "duration_ms": record.get("duration_ms"),
                "method": record.get("method"),
                "path": record.get("path"),
                "endpoint": record.get("endpoint"),
                "target": record.get("target_url"),
                "proxy": record.get("proxy_name") or record.get("proxy_id"),
                "client": self._client_address(record),
                "message_count": record.get("message_count"),
                "model_route": record.get("model_route"),
                "stripped_fields": record.get("stripped_fields"),
                "injected_fields": record.get("injected_fields"),
                "added_upstream_headers": record.get("added_upstream_headers"),
                "headers": record.get("request_headers"),
            }
        )

    def _response_meta(self, record: dict[str, Any]) -> dict[str, Any]:
        return self._compact_meta(
            {
                "status": record.get("status"),
                "duration_ms": record.get("duration_ms"),
                "token_count": record.get("token_count"),
                "error": record.get("error"),
                "headers": record.get("response_headers"),
            }
        )

    def _client_address(self, record: dict[str, Any]) -> str:
        host = record.get("client_host")
        port = record.get("client_port")
        if not host:
            return ""
        return f"{host}:{port}" if port not in {None, ""} else str(host)

    def _compact_meta(self, values: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in values.items() if not self._empty_meta_value(value)}

    def _empty_meta_value(self, value: Any) -> bool:
        return value is None or value == "" or value == [] or value == {}
