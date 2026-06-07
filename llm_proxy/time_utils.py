"""Timestamp formatting helpers used by logs and readable filenames."""

from __future__ import annotations

import datetime as dt
from typing import Mapping

def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def local_now_for_filename() -> str:
    return dt.datetime.now().astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_datetime_for_filename(timestamp: object) -> str:
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_time_from_timestamp_for_filename(timestamp: object) -> str:
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%H-%M-%S.%f")[:-3]


def readable_start_timestamp(record: Mapping[str, object]) -> object:
    return record.get("started_timestamp", record["timestamp"])


def local_time_for_filename() -> str:
    """Return time-only string for filenames, e.g. 14-13-07.132."""
    return dt.datetime.now().astimezone().strftime("%H-%M-%S.%f")[:-3]


def format_duration_hms(ms: float) -> str:
    """Format milliseconds as hh:mm:ss."""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"00:{minutes:02d}:{seconds:02d}"


