"""Shared log root discovery."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from .config import log_root_from_setting

if TYPE_CHECKING:
    from .manager import ProxyManager


def log_roots(manager: ProxyManager) -> list[Path]:
    paths: list[Path] = []

    def add_log_root(raw_path: object) -> None:
        if not raw_path:
            return
        log_root = log_root_from_setting(str(raw_path))
        if log_root:
            paths.append(log_root)

    for pair in manager.list_pairs():
        targets = pair.get("targets")
        if isinstance(targets, list):
            for target in targets:
                if isinstance(target, dict):
                    add_log_root(target.get("log_root"))
    if not paths:
        add_log_root(manager.log_root)
    return list(dict.fromkeys(paths))
