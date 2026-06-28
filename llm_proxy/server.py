"""HTTP 代理服务器实现。

这个模块负责真正接收客户端请求、转发给上游模型服务、把响应再写回客户端。
同时，它会在请求刚到达和请求结束时写日志，方便排查慢请求或卡住的请求。
"""

from __future__ import annotations

import http.client
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .constants import DEFAULT_PORTS, HOP_BY_HOP_HEADERS
from .http_utils import headers_to_dict
from .logger import TrafficLogger
from .payloads import bytes_payload
from .sanitize import transform_request_json_fields
from .target import join_target_path
from .time_utils import utc_now_iso

class ProxyHandler(BaseHTTPRequestHandler):
    """处理单个客户端 HTTP 请求的代理 Handler。

    ``BaseHTTPRequestHandler`` 会根据 HTTP 方法自动调用 ``do_GET``、``do_POST`` 等方法。
    这里所有方法都交给 ``_proxy``，因为代理逻辑对不同方法基本相同。
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
        """控制标准库自带访问日志是否输出到终端。"""
        if self.server_config["access_log"]:
            super().log_message(fmt, *args)

    @property
    def server_config(self) -> dict[str, object]:
        """取服务器启动时保存的配置。

        标准库的 ``self.server`` 类型比较宽泛，所以这里用 type ignore 告诉类型检查器：
        我们实际传入的是下面定义的 ``ProxyServer``。
        """
        return self.server.config  # type: ignore[attr-defined]

    @property
    def traffic_logger(self) -> TrafficLogger:
        """取共享的流量日志器。"""
        return self.server.traffic_logger  # type: ignore[attr-defined]

    def _read_request_body(self) -> bytes:
        """读取客户端请求体。

        HTTP 请求体长度由 ``Content-Length`` 指定；如果没有这个头，就认为没有 body。
        """
        length = self.headers.get("Content-Length")
        if not length:
            return b""
        try:
            body_size = int(length)
        except ValueError:
            return b""
        return self.rfile.read(body_size) if body_size > 0 else b""

    def _forward_headers(self) -> list[tuple[str, str]]:
        """构造转发给上游的请求头。

        代理不能原样复制所有头：Host 要改成上游地址，hop-by-hop 头要丢弃，
        同时还会追加 X-Forwarded-*，让上游知道原始客户端信息。
        """
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
            # 用户通过 --target-header 指定的头拥有最高优先级，会覆盖客户端原来的同名头。
            forwarded = [(key, value) for key, value in forwarded if key.lower() not in override_keys]
            forwarded.extend(self.server_config["target_headers"])  # type: ignore[arg-type]
        return forwarded

    def _upstream_headers(self, body_size: int) -> list[tuple[str, str]]:
        """生成上游请求头，并根据实际转发 body 长度重写 Content-Length。"""
        headers = self._forward_headers()
        headers = [(key, value) for key, value in headers if key.lower() != "content-length"]
        if body_size > 0 or "Content-Length" in self.headers:
            headers.append(("Content-Length", str(body_size)))
        return headers

    def _proxy(self) -> None:
        """完整执行一次代理转发。

        流程概览：
        1. 生成请求 ID，并立刻写一条 request_received 日志。
        2. 读取请求体，按配置清理后发给上游。
        3. 收到上游响应后，把响应头和响应体回写给客户端。
        4. 最后写 request_finished 日志，记录耗时、状态码、响应体和错误。
        """
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
        # 先写“请求已到达”日志，即使客户端 body 很慢或上游卡住，也能看到这次请求。
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
        if self.server_config.get("proxy_pair_id"):
            initial_record["proxy"] = {
                "id": self.server_config.get("proxy_pair_id"),
                "name": self.server_config.get("proxy_pair_name"),
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
        upstream_request_body, stripped_request_fields, injected_request_fields = transform_request_json_fields(
            request_body,
            self.server_config["strip_request_fields"],  # type: ignore[arg-type]
            self.server_config.get("inject_request_fields", {}),  # type: ignore[arg-type]
        )
        # 日志保存客户端原始请求体；真正发给上游的 body 可能已经移除了部分字段。
        request_record: dict[str, object] = {
            "method": self.command,
            "path": self.path,
            "headers": headers_to_dict(self.headers.items()),
            "body": bytes_payload(request_body),
        }
        if stripped_request_fields:
            request_record["stripped_fields"] = stripped_request_fields
        if injected_request_fields:
            request_record["injected_fields"] = injected_request_fields
        if stripped_request_fields or injected_request_fields:
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
            # 用 putrequest/putheader 可以精确控制 Host、Content-Length 等代理敏感字段。
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
            # 代理会在本次响应结束后关闭连接，避免连接复用带来的边界问题。
            self.send_header("Connection", "close")
            self.end_headers()
            sent_downstream_headers = True

            if self.command != "HEAD":
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    response_body_parts.append(chunk)
                    # 边读边写给客户端，不等完整响应结束，减少流式响应的延迟。
                    self.wfile.write(chunk)
                    self.wfile.flush()
            conn.close()
        except Exception as exc:  # noqa: BLE001 - proxy must record operational failures.
            error = repr(exc)
            if not sent_downstream_headers and not self.wfile.closed:
                self.send_error(502, "Bad Gateway", error)
        finally:
            # 无论成功还是失败，都写最终日志，这样排错时不会丢失异常信息。
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
    """带配置和日志器的多线程 HTTP 服务器。

    ``ThreadingHTTPServer`` 会为每个请求创建线程，适合代理这种可能长时间等待上游的场景。
    """

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
