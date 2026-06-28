"""解析 LLM 请求/响应记录的辅助函数。

日志器会用这些函数判断一次请求属于哪类接口、提取请求正文、生成内容指纹，
以及从响应中找出 response id。它们本身不写文件，只负责“理解记录内容”。
"""

from __future__ import annotations

import hashlib
import json
from typing import Mapping

from .payloads import body_json_value

def stable_hash(value: object, length: int = 12) -> str:
    """对任意 JSON 可序列化对象生成稳定短哈希。

    ``sort_keys=True`` 保证字典字段顺序不同也会得到同样哈希。
    """
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8", errors="replace")).hexdigest()[:length]


def safe_filename_part(value: object, fallback: str = "unknown", limit: int = 80) -> str:
    """把任意值转成适合放进文件名的片段。"""
    text = str(value or "").strip()
    safe = "".join(ch if ch.isalnum() else "-" for ch in text).strip("-")
    return (safe[:limit] or fallback).strip("-") or fallback


def get_nested_value(value: object, path: tuple[str, ...]) -> object | None:
    """安全读取嵌套字典里的值。"""
    current = value
    for key in path:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def first_string(*values: object) -> str | None:
    """返回第一个非空字符串。"""
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def request_body_json(record: Mapping[str, object]) -> object:
    """从记录中取出请求体，并按 JSON/SSE 规则解析。"""
    request = record.get("request")
    if not isinstance(request, Mapping):
        return None
    body = request.get("body")
    if not isinstance(body, Mapping):
        return None
    return body_json_value(body)


def response_body_json(record: Mapping[str, object]) -> object:
    """从记录中取出响应体，并按 JSON/SSE 规则解析。"""
    response = record.get("response")
    if not isinstance(response, Mapping):
        return None
    body = response.get("body")
    if not isinstance(body, Mapping):
        return None
    return body_json_value(body)


def request_path(record: Mapping[str, object]) -> str:
    """从记录中读取客户端请求路径。"""
    request = record.get("request")
    if not isinstance(request, Mapping):
        return ""
    return str(request.get("path", ""))


def endpoint_kind(path: str) -> str:
    """根据路径判断是哪类 LLM 接口。"""
    lowered = path.lower().split("?", 1)[0].rstrip("/")
    if lowered.endswith("/responses") or lowered == "/responses":
        return "responses"
    if lowered.endswith("/chat/completions") or lowered == "/chat/completions":
        return "chat"
    if lowered.endswith("/completions") or lowered == "/completions":
        return "completions"
    return "other"


def message_text(value: object) -> object:
    """把消息内容整理成适合生成指纹的稳定结构。"""
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
    """提取 Chat Completions 请求里的 system/developer 消息。"""
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
    """提取 Chat Completions 前几条消息作为内容指纹。"""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return []
    compacted = []
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


def chat_first_user_message(payload: Mapping[str, object]) -> object | None:
    """提取 Chat Completions 里的第一条用户消息。"""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None
    for message in messages:
        if isinstance(message, Mapping) and message.get("role") == "user" and not is_task_context_message(message):
            return message_text(message.get("content"))
    return None


def responses_input_items(payload: Mapping[str, object]) -> list[object]:
    """把 Responses API 的 input 统一转成列表。"""
    input_value = payload.get("input")
    if isinstance(input_value, list):
        return input_value
    if input_value is None:
        return []
    return [input_value]


def responses_input_item_summary(item: object) -> object:
    """压缩单个 Responses input 项，只保留用于识别任务的核心字段。"""
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
            # 去掉值为 None 的字段，让指纹更稳定、更简洁。
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
    """提取 Responses API 前几个 input 项作为内容指纹。"""
    content_items = [item for item in responses_input_items(payload) if not is_task_context_message(item)]
    return [responses_input_item_summary(item) for item in content_items[:limit]]


def responses_first_user_message(payload: Mapping[str, object]) -> object | None:
    """提取 Responses API input 中第一条用户文本。"""
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
    user_messages = []
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
    user_messages = []
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


def request_user_messages(kind: str, payload: object) -> list[object]:
    """Extract the user-message sequence used to decide task continuation."""
    if not isinstance(payload, Mapping):
        return []
    if kind == "responses":
        return responses_user_messages(payload)
    if kind == "chat":
        return chat_user_messages(payload)
    if kind == "completions":
        prompt = payload.get("prompt")
        return [message_text(prompt)] if prompt else []
    return []


def request_fingerprints(kind: str, payload: object) -> dict[str, str]:
    """为不同接口类型生成请求指纹。

    指纹用于判断两个请求是否可能属于同一个任务。不同接口的字段结构不同，
    所以这里分别处理 responses/chat/completions。
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


def request_boundary_fingerprints(kind: str, payload: object) -> dict[str, str]:
    """Fingerprints that must not change within one task."""
    fingerprints = request_fingerprints(kind, payload)
    if kind == "responses":
        boundary_keys = {"instructions", "tools", "first_user"}
    elif kind == "chat":
        boundary_keys = {"system", "tools", "first_user"}
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
