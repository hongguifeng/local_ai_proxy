#!/usr/bin/env python3
"""Small HTTP proxy for recording llama.cpp/OpenAI-compatible traffic."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
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


class TrafficLogger:
    def __init__(self, path: Path, readable_dir: Path | None) -> None:
        self.path = path
        self.readable_dir = readable_dir
        self.lock = threading.Lock()
        self.readable_paths: dict[str, Path] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.readable_dir:
            self.readable_dir.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict[str, object]) -> None:
        with self.lock:
            with self.path.open("a", encoding="utf-8") as file:
                json.dump(record, file, ensure_ascii=False, separators=(",", ":"))
                file.write("\n")
            self._write_readable(record)

    def update_readable(self, record: dict[str, object]) -> None:
        with self.lock:
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
