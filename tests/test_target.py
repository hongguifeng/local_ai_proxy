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


class JoinTargetPathTests(unittest.TestCase):
    """验证上游 base path 和客户端 path 的拼接规则。"""

    def test_prepends_target_base_path(self) -> None:
        self.assertEqual(join_target_path("/v1", "/chat/completions"), "/v1/chat/completions")

    def test_does_not_duplicate_existing_base_path(self) -> None:
        self.assertEqual(join_target_path("/v1", "/v1/chat/completions"), "/v1/chat/completions")

    def test_does_not_duplicate_existing_base_path_with_query(self) -> None:
        self.assertEqual(join_target_path("/v1", "/v1/models?limit=10"), "/v1/models?limit=10")

    def test_base_path_match_requires_path_boundary(self) -> None:
        self.assertEqual(join_target_path("/v1", "/v10/models"), "/v1/v10/models")

    def test_accepts_request_path_without_leading_slash(self) -> None:
        self.assertEqual(join_target_path("/api/v1", "models"), "/api/v1/models")
