"""HTTP proxy server implementation.

This module is responsible for receiving client requests, forwarding them to upstream model services, and writing responses back to the client.
It also writes logs when requests arrive and when they complete, making it easier to troubleshoot slow or stuck requests.
"""

from __future__ import annotations

import http.client
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .constants import DEFAULT_PORTS, HOP_BY_HOP_HEADERS
from .http_utils import headers_to_dict
from .logger import TrafficLogger
from .models import JsonObject, ProxyServerConfig, RuntimeTarget, TrafficRecord
from .payloads import bytes_payload
from .routing import rewrite_request_model, select_target_by_model
from .sanitize import transform_request_json_fields
from .target import join_target_path
from .time_utils import utc_now_iso


@dataclass
class UpstreamResult:
    status: int
    headers: list[tuple[str, str]]
    body: bytes
    error: str | None = None


class ProxyHandler(BaseHTTPRequestHandler):
    """Proxy handler for a single client HTTP request.

    ``BaseHTTPRequestHandler`` automatically calls ``do_GET``, ``do_POST``, etc. based on the HTTP method.
    Here all methods delegate to ``_proxy``, since the proxy logic is essentially the same across different methods.
    """

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
        """Control whether the standard library's access log is output to the terminal."""
        if self.server_config["access_log"]:
            super().log_message(fmt, *args)

    @property
    def server_config(self) -> ProxyServerConfig:
        """Retrieve the server configuration saved at startup.

        The standard library's ``self.server`` type is too broad, so here we use type ignore to tell the type checker:
        we actually pass in the ``ProxyServer`` defined below.
        """
        return self.server.config  # type: ignore[attr-defined]

    @property
    def traffic_logger(self) -> TrafficLogger:
        """Retrieve the shared traffic logger."""
        return self.server.traffic_logger  # type: ignore[attr-defined]

    def _read_request_body(self) -> bytes:
        """Read the client request body.

        The HTTP request body length is specified by ``Content-Length``; if this header is missing, assume no body.
        """
        length = self.headers.get("Content-Length")
        if not length:
            return b""
        try:
            body_size = int(length)
        except ValueError:
            return b""
        return self.rfile.read(body_size) if body_size > 0 else b""

    def _forward_headers(self, target: RuntimeTarget) -> list[tuple[str, str]]:
        """Construct the request headers to forward upstream.

        The proxy cannot copy all headers as-is: Host must be changed to the upstream address, hop-by-hop headers must be discarded,
        and X-Forwarded-* headers are added so the upstream knows the original client info.
        """
        forwarded: list[tuple[str, str]] = []
        target_host = str(target["target_host"])
        target_port = int(target["target_port"])
        target_scheme = str(target["target_scheme"])
        default_port = DEFAULT_PORTS[target_scheme]
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP_HEADERS or key.lower() == "host":
                continue
            forwarded.append((key, value))
        host_header = target_host if target_port == default_port else f"{target_host}:{target_port}"
        forwarded.append(("Host", host_header))
        forwarded.append(("X-Forwarded-For", self.client_address[0]))
        forwarded.append(("X-Forwarded-Host", self.headers.get("Host", "")))
        override_keys = {key.lower() for key, _ in target["target_headers"]}
        if override_keys:
            # User-specified headers via --target-header have highest priority, overriding original client headers with the same name.
            forwarded = [(key, value) for key, value in forwarded if key.lower() not in override_keys]
            forwarded.extend(target["target_headers"])
        target_api_key = str(target.get("target_api_key") or "").strip()
        if target_api_key:
            auth_value = target_api_key if target_api_key.lower().startswith("bearer ") else f"Bearer {target_api_key}"
            forwarded = [(key, value) for key, value in forwarded if key.lower() != "authorization"]
            forwarded.append(("Authorization", auth_value))
        return forwarded

    def _upstream_headers(self, target: RuntimeTarget, body_size: int) -> list[tuple[str, str]]:
        """Generate upstream request headers and rewrite Content-Length based on actual forwarded body size."""
        headers = self._forward_headers(target)
        headers = [(key, value) for key, value in headers if key.lower() != "content-length"]
        if body_size > 0 or "Content-Length" in self.headers:
            headers.append(("Content-Length", str(body_size)))
        return headers

    def _targets(self) -> list[RuntimeTarget]:
        """Return the configured upstream targets."""
        targets = self.server_config.get("targets")
        if isinstance(targets, list) and targets:
            return [target for target in targets if isinstance(target, dict)]
        raise ValueError("ProxyServer config must include at least one target.")

    def _target_path(self, target: RuntimeTarget) -> tuple[str, str, int, str]:
        target_scheme = str(target["target_scheme"])
        target_host = str(target["target_host"])
        target_port = int(target["target_port"])
        target_base_path = str(target["target_base_path"])
        return target_scheme, target_host, target_port, join_target_path(target_base_path, self.path)

    def _initial_record(self, request_id: str, target: RuntimeTarget) -> TrafficRecord:
        target_scheme, target_host, target_port, target_path = self._target_path(target)
        record: TrafficRecord = {
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
            "request": {
                "method": self.command,
                "path": self.path,
                "headers": headers_to_dict(self.headers.items()),
                "body": bytes_payload(b""),
                "body_pending": True,
            },
        }
        if self.server_config.get("proxy_pair_id"):
            record["proxy"] = {
                "id": self.server_config.get("proxy_pair_id"),
                "name": self.server_config.get("proxy_pair_name"),
            }
        record["started_timestamp"] = record["timestamp"]
        return record

    def _event_record(
        self,
        base_record: TrafficRecord,
        event: str,
        duration_ms: float,
        *,
        response_status: object = None,
        response_headers: list[tuple[str, str]] | None = None,
        response_body: bytes = b"",
        timestamp: str | None = None,
        error: str | None = None,
    ) -> TrafficRecord:
        record: TrafficRecord = {
            **base_record,
            "event": event,
            "duration_ms": duration_ms,
            "response": {
                "status": response_status,
                "headers": headers_to_dict(response_headers or []),
                "body": bytes_payload(response_body),
            },
        }
        if timestamp is not None:
            record["timestamp"] = timestamp
        if error:
            record["error"] = error
        return record

    def _request_record(
        self,
        request_body: bytes,
        upstream_request_body: bytes,
        selected_target: RuntimeTarget,
        request_model: str | None,
        upstream_model: str | None,
        stripped_request_fields: list[str],
        injected_request_fields: list[str],
    ) -> JsonObject:
        record: JsonObject = {
            "method": self.command,
            "path": self.path,
            "headers": headers_to_dict(self.headers.items()),
            "body": bytes_payload(request_body),
        }
        if stripped_request_fields:
            record["stripped_fields"] = stripped_request_fields
        if injected_request_fields:
            record["injected_fields"] = injected_request_fields
        if upstream_model:
            record["model_route"] = {
                "requested_model": request_model,
                "upstream_model": upstream_model,
                "target_id": selected_target.get("id"),
                "target_name": selected_target.get("name"),
            }
        elif request_model:
            record["model_route"] = {
                "requested_model": request_model,
                "target_id": selected_target.get("id"),
                "target_name": selected_target.get("name"),
            }
        if stripped_request_fields or injected_request_fields or upstream_model:
            record["upstream_body"] = bytes_payload(upstream_request_body)
        target_headers = selected_target["target_headers"]
        if target_headers:
            record["added_upstream_headers"] = [key for key, _ in target_headers]
        return record

    def _forward_upstream_response(
        self,
        selected_target: RuntimeTarget,
        target_scheme: str,
        target_host: str,
        target_port: int,
        target_path: str,
        upstream_request_body: bytes,
    ) -> UpstreamResult:
        """Forward the request upstream while streaming the response downstream."""
        response_body_parts: list[bytes] = []
        response_status = 502
        response_headers: list[tuple[str, str]] = []
        sent_downstream_headers = False
        conn: http.client.HTTPConnection | None = None

        try:
            timeout = float(selected_target["timeout"])
            conn_class = http.client.HTTPSConnection if target_scheme == "https" else http.client.HTTPConnection
            conn = conn_class(target_host, target_port, timeout=timeout)
            # Use putrequest/putheader to precisely control Host, Content-Length, and other proxy-sensitive fields.
            conn.putrequest(self.command, target_path, skip_host=True, skip_accept_encoding=True)
            for key, value in self._upstream_headers(selected_target, len(upstream_request_body)):
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
            # The proxy will close the connection after this response to avoid edge cases from connection reuse.
            self.send_header("Connection", "close")
            self.end_headers()
            sent_downstream_headers = True

            if self.command != "HEAD":
                response_body_parts = self._forward_response_body(upstream, response_headers)
            return UpstreamResult(
                status=response_status,
                headers=response_headers,
                body=b"".join(response_body_parts),
            )
        except Exception as exc:  # noqa: BLE001 - proxy must record operational failures.
            error = repr(exc)
            if not sent_downstream_headers and not self.wfile.closed:
                self.send_error(502, "Bad Gateway", error)
            return UpstreamResult(
                status=response_status,
                headers=response_headers,
                body=b"".join(response_body_parts),
                error=error,
            )
        finally:
            if conn is not None:
                conn.close()

    def _forward_response_body(
        self,
        upstream: http.client.HTTPResponse,
        response_headers: list[tuple[str, str]],
    ) -> list[bytes]:
        """Forward the upstream response body and keep a copy for logs."""
        response_body_parts: list[bytes] = []
        content_type = ""
        for key, value in response_headers:
            if key.lower() == "content-type":
                content_type = value.lower()
                break

        if "text/event-stream" in content_type:
            while True:
                line = upstream.readline()
                if not line:
                    break
                response_body_parts.append(line)
                self.wfile.write(line)
                self.wfile.flush()
            return response_body_parts

        while True:
            chunk = upstream.read(64 * 1024)
            if not chunk:
                break
            response_body_parts.append(chunk)
            # Write to client while reading, don't wait for complete response, reducing streaming latency.
            self.wfile.write(chunk)
            self.wfile.flush()
        return response_body_parts

    def _proxy(self) -> None:
        """Execute a complete proxy forward.

        Overview:
        1. Generate request ID and immediately write a request_received log.
        2. Read request body, sanitize per config, then forward upstream.
        3. After receiving upstream response, write response headers and body back to client.
        4. Finally write request_finished log with duration, status code, response body, and errors.
        """
        request_id = uuid.uuid4().hex
        started = time.perf_counter()
        targets = self._targets()
        early_log_before_body = len(targets) == 1
        early_target = targets[0]
        initial_record = self._initial_record(request_id, early_target)
        # Write "request arrived" log first, so even if client body is slow or upstream is stuck, we can still see the request.
        if early_log_before_body:
            self.traffic_logger.write(self._event_record(initial_record, "request_received", 0))

        request_body = self._read_request_body()
        selection = select_target_by_model(
            self._targets(),
            str(self.server_config.get("default_target_id") or ""),
            request_body,
        )
        selected_target = selection.target
        request_model = selection.request_model
        upstream_model = selection.upstream_model
        active_logger = selected_target.get("traffic_logger")
        if not isinstance(active_logger, TrafficLogger):
            active_logger = self.traffic_logger
        target_scheme, target_host, target_port, target_path = self._target_path(selected_target)
        model_rewritten_body = rewrite_request_model(request_body, upstream_model)
        upstream_request_body, stripped_request_fields, injected_request_fields = transform_request_json_fields(
            model_rewritten_body,
            selected_target["strip_request_fields"],
            selected_target.get("inject_request_fields", {}),
        )
        # Logs preserve the original client request body; the actual upstream body may have some fields removed.
        request_record = self._request_record(
            request_body,
            upstream_request_body,
            selected_target,
            request_model,
            upstream_model,
            stripped_request_fields,
            injected_request_fields,
        )
        base_record: TrafficRecord = {
            **initial_record,
            "target": {
                "scheme": target_scheme,
                "host": target_host,
                "port": target_port,
                "path": target_path,
                "id": selected_target.get("id"),
                "name": selected_target.get("name"),
            },
            "request": request_record,
        }
        if not early_log_before_body:
            active_logger.write(
                self._event_record(
                    base_record,
                    "request_received",
                    round((time.perf_counter() - started) * 1000, 3),
                )
            )
        active_logger.update_readable(
            self._event_record(
                base_record,
                "request_pending_response",
                round((time.perf_counter() - started) * 1000, 3),
            )
        )

        upstream_result = self._forward_upstream_response(
            selected_target,
            target_scheme,
            target_host,
            target_port,
            target_path,
            upstream_request_body,
        )

        # Whether success or failure, write the final log so error info is not lost when troubleshooting.
        duration_ms = round((time.perf_counter() - started) * 1000, 3)
        active_logger.write(
            self._event_record(
                base_record,
                "request_finished",
                duration_ms,
                response_status=upstream_result.status,
                response_headers=upstream_result.headers,
                response_body=upstream_result.body,
                timestamp=utc_now_iso(),
                error=upstream_result.error,
            )
        )
        self.close_connection = True


class ProxyServer(ThreadingHTTPServer):
    """Multi-threaded HTTP server with configuration and traffic logger.

    ``ThreadingHTTPServer`` creates a thread per request, suitable for proxies that may wait a long time for upstream responses.
    """

    daemon_threads = True

    def __init__(
        self,
        listen: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        config: ProxyServerConfig,
        traffic_logger: TrafficLogger,
    ) -> None:
        super().__init__(listen, handler_class)
        self.config = config
        self.traffic_logger = traffic_logger
