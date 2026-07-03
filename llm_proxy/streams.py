"""OpenAI 兼容流式响应的压缩工具。

模型接口常用 SSE（Server-Sent Events）返回流式数据，原始内容会是一堆
``data: {...}`` 片段。直接读这些片段很费劲，所以这里把它们合并成一个摘要：
最终文本、推理文本、工具调用参数、用量信息等。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field


def merge_tool_call_delta(merged: dict[int, dict[str, object]], tool_call: object) -> None:
    """合并 Chat Completions 流里的工具调用增量。

    流式返回时，工具调用的 arguments 经常被拆成很多小段。
    这个函数按 ``index`` 找到同一个工具调用，并把 arguments 字符串拼回去。
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
    """把多个工具调用增量压缩成完整工具调用列表。"""
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
                # arguments 通常是 JSON 字符串；能解析时额外放一份对象，阅读更方便。
                function["arguments_json"] = json.loads(arguments)
            except json.JSONDecodeError:
                pass
    return compacted


def compact_response_tool_calls(tool_calls: dict[str, dict[str, object]]) -> list[object]:
    """压缩 Responses API 的函数调用参数。"""
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
    """只保留 Responses API 响应里最有用的顶层字段。

    完整 response 对象可能很大，readable 日志只需要能快速判断状态、模型、
    上下文关系和错误信息。
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
    """解析 SSE 里的 JSON data 片段，并记录是否见到 ``[DONE]``。"""
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
            # 只要有一个 data 片段不是 JSON，就说明它不是我们能安全压缩的流。
            return None
    if not events:
        return None
    return events, done_seen


@dataclass
class StreamAccumulator:
    """把不同 OpenAI 兼容流事件累积成 readable 日志摘要。"""

    event_count: int
    done_seen: bool
    content_parts: list[str] = field(default_factory=list)
    reasoning_parts: list[str] = field(default_factory=list)
    tool_calls: list[object] = field(default_factory=list)
    response_tool_calls: dict[str, dict[str, object]] = field(default_factory=dict)
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

        self.add_chat_event(event)

    def add_response_event(self, event_type: str, event: Mapping[str, object]) -> None:
        # Responses API 的事件类型以 response. 开头，字段结构和 Chat Completions 不同。
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
        # 函数调用参数也是分片返回的，需要按 item_id/call_id 拼起来。
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

    def add_chat_event(self, event: Mapping[str, object]) -> None:
        if event.get("usage"):
            self.usage = event["usage"]
        choices = event.get("choices")
        if not isinstance(choices, list):
            self.other_payloads.append(event)
            return

        # Chat Completions 的流式内容通常放在 choices[].delta 或 choices[].message 里。
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
        # 只写入实际出现过的信息，避免日志里充满空字段。
        if self.reasoning_parts:
            stream_summary["reasoning"] = "".join(self.reasoning_parts)
        if self.content_parts:
            stream_summary["content"] = "".join(self.content_parts)
        if self.response_tool_calls:
            stream_summary["response_tool_calls"] = compact_response_tool_calls(
                self.response_tool_calls
            )
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
    """把 SSE 文本压缩成 JSON 摘要。

    如果输入不是可识别的 SSE，返回 ``None``，让调用方按普通文本/JSON 处理。
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
