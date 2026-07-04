"""Helper functions for parsing LLM request/response records.

The logger uses these functions to determine which type of API a request belongs to, extract request bodies, generate content fingerprints, and find response IDs from responses. They don't write files themselves, only responsible for "understanding record content".
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from .payloads import body_json_value


def stable_hash(value: object, length: int = 12) -> str:
    """Generate a stable short hash for any JSON-serializable object.

    ``sort_keys=True`` ensures that dictionaries with different field orders produce the same hash.
    """
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8", errors="replace")).hexdigest()[:length]


def safe_filename_part(value: object, fallback: str = "unknown", limit: int = 80) -> str:
    """Convert an arbitrary value into a filename-safe fragment."""
    text = str(value or "").strip()
    safe = "".join(ch if ch.isalnum() else "-" for ch in text).strip("-")
    return (safe[:limit] or fallback).strip("-") or fallback


def get_nested_value(value: object, path: tuple[str, ...]) -> object | None:
    """Safely read a value from a nested dictionary."""
    current = value
    for key in path:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def first_string(*values: object) -> str | None:
    """Return the first non-empty string."""
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def request_body_json(record: Mapping[str, object]) -> object:
    """Extract the request body from the record and parse it according to JSON/SSE rules."""
    request = record.get("request")
    if not isinstance(request, Mapping):
        return None
    body = request.get("body")
    if not isinstance(body, Mapping):
        return None
    return body_json_value(body)


def response_body_json(record: Mapping[str, object]) -> object:
    """Extract the response body from the record and parse it according to JSON/SSE rules."""
    response = record.get("response")
    if not isinstance(response, Mapping):
        return None
    body = response.get("body")
    if not isinstance(body, Mapping):
        return None
    return body_json_value(body)


def request_path(record: Mapping[str, object]) -> str:
    """Read the client request path from the record."""
    request = record.get("request")
    if not isinstance(request, Mapping):
        return ""
    return str(request.get("path", ""))


def endpoint_kind(path: str) -> str:
    """Determine which type of LLM API based on the path."""
    lowered = path.lower().split("?", 1)[0].rstrip("/")
    if lowered.endswith("/responses") or lowered == "/responses":
        return "responses"
    if lowered.endswith("/messages") or lowered == "/messages":
        return "messages"
    if lowered.endswith("/chat/completions") or lowered == "/chat/completions":
        return "chat"
    if lowered.endswith("/completions") or lowered == "/completions":
        return "completions"
    return "other"


def message_text(value: object) -> object:
    """Format message content into a stable structure for generating fingerprints."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [message_text(item) for item in value]
    if isinstance(value, Mapping):
        return {key: message_text(value[key]) for key in sorted(value)}
    return value


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, Mapping):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    if isinstance(value, Mapping):
        text = value.get("text")
        if isinstance(text, str):
            return text
    return ""


def is_task_context_message(item: object) -> bool:
    if not isinstance(item, Mapping):
        return False
    text = _content_text(item.get("content")).lstrip()
    fixed_prefixes = (
        "<environment_context>",
        "<permissions instructions>",
        "<app-context>",
        "# Codex desktop context",
    )
    return any(text.startswith(prefix) for prefix in fixed_prefixes)


def chat_system_messages(payload: Mapping[str, object]) -> list[object]:
    """Extract system/developer messages from Chat Completions requests."""
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
    """Extract the first few messages from Chat Completions as content fingerprints."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    compacted: list[object] = []
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        if is_task_context_message(message):
            continue
        compacted.append(
            {
                "role": message.get("role"),
                "content": message_text(message.get("content")),
                "name": message.get("name"),
                "tool_call_id": message.get("tool_call_id"),
            }
        )
        if len(compacted) >= limit:
            break
    return compacted


def chat_content_messages(payload: Mapping[str, object]) -> list[object]:
    """Return non-fixed chat messages used as whole-request context evidence."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    compacted: list[object] = []
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        if is_task_context_message(message):
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
    """Extract the first user message from Chat Completions."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None
    for message in messages:
        if isinstance(message, Mapping) and message.get("role") == "user" and not is_task_context_message(message):
            return message_text(message.get("content"))
    return None


def responses_input_items(payload: Mapping[str, object]) -> list[object]:
    """Convert Responses API input into a uniform list."""
    input_value = payload.get("input")
    if isinstance(input_value, list):
        return input_value
    if input_value is None:
        return []
    return [input_value]


def responses_input_item_summary(item: object) -> object:
    """Compress a single Responses input item, keeping only core fields for task identification."""
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
            # Remove fields with None values to make fingerprints more stable and concise.
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
    """Extract the first few input items from Responses API as content fingerprints."""
    content_items = [item for item in responses_input_items(payload) if not is_task_context_message(item)]
    return [responses_input_item_summary(item) for item in content_items[:limit]]


def responses_first_user_message(payload: Mapping[str, object]) -> object | None:
    """Extract the first user text from Responses API input."""
    for item in responses_input_items(payload):
        if not isinstance(item, Mapping) or item.get("role") != "user":
            continue
        if is_task_context_message(item):
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


def responses_user_messages(payload: Mapping[str, object]) -> list[object]:
    """Return non-fixed user messages from a Responses API payload."""
    user_messages: list[object] = []
    for item in responses_input_items(payload):
        if not isinstance(item, Mapping) or item.get("role") != "user":
            continue
        if is_task_context_message(item):
            continue
        user_messages.append(responses_input_item_summary(item))
    return user_messages


def chat_user_messages(payload: Mapping[str, object]) -> list[object]:
    """Return non-fixed user messages from a Chat Completions payload."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    user_messages: list[object] = []
    for message in messages:
        if not isinstance(message, Mapping) or message.get("role") != "user":
            continue
        if is_task_context_message(message):
            continue
        user_messages.append(
            {
                "role": message.get("role"),
                "content": message_text(message.get("content")),
                "name": message.get("name"),
            }
        )
    return user_messages


def claude_system_messages(payload: Mapping[str, object]) -> list[object]:
    """Extract top-level system messages from Anthropic/Claude Messages requests."""
    system = payload.get("system")
    if not system:
        return []
    return [{"role": "system", "content": message_text(system)}]


def claude_message_summary(message: Mapping[str, object]) -> dict[str, object]:
    """Compress a Claude message while preserving role and content shape."""
    summary: dict[str, object] = {
        "role": message.get("role"),
        "content": message_text(message.get("content")),
    }
    for key in ("name", "tool_use_id"):
        value = message.get(key)
        if value is not None:
            summary[key] = value
    return summary


def claude_messages(payload: Mapping[str, object]) -> list[object]:
    """Return non-fixed messages from an Anthropic/Claude Messages payload."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    compacted: list[object] = []
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        if is_task_context_message(message):
            continue
        compacted.append(claude_message_summary(message))
    return compacted


def claude_prefix_messages(payload: Mapping[str, object], limit: int = 4) -> list[object]:
    """Extract the first few Claude messages as content fingerprints."""
    return claude_messages(payload)[:limit]


def claude_first_user_message(payload: Mapping[str, object]) -> object | None:
    """Extract the first user message from an Anthropic/Claude Messages request."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None
    for message in messages:
        if isinstance(message, Mapping) and message.get("role") == "user" and not is_task_context_message(message):
            return message_text(message.get("content"))
    return None


def claude_user_messages(payload: Mapping[str, object]) -> list[object]:
    """Return non-fixed user messages from an Anthropic/Claude Messages payload."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    user_messages: list[object] = []
    for message in messages:
        if not isinstance(message, Mapping) or message.get("role") != "user":
            continue
        if is_task_context_message(message):
            continue
        user_messages.append(claude_message_summary(message))
    return user_messages


def request_user_messages(kind: str, payload: object) -> list[object]:
    """Extract the user-message sequence used to decide task continuation."""
    if not isinstance(payload, Mapping):
        return []
    if kind == "responses":
        return responses_user_messages(payload)
    if kind == "chat":
        return chat_user_messages(payload)
    if kind == "messages":
        return claude_user_messages(payload)
    if kind == "completions":
        prompt = payload.get("prompt")
        return [message_text(prompt)] if prompt else []
    return []


def request_fingerprints(kind: str, payload: object) -> dict[str, str]:
    """为不同接口类型生成请求指纹。

    指纹用于判断两个请求是否可能属于同一个任务。不同接口的字段结构不同，
    所以这里分别处理 responses/chat/messages/completions。
    """
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
        content_messages = chat_content_messages(payload)
        if content_messages:
            fingerprints["messages"] = stable_hash(content_messages)
        first_user = chat_first_user_message(payload)
        if first_user:
            fingerprints["first_user"] = stable_hash(first_user)
        tools = payload.get("tools", payload.get("functions"))
        if tools:
            fingerprints["tools"] = stable_hash(tools)
    elif kind == "messages":
        system_messages = claude_system_messages(payload)
        if system_messages:
            fingerprints["system"] = stable_hash(system_messages)
        prefix_messages = claude_prefix_messages(payload)
        if prefix_messages:
            fingerprints["messages_prefix"] = stable_hash(prefix_messages)
        content_messages = claude_messages(payload)
        if content_messages:
            fingerprints["messages"] = stable_hash(content_messages)
        first_user = claude_first_user_message(payload)
        if first_user:
            fingerprints["first_user"] = stable_hash(first_user)
        tools = payload.get("tools")
        if tools:
            fingerprints["tools"] = stable_hash(tools)
    elif kind == "completions":
        prompt = payload.get("prompt")
        if prompt:
            fingerprints["prompt"] = stable_hash(prompt)
    return fingerprints


def request_boundary_fingerprints(kind: str, payload: object) -> dict[str, str]:
    """Fingerprints that must not change within one task."""
    fingerprints = request_fingerprints(kind, payload)
    if kind == "responses":
        boundary_keys = {"instructions", "first_user"}
    elif kind in {"chat", "messages"}:
        boundary_keys = {"system", "first_user"}
    elif kind == "completions":
        boundary_keys = {"prompt"}
    else:
        boundary_keys = set()
    return {key: value for key, value in fingerprints.items() if key in boundary_keys}


def response_ids_from_body(body: object) -> list[str]:
    """从响应体中提取可能的响应 ID，并去重。"""
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
