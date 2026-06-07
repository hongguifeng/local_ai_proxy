"""Request body sanitizing before forwarding upstream."""

from __future__ import annotations

import json

from .constants import DEFAULT_STRIP_REQUEST_FIELDS

def parse_strip_request_fields(raw_fields: str | None) -> set[str]:
    if raw_fields is None:
        return set(DEFAULT_STRIP_REQUEST_FIELDS)
    return {field.strip() for field in raw_fields.split(",") if field.strip()}


def strip_request_json_fields(body: bytes, fields: set[str]) -> tuple[bytes, list[str]]:
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


