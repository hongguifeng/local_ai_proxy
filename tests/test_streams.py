import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llm_proxy import (
    ProxyHandler,
    ProxyServer,
    TrafficLogger,
    body_json_value,
    join_target_path,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    parse_inject_request_fields,
    parse_target_url,
    parse_strip_request_fields,
    transform_request_json_fields,
)
from llm_proxy.manager import ProxyManager, SUGGESTED_STRIP_REQUEST_FIELDS_TEXT
from llm_proxy.ui import AdminServer, INDEX_HTML


class StreamSummaryTests(unittest.TestCase):
    """验证 SSE 流式响应可以被压缩成可读摘要。"""

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
