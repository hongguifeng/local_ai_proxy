import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from llm_proxy import (
    ProxyHandler,
    ProxyServer,
    TrafficLogger,
    body_json_value,
    join_target_path,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    parse_inject_request_fields,
    parse_target,
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


class RequestSanitizationConfigTests(unittest.TestCase):
    def test_unset_strip_request_fields_removes_nothing(self) -> None:
        self.assertEqual(parse_strip_request_fields(None), set())

    def test_unset_inject_request_fields_adds_nothing(self) -> None:
        self.assertEqual(parse_inject_request_fields(None), {})
        self.assertEqual(parse_inject_request_fields(""), {})

    def test_parse_inject_request_fields_requires_json_object(self) -> None:
        self.assertEqual(parse_inject_request_fields({"stream": True}), {"stream": True})
        self.assertEqual(
            parse_inject_request_fields('{"metadata":{"source":"proxy"},"stream":true}'),
            {"metadata": {"source": "proxy"}, "stream": True},
        )
        with self.assertRaises(ValueError):
            parse_inject_request_fields("[1, 2]")
        with self.assertRaises(ValueError):
            parse_inject_request_fields(123)

    def test_transform_request_json_fields_strips_then_injects(self) -> None:
        body, stripped, injected = transform_request_json_fields(
            b'{"temperature":0.8,"model":"demo","metadata":{"source":"client"}}',
            {"temperature", "metadata"},
            {"metadata": {"source": "proxy"}, "stream": True},
        )
        self.assertEqual(json.loads(body), {"model": "demo", "metadata": {"source": "proxy"}, "stream": True})
        self.assertEqual(stripped, ["metadata", "temperature"])
        self.assertEqual(injected, ["metadata", "stream"])

    def test_transform_request_json_fields_ignores_non_object_json(self) -> None:
        body, stripped, injected = transform_request_json_fields(
            b'["not","object"]',
            {"temperature"},
            {"stream": True},
        )
        self.assertEqual(body, b'["not","object"]')
        self.assertEqual(stripped, [])
        self.assertEqual(injected, [])

    def test_default_proxy_pair_leaves_strip_fields_empty(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(temp_dir.name)
            manager = ProxyManager(root / "proxies.json", root / "interactions.jsonl", root / "readable")
            pairs = manager.list_pairs()
            self.assertEqual(pairs[0]["strip_request_fields"], "")
            self.assertEqual(pairs[0]["inject_request_fields"], "")
        finally:
            temp_dir.cleanup()

    def test_admin_html_uses_suggested_strip_fields_as_placeholder(self) -> None:
        self.assertIn(json.dumps(SUGGESTED_STRIP_REQUEST_FIELDS_TEXT), INDEX_HTML)
        self.assertIn('strip_request_fields: ""', INDEX_HTML)
        self.assertIn('placeholder="${escapeHtml(suggestedStripRequestFields)}"', INDEX_HTML)
        self.assertIn("inject_request_fields", INDEX_HTML)


class TrafficLoggerTaskGroupingTests(unittest.TestCase):
    """验证 readable 日志里的任务归组逻辑。"""

    def test_keeps_pending_and_finished_records_in_one_task(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")
            timestamp = "2026-06-07T08:00:00.000+00:00"
            base_record = {
                "id": "req_1",
                "timestamp": timestamp,
                "started_timestamp": timestamp,
                "client": {"host": "127.0.0.1", "port": 1000},
                "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                "request": {
                    "method": "POST",
                    "path": "/v1/responses",
                    "headers": {},
                    "body": {
                        "size_bytes": 0,
                        "base64": "",
                        "text": json.dumps(
                            {
                                "model": "gpt-5.5",
                                "instructions": "system",
                                "tools": [{"type": "function", "name": "shell"}],
                                "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
                            }
                        ),
                    },
                },
            }
            logger.update_readable(
                # 先模拟“请求已读完，但响应还没回来”的中间状态。
                {
                    **base_record,
                    "event": "request_pending_response",
                    "duration_ms": 1,
                    "response": {"status": None, "headers": {}, "body": {"size_bytes": 0, "base64": "", "text": ""}},
                }
            )
            logger.write(
                # 再模拟同一个请求完成，应该仍然归到同一个任务。
                {
                    **base_record,
                    "timestamp": "2026-06-07T08:00:02.000+00:00",
                    "event": "request_finished",
                    "duration_ms": 2000,
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"id": "resp_1"}),
                        },
                    },
                }
            )

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 1)
            self.assertEqual(list(only_task["requests"]), ["req_1"])
        finally:
            log_dir.cleanup()

    def test_groups_responses_requests_without_previous_response_id_using_input_prefix(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "instructions": "codex-system",
                                    "tools": [{"type": "function", "name": "shell_command"}],
                                    "input": input_items,
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            first_input = [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix proxy logging"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking at code"}]},
            ]
            second_input = [
                # 第二次请求没有 previous_response_id，但前几条 input 和第一次相同，
                # 日志器应通过 input_prefix 指纹判断它们属于同一个任务。
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix proxy logging"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking at code"}]},
                {"type": "function_call", "call_id": "call_1", "name": "shell_command", "arguments": "{\"command\":\"rg\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "proxy.py"},
            ]
            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first_input, "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second_input, "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
            self.assertEqual(sorted(only_task["requests"]), ["req_1", "req_2"])
        finally:
            log_dir.cleanup()

    def test_does_not_group_responses_by_environment_context_only(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def input_items(user_text: str) -> list[object]:
                return [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>"}],
                    },
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": user_text}]},
                ]

            def record(request_id: str, timestamp: str, user_text: str, response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "input": input_items(user_text)}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "fix proxy logging", "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "change UI defaults", "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_does_not_group_chat_by_environment_context_only(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def record(request_id: str, timestamp: str, user_text: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/chat/completions"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/chat/completions",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "messages": [
                                        {"role": "user", "content": "<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>"},
                                        {"role": "user", "content": user_text},
                                    ],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"chatcmpl_{request_id}"})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "fix proxy logging"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "change UI defaults"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_model_change_starts_new_responses_task(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def record(request_id: str, timestamp: str, model: str, response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": model,
                                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "same task text"}]}],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "gpt-5.5", "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "qwen3.6", "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_static_boundary_change_starts_new_task(self) -> None:
        for changed_field in ("instructions", "first_user"):
            with self.subTest(changed_field=changed_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

                    def record(request_id: str, timestamp: str, instructions: str, tools: list[object], first_user: str, response_id: str) -> dict[str, object]:
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/responses",
                                "headers": {},
                                "body": {
                                    "size_bytes": 0,
                                    "base64": "",
                                    "text": json.dumps(
                                        {
                                            "model": "gpt-5.5",
                                            "instructions": instructions,
                                            "tools": tools,
                                            "input": [
                                                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": first_user}]},
                                                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "follow up"}]},
                                            ],
                                        }
                                    ),
                                },
                            },
                            "response": {
                                "status": 200,
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                            },
                        }

                    first = {"instructions": "system A", "tools": [{"type": "function", "name": "shell"}], "first_user": "same first user"}
                    second = dict(first)
                    if changed_field == "instructions":
                        second["instructions"] = "system B"
                    else:
                        second["first_user"] = "different first user"

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first["instructions"], first["tools"], first["first_user"], "resp_1"))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second["instructions"], second["tools"], second["first_user"], "resp_2"))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 2)
                finally:
                    log_dir.cleanup()

    def test_responses_prompt_cache_key_links_compaction_without_tools(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def record(request_id: str, timestamp: str, input_text: str, tools: list[object] | None) -> dict[str, object]:
                payload: dict[str, object] = {
                    "model": "gpt-5.5",
                    "instructions": "same instructions",
                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": input_text}]}],
                }
                if tools is not None:
                    payload["tools"] = tools
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "prompt_cache_key": "cache-thread-1",
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps(payload)},
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"resp_{request_id}"})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "original request", [{"type": "function", "name": "shell"}]))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "compressed request", None))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_responses_client_metadata_links_compaction_without_tools(self) -> None:
        for metadata_field in ("thread_id", "session_id"):
            with self.subTest(metadata_field=metadata_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

                    def record(request_id: str, timestamp: str, input_text: str, tools: list[object] | None) -> dict[str, object]:
                        payload: dict[str, object] = {
                            "model": "gpt-5.5",
                            "instructions": "same instructions",
                            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": input_text}]}],
                        }
                        if tools is not None:
                            payload["tools"] = tools
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client_metadata": {metadata_field: "client-thread-1"},
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/responses",
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps(payload)},
                            },
                            "response": {
                                "status": 200,
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"resp_{request_id}"})},
                            },
                        }

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "original request", [{"type": "function", "name": "shell"}]))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "compressed request", None))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 1)
                    only_task = next(iter(index["tasks"].values()))
                    self.assertEqual(only_task["request_count"], 2)
                finally:
                    log_dir.cleanup()

    def test_responses_requires_previous_user_messages_to_be_contained(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "instructions": "same", "input": input_items}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("start"), message("detail A")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("start"), message("detail B")], "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_groups_when_previous_user_messages_are_contained(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "instructions": "same", "input": input_items}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("start"), message("detail A")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("start"), message("detail A"), message("next")], "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_responses_heuristic_does_not_group_identical_initial_requests(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def record(request_id: str, timestamp: str, response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "instructions": "same",
                                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "same initial task"}]}],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_heuristic_requires_user_messages_prefix(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "instructions": "same", "input": input_items}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("start"), message("detail A")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("start"), message("inserted"), message("detail A"), message("next")], "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_previous_response_id_groups_even_when_first_user_changes(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(
                request_id: str,
                timestamp: str,
                input_items: list[object],
                response_id: str,
                previous_response_id: str | None = None,
            ) -> dict[str, object]:
                payload: dict[str, object] = {
                    "model": "gpt-5.5",
                    "instructions": "same",
                    "tools": [{"type": "function", "name": "shell"}],
                    "input": input_items,
                }
                if previous_response_id:
                    payload["previous_response_id"] = previous_response_id
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps(payload)},
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("original first user")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("compressed follow up")], "resp_2", previous_response_id="resp_1"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_chat_static_boundary_change_starts_new_task(self) -> None:
        for changed_field in ("system", "first_user"):
            with self.subTest(changed_field=changed_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

                    def record(request_id: str, timestamp: str, system: str, tools: list[object], first_user: str) -> dict[str, object]:
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/chat/completions"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/chat/completions",
                                "headers": {},
                                "body": {
                                    "size_bytes": 0,
                                    "base64": "",
                                    "text": json.dumps(
                                        {
                                            "model": "gpt-5.5",
                                            "tools": tools,
                                            "messages": [
                                                {"role": "system", "content": system},
                                                {"role": "user", "content": first_user},
                                                {"role": "user", "content": "follow up"},
                                            ],
                                        }
                                    ),
                                },
                            },
                            "response": {
                                "status": 200,
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"chatcmpl_{request_id}"})},
                            },
                        }

                    first = {"system": "system A", "tools": [{"type": "function", "function": {"name": "shell"}}], "first_user": "same first user"}
                    second = dict(first)
                    if changed_field == "system":
                        second["system"] = "system B"
                    else:
                        second["first_user"] = "different first user"

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first["system"], first["tools"], first["first_user"]))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second["system"], second["tools"], second["first_user"]))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 2)
                finally:
                    log_dir.cleanup()

    def test_updates_task_dir_with_latest_response_time(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "interactions.jsonl", root / "readable")

            def record(request_id: str, started_at: str, finished_at: str, previous_response_id: str | None, response_id: str) -> dict[str, object]:
                payload: dict[str, object] = {
                    "model": "gpt-5.5",
                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue task"}]}],
                }
                if previous_response_id:
                    payload["previous_response_id"] = previous_response_id
                return {
                    "id": request_id,
                    "timestamp": finished_at,
                    "started_timestamp": started_at,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(payload),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            first = record("req_1", "2026-06-07T08:00:00.000+00:00", "2026-06-07T08:00:02.000+00:00", None, "resp_1")
            second = record("req_2", "2026-06-07T08:00:10.000+00:00", "2026-06-07T08:00:15.000+00:00", "resp_1", "resp_2")

            logger.write(first)
            first_expected = (
                f"{local_datetime_for_filename(first['started_timestamp'])}"
                f"__{local_time_from_timestamp_for_filename(first['timestamp'])}__gpt-5.5__responses__"
            )
            tasks_root = root / "tasks"
            task_dirs = [path for path in tasks_root.iterdir() if path.is_dir()]
            self.assertEqual(len(task_dirs), 1)
            first_task_dir = task_dirs[0]
            self.assertTrue(first_task_dir.name.startswith(first_expected))

            logger.write(second)
            second_expected = (
                f"{local_datetime_for_filename(first['started_timestamp'])}"
                f"__{local_time_from_timestamp_for_filename(second['timestamp'])}__gpt-5.5__responses__"
            )
            task_dirs = [path for path in tasks_root.iterdir() if path.is_dir()]
            self.assertEqual(len(task_dirs), 1)
            second_task_dir = task_dirs[0]
            self.assertTrue(second_task_dir.name.startswith(second_expected))
            self.assertFalse(first_task_dir.exists())
        finally:
            log_dir.cleanup()


class TargetUrlProxyTests(unittest.TestCase):
    """验证代理服务器会按 target-url 转发请求并写日志。"""

    def test_target_url_forwards_to_configured_upstream_and_logs_request_first(self) -> None:
        upstream_seen: dict[str, object] = {}

        class UpstreamHandler(BaseHTTPRequestHandler):
            """测试用上游服务，记录代理实际转发过来的内容。"""

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                upstream_seen["path"] = self.path
                upstream_seen["host"] = self.headers.get("Host")
                upstream_seen["body"] = self.rfile.read(length).decode("utf-8")
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            upstream_port = upstream.server_address[1]
            target = parse_target(
                SimpleNamespace(
                    target_url=f"http://127.0.0.1:{upstream_port}/v1",
                    target_scheme="http",
                    target_host="127.0.0.1",
                    target_port=1235,
                )
            )
            log_root = Path(log_dir.name)
            readable_dir = log_root / "readable"
            logger = TrafficLogger(log_root / "interactions.jsonl", readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                {
                    "target_scheme": target["scheme"],
                    "target_host": target["host"],
                    "target_port": target["port"],
                    "target_base_path": target["base_path"],
                    "target_headers": [],
                    "strip_request_fields": set(),
                    "inject_request_fields": {},
                    "timeout": 5,
                    "access_log": False,
                },
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/v1/chat/completions",
                body=b'{"messages":[]}',
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b'{"ok":true}')
            conn.close()

            self.assertEqual(upstream_seen["path"], "/v1/chat/completions")
            self.assertEqual(upstream_seen["body"], '{"messages":[]}')
            readable_interactions = [path for path in readable_dir.iterdir() if path.is_dir() and path.name != "tasks"]
            self.assertEqual(len(readable_interactions), 1)
            readable_path = readable_interactions[0]
            self.assertFalse((log_root / "interactions.jsonl").exists())
            with (readable_path / "request.json").open(encoding="utf-8") as file:
                self.assertEqual(json.load(file), {"messages": []})
            with (readable_path / "response.json").open(encoding="utf-8") as file:
                self.assertEqual(json.load(file), {"ok": True})
            markdown = next(readable_path.glob("*.md")).read_text(encoding="utf-8")
            self.assertIn(f"http://127.0.0.1:{upstream_port}/v1/chat/completions", markdown)
            self.assertIn("- Event: request_finished", markdown)
        finally:
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def test_injects_configured_request_fields_before_forwarding(self) -> None:
        upstream_seen: dict[str, object] = {}

        class UpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                upstream_seen["body"] = self.rfile.read(length).decode("utf-8")
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            log_root = Path(log_dir.name)
            readable_dir = log_root / "readable"
            logger = TrafficLogger(log_root / "interactions.jsonl", readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                {
                    "target_scheme": "http",
                    "target_host": "127.0.0.1",
                    "target_port": upstream.server_address[1],
                    "target_base_path": "/v1",
                    "target_headers": [],
                    "strip_request_fields": {"temperature"},
                    "inject_request_fields": {"metadata": {"source": "proxy"}, "stream": True},
                    "timeout": 5,
                    "access_log": False,
                },
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/v1/responses",
                body=b'{"model":"demo","temperature":0.8}',
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b'{"ok":true}')
            conn.close()

            self.assertEqual(
                json.loads(str(upstream_seen["body"])),
                {"model": "demo", "metadata": {"source": "proxy"}, "stream": True},
            )
            readable_path = next(path for path in readable_dir.iterdir() if path.is_dir() and path.name != "tasks")
            with (readable_path / "request.json").open(encoding="utf-8") as file:
                self.assertEqual(
                    json.load(file),
                    {"model": "demo", "metadata": {"source": "proxy"}, "stream": True},
                )
            markdown = next(readable_path.glob("*.md")).read_text(encoding="utf-8")
            self.assertIn("- Stripped request fields: temperature", markdown)
            self.assertIn("- Injected request fields: metadata, stream", markdown)
        finally:
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def test_logs_as_soon_as_headers_arrive_before_body_is_read(self) -> None:
        class UpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        sock = None
        try:
            upstream_port = upstream.server_address[1]
            log_root = Path(log_dir.name)
            readable_dir = log_root / "readable"
            logger = TrafficLogger(log_root / "interactions.jsonl", readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                {
                    "target_scheme": "http",
                    "target_host": "127.0.0.1",
                    "target_port": upstream_port,
                    "target_base_path": "/v1",
                    "target_headers": [],
                    "strip_request_fields": set(),
                    "inject_request_fields": {},
                    "timeout": 1,
                    "access_log": False,
                },
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            sock = socket.create_connection(("127.0.0.1", proxy.server_address[1]), timeout=5)
            sock.sendall(
                # 故意只发送请求头，不发送 body，用来验证代理能先写 request_received 日志。
                b"POST /v1/chat/completions HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 20\r\n"
                b"\r\n"
            )

            deadline = time.time() + 2
            readable_path = None
            while time.time() < deadline:
                if readable_dir.exists():
                    readable_interactions = [
                        path for path in readable_dir.iterdir() if path.is_dir() and path.name != "tasks"
                    ]
                    if readable_interactions:
                        readable_path = readable_interactions[0]
                        break
                time.sleep(0.05)

            self.assertIsNotNone(readable_path)
            assert readable_path is not None
            with (readable_path / "request.json").open(encoding="utf-8") as file:
                self.assertIsNone(json.load(file))
            with (readable_path / "response.json").open(encoding="utf-8") as file:
                self.assertIsNone(json.load(file))
            markdown = next(readable_path.glob("*.md")).read_text(encoding="utf-8")
            self.assertIn("- Event: request_received", markdown)
            self.assertFalse((log_root / "interactions.jsonl").exists())

            sock.close()
            sock = None
            deadline = time.time() + 2
            while time.time() < deadline:
                markdown = next(readable_path.glob("*.md")).read_text(encoding="utf-8")
                if "- Event: request_finished" in markdown:
                    break
                time.sleep(0.05)
            self.assertFalse((log_root / "interactions.jsonl").exists())
        finally:
            if sock is not None:
                sock.close()
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def test_readable_log_is_created_with_request_then_updated_with_response(self) -> None:
        release_response = threading.Event()

        class UpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                release_response.wait(timeout=2)
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            upstream_port = upstream.server_address[1]
            log_root = Path(log_dir.name)
            readable_dir = log_root / "readable"
            logger = TrafficLogger(log_root / "interactions.jsonl", readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                {
                    "target_scheme": "http",
                    "target_host": "127.0.0.1",
                    "target_port": upstream_port,
                    "target_base_path": "/v1",
                    "target_headers": [],
                    "strip_request_fields": set(),
                    "inject_request_fields": {},
                    "timeout": 5,
                    "access_log": False,
                },
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            response_holder: dict[str, object] = {}

            def send_request() -> None:
                conn.request(
                    "POST",
                    "/v1/chat/completions",
                    body=b'{"messages":[]}',
                    headers={"Content-Type": "application/json"},
                )
                response = conn.getresponse()
                response_holder["status"] = response.status
                response_holder["body"] = response.read()
                conn.close()

            request_thread = threading.Thread(target=send_request)
            request_thread.start()

            deadline = time.time() + 2
            readable_interactions = []
            while time.time() < deadline:
                if readable_dir.exists():
                    readable_interactions = [
                        path for path in readable_dir.iterdir() if path.is_dir() and path.name != "tasks"
                    ]
                    if readable_interactions and (readable_interactions[0] / "request.json").exists():
                        break
                time.sleep(0.05)

            self.assertEqual(len(readable_interactions), 1)
            readable_path = readable_interactions[0]
            with (readable_path / "request.json").open(encoding="utf-8") as file:
                self.assertEqual(json.load(file), {"messages": []})
            with (readable_path / "response.json").open(encoding="utf-8") as file:
                self.assertIsNone(json.load(file))
            self.assertEqual(len(list(readable_path.glob("*.md"))), 1)

            release_response.set()
            request_thread.join(timeout=2)
            self.assertEqual(response_holder["status"], 200)
            self.assertEqual(response_holder["body"], b'{"ok":true}')

            self.assertFalse((log_root / "interactions.jsonl").exists())

            readable_interactions = [path for path in readable_dir.iterdir() if path.is_dir() and path.name != "tasks"]
            self.assertEqual(readable_interactions, [readable_path])
            markdown_files = list(readable_path.glob("*.md"))
            self.assertEqual(readable_path.name.split("__")[1], markdown_files[0].name.split("__")[0])
            with (readable_path / "response.json").open(encoding="utf-8") as file:
                self.assertEqual(json.load(file), {"ok": True})
            self.assertEqual(len(markdown_files), 1)
        finally:
            release_response.set()
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()


class AdminUiTests(unittest.TestCase):
    def test_proxy_pairs_can_be_saved_and_listed(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            manager = ProxyManager(root / "proxies.json", root / "interactions.jsonl", root / "readable")
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            body = json.dumps(
                {
                    "pairs": [
                        {
                            "id": "one",
                            "name": "One",
                            "enabled": False,
                            "listen_host": "127.0.0.1",
                            "listen_port": 1234,
                            "target_url": "http://127.0.0.1:1235/v1",
                            "target_headers": ["X-Test: yes"],
                        },
                        {
                            "id": "two",
                            "name": "Two",
                            "enabled": False,
                            "listen_host": "127.0.0.1",
                            "listen_port": 1236,
                            "target_url": "http://127.0.0.1:1237",
                        },
                    ]
                }
            )
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("PUT", "/api/pairs", body=body, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            saved = json.loads(response.read())
            conn.close()

            self.assertEqual([pair["id"] for pair in saved["pairs"]], ["one", "two"])
            with (root / "proxies.json").open(encoding="utf-8") as file:
                on_disk = json.load(file)
            self.assertEqual([pair["id"] for pair in on_disk["pairs"]], ["one", "two"])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_detail_returns_request_and_response_json(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            log_path = root / "interactions.jsonl"
            readable_path = root / "readable" / "2026-06-07__08-00-00.000__post__v1-responses__req_1"
            readable_path.mkdir(parents=True)
            (readable_path / "08-00-00.000__08-00-00.010.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses",
                        "- Request: POST /v1/responses",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            (readable_path / "request.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            (readable_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            manager = ProxyManager(root / "proxies.json", log_path, root / "readable")
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/req_1")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            detail = json.loads(response.read())
            conn.close()

            self.assertEqual(detail["request"]["body_json"], {"a": 1})
            self.assertEqual(detail["response"]["body_json"], {"ok": True})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_groups_task_directories(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            log_path = root / "interactions.jsonl"
            task_request_path = (
                root
                / "tasks"
                / "2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo"
                / "001__08-00-00.000__v1-responses__req_1"
            )
            task_request_path.mkdir(parents=True)
            (root / "readable").mkdir(exist_ok=True)
            (task_request_path / "08-00-00.000__08-00-00.010.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses",
                        "- Request: POST /v1/responses",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            (task_request_path / "request.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            (task_request_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            manager = ProxyManager(root / "proxies.json", log_path, root / "readable")
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(len(payload["groups"]), 1)
            self.assertEqual(payload["groups"][0]["id"], "2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo")
            self.assertEqual(payload["groups"][0]["logs"][0]["id"], "req_1")
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_uses_directory_time_and_sorts_descending(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            log_path = root / "interactions.jsonl"
            task_path = (
                root
                / "tasks"
                / "2026-06-07__08-00-00.000__08-00-20.000__responses__fp-demo"
            )

            def write_record(dir_name: str, record_id: str, md_time: str) -> None:
                request_path = task_path / dir_name
                request_path.mkdir(parents=True)
                (request_path / "summary.md").write_text(
                    "\n".join(
                        [
                            f"# LLM Interaction {record_id}",
                            "",
                            "## Summary",
                            "",
                            f"- Time: {md_time}",
                            "- Event: request_finished",
                            "- Target: http://127.0.0.1:1235/v1/responses",
                            "- Request: POST /v1/responses",
                            "- Response: 200",
                        ]
                    ),
                    encoding="utf-8",
                )

            write_record("001__08-00-00.000__v1-responses__req_1", "req_1", "2099-01-01T00:00:00.000+00:00")
            write_record("002__08-00-20.000__v1-responses__req_2", "req_2", "2000-01-01T00:00:00.000+00:00")

            (root / "readable").mkdir(exist_ok=True)
            manager = ProxyManager(root / "proxies.json", log_path, root / "readable")
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            logs = payload["groups"][0]["logs"]
            self.assertEqual([item["id"] for item in logs], ["req_2", "req_1"])
            self.assertEqual([item["sequence"] for item in logs], ["002", "001"])
            self.assertEqual(logs[0]["timestamp"], "2026-06-07 08:00:20.000")
            self.assertEqual(logs[1]["timestamp"], "2026-06-07 08:00:00.000")
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()


if __name__ == "__main__":
    unittest.main()
