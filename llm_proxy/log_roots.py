"""Shared readable-log root discovery."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from .config import readable_dir_from_log_root

if TYPE_CHECKING:
    from .manager import ProxyManager


def readable_roots(manager: ProxyManager) -> list[Path]:
    paths: list[Path] = []

    def add_log_root(raw_path: object) -> None:
        if not raw_path:
            return
        readable_root = readable_dir_from_log_root(str(raw_path))
        if readable_root:
            paths.append(readable_root)

    for pair in manager.list_pairs():
        targets = pair.get("targets")
        if isinstance(targets, list):
            for target in targets:
                if isinstance(target, dict):
                    add_log_root(target.get("readable_log_dir"))
    if not paths:
        add_log_root(manager.readable_log_dir)
    return list(dict.fromkeys(paths))
