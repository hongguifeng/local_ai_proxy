"""HTTP 代理服务器实现。

这个模块负责真正接收客户端请求、转发给上游模型服务、把响应再写回客户端。
同时，它会在请求刚到达和请求结束时写日志，方便排查慢请求或卡住的请求。
"""

from __future__ import annotations

import http.client
import json
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .constants import DEFAULT_PORTS, HOP_BY_HOP_HEADERS
from .http_utils import headers_to_dict
from .logger import TrafficLogger
from .models import JsonObject, ProxyServerConfig, RuntimeTarget, TrafficRecord
from .payloads import bytes_payload
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
    def server_config(self) -> ProxyServerConfig:
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

    def _forward_headers(self, target: RuntimeTarget) -> list[tuple[str, str]]:
        """构造转发给上游的请求头。

        代理不能原样复制所有头：Host 要改成上游地址，hop-by-hop 头要丢弃，
        同时还会追加 X-Forwarded-*，让上游知道原始客户端信息。
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
            # 用户通过 --target-header 指定的头拥有最高优先级，会覆盖客户端原来的同名头。
            forwarded = [(key, value) for key, value in forwarded if key.lower() not in override_keys]
            forwarded.extend(target["target_headers"])
        target_api_key = str(target.get("target_api_key") or "").strip()
        if target_api_key:
            auth_value = target_api_key if target_api_key.lower().startswith("bearer ") else f"Bearer {target_api_key}"
            forwarded = [(key, value) for key, value in forwarded if key.lower() != "authorization"]
            forwarded.append(("Authorization", auth_value))
        return forwarded

    def _upstream_headers(self, target: RuntimeTarget, body_size: int) -> list[tuple[str, str]]:
        """生成上游请求头，并根据实际转发 body 长度重写 Content-Length。"""
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

    def _request_model(self, request_body: bytes) -> str | None:
        try:
            loaded = json.loads(request_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(loaded, dict):
            return None
        model = loaded.get("model")
        return model if isinstance(model, str) else None

    def _select_target(self, request_body: bytes) -> tuple[RuntimeTarget, str | None, str | None]:
        """按请求 model 选择上游，并返回可能需要改写成的上游 model。"""
        targets = self._targets()
        default_target_id = str(self.server_config.get("default_target_id") or "")
        default_target = next((target for target in targets if str(target.get("id")) == default_target_id), targets[0])
        request_model = self._request_model(request_body)
        if request_model:
            for target in targets:
                if target is not default_target and not bool(target.get("enabled", True)):
                    continue
                mappings = target.get("model_mappings")
                if not isinstance(mappings, list):
                    continue
                for mapping in mappings:
                    if not isinstance(mapping, dict):
                        continue
                    listen_model = mapping.get("listen")
                    if listen_model == request_model:
                        upstream_model = mapping.get("upstream")
                        return target, request_model, upstream_model if isinstance(upstream_model, str) and upstream_model else None
        return default_target, request_model, None

    def _rewrite_request_model(self, request_body: bytes, upstream_model: str | None) -> bytes:
        if not upstream_model:
            return request_body
        try:
            loaded = json.loads(request_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return request_body
        if not isinstance(loaded, dict):
            return request_body
        loaded["model"] = upstream_model
        return json.dumps(loaded, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

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
        record = {
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
            # 用 putrequest/putheader 可以精确控制 Host、Content-Length 等代理敏感字段。
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
        targets = self._targets()
        early_log_before_body = len(targets) == 1
        early_target = targets[0]
        initial_record = self._initial_record(request_id, early_target)
        # 先写“请求已到达”日志，即使客户端 body 很慢或上游卡住，也能看到这次请求。
        if early_log_before_body:
            self.traffic_logger.write(self._event_record(initial_record, "request_received", 0))

        request_body = self._read_request_body()
        selected_target, request_model, upstream_model = self._select_target(request_body)
        active_logger = selected_target.get("traffic_logger")
        if not isinstance(active_logger, TrafficLogger):
            active_logger = self.traffic_logger
        target_scheme, target_host, target_port, target_path = self._target_path(selected_target)
        model_rewritten_body = self._rewrite_request_model(request_body, upstream_model)
        upstream_request_body, stripped_request_fields, injected_request_fields = transform_request_json_fields(
            model_rewritten_body,
            selected_target["strip_request_fields"],
            selected_target.get("inject_request_fields", {}),
        )
        # 日志保存客户端原始请求体；真正发给上游的 body 可能已经移除了部分字段。
        request_record = self._request_record(
            request_body,
            upstream_request_body,
            selected_target,
            request_model,
            upstream_model,
            stripped_request_fields,
            injected_request_fields,
        )
        base_record = {
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

        # 无论成功还是失败，都写最终日志，这样排错时不会丢失异常信息。
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
    """带配置和日志器的多线程 HTTP 服务器。

    ``ThreadingHTTPServer`` 会为每个请求创建线程，适合代理这种可能长时间等待上游的场景。
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
