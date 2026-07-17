import json
import unittest

from llm_proxy import (
    body_json_value,
    compact_sse_json,
)
from llm_proxy.streams import StreamAccumulator


class StreamSummaryTests(unittest.TestCase):
    """Verify that SSE streaming responses can be compressed into stored summaries."""

    def parse_summary(self, text: str) -> dict[str, object]:
        compacted = compact_sse_json(text)
        self.assertIsNotNone(compacted)
        return json.loads(str(compacted))["stream_summary"]

    def test_compacts_responses_stream_text_deltas(self) -> None:
        body = (
            b'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'
            b'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
            b'data: {"type":"response.output_text.delta","delta":" world"}\n\n'
            b'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
            b"data: [DONE]\n\n"
        )

        self.assertEqual(
            body_json_value(
                {
                    "size_bytes": len(body),
                    "base64": "",
                    "text": body.decode("utf-8"),
                }
            ),
            {
                "stream_summary": {
                    "event_count": 4,
                    "done_seen": True,
                    "content": "Hello world",
                    "usage": {"input_tokens": 3, "output_tokens": 2},
                    "response": {"id": "resp_1"},
                }
            },
        )

    def test_invalid_sse_data_falls_back_to_text_body(self) -> None:
        text = "data: {not json}\n\n"

        self.assertIsNone(compact_sse_json(text))
        self.assertEqual(
            body_json_value(
                {
                    "size_bytes": len(text),
                    "base64": "",
                    "text": text,
                }
            ),
            {
                "text": text,
                "size_bytes": len(text),
            },
        )

    def test_compacts_chat_completion_content_reasoning_and_finish_reason(self) -> None:
        summary = self.parse_summary(
            "\n\n".join(
                [
                    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
                    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
                    (
                        'data: {"choices":[{"delta":{"text":" world"},'
                        '"finish_reason":"stop"}],"usage":{"total_tokens":9}}'
                    ),
                    "data: [DONE]",
                ]
            )
        )

        self.assertEqual(
            summary,
            {
                "event_count": 3,
                "done_seen": True,
                "reasoning": "think ",
                "content": "Hello world",
                "finish_reasons": ["stop"],
                "usage": {"total_tokens": 9},
            },
        )

    def test_compacts_chat_completion_tool_call_deltas(self) -> None:
        summary = self.parse_summary(
            "\n\n".join(
                [
                    (
                        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
                        '"id":"call_1","type":"function","function":{"name":"lookup",'
                        '"arguments":"{\\"city\\":"}}]}}]}'
                    ),
                    (
                        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
                        '"function":{"arguments":"\\"Shanghai\\"}"}}]}}]}'
                    ),
                ]
            )
        )

        self.assertEqual(
            summary["tool_calls"],
            [
                {
                    "index": 0,
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "arguments": '{"city":"Shanghai"}',
                        "arguments_json": {"city": "Shanghai"},
                    },
                }
            ],
        )

    def test_compacts_response_function_call_argument_deltas(self) -> None:
        summary = self.parse_summary(
            "\n\n".join(
                [
                    (
                        'data: {"type":"response.function_call_arguments.delta",'
                        '"item_id":"item_1","call_id":"call_1","output_index":0,'
                        '"delta":"{\\"q\\":"}'
                    ),
                    (
                        'data: {"type":"response.function_call_arguments.delta",'
                        '"item_id":"item_1","delta":"\\"docs\\"}"}'
                    ),
                    'data: {"type":"response.completed","response":{"status":"completed"}}',
                ]
            )
        )

        self.assertEqual(
            summary,
            {
                "event_count": 3,
                "done_seen": False,
                "response_tool_calls": [
                    {
                        "arguments": '{"q":"docs"}',
                        "item_id": "item_1",
                        "call_id": "call_1",
                        "output_index": 0,
                        "arguments_json": {"q": "docs"},
                    }
                ],
                "finish_reasons": ["completed"],
                "response": {"status": "completed"},
            },
        )

    def test_compacts_response_web_search_call_events(self) -> None:
        summary = self.parse_summary(
            "\n\n".join(
                [
                    (
                        'data: {"type":"response.output_item.added","output_index":0,'
                        '"item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}'
                    ),
                    'data: {"type":"response.web_search_call.searching","item_id":"ws_1","output_index":0}',
                    'data: {"type":"response.web_search_call.completed","item_id":"ws_1","output_index":0}',
                    (
                        'data: {"type":"response.output_item.done","output_index":0,'
                        '"item":{"id":"ws_1","type":"web_search_call","status":"completed",'
                        '"action":{"type":"search","query":"latest docs","queries":["latest docs"]}}}'
                    ),
                    'data: {"type":"response.completed","response":{"status":"completed"}}',
                ]
            )
        )

        self.assertEqual(
            summary["web_search_calls"],
            [
                {
                    "type": "web_search_call",
                    "id": "ws_1",
                    "item_id": "ws_1",
                    "status": "completed",
                    "output_index": 0,
                    "action": {"type": "search", "query": "latest docs", "queries": ["latest docs"]},
                }
            ],
        )

    def test_ignores_unknown_response_events(self) -> None:
        summary = self.parse_summary(
            "\n\n".join(
                [
                    (
                        'data: {"type":"response.output_item.done","output_index":1,'
                        '"item":{"id":"mcp_1","type":"mcp_call","status":"completed","name":"fetch"}}'
                    ),
                    'data: {"type":"response.completed","response":{"status":"completed"}}',
                ]
            )
        )

        self.assertNotIn("unknown_response_events", summary)

    def test_compacts_claude_messages_stream_text_thinking_and_tool_use(self) -> None:
        summary = self.parse_summary(
            "\n\n".join(
                [
                    (
                        'data: {"type":"message_start","message":{"id":"msg_1",'
                        '"type":"message","role":"assistant","model":"claude-sonnet-4",'
                        '"usage":{"input_tokens":8}}}'
                    ),
                    (
                        'data: {"type":"content_block_delta","index":0,'
                        '"delta":{"type":"thinking_delta","thinking":"plan "}}'
                    ),
                    (
                        'data: {"type":"content_block_delta","index":1,'
                        '"delta":{"type":"text_delta","text":"Hello"}}'
                    ),
                    (
                        'data: {"type":"content_block_start","index":2,'
                        '"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}'
                    ),
                    (
                        'data: {"type":"content_block_delta","index":2,'
                        '"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}'
                    ),
                    (
                        'data: {"type":"content_block_delta","index":2,'
                        '"delta":{"type":"input_json_delta","partial_json":"\\"docs\\"}"}}'
                    ),
                    (
                        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},'
                        '"usage":{"output_tokens":5}}'
                    ),
                    "data: [DONE]",
                ]
            )
        )

        self.assertEqual(
            summary,
            {
                "event_count": 7,
                "done_seen": True,
                "reasoning": "plan ",
                "content": "Hello",
                "claude_tool_calls": [
                    {
                        "index": 2,
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "lookup",
                        "input": {"q": "docs"},
                    }
                ],
                "finish_reasons": ["end_turn"],
                "usage": {"input_tokens": 8, "output_tokens": 5},
                "response": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4",
                    "usage": {"input_tokens": 8},
                },
            },
        )

    def test_summary_contract_covers_all_optional_fields_and_unknown_payloads(self) -> None:
        accumulator = StreamAccumulator(event_count=12, done_seen=True)
        events = [
            {"type": "response.created", "response": {"id": "resp_all", "model": "fixture"}},
            {"type": "response.output_text.delta", "delta": "response content"},
            {"type": "response.reasoning_text.delta", "delta": "response reasoning"},
            {
                "type": "response.function_call_arguments.done",
                "item_id": "item_all",
                "call_id": "call_all",
                "arguments": '{"value":1}',
            },
            {
                "type": "response.web_search_call.completed",
                "item_id": "search_all",
                "status": "completed",
            },
            {
                "type": "content_block_start",
                "index": 2,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_all",
                    "name": "claude_tool",
                    "input": {"value": 2},
                },
            },
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "chat_call_all",
                                    "type": "function",
                                    "function": {"name": "chat_tool", "arguments": '{"value":3}'},
                                }
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"total_tokens": 13},
            },
            {"fixture_unknown": "preserved"},
            {"type": "error", "error": {"type": "fixture_error"}},
            {"type": "response.future.event", "value": "ignored response event"},
            {
                "type": "response.completed",
                "response": {"id": "resp_all", "status": "completed", "usage": {"total_tokens": 21}},
            },
            {"type": "ping"},
        ]
        for event in events:
            accumulator.add_event(event)

        summary = accumulator.summary()["stream_summary"]

        self.assertEqual(
            set(summary),
            {
                "event_count",
                "done_seen",
                "reasoning",
                "content",
                "response_tool_calls",
                "web_search_calls",
                "claude_tool_calls",
                "tool_calls",
                "finish_reasons",
                "usage",
                "response",
                "other_payloads",
            },
        )
        self.assertEqual(summary["event_count"], 12)
        self.assertTrue(summary["done_seen"])
        self.assertEqual(summary["content"], "response content")
        self.assertEqual(summary["reasoning"], "response reasoning")
        self.assertEqual(summary["usage"], {"total_tokens": 21})
        self.assertEqual(summary["finish_reasons"], ["tool_calls", "completed"])
        self.assertEqual(summary["response"]["id"], "resp_all")
        self.assertEqual(summary["response_tool_calls"][0]["arguments_json"], {"value": 1})
        self.assertEqual(summary["web_search_calls"][0]["status"], "completed")
        self.assertEqual(summary["claude_tool_calls"][0]["input"], {"value": 2})
        self.assertEqual(summary["tool_calls"][0]["function"]["arguments_json"], {"value": 3})
        self.assertEqual(
            summary["other_payloads"],
            [
                {"fixture_unknown": "preserved"},
                {"type": "error", "error": {"type": "fixture_error"}},
            ],
        )
