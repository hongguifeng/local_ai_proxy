"""Serialization and display utilities for request/response bodies.

Logs need to preserve complete raw bytes while also being human-readable. This module converts bytes to JSON-writable structures and formats JSON or SSE streams more clearly in readable logs.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping

from .streams import compact_sse_json


def bytes_payload(data: bytes) -> dict[str, object]:
    """Wrap raw bytes into the body field for logs.

    - ``size_bytes``: original byte count.
    - ``base64``: lossless preservation of raw content, including binary.
    - ``text``: UTF-8 decoded text for human readability.
    """
    payload: dict[str, object] = {
        "size_bytes": len(data),
        "base64": base64.b64encode(data).decode("ascii"),
        "text": data.decode("utf-8", errors="replace"),
    }
    return payload


def try_pretty_json(text: str) -> str:
    """If the text is JSON, format with indentation; otherwise return as-is."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text
    return json.dumps(parsed, ensure_ascii=False, indent=2)



def render_headers(headers: Mapping[str, list[str]]) -> str:
    """Render headers into readable multiline text for Markdown."""
    if not headers:
        return "(none)"
    lines: list[str] = []
    for key in sorted(headers):
        for value in headers[key]:
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def render_body(body: Mapping[str, object]) -> str:
    """Render the body into human-readable text.

    OpenAI-compatible APIs commonly return SSE streams. For such content, first try to compress into a summary; if not SSE, try to beautify as regular JSON.
    """
    size = body.get("size_bytes", 0)
    text = str(body.get("text", ""))
    if not text:
        return f"(empty body, {size} bytes)"
    compacted = compact_sse_json(text)
    if compacted:
        return compacted
    return try_pretty_json(text)


def body_json_value(body: Mapping[str, object]) -> object:
    """Convert the log body into a value to write in JSON files.

    Readable logs generate request.json and response.json. This function decides what to write: parsed objects for valid JSON, compressed summaries for SSE, and wrapped plain text otherwise.
    """
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

