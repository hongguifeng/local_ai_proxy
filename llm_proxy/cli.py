"""命令行入口。

这里负责解析用户在终端传入的参数，组装代理配置，然后启动 HTTP 服务器。
真正的代理逻辑在 ``server.py``，日志逻辑在 ``logger.py``。
"""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser
from pathlib import Path

from .constants import DEFAULT_STRIP_REQUEST_FIELDS
from .http_utils import parse_header_overrides
from .logger import TrafficLogger
from .manager import DEFAULT_CONFIG_PATH, ProxyManager
from .sanitize import parse_inject_request_fields, parse_strip_request_fields
from .server import ProxyHandler, ProxyServer
from .target import parse_target
from .ui import serve_admin


def open_browser_later(url: str) -> None:
    timer = threading.Timer(0.5, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()


def parse_args() -> argparse.Namespace:
    """定义并解析命令行参数。

    大多数参数也支持环境变量，这样可以在脚本或服务配置中复用。
    """
    parser = argparse.ArgumentParser(description="Record and proxy LLM HTTP traffic.")
    parser.add_argument("--listen-host", default=os.getenv("LLM_PROXY_HOST", "127.0.0.1"))
    parser.add_argument("--listen-port", type=int, default=int(os.getenv("LLM_PROXY_PORT", "1234")))
    parser.add_argument(
        "--target-url",
        default=None,
        help="Full upstream base URL, e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:1235.",
    )
    parser.add_argument("--target-scheme", default=os.getenv("LLM_PROXY_TARGET_SCHEME", "http"))
    parser.add_argument("--target-host", default=os.getenv("LLM_PROXY_TARGET_HOST", "127.0.0.1"))
    parser.add_argument("--target-port", type=int, default=int(os.getenv("LLM_PROXY_TARGET_PORT", "1235")))
    parser.add_argument(
        "--target-header",
        action="append",
        default=None,
        help="Header to add or override when forwarding upstream. Can be repeated. Format: 'Name: value'.",
    )
    parser.add_argument(
        "--log-file",
        default=os.getenv("LLM_PROXY_LOG_FILE", "logs/interactions.jsonl"),
        help="Deprecated: JSONL interaction logs are no longer written.",
    )
    parser.add_argument(
        "--readable-log-dir",
        default=os.getenv("LLM_PROXY_READABLE_LOG_DIR", "logs/readable"),
        help="Write one human-readable Markdown file per interaction. Use empty string to disable.",
    )
    parser.add_argument("--timeout", type=float, default=float(os.getenv("LLM_PROXY_TIMEOUT", "600")))
    parser.add_argument(
        "--strip-request-fields",
        default=os.getenv("LLM_PROXY_STRIP_REQUEST_FIELDS"),
        help=(
            "Comma-separated top-level JSON request fields to remove before forwarding. "
            f"Default: none. Suggested fields: {','.join(DEFAULT_STRIP_REQUEST_FIELDS)}."
        ),
    )
    parser.add_argument(
        "--inject-request-fields",
        default=os.getenv("LLM_PROXY_INJECT_REQUEST_FIELDS"),
        help=(
            "JSON object of top-level request fields to add or override before forwarding. "
            'Example: \'{"metadata":{"source":"proxy"}}\'.'
        ),
    )
    parser.add_argument(
        "--text-limit",
        type=int,
        default=int(os.getenv("LLM_PROXY_TEXT_LIMIT", "0")),
        help="Deprecated: logs always keep complete body data.",
    )
    parser.add_argument("--access-log", action="store_true", default=os.getenv("LLM_PROXY_ACCESS_LOG") == "1")
    parser.add_argument("--ui", action="store_true", default=os.getenv("LLM_PROXY_UI") == "1")
    parser.add_argument("--ui-host", default=os.getenv("LLM_PROXY_UI_HOST", "127.0.0.1"))
    parser.add_argument("--ui-port", type=int, default=int(os.getenv("LLM_PROXY_UI_PORT", "8088")))
    parser.add_argument("--config-file", default=os.getenv("LLM_PROXY_CONFIG_FILE", str(DEFAULT_CONFIG_PATH)))
    return parser.parse_args()


def main() -> int:
    """启动代理服务，并在 Ctrl+C 时优雅关闭。"""
    args = parse_args()
    if args.ui:
        log_file = Path(args.log_file)
        readable_dir = Path(args.readable_log_dir) if args.readable_log_dir else None
        manager = ProxyManager(Path(args.config_file), log_file, readable_dir)
        ui_url = f"http://{args.ui_host}:{args.ui_port}"
        print(f"LLM proxy UI listening on {ui_url}", flush=True)
        print(f"Proxy pair config: {Path(args.config_file).resolve()}", flush=True)
        if readable_dir:
            print(f"Readable logs directory: {readable_dir.resolve()}", flush=True)
        open_browser_later(ui_url)
        try:
            serve_admin(args.ui_host, args.ui_port, manager)
        except KeyboardInterrupt:
            print("\nShutting down.", flush=True)
        return 0

    target = parse_target(args)
    target_headers = parse_header_overrides(args.target_header)
    strip_request_fields = parse_strip_request_fields(args.strip_request_fields)
    inject_request_fields = parse_inject_request_fields(args.inject_request_fields)
    log_file = Path(args.log_file)
    readable_dir = Path(args.readable_log_dir) if args.readable_log_dir else None
    logger = TrafficLogger(log_file, readable_dir)
    config = {
        # 这个 config 会挂在 ProxyServer 上，ProxyHandler 处理每个请求时读取它。
        "target_scheme": target["scheme"],
        "target_host": target["host"],
        "target_port": target["port"],
        "target_base_path": target["base_path"],
        "target_headers": target_headers,
        "strip_request_fields": strip_request_fields,
        "inject_request_fields": inject_request_fields,
        "timeout": args.timeout,
        "access_log": args.access_log,
        "proxy_pair_id": "cli",
        "proxy_pair_name": "CLI proxy",
    }
    server = ProxyServer((args.listen_host, args.listen_port), ProxyHandler, config, logger)
    listen_url = f"http://{args.listen_host}:{args.listen_port}"
    target_url = str(target["display_url"])
    print(f"LLM proxy listening on {listen_url}", flush=True)
    print(f"Forwarding to {target_url}", flush=True)
    if readable_dir:
        print(f"Writing readable logs to {readable_dir.resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
    finally:
        server.server_close()
    return 0
