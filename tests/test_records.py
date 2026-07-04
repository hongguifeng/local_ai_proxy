import unittest

from llm_proxy.records import (
    display_endpoint,
    request_message_count,
    response_token_count,
)


class RecordSummaryTests(unittest.TestCase):
    def test_counts_messages_for_common_request_shapes(self) -> None:
        self.assertEqual(
            request_message_count(
                "messages",
                {
                    "system": [{"text": "system"}, {"text": "developer"}],
                    "messages": [{"role": "user"}, {"role": "assistant"}],
                },
            ),
            4,
        )
        self.assertEqual(
            request_message_count(
                "responses",
                {
                    "instructions": "system",
                    "input": [{"role": "user"}, {"type": "function_call"}],
                },
            ),
            3,
        )
        self.assertEqual(request_message_count("chat", {"messages": [{"role": "system"}, {"role": "user"}]}), 2)
        self.assertEqual(request_message_count("completions", {"prompt": ["a", "b"]}), 2)

    def test_reads_token_counts_from_usage_shapes(self) -> None:
        self.assertEqual(response_token_count({"usage": {"total_tokens": 9}}), 9)
        self.assertEqual(
            response_token_count({"stream_summary": {"usage": {"input_tokens": 3, "output_tokens": 2}}}),
            5,
        )
        self.assertEqual(response_token_count({"response": {"usage": {"input_tokens": 4}}}), 4)
        self.assertIsNone(response_token_count({"ok": True}))

    def test_normalizes_display_endpoint(self) -> None:
        self.assertEqual(display_endpoint("/v1/responses?foo=bar/"), "/v1/responses")
        self.assertEqual(display_endpoint("/v1/messages/"), "/v1/messages")
