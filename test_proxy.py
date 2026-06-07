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

from proxy import (
    ProxyHandler,
    ProxyServer,
    TrafficLogger,
    body_json_value,
    join_target_path,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    parse_target,
)


class JoinTargetPathTests(unittest.TestCase):
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


class TrafficLoggerTaskGroupingTests(unittest.TestCase):
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
                {
                    **base_record,
                    "event": "request_pending_response",
                    "duration_ms": 1,
                    "response": {"status": None, "headers": {}, "body": {"size_bytes": 0, "base64": "", "text": ""}},
                }
            )
            logger.write(
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

            with (root / "readable" / ".task-index.json").open(encoding="utf-8") as file:
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
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix proxy logging"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking at code"}]},
                {"type": "function_call", "call_id": "call_1", "name": "shell_command", "arguments": "{\"command\":\"rg\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "proxy.py"},
            ]
            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first_input, "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second_input, "resp_2"))

            with (root / "readable" / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
            self.assertEqual(sorted(only_task["requests"]), ["req_1", "req_2"])
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
                f"__{local_time_from_timestamp_for_filename(first['timestamp'])}__responses__"
            )
            tasks_root = root / "readable" / "tasks"
            task_dirs = [path for path in tasks_root.iterdir() if path.is_dir()]
            self.assertEqual(len(task_dirs), 1)
            first_task_dir = task_dirs[0]
            self.assertTrue(first_task_dir.name.startswith(first_expected))

            logger.write(second)
            second_expected = (
                f"{local_datetime_for_filename(first['started_timestamp'])}"
                f"__{local_time_from_timestamp_for_filename(second['timestamp'])}__responses__"
            )
            task_dirs = [path for path in tasks_root.iterdir() if path.is_dir()]
            self.assertEqual(len(task_dirs), 1)
            second_task_dir = task_dirs[0]
            self.assertTrue(second_task_dir.name.startswith(second_expected))
            self.assertFalse(first_task_dir.exists())
        finally:
            log_dir.cleanup()


class TargetUrlProxyTests(unittest.TestCase):
    def test_target_url_forwards_to_configured_upstream_and_logs_request_first(self) -> None:
        upstream_seen: dict[str, object] = {}

        class UpstreamHandler(BaseHTTPRequestHandler):
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
            logger = TrafficLogger(Path(log_dir.name) / "interactions.jsonl", None)
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
            with (Path(log_dir.name) / "interactions.jsonl").open(encoding="utf-8") as file:
                records = [json.loads(line) for line in file]
            self.assertEqual([record["event"] for record in records], ["request_received", "request_finished"])
            self.assertEqual(records[0]["target"]["port"], upstream_port)
            self.assertEqual(records[0]["target"]["path"], "/v1/chat/completions")
            self.assertIsNone(records[0]["response"]["status"])
            self.assertEqual(records[1]["response"]["status"], 200)
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
            logger = TrafficLogger(Path(log_dir.name) / "interactions.jsonl", None)
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
                    "timeout": 1,
                    "access_log": False,
                },
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            sock = socket.create_connection(("127.0.0.1", proxy.server_address[1]), timeout=5)
            sock.sendall(
                b"POST /v1/chat/completions HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 20\r\n"
                b"\r\n"
            )

            log_path = Path(log_dir.name) / "interactions.jsonl"
            deadline = time.time() + 2
            records = []
            while time.time() < deadline:
                if log_path.exists():
                    with log_path.open(encoding="utf-8") as file:
                        records = [json.loads(line) for line in file]
                    if records:
                        break
                time.sleep(0.05)

            self.assertEqual(records[0]["event"], "request_received")
            self.assertTrue(records[0]["request"]["body_pending"])
            self.assertEqual(records[0]["request"]["body"]["size_bytes"], 0)
            self.assertIsNone(records[0]["response"]["status"])

            sock.close()
            sock = None
            deadline = time.time() + 2
            while time.time() < deadline:
                with log_path.open(encoding="utf-8") as file:
                    records = [json.loads(line) for line in file]
                if len(records) >= 2:
                    break
                time.sleep(0.05)
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

            with (log_root / "interactions.jsonl").open(encoding="utf-8") as file:
                records = [json.loads(line) for line in file]
            self.assertEqual([record["event"] for record in records], ["request_received", "request_finished"])

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


if __name__ == "__main__":
    unittest.main()
