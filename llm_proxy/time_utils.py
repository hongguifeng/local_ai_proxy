"""Time formatting utilities.

Two time formats are needed in logs:
1. Local ISO time for database logs, easy for programs to parse.
2. Shorter local time for Markdown directories and filenames, easy for humans to browse.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping


def local_now_iso() -> str:
    """Return the current local time, formatted for machine logs."""
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def local_datetime_from_timestamp(timestamp: object) -> dt.datetime:
    """Parse an ISO timestamp and convert it to the local timezone."""
    return dt.datetime.fromisoformat(str(timestamp)).astimezone()


def format_local_timestamp(timestamp: object, fmt: str) -> str:
    """Format an ISO timestamp in the local timezone."""
    return local_datetime_from_timestamp(timestamp).strftime(fmt)


def local_now_for_filename() -> str:
    """Return the current local time, formatted for filenames."""
    return dt.datetime.now().astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_datetime_for_filename(timestamp: object) -> str:
    """Convert an ISO timestamp to a local date+time filename segment."""
    return format_local_timestamp(timestamp, "%m-%d__%H-%M-%S.%f")[:-3]


def local_time_from_timestamp_for_filename(timestamp: object) -> str:
    """Convert an ISO timestamp to a local 'HH-MM-SS.mmm' filename segment."""
    return format_local_timestamp(timestamp, "%H-%M-%S.%f")[:-3]


def log_start_timestamp(record: Mapping[str, object]) -> object:
    """Get the start time of a record.

    The proxy first writes a 'request received' record, then a 'request ended' record.
    The ended record's timestamp is the end time, so stored logs should prefer started_timestamp.
    """
    return record.get("started_timestamp", record["timestamp"])


def local_time_for_filename() -> str:
    """Return the current local time segment, e.g. 14-13-07.132."""
    return dt.datetime.now().astimezone().strftime("%H-%M-%S.%f")[:-3]


def format_duration_hms(ms: float) -> str:
    """Format millisecond duration into a human-facing HH:MM:SS form."""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"00:{minutes:02d}:{seconds:02d}"
