"""上游目标地址解析与路径拼接。"""

from __future__ import annotations

import argparse
import os
from urllib.parse import urlsplit

from .constants import DEFAULT_PORTS

def parse_target(args: argparse.Namespace) -> dict[str, object]:
    """根据命令行参数和环境变量解析上游服务地址。

    用户可以用两种方式配置目标：
    1. ``--target-url``：一次性写完整地址，例如 ``https://api.example.com/v1``。
    2. ``--target-scheme/host/port``：分别写协议、主机和端口。
    """
    raw_target_url = args.target_url or os.getenv("LLM_PROXY_TARGET_URL")
    if raw_target_url:
        parsed = urlsplit(raw_target_url)
        if parsed.scheme not in DEFAULT_PORTS or not parsed.hostname:
            raise ValueError("--target-url must look like http://host[:port][/base-path] or https://host[:port][/base-path].")
        return {
            "scheme": parsed.scheme,
            "host": parsed.hostname,
            "port": parsed.port or DEFAULT_PORTS[parsed.scheme],
            "base_path": parsed.path.rstrip("/"),
            "display_url": raw_target_url.rstrip("/"),
        }

    scheme = args.target_scheme
    if scheme not in DEFAULT_PORTS:
        raise ValueError("--target-scheme must be http or https.")
    return {
        "scheme": scheme,
        "host": args.target_host,
        "port": args.target_port,
        "base_path": "",
        "display_url": f"{scheme}://{args.target_host}:{args.target_port}",
    }


def join_target_path(base_path: str, request_path: str) -> str:
    """把上游基础路径和客户端请求路径拼成最终转发路径。

    例如目标是 ``http://server/v1``，客户端请求 ``/chat/completions``，
    最终应该发到 ``/v1/chat/completions``。如果客户端已经带了 ``/v1``，
    就不要重复拼接。
    """
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

