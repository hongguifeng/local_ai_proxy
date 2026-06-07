"""Compaction helpers for OpenAI-compatible streaming responses."""

from __future__ import annotations

import json
from typing import Mapping

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


