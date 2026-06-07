"""HTTP proxy server implementation."""

from __future__ import annotations

import http.client
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .constants import DEFAULT_PORTS, HOP_BY_HOP_HEADERS
from .http_utils import headers_to_dict
from .logger import TrafficLogger
from .payloads import bytes_payload
from .sanitize import strip_request_json_fields
from .target import join_target_path
from .time_utils import utc_now_iso

class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        self._proxy()

    def do_PUT(self) -> None:
        self._proxy()

    def do_PATCH(self) -> None:
        self._proxy()

    def do_DELETE(self) -> None:
        self._proxy()

    def do_OPTIONS(self) -> None:
        self._proxy()

    def do_HEAD(self) -> None:
        self._proxy()

    def log_message(self, fmt: str, *args: object) -> None:
        if self.server_config["access_log"]:
            super().log_message(fmt, *args)

    @property
    def server_config(self) -> dict[str, object]:
        return self.server.config  # type: ignore[attr-defined]

    @property
    def traffic_logger(self) -> TrafficLogger:
        return self.server.traffic_logger  # type: ignore[attr-defined]

    def _read_request_body(self) -> bytes:
        length = self.headers.get("Content-Length")
        if not length:
            return b""
        try:
            body_size = int(length)
        except ValueError:
            return b""
        return self.rfile.read(body_size) if body_size > 0 else b""

    def _forward_headers(self) -> list[tuple[str, str]]:
        forwarded: list[tuple[str, str]] = []
        target_host = str(self.server_config["target_host"])
        target_port = int(self.server_config["target_port"])
        target_scheme = str(self.server_config["target_scheme"])
        default_port = DEFAULT_PORTS[target_scheme]
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP_HEADERS or key.lower() == "host":
                continue
            forwarded.append((key, value))
        host_header = target_host if target_port == default_port else f"{target_host}:{target_port}"
        forwarded.append(("Host", host_header))
        forwarded.append(("X-Forwarded-For", self.client_address[0]))
        forwarded.append(("X-Forwarded-Host", self.headers.get("Host", "")))
        override_keys = {key.lower() for key, _ in self.server_config["target_headers"]}  # type: ignore[index]
        if override_keys:
            forwarded = [(key, value) for key, value in forwarded if key.lower() not in override_keys]
            forwarded.extend(self.server_config["target_headers"])  # type: ignore[arg-type]
        return forwarded

    def _upstream_headers(self, body_size: int) -> list[tuple[str, str]]:
        headers = self._forward_headers()
        headers = [(key, value) for key, value in headers if key.lower() != "content-length"]
        if body_size > 0 or "Content-Length" in self.headers:
            headers.append(("Content-Length", str(body_size)))
        return headers

    def _proxy(self) -> None:
        request_id = uuid.uuid4().hex
        started = time.perf_counter()
        target_scheme = str(self.server_config["target_scheme"])
        target_host = str(self.server_config["target_host"])
        target_port = int(self.server_config["target_port"])
        target_base_path = str(self.server_config["target_base_path"])
        target_path = join_target_path(target_base_path, self.path)
        timeout = float(self.server_config["timeout"])
        response_body_parts: list[bytes] = []
        response_status = 502
        response_headers: list[tuple[str, str]] = []
        error: str | None = None
        sent_downstream_headers = False
        initial_request_record: dict[str, object] = {
            "method": self.command,
            "path": self.path,
            "headers": headers_to_dict(self.headers.items()),
            "body": bytes_payload(b""),
            "body_pending": True,
        }
        initial_record: dict[str, object] = {
            "id": request_id,
            "timestamp": utc_now_iso(),
            "client": {
                "host": self.client_address[0],
                "port": self.client_address[1],
            },
            "target": {
                "scheme": target_scheme,
                "host": target_host,
                "port": target_port,
                "path": target_path,
            },
            "request": initial_request_record,
        }
        initial_record["started_timestamp"] = initial_record["timestamp"]
        self.traffic_logger.write(
            {
                **initial_record,
                "event": "request_received",
                "duration_ms": 0,
                "response": {
                    "status": None,
                    "headers": {},
                    "body": bytes_payload(b""),
                },
            }
        )

        request_body = self._read_request_body()
        upstream_request_body, stripped_request_fields = strip_request_json_fields(
            request_body, self.server_config["strip_request_fields"]  # type: ignore[arg-type]
        )
        request_record: dict[str, object] = {
            "method": self.command,
            "path": self.path,
            "headers": headers_to_dict(self.headers.items()),
            "body": bytes_payload(request_body),
        }
        if stripped_request_fields:
            request_record["stripped_fields"] = stripped_request_fields
            request_record["upstream_body"] = bytes_payload(upstream_request_body)
        target_headers = self.server_config["target_headers"]  # type: ignore[assignment]
        if target_headers:
            request_record["added_upstream_headers"] = [key for key, _ in target_headers]  # type: ignore[union-attr]
        base_record = {
            **initial_record,
            "request": request_record,
        }
        self.traffic_logger.update_readable(
            {
                **base_record,
                "event": "request_pending_response",
                "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                "response": {
                    "status": None,
                    "headers": {},
                    "body": bytes_payload(b""),
                },
            }
        )

        try:
            conn_class = http.client.HTTPSConnection if target_scheme == "https" else http.client.HTTPConnection
            conn = conn_class(target_host, target_port, timeout=timeout)
            conn.putrequest(self.command, target_path, skip_host=True, skip_accept_encoding=True)
            for key, value in self._upstream_headers(len(upstream_request_body)):
                conn.putheader(key, value)
            conn.endheaders(upstream_request_body)

            upstream = conn.getresponse()
            response_status = upstream.status
            response_headers = upstream.getheaders()
            self.send_response(upstream.status, upstream.reason)
            for key, value in response_headers:
                lower_key = key.lower()
                if lower_key in HOP_BY_HOP_HEADERS or lower_key == "content-length":
                    continue
                self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            sent_downstream_headers = True

            if self.command != "HEAD":
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    response_body_parts.append(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
            conn.close()
        except Exception as exc:  # noqa: BLE001 - proxy must record operational failures.
            error = repr(exc)
            if not sent_downstream_headers and not self.wfile.closed:
                self.send_error(502, "Bad Gateway", error)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 3)
            response_body = b"".join(response_body_parts)
            record = {
                **base_record,
                "event": "request_finished",
                "timestamp": utc_now_iso(),
                "duration_ms": duration_ms,
                "response": {
                    "status": response_status,
                    "headers": headers_to_dict(response_headers),
                    "body": bytes_payload(response_body),
                },
            }
            if error:
                record["error"] = error
            self.traffic_logger.write(record)
            self.close_connection = True


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        listen: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        config: dict[str, object],
        traffic_logger: TrafficLogger,
    ) -> None:
        super().__init__(listen, handler_class)
        self.config = config
        self.traffic_logger = traffic_logger


