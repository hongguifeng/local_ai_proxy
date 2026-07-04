import json
import unittest

from llm_proxy import (
    body_json_value,
    compact_sse_json,
)


class StreamSummaryTests(unittest.TestCase):
    """Verify that SSE streaming responses can be compressed into readable summaries."""

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
