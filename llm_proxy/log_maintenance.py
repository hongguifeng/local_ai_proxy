"""Export and cleanup helpers for readable log directories."""

from __future__ import annotations

import io
import json
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any

from .log_roots import readable_roots as _readable_roots
from .manager import ProxyManager


def readable_roots(manager: ProxyManager) -> list[Path]:
    return _readable_roots(manager)


def export_logs_zip(manager: ProxyManager) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for root in readable_roots(manager):
            if not root.exists():
                continue
            base = root.parent.resolve()
            for path in root.rglob("*"):
                if not path.is_file() or path.name.startswith("."):
                    continue
                archive.write(path, path.resolve().relative_to(base).as_posix())
            tasks_root = root.parent / "tasks"
            if tasks_root.exists():
                for path in tasks_root.rglob("*"):
                    if not path.is_file() or path.name.startswith("."):
                        continue
                    archive.write(path, path.resolve().relative_to(base).as_posix())
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

    for root in readable_roots(manager):
        if root.exists():
            candidates = _interaction_dirs(root)
            deleted.extend(_delete_by_policy(root, candidates, cutoff, keep_latest))
        tasks_root = root.parent / "tasks"
        if tasks_root.exists():
            for task_path in _safe_child_dirs(tasks_root):
                candidates = _safe_child_dirs(task_path)
                deleted.extend(_delete_by_policy(task_path, candidates, cutoff, keep_latest))
                _remove_empty_dir(task_path, tasks_root)

    return {"deleted": deleted, "deleted_count": len(deleted)}


def cleanup_log_groups(manager: ProxyManager, group_ids: list[str]) -> dict[str, Any]:
    selected_ids = {str(group_id) for group_id in group_ids if str(group_id).strip()}
    deleted: list[str] = []
    if not selected_ids:
        return {"deleted": deleted, "deleted_count": 0}

    for root in readable_roots(manager):
        tasks_root = root.parent / "tasks"
        task_id_to_dir = _task_id_to_dir(root)
        selected_dirs = {
            task_id_to_dir.get(group_id, group_id)
            for group_id in selected_ids
        }
        if not tasks_root.exists():
            continue
        for task_path in _safe_child_dirs(tasks_root):
            if task_path.name not in selected_dirs:
                continue
            request_ids = _request_ids_from_task_dir(task_path)
            if _safe_rmtree(task_path, tasks_root):
                deleted.append(str(task_path))
            for readable_path in _interaction_dirs(root):
                if _record_id_from_dir(readable_path) in request_ids and _safe_rmtree(readable_path, root):
                    deleted.append(str(readable_path))

    return {"deleted": deleted, "deleted_count": len(deleted)}


def _task_id_to_dir(root: Path) -> dict[str, str]:
    index_path = root.parent / ".task-index.json"
    if not index_path.exists():
        return {}
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, dict):
        return {}
    result: dict[str, str] = {}
    for task_id, task in tasks.items():
        if isinstance(task, dict) and task.get("dir_name"):
            result[str(task_id)] = str(task["dir_name"])
    return result


def _request_ids_from_task_dir(task_path: Path) -> set[str]:
    request_ids: set[str] = set()
    for request_path in _safe_child_dirs(task_path):
        record_id = _record_id_from_dir(request_path)
        if record_id:
            request_ids.add(record_id)
    return request_ids


def _record_id_from_dir(path: Path) -> str:
    parts = path.name.split("__")
    return parts[-1] if parts else ""


def _interaction_dirs(root: Path) -> list[Path]:
    return [
        path
        for path in _safe_child_dirs(root)
        if path.name != "tasks"
    ]


def _safe_child_dirs(root: Path) -> list[Path]:
    try:
        return [path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")]
    except OSError:
        return []


def _delete_by_policy(
    root: Path,
    candidates: list[Path],
    cutoff: float | None,
    keep_latest: int | None,
) -> list[str]:
    candidates = sorted(candidates, key=_dir_mtime, reverse=True)
    to_delete: set[Path] = set()
    if cutoff is not None:
        to_delete.update(path for path in candidates if _dir_mtime(path) < cutoff)
    if keep_latest is not None:
        to_delete.update(candidates[keep_latest:])

    deleted: list[str] = []
    for path in sorted(to_delete, key=lambda item: str(item)):
        if _safe_rmtree(path, root):
            deleted.append(str(path))
    return deleted


def _dir_mtime(path: Path) -> float:
    newest = 0.0
    try:
        newest = path.stat().st_mtime
        for child in path.rglob("*"):
            try:
                newest = max(newest, child.stat().st_mtime)
            except OSError:
                pass
    except OSError:
        pass
    return newest


def _safe_rmtree(path: Path, root: Path) -> bool:
    try:
        resolved_path = path.resolve()
        resolved_root = root.resolve()
        resolved_path.relative_to(resolved_root)
    except (OSError, ValueError):
        return False
    shutil.rmtree(resolved_path)
    return True


def _remove_empty_dir(path: Path, root: Path) -> None:
    try:
        path.resolve().relative_to(root.resolve())
        path.rmdir()
    except OSError:
        return
    except ValueError:
        return
