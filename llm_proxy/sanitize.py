"""Request body sanitization utilities.

After recording the original request, the proxy can remove some top-level JSON fields before forwarding to upstream.
This preserves the real content from the client while controlling the parameters actually sent to the model service.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


def parse_strip_request_fields(raw_fields: str | None) -> set[str]:
    """Parse field names to strip.

    - ``None`` means the user did not configure anything, don't strip any fields.
    - Empty string means the user explicitly disabled stripping, return empty set.
    - Comma-separated string will be split into a set of fields.
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
    """Remove specified fields from the top level of the request JSON.

    Returns ``(new_request_body, list_of_removed_fields)``. If the request body is not valid JSON,
    not an object, or no fields match, return unchanged to avoid breaking non-JSON requests.
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
