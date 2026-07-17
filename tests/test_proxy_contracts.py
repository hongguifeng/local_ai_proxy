from __future__ import annotations

import http.client
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from llm_proxy import ProxyHandler, ProxyServer, TrafficLogger


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


if __name__ == "__main__":
    unittest.main()
