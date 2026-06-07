"""Body serialization and readable rendering helpers."""

from __future__ import annotations

import base64
import json
from typing import Mapping

from .streams import compact_sse_json

def bytes_payload(data: bytes) -> dict[str, object]:
    payload: dict[str, object] = {
        "size_bytes": len(data),
        "base64": base64.b64encode(data).decode("ascii"),
        "text": data.decode("utf-8", errors="replace"),
    }
    return payload


def try_pretty_json(text: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text
    return json.dumps(parsed, ensure_ascii=False, indent=2)



def render_headers(headers: Mapping[str, list[str]]) -> str:
    if not headers:
        return "(none)"
    lines: list[str] = []
    for key in sorted(headers):
        for value in headers[key]:
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def render_body(body: Mapping[str, object]) -> str:
    size = body.get("size_bytes", 0)
    text = str(body.get("text", ""))
    if not text:
        return f"(empty body, {size} bytes)"
    compacted = compact_sse_json(text)
    if compacted:
        return compacted
    return try_pretty_json(text)


def body_json_value(body: Mapping[str, object]) -> object:
    text = str(body.get("text", ""))
    if not text:
        return None
    compacted = compact_sse_json(text)
    if compacted:
        return json.loads(compacted)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "text": text,
            "size_bytes": body.get("size_bytes", 0),
        }


