"""Filesystem helpers for durable small-file writes."""

from __future__ import annotations

import os
import uuid
from pathlib import Path


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """Write text through a sibling temporary file, then atomically replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp_path.open("w", encoding=encoding) as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        temp_path.replace(path)
    except Exception:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        raise
