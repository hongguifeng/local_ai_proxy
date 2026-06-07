"""Helpers for interpreting recorded LLM request and response payloads."""

from __future__ import annotations

import hashlib
import json
from typing import Mapping

from .payloads import body_json_value

def stable_hash(value: object, length: int = 12) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8", errors="replace")).hexdigest()[:length]


def safe_filename_part(value: object, fallback: str = "unknown", limit: int = 80) -> str:
    text = str(value or "").strip()
    safe = "".join(ch if ch.isalnum() else "-" for ch in text).strip("-")
    return (safe[:limit] or fallback).strip("-") or fallback


def get_nested_value(value: object, path: tuple[str, ...]) -> object | None:
    current = value
    for key in path:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def first_string(*values: object) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def request_body_json(record: Mapping[str, object]) -> object:
    request = record.get("request")
    if not isinstance(request, Mapping):
        return None
    body = request.get("body")
    if not isinstance(body, Mapping):
        return None
    return body_json_value(body)


def response_body_json(record: Mapping[str, object]) -> object:
    response = record.get("response")
    if not isinstance(response, Mapping):
        return None
    body = response.get("body")
    if not isinstance(body, Mapping):
        return None
    return body_json_value(body)


def request_path(record: Mapping[str, object]) -> str:
    request = record.get("request")
    if not isinstance(request, Mapping):
        return ""
    return str(request.get("path", ""))


def endpoint_kind(path: str) -> str:
    lowered = path.lower().split("?", 1)[0].rstrip("/")
    if lowered.endswith("/responses") or lowered == "/responses":
        return "responses"
    if lowered.endswith("/chat/completions") or lowered == "/chat/completions":
        return "chat"
    if lowered.endswith("/completions") or lowered == "/completions":
        return "completions"
    return "other"


def message_text(value: object) -> object:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [message_text(item) for item in value]
    if isinstance(value, Mapping):
        return {key: message_text(value[key]) for key in sorted(value)}
    return value


def chat_system_messages(payload: Mapping[str, object]) -> list[object]:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    system_roles = {"system", "developer"}
    return [
        {"role": message.get("role"), "content": message_text(message.get("content"))}
        for message in messages
        if isinstance(message, Mapping) and message.get("role") in system_roles
    ]


def chat_prefix_messages(payload: Mapping[str, object], limit: int = 4) -> list[object]:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    compacted = []
    for message in messages[:limit]:
        if not isinstance(message, Mapping):
            continue
        compacted.append(
            {
                "role": message.get("role"),
                "content": message_text(message.get("content")),
                "name": message.get("name"),
                "tool_call_id": message.get("tool_call_id"),
            }
        )
    return compacted


def chat_first_user_message(payload: Mapping[str, object]) -> object | None:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None
    for message in messages:
        if isinstance(message, Mapping) and message.get("role") == "user":
            return message_text(message.get("content"))
    return None


def responses_input_items(payload: Mapping[str, object]) -> list[object]:
    input_value = payload.get("input")
    if isinstance(input_value, list):
        return input_value
    if input_value is None:
        return []
    return [input_value]


def responses_input_item_summary(item: object) -> object:
    if isinstance(item, str):
        return item
    if not isinstance(item, Mapping):
        return item
    summary: dict[str, object] = {}
    for key in ("type", "role", "call_id", "name"):
        value = item.get(key)
        if value is not None:
            summary[key] = value

    content = item.get("content")
    if isinstance(content, list):
        compact_content = []
        for content_item in content:
            if not isinstance(content_item, Mapping):
                compact_content.append(content_item)
                continue
            compact_entry = {
                "type": content_item.get("type"),
                "text": content_item.get("text"),
                "arguments": content_item.get("arguments"),
                "call_id": content_item.get("call_id"),
            }
            compact_content.append({key: value for key, value in compact_entry.items() if value is not None})
        summary["content"] = compact_content
    elif content is not None:
        summary["content"] = message_text(content)

    for key in ("output", "arguments"):
        value = item.get(key)
        if value is not None:
            summary[key] = message_text(value)
    return summary or message_text(item)


def responses_input_prefix(payload: Mapping[str, object], limit: int = 6) -> list[object]:
    return [responses_input_item_summary(item) for item in responses_input_items(payload)[:limit]]


def responses_first_user_message(payload: Mapping[str, object]) -> object | None:
    for item in responses_input_items(payload):
        if not isinstance(item, Mapping) or item.get("role") != "user":
            continue
        content = item.get("content")
        if isinstance(content, list):
            texts = []
            for content_item in content:
                if isinstance(content_item, Mapping):
                    text = content_item.get("text")
                    if isinstance(text, str) and text:
                        texts.append(text)
            if texts:
                return texts
        elif content:
            return message_text(content)
    return None


def request_fingerprints(kind: str, payload: object) -> dict[str, str]:
    if not isinstance(payload, Mapping):
        return {}

    fingerprints: dict[str, str] = {}
    if kind == "responses":
        instructions = payload.get("instructions")
        if instructions:
            fingerprints["instructions"] = stable_hash(instructions)
        tools = payload.get("tools")
        if tools:
            fingerprints["tools"] = stable_hash(tools)
        first_user = responses_first_user_message(payload)
        if first_user:
            fingerprints["first_user"] = stable_hash(first_user)
        input_prefix = responses_input_prefix(payload)
        if input_prefix:
            fingerprints["input_prefix"] = stable_hash(input_prefix)
        input_value = payload.get("input")
        if input_value:
            fingerprints["input"] = stable_hash(input_value)
    elif kind == "chat":
        system_messages = chat_system_messages(payload)
        if system_messages:
            fingerprints["system"] = stable_hash(system_messages)
        prefix_messages = chat_prefix_messages(payload)
        if prefix_messages:
            fingerprints["messages_prefix"] = stable_hash(prefix_messages)
        first_user = chat_first_user_message(payload)
        if first_user:
            fingerprints["first_user"] = stable_hash(first_user)
        tools = payload.get("tools", payload.get("functions"))
        if tools:
            fingerprints["tools"] = stable_hash(tools)
    elif kind == "completions":
        prompt = payload.get("prompt")
        if prompt:
            fingerprints["prompt"] = stable_hash(prompt)
    return fingerprints


def response_ids_from_body(body: object) -> list[str]:
    ids: list[str] = []
    if isinstance(body, Mapping):
        response_id = body.get("id")
        if isinstance(response_id, str) and response_id:
            ids.append(response_id)
        response_payload = body.get("response")
        if isinstance(response_payload, Mapping):
            nested_id = response_payload.get("id")
            if isinstance(nested_id, str) and nested_id:
                ids.append(nested_id)
    return list(dict.fromkeys(ids))


