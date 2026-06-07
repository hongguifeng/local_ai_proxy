"""HTTP 头处理工具。"""

from __future__ import annotations

from typing import Iterable

def headers_to_dict(headers: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    """把 HTTP 头列表转成字典。

    同一个 HTTP 头名可能出现多次，所以值用 list 保存，而不是简单字符串。
    """
    result: dict[str, list[str]] = {}
    for key, value in headers:
        result.setdefault(key, []).append(value)
    return result


def parse_header_overrides(raw_headers: list[str] | None) -> list[tuple[str, str]]:
    """解析命令行传入的 --target-header 参数。

    用户可以多次传入类似 ``--target-header "Authorization: Bearer xxx"``。
    这里会检查格式，并转成后续转发请求时可以直接使用的元组列表。
    """
    parsed: list[tuple[str, str]] = []
    for raw in raw_headers or []:
        if ":" not in raw:
            raise ValueError(f"Invalid header override {raw!r}. Expected 'Name: value'.")
        key, value = raw.split(":", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Invalid header override {raw!r}. Header name is empty.")
        parsed.append((key, value.strip()))
    return parsed

