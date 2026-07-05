import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llm_proxy import ProxyHandler, ProxyServer, TrafficLogger, parse_target_url
from llm_proxy.log_repository import LogRepository


class TargetUrlProxyTests(unittest.TestCase):
    def _target(
        self,
        target_id: str,
        name: str,
        port: int,
        *,
        base_path: str = "/v1",
        target_api_key: str = "",
        target_headers: list[tuple[str, str]] | None = None,
        strip_request_fields: set[str] | None = None,
        inject_request_fields: dict[str, object] | None = None,
        model_mappings: list[dict[str, str]] | None = None,
        enabled: bool = True,
        timeout: float = 5,
        logger: TrafficLogger | None = None,
    ) -> dict[str, object]:
        result: dict[str, object] = {
            "id": target_id,
            "name": name,
            "enabled": enabled,
            "target_scheme": "http",
            "target_host": "127.0.0.1",
            "target_port": port,
            "target_base_path": base_path,
            "target_api_key": target_api_key,
            "target_headers": target_headers or [],
            "strip_request_fields": strip_request_fields or set(),
            "inject_request_fields": inject_request_fields or {},
            "timeout": timeout,
            "model_mappings": model_mappings or [],
        }
        if logger is not None:
            result["traffic_logger"] = logger
        return result

    def _config(
        self,
        targets: list[dict[str, object]],
        *,
        default_target_id: str = "default",
        access_log: bool = False,
    ) -> dict[str, object]:
        return {
            "targets": targets,
            "default_target_id": default_target_id,
            "access_log": access_log,
        }

    def test_routes_requests_to_target_by_model_and_rewrites_model(self) -> None:
        seen: dict[str, dict[str, object]] = {}

        def make_handler(name: str) -> type[BaseHTTPRequestHandler]:
            class UpstreamHandler(BaseHTTPRequestHandler):
                def do_POST(self) -> None:
                    length = int(self.headers.get("Content-Length", "0"))
                    seen[name] = {"path": self.path, "body": self.rfile.read(length).decode("utf-8")}
                    body = json.dumps({"upstream": name}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, fmt: str, *args: object) -> None:
                    return

            return UpstreamHandler

        upstream_a = ThreadingHTTPServer(("127.0.0.1", 0), make_handler("a"))
        upstream_b = ThreadingHTTPServer(("127.0.0.1", 0), make_handler("b"))
        threading.Thread(target=upstream_a.serve_forever, daemon=True).start()
        threading.Thread(target=upstream_b.serve_forever, daemon=True).start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            logger = TrafficLogger(Path(log_dir.name))
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config(
                    [
                        self._target(
                            "a",
                            "A",
                            upstream_a.server_address[1],
                            model_mappings=[{"listen": "A-gpt-5.5", "upstream": "gpt-5.5"}],
                        ),
                        self._target("b", "B", upstream_b.server_address[1]),
                    ],
                    default_target_id="b",
                ),
                logger,
            )
            threading.Thread(target=proxy.serve_forever, daemon=True).start()

            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/v1/chat/completions",
                body=b'{"model":"A-gpt-5.5","messages":[]}',
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"upstream": "a"})
            conn.close()

            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/v1/chat/completions",
                body=b'{"model":"unknown","messages":[]}',
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"upstream": "b"})
            conn.close()

            self.assertEqual(json.loads(str(seen["a"]["body"]))["model"], "gpt-5.5")
            self.assertEqual(json.loads(str(seen["b"]["body"]))["model"], "unknown")
        finally:
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream_a.shutdown()
            upstream_a.server_close()
            upstream_b.shutdown()
            upstream_b.server_close()
            log_dir.cleanup()

    def test_target_url_forwards_and_logs_to_sqlite(self) -> None:
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
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            upstream_port = upstream.server_address[1]
            target = parse_target_url(f"http://127.0.0.1:{upstream_port}/v1")
            log_root = Path(log_dir.name)
            logger = TrafficLogger(log_root)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", int(target["port"]), base_path=str(target["base_path"]))]),
                logger,
            )
            threading.Thread(target=proxy.serve_forever, daemon=True).start()

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
            with LogRepository(log_root) as repository:
                tasks = repository.list_tasks()
                self.assertEqual(tasks["total"], 1)
                records = repository.list_task_records(tasks["tasks"][0]["id"])
                self.assertEqual(records["total"], 1)
                record = records["records"][0]
                self.assertEqual(record["request_body"], {"messages": []})
                self.assertEqual(record["response_body"], {"ok": True})
                self.assertEqual(record["target_url"], f"http://127.0.0.1:{upstream_port}/v1/chat/completions")
        finally:
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def test_sse_response_is_forwarded_before_upstream_completes(self) -> None:
        first_sent = threading.Event()
        release_second = threading.Event()

        class UpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"content":"first"}\n\n')
                self.wfile.flush()
                first_sent.set()
                release_second.wait(timeout=2)
                self.wfile.write(b'data: {"content":"second"}\n\n')
                self.wfile.flush()

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        sock = None
        try:
            logger = TrafficLogger(Path(log_dir.name))
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", upstream.server_address[1])]),
                logger,
            )
            threading.Thread(target=proxy.serve_forever, daemon=True).start()

            sock = socket.create_connection(("127.0.0.1", proxy.server_address[1]), timeout=5)
            sock.settimeout(2)
            sock.sendall(
                b"POST /v1/messages HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 2\r\n"
                b"\r\n"
                b"{}"
            )

            received = b""
            deadline = time.time() + 2
            while b"first" not in received and time.time() < deadline:
                received += sock.recv(4096)

            self.assertTrue(first_sent.is_set())
            self.assertIn(b"first", received)
            self.assertNotIn(b"second", received)

            release_second.set()
            deadline = time.time() + 2
            while b"second" not in received and time.time() < deadline:
                received += sock.recv(4096)
            self.assertIn(b"second", received)
        finally:
            release_second.set()
            if sock is not None:
                sock.close()
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def test_injects_configured_request_fields_before_forwarding_and_logging(self) -> None:
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
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            log_root = Path(log_dir.name)
            logger = TrafficLogger(log_root)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config(
                    [
                        self._target(
                            "default",
                            "Default",
                            upstream.server_address[1],
                            strip_request_fields={"temperature"},
                            inject_request_fields={"metadata": {"source": "proxy"}, "stream": True},
                        )
                    ]
                ),
                logger,
            )
            threading.Thread(target=proxy.serve_forever, daemon=True).start()

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

            expected = {"model": "demo", "metadata": {"source": "proxy"}, "stream": True}
            self.assertEqual(json.loads(str(upstream_seen["body"])), expected)
            with LogRepository(log_root) as repository:
                records = repository.list_task_records(repository.list_tasks()["tasks"][0]["id"])["records"]
                self.assertEqual(records[0]["request_body"], expected)
                self.assertEqual(records[0]["stripped_fields"], ["temperature"])
                self.assertEqual(records[0]["injected_fields"], ["metadata", "stream"])
        finally:
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def test_pending_log_is_updated_to_finished_record(self) -> None:
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
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        try:
            log_root = Path(log_dir.name)
            logger = TrafficLogger(log_root)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", upstream.server_address[1])]),
                logger,
            )
            threading.Thread(target=proxy.serve_forever, daemon=True).start()

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
            self._wait_for_record_event(log_root, "request_pending_response")

            release_response.set()
            request_thread.join(timeout=2)
            self.assertEqual(response_holder["status"], 200)
            self.assertEqual(response_holder["body"], b'{"ok":true}')

            with LogRepository(log_root) as repository:
                tasks = repository.list_tasks()
                self.assertEqual(tasks["total"], 1)
                records = repository.list_task_records(tasks["tasks"][0]["id"])
                self.assertEqual(records["total"], 1)
                self.assertEqual(records["records"][0]["event"], "request_finished")
                self.assertEqual(records["records"][0]["response_body"], {"ok": True})
        finally:
            release_response.set()
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()

    def _wait_for_record_event(self, log_root: Path, event: str) -> None:
        deadline = time.time() + 2
        while time.time() < deadline:
            with LogRepository(log_root) as repository:
                tasks = repository.list_tasks()
                for task in tasks["tasks"]:
                    records = repository.list_task_records(task["id"])["records"]
                    if any(record["event"] == event for record in records):
                        return
            time.sleep(0.05)
        raise AssertionError(f"Timed out waiting for {event}")
