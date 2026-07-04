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
    parse_target_url,
)


class TargetUrlProxyTests(unittest.TestCase):
    """Verify that the proxy server forwards requests by target-url and writes logs."""

    def _read_json_with_retry(self, path: Path, timeout: float = 2) -> object:
        deadline = time.time() + timeout
        last_error: OSError | json.JSONDecodeError | None = None
        while time.time() < deadline:
            try:
                with path.open(encoding="utf-8") as file:
                    return json.load(file)
            except (OSError, json.JSONDecodeError) as exc:
                last_error = exc
                time.sleep(0.02)
        if last_error is not None:
            raise last_error
        raise AssertionError(f"Timed out reading {path}")

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
    ) -> dict[str, object]:
        return {
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
                    seen[name] = {
                        "path": self.path,
                        "body": self.rfile.read(length).decode("utf-8"),
                    }
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
            log_root = Path(log_dir.name)
            logger = TrafficLogger(log_root / "readable")
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

    def test_disabled_non_default_target_is_skipped_for_model_routing(self) -> None:
        seen: dict[str, int] = {"a": 0, "b": 0}

        def make_handler(name: str) -> type[BaseHTTPRequestHandler]:
            class UpstreamHandler(BaseHTTPRequestHandler):
                def do_POST(self) -> None:
                    length = int(self.headers.get("Content-Length", "0"))
                    self.rfile.read(length)
                    seen[name] += 1
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
            log_root = Path(log_dir.name)
            logger = TrafficLogger(log_root / "readable")
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config(
                    [
                        self._target(
                            "a",
                            "A",
                            upstream_a.server_address[1],
                            enabled=False,
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
            self.assertEqual(json.loads(response.read()), {"upstream": "b"})
            conn.close()

            self.assertEqual(seen, {"a": 0, "b": 1})
        finally:
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream_a.shutdown()
            upstream_a.server_close()
            upstream_b.shutdown()
            upstream_b.server_close()
            log_dir.cleanup()

    def test_target_url_forwards_to_configured_upstream_and_logs_request_first(self) -> None:
        upstream_seen: dict[str, object] = {}

        class UpstreamHandler(BaseHTTPRequestHandler):
            """Test upstream service that records what the proxy actually forwards."""

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
            target = parse_target_url(f"http://127.0.0.1:{upstream_port}/v1")
            log_root = Path(log_dir.name)
            readable_dir = log_root / "readable"
            logger = TrafficLogger(readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", int(target["port"]), base_path=str(target["base_path"]))]),
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
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        log_dir = tempfile.TemporaryDirectory()
        proxy = None
        sock = None
        try:
            log_root = Path(log_dir.name)
            logger = TrafficLogger(log_root / "readable")
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", upstream.server_address[1])]),
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

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

    def test_target_api_key_overrides_authorization_header(self) -> None:
        upstream_seen: dict[str, object] = {}

        class UpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                upstream_seen["authorization"] = self.headers.get("Authorization")
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
            logger = TrafficLogger(log_root / "readable")
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config(
                    [
                        self._target(
                            "default",
                            "Default",
                            upstream.server_address[1],
                            target_api_key="sk-target",
                            target_headers=[("Authorization", "Bearer sk-header")],
                        )
                    ]
                ),
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/v1/responses",
                body=b'{}',
                headers={"Authorization": "Bearer sk-client", "Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b'{"ok":true}')
            conn.close()

            self.assertEqual(upstream_seen["authorization"], "Bearer sk-target")
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
            logger = TrafficLogger(readable_dir)
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
            logger = TrafficLogger(readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", upstream_port, timeout=1)]),
                logger,
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()

            sock = socket.create_connection(("127.0.0.1", proxy.server_address[1]), timeout=5)
            sock.sendall(
                # Only send request headers without body to verify the proxy writes request_received logs first.
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

            sock.close()
            sock = None
            deadline = time.time() + 2
            while time.time() < deadline:
                markdown = next(readable_path.glob("*.md")).read_text(encoding="utf-8")
                if "- Event: request_finished" in markdown:
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
            logger = TrafficLogger(readable_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                self._config([self._target("default", "Default", upstream_port)]),
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
            self.assertEqual(self._read_json_with_retry(readable_path / "request.json"), {"messages": []})
            self.assertIsNone(self._read_json_with_retry(readable_path / "response.json"))
            self.assertEqual(len(list(readable_path.glob("*.md"))), 1)

            release_response.set()
            request_thread.join(timeout=2)
            self.assertEqual(response_holder["status"], 200)
            self.assertEqual(response_holder["body"], b'{"ok":true}')


            readable_interactions = [path for path in readable_dir.iterdir() if path.is_dir() and path.name != "tasks"]
            self.assertEqual(readable_interactions, [readable_path])
            markdown_files = list(readable_path.glob("*.md"))
            self.assertEqual(readable_path.name.split("__")[1], markdown_files[0].name.split("__")[0])
            self.assertEqual(self._read_json_with_retry(readable_path / "response.json"), {"ok": True})
            self.assertEqual(len(markdown_files), 1)
        finally:
            release_response.set()
            if proxy is not None:
                proxy.shutdown()
                proxy.server_close()
            upstream.shutdown()
            upstream.server_close()
            log_dir.cleanup()
