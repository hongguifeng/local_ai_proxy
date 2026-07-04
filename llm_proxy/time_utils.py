"""Time formatting utilities.

Two time formats are needed in logs:
1. ISO time for JSONL machine logs, easy for programs to parse.
2. Shorter local time for Markdown directories and filenames, easy for humans to browse.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping


def utc_now_iso() -> str:
    """Return the current UTC time, formatted for JSON logs."""
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def local_now_for_filename() -> str:
    """Return the current local time, formatted for filenames."""
    return dt.datetime.now().astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_datetime_for_filename(timestamp: object) -> str:
    """Convert an ISO timestamp to a local date+time filename segment."""
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_time_from_timestamp_for_filename(timestamp: object) -> str:
    """Convert an ISO timestamp to a local 'HH-MM-SS.mmm' filename segment."""
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%H-%M-%S.%f")[:-3]


def readable_start_timestamp(record: Mapping[str, object]) -> object:
    """Get the start time of a record.

    The proxy first writes a 'request received' record, then a 'request ended' record.
    The ended record's timestamp is the end time, so readable logs should prefer started_timestamp.
    """
    return record.get("started_timestamp", record["timestamp"])


def local_time_for_filename() -> str:
    """Return the current local time segment, e.g. 14-13-07.132."""
    return dt.datetime.now().astimezone().strftime("%H-%M-%S.%f")[:-3]


def format_duration_hms(ms: float) -> str:
    """Format millisecond duration into a human-readable HH:MM:SS form."""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"00:{minutes:02d}:{seconds:02d}"

