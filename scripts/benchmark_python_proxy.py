"""Run the fixed protocol benchmark through the Python v0.2.0 proxy."""

from __future__ import annotations

import argparse
import json
import platform
import threading
from pathlib import Path

from protocol_benchmark import DEFAULT_CONFIG, load_config, run_benchmark, start_fixture_server, stop_fixture_server

from llm_proxy.logger import TrafficLogger
from llm_proxy.server import ProxyHandler, ProxyServer


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    upstream, upstream_thread = start_fixture_server()
    upstream_port = int(upstream.server_address[1])
    logger = TrafficLogger(None)
    target = {
        "id": "fixture",
        "name": "Protocol fixture",
        "target_scheme": "http",
        "target_host": "127.0.0.1",
        "target_port": upstream_port,
        "target_base_path": "",
        "target_api_key": "",
        "target_headers": [],
        "strip_request_fields": set(),
        "inject_request_fields": {},
        "timeout": 10.0,
        "model_mappings": [],
        "enabled": True,
        "traffic_logger": logger,
    }
    config = {
        "targets": [target],
        "default_target_id": "fixture",
        "access_log": False,
        "proxy_pair_id": "benchmark",
        "proxy_pair_name": "Python benchmark",
    }
    proxy = ProxyServer(("127.0.0.1", 0), ProxyHandler, config, logger)  # type: ignore[arg-type]
    proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True, name="python-proxy-benchmark")
    proxy_thread.start()
    try:
        report = run_benchmark(f"http://127.0.0.1:{proxy.server_address[1]}", load_config(args.config))
        report["implementation"] = "python-v0.2.0"
        report["environment"] = {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
        }
        report["note"] = "Reference measurement only; it is not a minimum Node.js performance target."
        rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered, encoding="utf-8", newline="\n")
        print(rendered, end="")
    finally:
        proxy.shutdown()
        proxy.server_close()
        proxy_thread.join(timeout=2)
        logger.close()
        stop_fixture_server(upstream, upstream_thread)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
