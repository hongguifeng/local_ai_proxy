"""请求体清理工具。

代理在记录原始请求后，可以先移除一些顶层 JSON 字段，再把请求发给上游。
这样既保留了客户端真实传来的内容，也能控制实际发给模型服务的参数。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


def parse_strip_request_fields(raw_fields: str | None) -> set[str]:
    """解析需要移除的字段名。

    - ``None`` 表示用户没有配置，不移除任何字段。
    - 空字符串表示用户明确想禁用移除逻辑，返回空集合。
    - 逗号分隔字符串会被拆成字段集合。
    """
    if raw_fields is None:
        return set()
    return {field.strip() for field in raw_fields.split(",") if field.strip()}


def parse_inject_request_fields(raw_fields: object | None) -> dict[str, Any]:
    """Parse top-level JSON request fields to inject before forwarding."""
    if raw_fields is None:
        return {}
    if isinstance(raw_fields, Mapping):
        return dict(raw_fields)
    if not isinstance(raw_fields, str):
        raise ValueError("inject request fields must be a JSON object")
    if raw_fields.strip() == "":
        return {}
    try:
        parsed = json.loads(raw_fields)
    except json.JSONDecodeError as exc:
        raise ValueError("inject request fields must be a JSON object") from exc
    if not isinstance(parsed, dict):
        raise ValueError("inject request fields must be a JSON object")
    return parsed


def strip_request_json_fields(body: bytes, fields: set[str]) -> tuple[bytes, list[str]]:
    """从请求 JSON 顶层移除指定字段。

    返回值是 ``(新的请求体, 被移除的字段列表)``。如果请求体不是合法 JSON、
    不是对象，或者没有命中字段，就原样返回，避免破坏非 JSON 请求。
    """
    if not body or not fields:
        return body, []
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body, []
    if not isinstance(payload, dict):
        return body, []

    removed = [field for field in fields if field in payload]
    if not removed:
        return body, []
    for field in removed:
        payload.pop(field, None)
    stripped_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return stripped_body, sorted(removed)


def transform_request_json_fields(
    body: bytes,
    strip_fields: set[str],
    inject_fields: dict[str, Any],
) -> tuple[bytes, list[str], list[str]]:
    """Remove and inject top-level JSON request fields before forwarding.

    Non-JSON bodies and JSON values that are not objects are left unchanged.
    Injection runs after stripping so configured injected values are final.
    """
    if not body or (not strip_fields and not inject_fields):
        return body, [], []
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body, [], []
    if not isinstance(payload, dict):
        return body, [], []

    removed = [field for field in strip_fields if field in payload]
    for field in removed:
        payload.pop(field, None)

    injected = sorted(inject_fields)
    if inject_fields:
        payload.update(inject_fields)

    if not removed and not injected:
        return body, [], []
    transformed_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return transformed_body, sorted(removed), injected
