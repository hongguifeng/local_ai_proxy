"""Target URL parsing and path joining."""

from __future__ import annotations

from typing import TypedDict
from urllib.parse import urlsplit

from .constants import DEFAULT_PORTS


class ParsedTargetUrl(TypedDict):
    scheme: str
    host: str
    port: int
    base_path: str
    display_url: str


def parse_target_url(raw_target_url: str) -> ParsedTargetUrl:
    parsed = urlsplit(raw_target_url)
    if parsed.scheme not in DEFAULT_PORTS or not parsed.hostname:
        raise ValueError("target_url must look like http://host[:port][/base-path] or https://host[:port][/base-path].")
    return {
        "scheme": parsed.scheme,
        "host": parsed.hostname,
        "port": parsed.port or DEFAULT_PORTS[parsed.scheme],
        "base_path": parsed.path.rstrip("/"),
        "display_url": raw_target_url.rstrip("/"),
    }


def join_target_path(base_path: str, request_path: str) -> str:
    """Join an upstream base path with a client request path."""
    if not base_path:
        return request_path
    if not request_path.startswith("/"):
        request_path = f"/{request_path}"
    if (
        request_path == base_path
        or request_path.startswith(f"{base_path}/")
        or request_path.startswith(f"{base_path}?")
    ):
        return request_path
    return f"{base_path}{request_path}"
