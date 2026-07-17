from __future__ import annotations

import http.client
import socket
import struct
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llm_proxy import ProxyHandler, ProxyServer, TrafficLogger
from llm_proxy.log_repository import LogRepository


def runtime_target(port: int, **overrides: object) -> dict[str, object]:
    target: dict[str, object] = {
        "id": "default",
        "name": "Default",
        "enabled": True,
        "target_scheme": "http",
        "target_host": "127.0.0.1",
        "target_port": port,
        "target_base_path": "",
        "target_api_key": "",
        "target_headers": [],
        "strip_request_fields": set(),
        "inject_request_fields": {},
        "timeout": 5.0,
        "model_mappings": [],
    }
    target.update(overrides)
    return target


def proxy_config(targets: list[dict[str, object]], default_target_id: str = "default") -> dict[str, object]:
    return {
        "targets": targets,
        "default_target_id": default_target_id,
        "access_log": False,
        "proxy_pair_id": "contract-proxy",
        "proxy_pair_name": "Contract proxy",
    }


class ProxyHttpContractTests(unittest.TestCase):
    def test_forwards_all_explicitly_supported_http_methods(self) -> None:
        seen: list[tuple[str, str, bytes]] = []

        class UpstreamHandler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length", "0") or "0")
                body = self.rfile.read(length) if length > 0 else b""
                seen.append((self.command, self.path, body))
                response_body = f'{{"method":"{self.command}"}}'.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response_body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(response_body)

            do_GET = _handle
            do_POST = _handle
            do_PUT = _handle
            do_PATCH = _handle
            do_DELETE = _handle
            do_OPTIONS = _handle
            do_HEAD = _handle

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        proxy = ProxyServer(
            ("127.0.0.1", 0),
            ProxyHandler,
            proxy_config([runtime_target(upstream.server_address[1])]),  # type: ignore[arg-type]
            TrafficLogger(None),
        )
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        proxy_thread.start()
        try:
            methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
            for method in methods:
                request_body = b'{"fixture":true}' if method in {"POST", "PUT", "PATCH", "DELETE"} else None
                connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
                connection.request(method, f"/contract/{method.lower()}?source=test", body=request_body)
                response = connection.getresponse()
                response_body = response.read()
                connection.close()
                self.assertEqual(response.status, 200, method)
                if method == "HEAD":
                    self.assertEqual(response_body, b"")
                else:
                    self.assertEqual(response_body, f'{{"method":"{method}"}}'.encode())

            self.assertEqual([item[0] for item in seen], methods)
            self.assertEqual(
                [item[1] for item in seen],
                [f"/contract/{method.lower()}?source=test" for method in methods],
            )
            for method, _path, body in seen:
                if method in {"POST", "PUT", "PATCH", "DELETE"}:
                    self.assertEqual(body, b'{"fixture":true}')
                else:
                    self.assertEqual(body, b"")
        finally:
            proxy.shutdown()
            proxy.server_close()
            proxy_thread.join(timeout=2)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=2)

    def test_returns_502_for_connection_failure_and_upstream_timeout(self) -> None:
        unavailable_socket = socket.socket()
        unavailable_socket.bind(("127.0.0.1", 0))
        unavailable_port = unavailable_socket.getsockname()[1]
        unavailable_socket.close()

        connection_failure_proxy = ProxyServer(
            ("127.0.0.1", 0),
            ProxyHandler,
            proxy_config([runtime_target(unavailable_port)]),  # type: ignore[arg-type]
            TrafficLogger(None),
        )
        connection_failure_thread = threading.Thread(
            target=connection_failure_proxy.serve_forever,
            daemon=True,
        )
        connection_failure_thread.start()
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1",
                connection_failure_proxy.server_address[1],
                timeout=5,
            )
            connection.request("POST", "/connection-failure", body=b"{}")
            response = connection.getresponse()
            self.assertEqual(response.status, 502)
            self.assertIn(b"Bad Gateway", response.read())
            connection.close()
        finally:
            connection_failure_proxy.shutdown()
            connection_failure_proxy.server_close()
            connection_failure_thread.join(timeout=2)

        class SlowUpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                time.sleep(0.2)
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"ok")
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, fmt: str, *args: object) -> None:
                return

        slow_upstream = ThreadingHTTPServer(("127.0.0.1", 0), SlowUpstreamHandler)
        slow_thread = threading.Thread(target=slow_upstream.serve_forever, daemon=True)
        slow_thread.start()
        timeout_proxy = ProxyServer(
            ("127.0.0.1", 0),
            ProxyHandler,
            proxy_config([runtime_target(slow_upstream.server_address[1], timeout=0.05)]),  # type: ignore[arg-type]
            TrafficLogger(None),
        )
        timeout_thread = threading.Thread(target=timeout_proxy.serve_forever, daemon=True)
        timeout_thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", timeout_proxy.server_address[1], timeout=5)
            connection.request("POST", "/timeout", body=b"{}")
            response = connection.getresponse()
            self.assertEqual(response.status, 502)
            self.assertIn(b"timed out", response.read())
            connection.close()
        finally:
            timeout_proxy.shutdown()
            timeout_proxy.server_close()
            timeout_thread.join(timeout=2)
            slow_upstream.shutdown()
            slow_upstream.server_close()
            slow_thread.join(timeout=2)

    def test_records_error_when_upstream_disconnects_after_response_headers(self) -> None:
        class ResettingUpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                self.wfile.write(b"5\r\nfirst\r\n")
                self.wfile.flush()
                self.connection.setsockopt(
                    socket.SOL_SOCKET,
                    socket.SO_LINGER,
                    struct.pack("ii", 1, 0),
                )
                self.connection.close()

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), ResettingUpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        with tempfile.TemporaryDirectory() as temp_dir:
            log_root = Path(temp_dir)
            proxy = ProxyServer(
                ("127.0.0.1", 0),
                ProxyHandler,
                proxy_config([runtime_target(upstream.server_address[1])]),  # type: ignore[arg-type]
                TrafficLogger(log_root),
            )
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
                connection.request("POST", "/partial", body=b"{}")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                try:
                    response.read()
                except (http.client.IncompleteRead, ConnectionResetError):
                    pass
                connection.close()

                deadline = time.time() + 2
                stored_record = None
                while time.time() < deadline:
                    with LogRepository(log_root) as repository:
                        tasks = repository.list_tasks("", 10, 0)["tasks"]
                        if tasks:
                            records = repository.list_task_records(str(tasks[0]["id"]))["records"]
                            if records and records[0]["event"] == "request_finished":
                                stored_record = records[0]
                                break
                    time.sleep(0.02)

                self.assertIsNotNone(stored_record)
                self.assertEqual(stored_record["status"], 200)
                self.assertTrue(
                    any(name in str(stored_record["error"]) for name in ("IncompleteRead", "ConnectionResetError")),
                    stored_record["error"],
                )
            finally:
                proxy.shutdown()
                proxy.server_close()
                proxy_thread.join(timeout=2)
                upstream.shutdown()
                upstream.server_close()
                upstream_thread.join(timeout=2)

    def test_header_overrides_api_key_priority_and_duplicate_headers(self) -> None:
        seen: dict[str, object] = {}

        class UpstreamHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0") or "0")
                seen.update(
                    {
                        "authorization": self.headers.get_all("Authorization"),
                        "override": self.headers.get_all("X-Override"),
                        "repeated": self.headers.get_all("X-Repeated"),
                        "host": self.headers.get("Host"),
                        "forwarded_for": self.headers.get("X-Forwarded-For"),
                        "forwarded_host": self.headers.get("X-Forwarded-Host"),
                        "body": self.rfile.read(length),
                    }
                )
                response_body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)

            def log_message(self, fmt: str, *args: object) -> None:
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        target = runtime_target(
            upstream.server_address[1],
            target_api_key="fixture-api-key",
            target_headers=[
                ("X-Override", "target-value"),
                ("Authorization", "Target header must lose to API key"),
            ],
        )
        proxy = ProxyServer(
            ("127.0.0.1", 0),
            ProxyHandler,
            proxy_config([target]),  # type: ignore[arg-type]
            TrafficLogger(None),
        )
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        proxy_thread.start()
        try:
            body = b'{"fixture":true}'
            connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            connection.putrequest("POST", "/headers", skip_host=True)
            connection.putheader("Host", "client.example:9000")
            connection.putheader("Authorization", "Bearer client-value")
            connection.putheader("X-Override", "client-one")
            connection.putheader("X-Override", "client-two")
            connection.putheader("X-Repeated", "first")
            connection.putheader("X-Repeated", "second")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body)
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b'{"ok":true}')
            connection.close()

            self.assertEqual(seen["authorization"], ["Bearer fixture-api-key"])
            self.assertEqual(seen["override"], ["target-value"])
            self.assertEqual(seen["repeated"], ["first", "second"])
            self.assertEqual(seen["host"], f"127.0.0.1:{upstream.server_address[1]}")
            self.assertEqual(seen["forwarded_for"], "127.0.0.1")
            self.assertEqual(seen["forwarded_host"], "client.example:9000")
            self.assertEqual(seen["body"], body)
        finally:
            proxy.shutdown()
            proxy.server_close()
            proxy_thread.join(timeout=2)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
