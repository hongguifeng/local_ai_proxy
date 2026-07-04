"""Shared typed shapes for proxy configuration and traffic records."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeAlias, TypedDict

if TYPE_CHECKING:
    from .logger import TrafficLogger


JsonObject: TypeAlias = dict[str, Any]
HeaderPairs: TypeAlias = list[tuple[str, str]]


class ModelMapping(TypedDict):
    listen: str
    upstream: str


class TargetConfig(TypedDict):
    id: str
    name: str
    target_url: str
    target_api_key: str
    target_headers: list[str]
    strip_request_fields: str
    inject_request_fields: str
    timeout: float
    log_root: str
    redact_logs: bool
    model_mappings: list[ModelMapping]
    enabled: bool


class ProxyPair(TypedDict):
    id: str
    name: str
    enabled: bool
    listen_host: str
    listen_port: int
    access_log: bool
    targets: list[TargetConfig]
    default_target_id: str


class PublicProxyPair(ProxyPair, total=False):
    running: bool
    actual_listen_port: int | None


class RuntimeTarget(TypedDict):
    id: str
    name: str
    target_scheme: str
    target_host: str
    target_port: int
    target_base_path: str
    target_api_key: str
    target_headers: HeaderPairs
    strip_request_fields: set[str]
    inject_request_fields: JsonObject
    timeout: float
    model_mappings: list[ModelMapping]
    enabled: bool
    traffic_logger: TrafficLogger


class ProxyServerConfig(TypedDict):
    targets: list[RuntimeTarget]
    default_target_id: str
    access_log: bool
    proxy_pair_id: str
    proxy_pair_name: str


class TrafficRecord(TypedDict, total=False):
    id: str
    timestamp: str
    started_timestamp: str
    event: str
    duration_ms: float
    client: JsonObject
    target: JsonObject
    proxy: JsonObject
    request: JsonObject
    response: JsonObject
    error: str
    task: JsonObject
