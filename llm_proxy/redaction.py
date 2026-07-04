"""Optional stored-log redaction helpers."""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping

SENSITIVE_HEADER_NAMES = {"authorization", "proxy-authorization", "x-api-key", "api-key"}
SENSITIVE_JSON_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "access_token",
    "refresh_token",
    "token",
    "password",
    "secret",
}
REDACTED = "[redacted]"


def redact_record(record: Mapping[str, object]) -> dict[str, object]:
    redacted = copy.deepcopy(dict(record))
    for section_name in ("request", "response"):
        section = redacted.get(section_name)
        if not isinstance(section, dict):
            continue
        headers = section.get("headers")
        if isinstance(headers, dict):
            section["headers"] = redact_headers(headers)
        body = section.get("body")
        if isinstance(body, dict):
            section["body"] = redact_body(body)
        upstream_body = section.get("upstream_body")
        if isinstance(upstream_body, dict):
            section["upstream_body"] = redact_body(upstream_body)
    return redacted


def redact_headers(headers: Mapping[object, object]) -> dict[str, object]:
    redacted: dict[str, object] = {}
    for key, value in headers.items():
        key_text = str(key)
        if key_text.lower() in SENSITIVE_HEADER_NAMES:
            if isinstance(value, list):
                redacted[key_text] = [REDACTED for _ in value]
            else:
                redacted[key_text] = REDACTED
        else:
            redacted[key_text] = value
    return redacted


def redact_body(body: Mapping[str, object]) -> dict[str, object]:
    redacted = dict(body)
    text = redacted.get("text")
    if not isinstance(text, str) or not text:
        return redacted
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return redacted
    masked = redact_json_value(parsed)
    redacted_text = json.dumps(masked, ensure_ascii=False, separators=(",", ":"))
    redacted["text"] = redacted_text
    redacted["base64"] = ""
    redacted["size_bytes"] = len(redacted_text.encode("utf-8"))
    return redacted


def redact_json_value(value: object) -> object:
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for key, item in value.items():
            key_text = str(key)
            result[key_text] = REDACTED if key_text.lower() in SENSITIVE_JSON_KEYS else redact_json_value(item)
        return result
    if isinstance(value, list):
        return [redact_json_value(item) for item in value]
    return value
