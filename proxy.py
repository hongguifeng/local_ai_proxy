#!/usr/bin/env python3
"""Small HTTP proxy for recording llama.cpp/OpenAI-compatible traffic."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import http.client
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable, Mapping
from urllib.parse import urlsplit


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


DEFAULT_PORTS = {
    "http": 80,
    "https": 443,
}

DEFAULT_STRIP_REQUEST_FIELDS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "typical_p",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "seed",
)


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def local_now_for_filename() -> str:
    return dt.datetime.now().astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_datetime_for_filename(timestamp: object) -> str:
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%m-%d__%H-%M-%S.%f")[:-3]


def local_time_from_timestamp_for_filename(timestamp: object) -> str:
    return dt.datetime.fromisoformat(str(timestamp)).astimezone().strftime("%H-%M-%S.%f")[:-3]


def readable_start_timestamp(record: Mapping[str, object]) -> object:
    return record.get("started_timestamp", record["timestamp"])


def local_time_for_filename() -> str:
    """Return time-only string for filenames, e.g. 14-13-07.132."""
    return dt.datetime.now().astimezone().strftime("%H-%M-%S.%f")[:-3]


def format_duration_hms(ms: float) -> str:
    """Format milliseconds as hh:mm:ss."""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"00:{minutes:02d}:{seconds:02d}"


def headers_to_dict(headers: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for key, value in headers:
        result.setdefault(key, []).append(value)
    return result


def parse_header_overrides(raw_headers: list[str] | None) -> list[tuple[str, str]]:
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


def parse_target(args: argparse.Namespace) -> dict[str, object]:
    raw_target_url = args.target_url or os.getenv("LLM_PROXY_TARGET_URL")
    if raw_target_url:
        parsed = urlsplit(raw_target_url)
        if parsed.scheme not in DEFAULT_PORTS or not parsed.hostname:
            raise ValueError("--target-url must look like http://host[:port][/base-path] or https://host[:port][/base-path].")
        return {
            "scheme": parsed.scheme,
            "host": parsed.hostname,
            "port": parsed.port or DEFAULT_PORTS[parsed.scheme],
            "base_path": parsed.path.rstrip("/"),
            "display_url": raw_target_url.rstrip("/"),
        }

    scheme = args.target_scheme
    if scheme not in DEFAULT_PORTS:
        raise ValueError("--target-scheme must be http or https.")
    return {
        "scheme": scheme,
        "host": args.target_host,
        "port": args.target_port,
        "base_path": "",
        "display_url": f"{scheme}://{args.target_host}:{args.target_port}",
    }


def join_target_path(base_path: str, request_path: str) -> str:
    if not base_path:
        return request_path
    if not request_path.startswith("/"):
        request_path = f"/{request_path}"
    if (
        request_path == base_path
        or request_path.startswith(f"{base_path}/")
        or request_path.startswith(f"{base_path}?")
    ):
        return request_path
    return f"{base_path}{request_path}"


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


def merge_tool_call_delta(merged: dict[int, dict[str, object]], tool_call: object) -> None:
    if not isinstance(tool_call, dict):
        return
    raw_index = tool_call.get("index", 0)
    index = raw_index if isinstance(raw_index, int) else 0
    current = merged.setdefault(index, {"index": index})

    for key in ("id", "type"):
        value = tool_call.get(key)
        if value:
            current[key] = value

    function_delta = tool_call.get("function")
    if isinstance(function_delta, dict):
        function = current.setdefault("function", {})
        if isinstance(function, dict):
            name = function_delta.get("name")
            if name:
                function["name"] = name
            arguments = function_delta.get("arguments")
            if isinstance(arguments, str):
                function["arguments"] = str(function.get("arguments", "")) + arguments


def compact_tool_calls(tool_calls: list[object]) -> list[object]:
    merged: dict[int, dict[str, object]] = {}
    passthrough: list[object] = []
    for item in tool_calls:
        if isinstance(item, list):
            for tool_call in item:
                merge_tool_call_delta(merged, tool_call)
        elif isinstance(item, dict):
            merge_tool_call_delta(merged, item)
        else:
            passthrough.append(item)
    compacted = [merged[index] for index in sorted(merged)]
    compacted.extend(passthrough)
    for tool_call in compacted:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function")
        if not isinstance(function, dict):
            continue
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            try:
                function["arguments_json"] = json.loads(arguments)
            except json.JSONDecodeError:
                pass
    return compacted


def compact_response_tool_calls(tool_calls: dict[str, dict[str, object]]) -> list[object]:
    compacted = []
    for key in sorted(tool_calls):
        tool_call = dict(tool_calls[key])
        arguments = tool_call.get("arguments")
        if isinstance(arguments, str):
            try:
                tool_call["arguments_json"] = json.loads(arguments)
            except json.JSONDecodeError:
                pass
        compacted.append(tool_call)
    return compacted


def compact_response_payload(response: Mapping[str, object]) -> dict[str, object]:
    keep_keys = (
        "id",
        "object",
        "created_at",
        "status",
        "model",
        "parallel_tool_calls",
        "previous_response_id",
    )
    compacted = {key: response[key] for key in keep_keys if key in response}
    error = response.get("error")
    if error:
        compacted["error"] = error
    incomplete_details = response.get("incomplete_details")
    if incomplete_details:
        compacted["incomplete_details"] = incomplete_details
    return compacted


def compact_sse_json(text: str) -> str | None:
    events = []
    done_seen = False
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data:
            continue
        if data == "[DONE]":
            done_seen = True
            continue
        try:
            events.append(json.loads(data))
        except json.JSONDecodeError:
            return None
    if not events:
        return None

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[object] = []
    response_tool_calls: dict[str, dict[str, object]] = {}
    finish_reasons: list[str] = []
    usage: object | None = None
    response_payload: object | None = None
    other_payloads: list[object] = []

    for event in events:
        if not isinstance(event, dict):
            other_payloads.append(event)
            continue

        event_type = event.get("type")
        if isinstance(event_type, str) and event_type.startswith("response."):
            if event_type == "response.output_text.delta":
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    content_parts.append(delta)
            elif event_type == "response.output_text.done" and not content_parts:
                value = event.get("text")
                if isinstance(value, str) and value:
                    content_parts.append(value)
            elif event_type in {
                "response.reasoning_text.delta",
                "response.reasoning_summary_text.delta",
            }:
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    reasoning_parts.append(delta)
            elif event_type in {
                "response.reasoning_text.done",
                "response.reasoning_summary_text.done",
            } and not reasoning_parts:
                value = event.get("text")
                if isinstance(value, str) and value:
                    reasoning_parts.append(value)
            elif event_type == "response.function_call_arguments.delta":
                item_id = str(event.get("item_id") or event.get("call_id") or event.get("output_index") or "0")
                tool_call = response_tool_calls.setdefault(item_id, {"arguments": ""})
                for key in ("item_id", "call_id", "output_index"):
                    value = event.get(key)
                    if value is not None:
                        tool_call[key] = value
                delta = event.get("delta")
                if isinstance(delta, str):
                    tool_call["arguments"] = str(tool_call.get("arguments", "")) + delta
            elif event_type == "response.function_call_arguments.done":
                item_id = str(event.get("item_id") or event.get("call_id") or event.get("output_index") or "0")
                tool_call = response_tool_calls.setdefault(item_id, {})
                for key in ("item_id", "call_id", "output_index"):
                    value = event.get(key)
                    if value is not None:
                        tool_call[key] = value
                arguments = event.get("arguments")
                if isinstance(arguments, str):
                    tool_call["arguments"] = arguments
            elif event_type in {"response.completed", "response.incomplete"}:
                response = event.get("response")
                if isinstance(response, dict):
                    compacted_response = compact_response_payload(response)
                    if compacted_response:
                        response_payload = {
                            **response_payload,
                            **compacted_response,
                        } if isinstance(response_payload, dict) else compacted_response
                    if response.get("usage"):
                        usage = response["usage"]
                    status = response.get("status")
                    if status:
                        finish_reasons.append(str(status))
            elif event_type == "response.created":
                response = event.get("response")
                if isinstance(response, dict) and response_payload is None:
                    response_payload = compact_response_payload(response)
            continue

        if event.get("usage"):
            usage = event["usage"]
        choices = event.get("choices") if isinstance(event, dict) else None
        if not isinstance(choices, list):
            other_payloads.append(event)
            continue
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            finish_reason = choice.get("finish_reason")
            if finish_reason:
                finish_reasons.append(str(finish_reason))
            delta = choice.get("delta")
            message = choice.get("message")
            for payload in (delta, message, choice):
                if not isinstance(payload, dict):
                    continue
                for key in ("reasoning_content", "reasoning", "reasoning_text"):
                    value = payload.get(key)
                    if isinstance(value, str) and value:
                        reasoning_parts.append(value)
                value = payload.get("content")
                if isinstance(value, str) and value:
                    content_parts.append(value)
                value = payload.get("text")
                if isinstance(value, str) and value:
                    content_parts.append(value)
                value = payload.get("tool_calls")
                if value:
                    tool_calls.append(value)

    summary: dict[str, object] = {
        "stream_summary": {
            "event_count": len(events),
            "done_seen": done_seen,
        }
    }
    stream_summary = summary["stream_summary"]
    if isinstance(stream_summary, dict):
        if reasoning_parts:
            stream_summary["reasoning"] = "".join(reasoning_parts)
        if content_parts:
            stream_summary["content"] = "".join(content_parts)
        if response_tool_calls:
            stream_summary["response_tool_calls"] = compact_response_tool_calls(response_tool_calls)
        if tool_calls:
            stream_summary["tool_calls"] = compact_tool_calls(tool_calls)
        if finish_reasons:
            stream_summary["finish_reasons"] = finish_reasons
        if usage:
            stream_summary["usage"] = usage
        if response_payload:
            stream_summary["response"] = response_payload
        if other_payloads:
            stream_summary["other_payloads"] = other_payloads
    return json.dumps(summary, ensure_ascii=False, indent=2)


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


class TrafficLogger:
    def __init__(self, path: Path, readable_dir: Path | None) -> None:
        self.path = path
        self.readable_dir = readable_dir
        self.lock = threading.Lock()
        self.readable_paths: dict[str, Path] = {}
        self.task_index_path = readable_dir / ".task-index.json" if readable_dir else None
        self.task_index = self._load_task_index()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.readable_dir:
            self.readable_dir.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict[str, object]) -> None:
        with self.lock:
            self._prepare_task(record)
            with self.path.open("a", encoding="utf-8") as file:
                json.dump(record, file, ensure_ascii=False, separators=(",", ":"))
                file.write("\n")
            self._write_readable(record)

    def update_readable(self, record: dict[str, object]) -> None:
        with self.lock:
            self._prepare_task(record)
            self._write_readable(record)

    def _write_readable(self, record: dict[str, object]) -> None:
        if not self.readable_dir:
            return
        record_id = str(record["id"])
        readable_path = self.readable_paths.get(record_id)
        if readable_path is None:
            readable_dir_name = self._readable_dir_name(record)
            readable_path = self.readable_dir / readable_dir_name
            self._ensure_readable_dir(readable_path)
            self.readable_paths[record_id] = readable_path
        readable_filename = self._readable_filename(record)
        for existing_markdown in readable_path.glob("*.md"):
            if existing_markdown.name != readable_filename:
                existing_markdown.unlink()
        (readable_path / readable_filename).write_text(self._render_markdown(record), encoding="utf-8")
        self._write_body_json_files(readable_path, record)
        self._write_task_readable(record, readable_filename)

    def _load_task_index(self) -> dict[str, object]:
        if not self.task_index_path or not self.task_index_path.exists():
            return {"tasks": {}, "request_to_task": {}, "response_to_task": {}, "context_to_task": {}}
        try:
            loaded = json.loads(self.task_index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"tasks": {}, "request_to_task": {}, "response_to_task": {}, "context_to_task": {}}
        if not isinstance(loaded, dict):
            return {"tasks": {}, "request_to_task": {}, "response_to_task": {}, "context_to_task": {}}
        loaded.setdefault("tasks", {})
        loaded.setdefault("request_to_task", {})
        loaded.setdefault("response_to_task", {})
        loaded.setdefault("context_to_task", {})
        return loaded

    def _save_task_index(self) -> None:
        if not self.task_index_path:
            return
        self.task_index_path.write_text(json.dumps(self.task_index, ensure_ascii=False, indent=2), encoding="utf-8")

    def _prepare_task(self, record: dict[str, object]) -> None:
        if not self.readable_dir:
            return
        request = record.get("request")
        if not isinstance(request, dict) or request.get("body_pending"):
            return
        kind = endpoint_kind(request_path(record))
        if kind not in {"responses", "chat", "completions"}:
            return

        payload = request_body_json(record)
        response_payload = response_body_json(record)
        task = self._find_or_create_task(record, kind, payload)
        if not task:
            return

        request_id = str(record["id"])
        requests = task.setdefault("requests", {})
        if not isinstance(requests, dict):
            requests = {}
            task["requests"] = requests
        request_info = requests.get(request_id)
        if not isinstance(request_info, dict):
            sequence = len(requests) + 1
            request_info = {
                "sequence": sequence,
                "dir_name": self._task_request_dir_name(record, sequence),
                "started_at": record.get("started_timestamp", record.get("timestamp")),
            }
            requests[request_id] = request_info
        request_to_task = self.task_index.setdefault("request_to_task", {})
        if isinstance(request_to_task, dict):
            request_to_task[request_id] = str(task["id"])

        response = record.get("response")
        status = response.get("status") if isinstance(response, dict) else None
        request_info["status"] = status
        request_info["event"] = record.get("event", "interaction")
        request_info["timestamp"] = record.get("timestamp")
        request_info["duration_ms"] = record.get("duration_ms")
        request_info["method"] = request.get("method")
        request_info["path"] = request.get("path")

        task["last_seen_at"] = record.get("timestamp")
        if status is not None:
            task["last_response_at"] = record.get("timestamp")
        task["request_count"] = len(requests)
        model = payload.get("model") if isinstance(payload, dict) else None
        if model:
            task["model"] = model
        self._sync_task_dir_name(task)

        task_id = str(task["id"])
        if isinstance(payload, dict):
            previous_response_id = payload.get("previous_response_id")
            if isinstance(previous_response_id, str) and previous_response_id:
                response_to_task = self.task_index.setdefault("response_to_task", {})
                if isinstance(response_to_task, dict):
                    response_to_task.setdefault(previous_response_id, task_id)
            for context_key in self._context_keys(payload):
                context_to_task = self.task_index.setdefault("context_to_task", {})
                if isinstance(context_to_task, dict):
                    context_to_task.setdefault(context_key, task_id)

        response_to_task = self.task_index.setdefault("response_to_task", {})
        if isinstance(response_to_task, dict):
            for response_id in response_ids_from_body(response_payload):
                response_to_task[response_id] = task_id

        record["task"] = {
            "id": task_id,
            "kind": task.get("kind"),
            "dir": task.get("dir_name"),
            "request_sequence": request_info.get("sequence"),
            "confidence": task.get("last_match_confidence", 1.0),
        }
        self._save_task_index()

    def _find_or_create_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, object] | None:
        tasks = self.task_index.setdefault("tasks", {})
        if not isinstance(tasks, dict):
            self.task_index["tasks"] = {}
            tasks = self.task_index["tasks"]  # type: ignore[assignment]
        if not isinstance(tasks, dict):
            return None

        matched_id = self._match_existing_task(record, kind, payload)
        if matched_id and isinstance(tasks.get(matched_id), dict):
            task = tasks[matched_id]
            task["last_match_confidence"] = 1.0 if kind == "responses" else task.get("last_match_confidence", 0.8)
            return task  # type: ignore[return-value]

        task = self._new_task(record, kind, payload)
        tasks[str(task["id"])] = task
        return task

    def _match_existing_task(self, record: Mapping[str, object], kind: str, payload: object) -> str | None:
        request_id = str(record["id"])
        request_to_task = self.task_index.get("request_to_task")
        if isinstance(request_to_task, dict):
            task_id = request_to_task.get(request_id)
            if isinstance(task_id, str):
                return task_id
        scanned_task_id = self._find_task_for_request_id(request_id)
        if scanned_task_id:
            return scanned_task_id

        if isinstance(payload, dict):
            response_to_task = self.task_index.get("response_to_task")
            previous_response_id = payload.get("previous_response_id")
            if kind == "responses" and isinstance(response_to_task, dict) and isinstance(previous_response_id, str):
                task_id = response_to_task.get(previous_response_id)
                if isinstance(task_id, str):
                    return task_id

            context_to_task = self.task_index.get("context_to_task")
            if isinstance(context_to_task, dict):
                for context_key in self._context_keys(payload):
                    task_id = context_to_task.get(context_key)
                    if isinstance(task_id, str):
                        return task_id

        return self._best_heuristic_task(record, kind, payload)

    def _find_task_for_request_id(self, request_id: str) -> str | None:
        tasks = self.task_index.get("tasks")
        if not isinstance(tasks, dict):
            return None
        for task_id, task in tasks.items():
            if not isinstance(task, dict):
                continue
            requests = task.get("requests")
            if isinstance(requests, dict) and request_id in requests:
                request_to_task = self.task_index.setdefault("request_to_task", {})
                if isinstance(request_to_task, dict):
                    request_to_task[request_id] = str(task_id)
                return str(task_id)
        return None

    def _best_heuristic_task(self, record: Mapping[str, object], kind: str, payload: object) -> str | None:
        if not isinstance(payload, dict):
            return None
        tasks = self.task_index.get("tasks")
        if not isinstance(tasks, dict):
            return None
        path = request_path(record)
        model = payload.get("model")
        fingerprints = request_fingerprints(kind, payload)
        now = dt.datetime.fromisoformat(str(record.get("timestamp", utc_now_iso())))
        best_id: str | None = None
        best_score = 0

        for task_id, task in tasks.items():
            if not isinstance(task, dict) or task.get("kind") != kind:
                continue
            last_seen_raw = task.get("last_seen_at", task.get("started_at"))
            try:
                last_seen = dt.datetime.fromisoformat(str(last_seen_raw))
            except ValueError:
                continue
            age_seconds = abs((now - last_seen).total_seconds())
            if age_seconds > 30 * 60:
                continue

            score = 0
            content_match = False
            if task.get("endpoint") == path:
                score += 20
            if model and task.get("model") == model:
                score += 30
            task_fingerprints = task.get("fingerprints")
            if isinstance(task_fingerprints, dict):
                for key, value in fingerprints.items():
                    if task_fingerprints.get(key) == value:
                        if key in {"messages_prefix", "first_user", "prompt", "input_prefix"}:
                            content_match = True
                            score += 50
                        else:
                            score += 35
            if age_seconds <= 2 * 60:
                score += 30
            elif age_seconds <= 10 * 60:
                score += 15

            if kind in {"chat", "responses"} and not content_match:
                continue
            if score > best_score:
                best_score = score
                best_id = str(task_id)

        threshold = 80 if kind == "chat" else 100 if kind == "responses" else 90
        if best_id and best_score >= threshold:
            task = tasks.get(best_id)
            if isinstance(task, dict):
                task["last_match_confidence"] = round(min(best_score / 120, 0.99), 2)
            return best_id
        return None

    def _new_task(self, record: Mapping[str, object], kind: str, payload: object) -> dict[str, object]:
        task_id = uuid.uuid4().hex
        anchor = self._task_anchor(record, kind, payload)
        task = {
            "id": task_id,
            "kind": kind,
            "anchor": anchor,
            "started_at": record.get("started_timestamp", record.get("timestamp")),
            "last_seen_at": record.get("timestamp"),
            "endpoint": request_path(record),
            "fingerprints": request_fingerprints(kind, payload),
            "requests": {},
            "request_count": 0,
            "last_match_confidence": 1.0,
        }
        task["dir_name"] = self._task_dir_name(task)
        if isinstance(payload, dict) and payload.get("model"):
            task["model"] = payload.get("model")
        return task

    def _task_anchor(self, record: Mapping[str, object], kind: str, payload: object) -> str:
        if kind == "responses" and isinstance(payload, dict):
            previous_response_id = payload.get("previous_response_id")
            if isinstance(previous_response_id, str) and previous_response_id:
                return f"prev-{safe_filename_part(previous_response_id, limit=32)}"
        fingerprints = request_fingerprints(kind, payload)
        if fingerprints:
            first_key = sorted(fingerprints)[0]
            return f"fp-{fingerprints[first_key]}"
        return f"req-{str(record['id'])[:12]}"

    def _context_keys(self, payload: Mapping[str, object]) -> list[str]:
        keys: list[str] = []
        conversation = payload.get("conversation")
        conversation_id = first_string(
            conversation,
            get_nested_value(conversation, ("id",)),
            payload.get("conversation_id"),
            payload.get("thread_id"),
            get_nested_value(payload, ("metadata", "conversation_id")),
            get_nested_value(payload, ("metadata", "thread_id")),
            get_nested_value(payload, ("metadata", "session_id")),
        )
        if conversation_id:
            keys.append(f"conversation:{conversation_id}")
        return keys

    def _task_request_dir_name(self, record: Mapping[str, object], sequence: int) -> str:
        request = record["request"]  # type: ignore[index]
        started_at = record.get("started_timestamp", record.get("timestamp"))
        time_part = local_time_from_timestamp_for_filename(started_at)
        path = safe_filename_part(request["path"], "root")  # type: ignore[index]
        return f"{sequence:03d}__{time_part}__{path}__{record['id']}"

    def _task_anchor_from_dir_name(self, dir_name: str) -> str | None:
        parts = str(dir_name).split("__")
        if len(parts) >= 4:
            return parts[-1]
        if len(parts) >= 3:
            return parts[-1]
        return None

    def _task_dir_name(self, task: Mapping[str, object]) -> str:
        started_at = task.get("started_at") or task.get("last_seen_at") or utc_now_iso()
        last_response_at = task.get("last_response_at") or started_at
        start_part = local_datetime_for_filename(started_at)
        end_part = local_time_from_timestamp_for_filename(last_response_at)
        kind = safe_filename_part(task.get("kind"), "task")
        anchor = safe_filename_part(
            task.get("anchor") or self._task_anchor_from_dir_name(str(task.get("dir_name") or "")),
            "task",
        )
        return f"{start_part}__{end_part}__{kind}__{anchor}"

    def _sync_task_dir_name(self, task: dict[str, object]) -> None:
        new_dir_name = self._task_dir_name(task)
        old_dir_name = str(task.get("dir_name") or "")
        if new_dir_name == old_dir_name:
            return
        if self.readable_dir and old_dir_name:
            old_task_path = self.readable_dir / "tasks" / old_dir_name
            new_task_path = self.readable_dir / "tasks" / new_dir_name
            if old_task_path.exists() and not new_task_path.exists():
                old_task_path.rename(new_task_path)
        task["dir_name"] = new_dir_name

    def _write_task_readable(self, record: Mapping[str, object], readable_filename: str) -> None:
        task_ref = record.get("task")
        if not isinstance(task_ref, dict) or not self.readable_dir:
            return
        task_dir_name = task_ref.get("dir")
        sequence = task_ref.get("request_sequence")
        if not task_dir_name or not sequence:
            return
        tasks = self.task_index.get("tasks")
        task = tasks.get(task_ref.get("id")) if isinstance(tasks, dict) else None
        if not isinstance(task, dict):
            return
        requests = task.get("requests")
        request_info = requests.get(str(record["id"])) if isinstance(requests, dict) else None
        if not isinstance(request_info, dict):
            return

        task_path = self.readable_dir / "tasks" / str(task_dir_name)
        request_path_in_task = task_path / str(request_info["dir_name"])
        self._ensure_readable_dir(request_path_in_task)
        for existing_markdown in request_path_in_task.glob("*.md"):
            if existing_markdown.name != readable_filename:
                existing_markdown.unlink()
        (request_path_in_task / readable_filename).write_text(self._render_markdown(record), encoding="utf-8")
        self._write_body_json_files(request_path_in_task, dict(record))
        self._write_task_index_markdown(task_path, task)

    def _write_task_index_markdown(self, task_path: Path, task: Mapping[str, object]) -> None:
        task_path.mkdir(parents=True, exist_ok=True)
        requests = task.get("requests")
        request_items = list(requests.items()) if isinstance(requests, dict) else []
        request_items.sort(key=lambda item: item[1].get("sequence", 0) if isinstance(item[1], dict) else 0)
        parts = [
            f"# LLM Task {task.get('id')}",
            "",
            "## Summary",
            "",
            f"- Kind: {task.get('kind')}",
            f"- Started: {task.get('started_at')}",
            f"- Last seen: {task.get('last_seen_at')}",
            f"- Requests: {task.get('request_count', len(request_items))}",
        ]
        if task.get("model"):
            parts.append(f"- Model: {task.get('model')}")
        parts.extend(["", "## Timeline", ""])
        for request_id, info in request_items:
            if not isinstance(info, dict):
                continue
            status = info.get("status")
            status_text = "pending" if status is None else str(status)
            method = info.get("method", "")
            path = info.get("path", "")
            duration = info.get("duration_ms", 0)
            dir_name = info.get("dir_name")
            parts.append(
                f"- {int(info.get('sequence', 0)):03d} `{method} {path}` -> {status_text} "
                f"({duration} ms) [{request_id}]({dir_name}/)"
            )
        parts.append("")
        (task_path / "index.md").write_text("\n".join(parts), encoding="utf-8")

    def _ensure_readable_dir(self, path: Path) -> None:
        if path.is_file():
            path.unlink()
        path.mkdir(parents=True, exist_ok=True)

    def _write_json_file(self, path: Path, value: object) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def _write_body_json_files(self, path: Path, record: dict[str, object]) -> None:
        request = record["request"]  # type: ignore[assignment]
        response = record["response"]  # type: ignore[assignment]
        self._write_json_file(path / "request.json", body_json_value(request["body"]))  # type: ignore[index]
        self._write_json_file(path / "response.json", body_json_value(response["body"]))  # type: ignore[index]

    def _readable_dir_name(self, record: dict[str, object]) -> str:
        """Return directory name with __ separators, original format."""
        timestamp = local_datetime_for_filename(readable_start_timestamp(record))
        method = str(record["request"]["method"])  # type: ignore[index]
        path = str(record["request"]["path"])  # type: ignore[index]
        safe_path = "".join(ch if ch.isalnum() else "-" for ch in path).strip("-")
        safe_path = safe_path[:80] or "root"
        return f"{timestamp}__{method}__{safe_path}__{record['id']}"

    def _readable_filename(self, record: dict[str, object]) -> str:
        """Return MD filename with only time: {start_time}__{end_time}.md."""
        start_time = readable_start_timestamp(record)
        duration_ms = record["duration_ms"]

        start_dt = dt.datetime.fromisoformat(str(start_time))
        end_dt = start_dt + dt.timedelta(milliseconds=duration_ms)

        start_str = local_time_from_timestamp_for_filename(start_time)
        end_str = end_dt.astimezone().strftime("%H-%M-%S.%f")[:-3]

        return f"{start_str}__{end_str}.md"

    def _render_markdown(self, record: dict[str, object]) -> str:
        request = record["request"]  # type: ignore[assignment]
        response = record["response"]  # type: ignore[assignment]
        target = record["target"]  # type: ignore[assignment]
        client = record["client"]  # type: ignore[assignment]
        error = record.get("error")
        parts = [
            f"# LLM Interaction {record['id']}",
            "",
            "## Summary",
            "",
            f"- Time: {record['timestamp']}",
            f"- Event: {record.get('event', 'interaction')}",
            f"- Duration: {format_duration_hms(record['duration_ms'])} ({record['duration_ms']} ms)",
            f"- Client: {client['host']}:{client['port']}",  # type: ignore[index]
            f"- Target: {target['scheme']}://{target['host']}:{target['port']}{target['path']}",  # type: ignore[index]
            f"- Request: {request['method']} {request['path']}",  # type: ignore[index]
            f"- Response: {response['status']}",  # type: ignore[index]
        ]
        if error:
            parts.append(f"- Error: {error}")
        stripped_fields = request.get("stripped_fields") if isinstance(request, dict) else None
        if stripped_fields:
            parts.append(f"- Stripped request fields: {', '.join(str(field) for field in stripped_fields)}")
        added_headers = request.get("added_upstream_headers") if isinstance(request, dict) else None
        if added_headers:
            parts.append(f"- Added upstream headers: {', '.join(str(field) for field in added_headers)}")
        task = record.get("task")
        if isinstance(task, dict):
            parts.append(f"- Task: {task.get('kind')} / {task.get('id')} / request {task.get('request_sequence')}")
        parts.extend(
            [
                "",
                "## Request Headers",
                "",
                "```text",
                render_headers(request["headers"]),  # type: ignore[index]
                "```",
                "",
                "## Request Body",
                "",
                "See `request.json`.",
            ]
        )
        parts.extend(
            [
                "",
                "## Response Headers",
                "",
                "```text",
                render_headers(response["headers"]),  # type: ignore[index]
                "```",
                "",
                "## Response Body",
                "",
                "See `response.json`.",
                "",
            ]
        )
        return "\n".join(parts)

    def write_index(self, record: dict[str, object]) -> None:
        if not self.readable_dir:
            return


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        self._proxy()

    def do_PUT(self) -> None:
        self._proxy()

    def do_PATCH(self) -> None:
        self._proxy()

    def do_DELETE(self) -> None:
        self._proxy()

    def do_OPTIONS(self) -> None:
        self._proxy()

    def do_HEAD(self) -> None:
        self._proxy()

    def log_message(self, fmt: str, *args: object) -> None:
        if self.server_config["access_log"]:
            super().log_message(fmt, *args)

    @property
    def server_config(self) -> dict[str, object]:
        return self.server.config  # type: ignore[attr-defined]

    @property
    def traffic_logger(self) -> TrafficLogger:
        return self.server.traffic_logger  # type: ignore[attr-defined]

    def _read_request_body(self) -> bytes:
        length = self.headers.get("Content-Length")
        if not length:
            return b""
        try:
            body_size = int(length)
        except ValueError:
            return b""
        return self.rfile.read(body_size) if body_size > 0 else b""

    def _forward_headers(self) -> list[tuple[str, str]]:
        forwarded: list[tuple[str, str]] = []
        target_host = str(self.server_config["target_host"])
        target_port = int(self.server_config["target_port"])
        target_scheme = str(self.server_config["target_scheme"])
        default_port = DEFAULT_PORTS[target_scheme]
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP_HEADERS or key.lower() == "host":
                continue
            forwarded.append((key, value))
        host_header = target_host if target_port == default_port else f"{target_host}:{target_port}"
        forwarded.append(("Host", host_header))
        forwarded.append(("X-Forwarded-For", self.client_address[0]))
        forwarded.append(("X-Forwarded-Host", self.headers.get("Host", "")))
        override_keys = {key.lower() for key, _ in self.server_config["target_headers"]}  # type: ignore[index]
        if override_keys:
            forwarded = [(key, value) for key, value in forwarded if key.lower() not in override_keys]
            forwarded.extend(self.server_config["target_headers"])  # type: ignore[arg-type]
        return forwarded

    def _upstream_headers(self, body_size: int) -> list[tuple[str, str]]:
        headers = self._forward_headers()
        headers = [(key, value) for key, value in headers if key.lower() != "content-length"]
        if body_size > 0 or "Content-Length" in self.headers:
            headers.append(("Content-Length", str(body_size)))
        return headers

    def _proxy(self) -> None:
        request_id = uuid.uuid4().hex
        started = time.perf_counter()
        target_scheme = str(self.server_config["target_scheme"])
        target_host = str(self.server_config["target_host"])
        target_port = int(self.server_config["target_port"])
        target_base_path = str(self.server_config["target_base_path"])
        target_path = join_target_path(target_base_path, self.path)
        timeout = float(self.server_config["timeout"])
        response_body_parts: list[bytes] = []
        response_status = 502
        response_headers: list[tuple[str, str]] = []
        error: str | None = None
        sent_downstream_headers = False
        initial_request_record: dict[str, object] = {
            "method": self.command,
            "path": self.path,
            "headers": headers_to_dict(self.headers.items()),
            "body": bytes_payload(b""),
            "body_pending": True,
        }
        initial_record: dict[str, object] = {
            "id": request_id,
            "timestamp": utc_now_iso(),
            "client": {
                "host": self.client_address[0],
                "port": self.client_address[1],
            },
            "target": {
                "scheme": target_scheme,
                "host": target_host,
                "port": target_port,
                "path": target_path,
            },
            "request": initial_request_record,
        }
        initial_record["started_timestamp"] = initial_record["timestamp"]
        self.traffic_logger.write(
            {
                **initial_record,
                "event": "request_received",
                "duration_ms": 0,
                "response": {
                    "status": None,
                    "headers": {},
                    "body": bytes_payload(b""),
                },
            }
        )

        request_body = self._read_request_body()
        upstream_request_body, stripped_request_fields = strip_request_json_fields(
            request_body, self.server_config["strip_request_fields"]  # type: ignore[arg-type]
        )
        request_record: dict[str, object] = {
            "method": self.command,
            "path": self.path,
            "headers": headers_to_dict(self.headers.items()),
            "body": bytes_payload(request_body),
        }
        if stripped_request_fields:
            request_record["stripped_fields"] = stripped_request_fields
            request_record["upstream_body"] = bytes_payload(upstream_request_body)
        target_headers = self.server_config["target_headers"]  # type: ignore[assignment]
        if target_headers:
            request_record["added_upstream_headers"] = [key for key, _ in target_headers]  # type: ignore[union-attr]
        base_record = {
            **initial_record,
            "request": request_record,
        }
        self.traffic_logger.update_readable(
            {
                **base_record,
                "event": "request_pending_response",
                "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                "response": {
                    "status": None,
                    "headers": {},
                    "body": bytes_payload(b""),
                },
            }
        )

        try:
            conn_class = http.client.HTTPSConnection if target_scheme == "https" else http.client.HTTPConnection
            conn = conn_class(target_host, target_port, timeout=timeout)
            conn.putrequest(self.command, target_path, skip_host=True, skip_accept_encoding=True)
            for key, value in self._upstream_headers(len(upstream_request_body)):
                conn.putheader(key, value)
            conn.endheaders(upstream_request_body)

            upstream = conn.getresponse()
            response_status = upstream.status
            response_headers = upstream.getheaders()
            self.send_response(upstream.status, upstream.reason)
            for key, value in response_headers:
                lower_key = key.lower()
                if lower_key in HOP_BY_HOP_HEADERS or lower_key == "content-length":
                    continue
                self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            sent_downstream_headers = True

            if self.command != "HEAD":
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    response_body_parts.append(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
            conn.close()
        except Exception as exc:  # noqa: BLE001 - proxy must record operational failures.
            error = repr(exc)
            if not sent_downstream_headers and not self.wfile.closed:
                self.send_error(502, "Bad Gateway", error)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 3)
            response_body = b"".join(response_body_parts)
            record = {
                **base_record,
                "event": "request_finished",
                "timestamp": utc_now_iso(),
                "duration_ms": duration_ms,
                "response": {
                    "status": response_status,
                    "headers": headers_to_dict(response_headers),
                    "body": bytes_payload(response_body),
                },
            }
            if error:
                record["error"] = error
            self.traffic_logger.write(record)
            self.close_connection = True


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        listen: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        config: dict[str, object],
        traffic_logger: TrafficLogger,
    ) -> None:
        super().__init__(listen, handler_class)
        self.config = config
        self.traffic_logger = traffic_logger


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Record and proxy LLM HTTP traffic.")
    parser.add_argument("--listen-host", default=os.getenv("LLM_PROXY_HOST", "127.0.0.1"))
    parser.add_argument("--listen-port", type=int, default=int(os.getenv("LLM_PROXY_PORT", "1234")))
    parser.add_argument(
        "--target-url",
        default=None,
        help="Full upstream base URL, e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:1235.",
    )
    parser.add_argument("--target-scheme", default=os.getenv("LLM_PROXY_TARGET_SCHEME", "http"))
    parser.add_argument("--target-host", default=os.getenv("LLM_PROXY_TARGET_HOST", "127.0.0.1"))
    parser.add_argument("--target-port", type=int, default=int(os.getenv("LLM_PROXY_TARGET_PORT", "1235")))
    parser.add_argument(
        "--target-header",
        action="append",
        default=None,
        help="Header to add or override when forwarding upstream. Can be repeated. Format: 'Name: value'.",
    )
    parser.add_argument("--log-file", default=os.getenv("LLM_PROXY_LOG_FILE", "logs/interactions.jsonl"))
    parser.add_argument(
        "--readable-log-dir",
        default=os.getenv("LLM_PROXY_READABLE_LOG_DIR", "logs/readable"),
        help="Write one human-readable Markdown file per interaction. Use empty string to disable.",
    )
    parser.add_argument("--timeout", type=float, default=float(os.getenv("LLM_PROXY_TIMEOUT", "600")))
    parser.add_argument(
        "--strip-request-fields",
        default=os.getenv("LLM_PROXY_STRIP_REQUEST_FIELDS"),
        help=(
            "Comma-separated top-level JSON request fields to remove before forwarding. "
            f"Default: {','.join(DEFAULT_STRIP_REQUEST_FIELDS)}. Use empty string to disable."
        ),
    )
    parser.add_argument(
        "--text-limit",
        type=int,
        default=int(os.getenv("LLM_PROXY_TEXT_LIMIT", "0")),
        help="Deprecated: logs always keep complete body data.",
    )
    parser.add_argument("--access-log", action="store_true", default=os.getenv("LLM_PROXY_ACCESS_LOG") == "1")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target = parse_target(args)
    target_headers = parse_header_overrides(args.target_header)
    strip_request_fields = parse_strip_request_fields(args.strip_request_fields)
    log_file = Path(args.log_file)
    readable_dir = Path(args.readable_log_dir) if args.readable_log_dir else None
    logger = TrafficLogger(log_file, readable_dir)
    config = {
        "target_scheme": target["scheme"],
        "target_host": target["host"],
        "target_port": target["port"],
        "target_base_path": target["base_path"],
        "target_headers": target_headers,
        "strip_request_fields": strip_request_fields,
        "timeout": args.timeout,
        "access_log": args.access_log,
    }
    server = ProxyServer((args.listen_host, args.listen_port), ProxyHandler, config, logger)
    listen_url = f"http://{args.listen_host}:{args.listen_port}"
    target_url = str(target["display_url"])
    print(f"LLM proxy listening on {listen_url}", flush=True)
    print(f"Forwarding to {target_url}", flush=True)
    print(f"Writing JSONL logs to {log_file.resolve()}", flush=True)
    if readable_dir:
        print(f"Writing readable logs to {readable_dir.resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
