"""Command-line entry for the admin UI."""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser
from pathlib import Path

from .admin_server import serve_admin
from .manager import DEFAULT_CONFIG_PATH, DEFAULT_LOG_ROOT, ProxyManager


def open_browser_later(url: str) -> None:
    timer = threading.Timer(0.5, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local LLM proxy admin UI.")
    parser.add_argument("--host", default=os.getenv("LLM_PROXY_UI_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("LLM_PROXY_UI_PORT", "8088")))
    parser.add_argument("--config-file", default=os.getenv("LLM_PROXY_CONFIG_FILE", str(DEFAULT_CONFIG_PATH)))
    parser.add_argument("--log-root", default=os.getenv("LLM_PROXY_LOG_ROOT", str(DEFAULT_LOG_ROOT)))
    parser.add_argument("--no-browser", action="store_true", default=os.getenv("LLM_PROXY_NO_BROWSER") == "1")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    log_root = Path(args.log_root) if args.log_root else None
    manager = ProxyManager(Path(args.config_file), readable_log_dir=log_root)
    ui_url = f"http://{args.host}:{args.port}"
    print(f"LLM proxy UI listening on {ui_url}", flush=True)
    print(f"Proxy config: {Path(args.config_file).resolve()}", flush=True)
    if log_root:
        print(f"Logs directory: {log_root.resolve()}", flush=True)
    if not args.no_browser:
        open_browser_later(ui_url)
    try:
        serve_admin(args.host, args.port, manager)
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
    return 0
