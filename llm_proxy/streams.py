"""Compression utilities for OpenAI-compatible streaming responses.

Model APIs commonly return streaming data via SSE (Server-Sent Events), consisting of many
``data: {...}`` fragments. Reading these fragments directly is cumbersome, so here they are merged into a summary:
final text, reasoning text, tool call arguments, usage info, etc.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field


def merge_tool_call_delta(merged: dict[int, dict[str, object]], tool_call: object) -> None:
    """Merge tool call deltas from Chat Completions streams.

    When streaming, tool call arguments are often split into many small chunks.
    This function finds the same tool call by ``index`` and concatenates the arguments string back together.
    """
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
    """Compress multiple tool call deltas into a complete tool call list."""
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
    compacted: list[object] = [merged[index] for index in sorted(merged)]
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
                # arguments is usually a JSON string; when parseable, also store an object for easier reading.
                function["arguments_json"] = json.loads(arguments)
            except json.JSONDecodeError:
                pass
    return compacted


def compact_response_tool_calls(tool_calls: dict[str, dict[str, object]]) -> list[object]:
    """Compress function call arguments from the Responses API."""
    compacted: list[object] = []
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


def compact_claude_tool_calls(tool_calls: dict[int, dict[str, object]]) -> list[object]:
    """Compress tool_use blocks from Anthropic/Claude Messages streams."""
    compacted: list[object] = []
    for index in sorted(tool_calls):
        tool_call = dict(tool_calls[index])
        input_json = tool_call.pop("input_json", None)
        if isinstance(input_json, str) and input_json:
            try:
                tool_call["input"] = json.loads(input_json)
            except json.JSONDecodeError:
                tool_call["input_json"] = input_json
        compacted.append(tool_call)
    return compacted


def compact_response_payload(response: Mapping[str, object]) -> dict[str, object]:
    """Keep only the most useful top-level fields from the Responses API response.

    The full response object can be large; stored logs only need to quickly determine status, model,
    context relationships, and error information.
    """
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


def parse_sse_events(text: str) -> tuple[list[object], bool] | None:
    """Parse JSON data fragments from SSE and track whether ``[DONE]`` is seen."""
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
            # If any data fragment is not JSON, it means it's not a stream we can safely compress.
            return None
    if not events:
        return None
    return events, done_seen


@dataclass
class StreamAccumulator:
    """Accumulate different OpenAI-compatible stream events into a stored log summary."""

    event_count: int
    done_seen: bool
    content_parts: list[str] = field(default_factory=list)
    reasoning_parts: list[str] = field(default_factory=list)
    tool_calls: list[object] = field(default_factory=list)
    response_tool_calls: dict[str, dict[str, object]] = field(default_factory=dict)
    claude_tool_calls: dict[int, dict[str, object]] = field(default_factory=dict)
    finish_reasons: list[str] = field(default_factory=list)
    usage: object | None = None
    response_payload: object | None = None
    other_payloads: list[object] = field(default_factory=list)

    def add_event(self, event: object) -> None:
        if not isinstance(event, dict):
            self.other_payloads.append(event)
            return

        event_type = event.get("type")
        if isinstance(event_type, str) and event_type.startswith("response."):
            self.add_response_event(event_type, event)
            return
        if isinstance(event_type, str) and event_type in {
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
            "ping",
            "error",
        }:
            self.add_claude_event(event_type, event)
            return

        self.add_chat_event(event)

    def add_response_event(self, event_type: str, event: Mapping[str, object]) -> None:
        # Responses API event types start with response. and have different field structures than Chat Completions.
        if event_type == "response.output_text.delta":
            self.append_string(self.content_parts, event.get("delta"))
        elif event_type == "response.output_text.done" and not self.content_parts:
            self.append_string(self.content_parts, event.get("text"))
        elif event_type in {
            "response.reasoning_text.delta",
            "response.reasoning_summary_text.delta",
        }:
            self.append_string(self.reasoning_parts, event.get("delta"))
        elif event_type in {
            "response.reasoning_text.done",
            "response.reasoning_summary_text.done",
        } and not self.reasoning_parts:
            self.append_string(self.reasoning_parts, event.get("text"))
        elif event_type == "response.function_call_arguments.delta":
            self.add_response_function_call_delta(event)
        elif event_type == "response.function_call_arguments.done":
            self.add_response_function_call_done(event)
        elif event_type in {"response.completed", "response.incomplete"}:
            self.add_response_completion(event)
        elif event_type == "response.created":
            response = event.get("response")
            if isinstance(response, dict) and self.response_payload is None:
                self.response_payload = compact_response_payload(response)

    def add_response_function_call_delta(self, event: Mapping[str, object]) -> None:
        # Function call arguments are also returned in chunks, need to concatenate by item_id/call_id.
        item_id = self.response_tool_call_key(event)
        tool_call = self.response_tool_calls.setdefault(item_id, {"arguments": ""})
        self.copy_response_tool_call_ids(tool_call, event)
        delta = event.get("delta")
        if isinstance(delta, str):
            tool_call["arguments"] = str(tool_call.get("arguments", "")) + delta

    def add_response_function_call_done(self, event: Mapping[str, object]) -> None:
        item_id = self.response_tool_call_key(event)
        tool_call = self.response_tool_calls.setdefault(item_id, {})
        self.copy_response_tool_call_ids(tool_call, event)
        arguments = event.get("arguments")
        if isinstance(arguments, str):
            tool_call["arguments"] = arguments

    def add_response_completion(self, event: Mapping[str, object]) -> None:
        response = event.get("response")
        if not isinstance(response, dict):
            return
        compacted_response = compact_response_payload(response)
        if compacted_response:
            self.response_payload = (
                {
                    **self.response_payload,
                    **compacted_response,
                }
                if isinstance(self.response_payload, dict)
                else compacted_response
            )
        if response.get("usage"):
            self.usage = response["usage"]
        status = response.get("status")
        if status:
            self.finish_reasons.append(str(status))

    def add_claude_event(self, event_type: str, event: Mapping[str, object]) -> None:
        # Anthropic/Claude Messages streams emit message_* and content_block_* events.
        if event_type == "message_start":
            message = event.get("message")
            if isinstance(message, dict):
                self.response_payload = self.compact_claude_message(message)
                if message.get("usage"):
                    self.usage = message["usage"]
        elif event_type == "content_block_start":
            self.add_claude_content_block_start(event)
        elif event_type == "content_block_delta":
            self.add_claude_content_block_delta(event)
        elif event_type == "message_delta":
            self.add_claude_message_delta(event)
        elif event_type == "error":
            self.other_payloads.append(event)

    def add_claude_content_block_start(self, event: Mapping[str, object]) -> None:
        raw_index = event.get("index", 0)
        index = raw_index if isinstance(raw_index, int) else 0
        block = event.get("content_block")
        if not isinstance(block, dict):
            return
        block_type = block.get("type")
        if block_type == "text":
            self.append_string(self.content_parts, block.get("text"))
        elif block_type == "thinking":
            self.append_string(self.reasoning_parts, block.get("thinking"))
        elif block_type == "tool_use":
            tool_call = self.claude_tool_calls.setdefault(index, {"index": index, "type": "tool_use"})
            for key in ("id", "name", "type"):
                value = block.get(key)
                if value is not None:
                    tool_call[key] = value
            input_value = block.get("input")
            if input_value is not None:
                tool_call["input"] = input_value

    def add_claude_content_block_delta(self, event: Mapping[str, object]) -> None:
        raw_index = event.get("index", 0)
        index = raw_index if isinstance(raw_index, int) else 0
        delta = event.get("delta")
        if not isinstance(delta, dict):
            return
        delta_type = delta.get("type")
        if delta_type == "text_delta":
            self.append_string(self.content_parts, delta.get("text"))
        elif delta_type == "thinking_delta":
            self.append_string(self.reasoning_parts, delta.get("thinking"))
        elif delta_type == "input_json_delta":
            tool_call = self.claude_tool_calls.setdefault(index, {"index": index, "type": "tool_use"})
            partial_json = delta.get("partial_json")
            if isinstance(partial_json, str):
                tool_call["input_json"] = str(tool_call.get("input_json", "")) + partial_json

    def add_claude_message_delta(self, event: Mapping[str, object]) -> None:
        delta = event.get("delta")
        if isinstance(delta, dict):
            stop_reason = delta.get("stop_reason")
            if stop_reason:
                self.finish_reasons.append(str(stop_reason))
        usage = event.get("usage")
        if usage:
            if isinstance(self.usage, dict) and isinstance(usage, dict):
                self.usage = {**self.usage, **usage}
            else:
                self.usage = usage

    @staticmethod
    def compact_claude_message(message: Mapping[str, object]) -> dict[str, object]:
        keep_keys = ("id", "type", "role", "model", "stop_reason", "stop_sequence")
        compacted = {key: message[key] for key in keep_keys if key in message}
        if message.get("usage"):
            compacted["usage"] = message["usage"]
        return compacted

    def add_chat_event(self, event: Mapping[str, object]) -> None:
        if event.get("usage"):
            self.usage = event["usage"]
        choices = event.get("choices")
        if not isinstance(choices, list):
            self.other_payloads.append(event)
            return

        # Chat Completions streaming content is usually in choices[].delta or choices[].message.
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            finish_reason = choice.get("finish_reason")
            if finish_reason:
                self.finish_reasons.append(str(finish_reason))
            delta = choice.get("delta")
            message = choice.get("message")
            for payload in (delta, message, choice):
                if not isinstance(payload, dict):
                    continue
                self.add_chat_payload(payload)

    def add_chat_payload(self, payload: Mapping[str, object]) -> None:
        for key in ("reasoning_content", "reasoning", "reasoning_text"):
            self.append_string(self.reasoning_parts, payload.get(key))
        self.append_string(self.content_parts, payload.get("content"))
        self.append_string(self.content_parts, payload.get("text"))
        value = payload.get("tool_calls")
        if value:
            self.tool_calls.append(value)

    def summary(self) -> dict[str, object]:
        stream_summary: dict[str, object] = {
            "event_count": self.event_count,
            "done_seen": self.done_seen,
        }
        # Only write information that actually appeared, avoid filling logs with empty fields.
        if self.reasoning_parts:
            stream_summary["reasoning"] = "".join(self.reasoning_parts)
        if self.content_parts:
            stream_summary["content"] = "".join(self.content_parts)
        if self.response_tool_calls:
            stream_summary["response_tool_calls"] = compact_response_tool_calls(
                self.response_tool_calls
            )
        if self.claude_tool_calls:
            stream_summary["claude_tool_calls"] = compact_claude_tool_calls(self.claude_tool_calls)
        if self.tool_calls:
            stream_summary["tool_calls"] = compact_tool_calls(self.tool_calls)
        if self.finish_reasons:
            stream_summary["finish_reasons"] = self.finish_reasons
        if self.usage:
            stream_summary["usage"] = self.usage
        if self.response_payload:
            stream_summary["response"] = self.response_payload
        if self.other_payloads:
            stream_summary["other_payloads"] = self.other_payloads
        return {"stream_summary": stream_summary}

    @staticmethod
    def append_string(parts: list[str], value: object) -> None:
        if isinstance(value, str) and value:
            parts.append(value)

    @staticmethod
    def response_tool_call_key(event: Mapping[str, object]) -> str:
        return str(
            event.get("item_id")
            or event.get("call_id")
            or event.get("output_index")
            or "0"
        )

    @staticmethod
    def copy_response_tool_call_ids(
        tool_call: dict[str, object],
        event: Mapping[str, object],
    ) -> None:
        for key in ("item_id", "call_id", "output_index"):
            value = event.get(key)
            if value is not None:
                tool_call[key] = value


def compact_sse_json(text: str) -> str | None:
    """Compress SSE text into a JSON summary.

    If the input is not recognizable SSE, return ``None`` so the caller handles it as plain text/JSON.
    """
    parsed = parse_sse_events(text)
    if parsed is None:
        return None
    events, done_seen = parsed
    accumulator = StreamAccumulator(event_count=len(events), done_seen=done_seen)
    for event in events:
        accumulator.add_event(event)
    summary = accumulator.summary()
    return json.dumps(summary, ensure_ascii=False, indent=2)
