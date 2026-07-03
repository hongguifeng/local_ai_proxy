import json
import unittest

from llm_proxy import (
    body_json_value,
    compact_sse_json,
)


class StreamSummaryTests(unittest.TestCase):
    """验证 SSE 流式响应可以被压缩成可读摘要。"""

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
