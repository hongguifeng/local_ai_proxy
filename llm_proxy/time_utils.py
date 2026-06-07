"""时间格式化工具。

日志中需要两种时间格式：
1. JSONL 机器日志使用 ISO 时间，便于程序解析。
2. Markdown 目录和文件名使用较短的本地时间，便于人工浏览。
"""

from __future__ import annotations

import datetime as dt
from typing import Mapping

def utc_now_iso() -> str:
    """返回当前 UTC 时间，格式适合写入 JSON 日志。"""
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def local_now_for_filename() -> str:
    """返回当前本地时间，格式适合放进文件名。"""
    return dt.datetime.now().astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_datetime_for_filename(timestamp: object) -> str:
    """把 ISO 时间转成本地日期+时间文件名片段。"""
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_time_from_timestamp_for_filename(timestamp: object) -> str:
    """把 ISO 时间转成本地“时分秒毫秒”文件名片段。"""
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%H-%M-%S.%f")[:-3]


def readable_start_timestamp(record: Mapping[str, object]) -> object:
    """取一条记录的开始时间。

    代理会先写一条“收到请求”的记录，再写一条“请求结束”的记录。
    结束记录的 timestamp 是结束时间，所以 readable 日志要优先使用 started_timestamp。
    """
    return record.get("started_timestamp", record["timestamp"])


def local_time_for_filename() -> str:
    """返回当前本地时间片段，例如 14-13-07.132。"""
    return dt.datetime.now().astimezone().strftime("%H-%M-%S.%f")[:-3]


def format_duration_hms(ms: float) -> str:
    """把毫秒耗时格式化成 00:00:00 这种易读形式。"""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"00:{minutes:02d}:{seconds:02d}"

