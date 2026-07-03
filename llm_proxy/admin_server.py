"""Admin UI HTTP server and JSON API routes."""

from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .log_store import LogStore
from .manager import ProxyManager
from .ui import INDEX_HTML


class AdminHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def manager(self) -> ProxyManager:
        return self.server.manager  # type: ignore[attr-defined]

    @property
    def log_store(self) -> LogStore:
        return self.server.log_store  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/":
            self._send_html(INDEX_HTML)
            return
        if parsed.path == "/api/pairs":
            self._send_json({"pairs": self.manager.list_pairs()})
            return
        if parsed.path == "/api/logs":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._send_json(
                {
                    "groups": self.log_store.list_log_groups(query),
                    "logs": self.log_store.list_logs(query),
                }
            )
            return
        if parsed.path.startswith("/api/logs/"):
            record_id = parsed.path.rsplit("/", 1)[-1]
            record = self.log_store.find_log(record_id)
            if not record:
                self._send_json({"error": "Log record not found."}, HTTPStatus.NOT_FOUND)
                return
            self._send_json(self.log_store.record_detail(record))
            return
        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/pairs":
            self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return
        payload = self._read_json()
        pairs = payload.get("pairs")
        if not isinstance(pairs, list):
            self._send_json({"error": "Expected pairs list."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            updated = self.manager.replace_pairs(
                [pair for pair in pairs if isinstance(pair, dict)]
            )
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json({"pairs": updated})

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/pairs/") and parsed.path.endswith("/enabled"):
            pair_id = parsed.path.split("/")[-2]
            payload = self._read_json()
            try:
                pair = self.manager.set_enabled(pair_id, bool(payload.get("enabled")))
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"pair": pair})
            return
        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        try:
            loaded = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def _send_html(self, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True


class AdminServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, listen: tuple[str, int], manager: ProxyManager) -> None:
        super().__init__(listen, AdminHandler)
        self.manager = manager
        self.log_store = LogStore(manager)


def serve_admin(host: str, port: int, manager: ProxyManager) -> None:
    manager.start_enabled()
    server = AdminServer((host, port), manager)
    try:
        server.serve_forever()
    finally:
        manager.stop_all()
        server.server_close()
