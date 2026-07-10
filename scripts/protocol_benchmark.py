"""Local HTTP protocol fixture server and machine-readable benchmark client."""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "benchmarks" / "protocol-config.json"


class ProtocolFixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        mode = query.get("mode", ["fixed"])[0]
        size = _bounded_int(query, "size", 1024, 0, 16 * 1024 * 1024)
        chunks = _bounded_int(query, "chunks", 3, 1, 1000)
        delay = _bounded_int(query, "delay_ms", 0, 0, 60_000) / 1000
        interval = _bounded_int(query, "interval_ms", 0, 0, 60_000) / 1000

        if delay:
            time.sleep(delay)
        if mode == "fixed":
            self._fixed(size)
        elif mode == "chunked":
            self._chunked(size, chunks, interval)
        elif mode == "sse":
            self._sse(chunks, interval)
        elif mode == "disconnect":
            self._disconnect(size)
        elif mode == "malformed":
            self.connection.sendall(b"NOT-HTTP\r\n\r\nbroken")
            self.close_connection = True
        else:
            self.send_error(400, "Unknown fixture mode")

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _fixed(self, size: int) -> None:
        body = _payload(size)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _chunked(self, size: int, chunks: int, interval: float) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        remaining = size
        for index in range(chunks):
            count = remaining // (chunks - index)
            remaining -= count
            data = _payload(count)
            self.wfile.write(f"{len(data):X}\r\n".encode("ascii") + data + b"\r\n")
            self.wfile.flush()
            if interval:
                time.sleep(interval)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _sse(self, chunks: int, interval: float) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for index in range(chunks):
            data = f'data: {{"index":{index},"text":"event-{index}"}}\n\n'.encode()
            self.wfile.write(f"{len(data):X}\r\n".encode("ascii") + data + b"\r\n")
            self.wfile.flush()
            if interval:
                time.sleep(interval)
        done = b"data: [DONE]\n\n"
        self.wfile.write(f"{len(done):X}\r\n".encode("ascii") + done + b"\r\n0\r\n\r\n")
        self.wfile.flush()

    def _disconnect(self, size: int) -> None:
        declared = max(size, 2)
        body = _payload(declared // 2)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(declared))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RDWR)


class ProtocolFixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: object, client_address: tuple[str, int]) -> None:
        # Client aborts are an intentional fixture mode and should not print server tracebacks.
        return


def _payload(size: int) -> bytes:
    pattern = b"llm-proxy-fixture\n"
    return (pattern * ((size + len(pattern) - 1) // len(pattern)))[:size]


def _bounded_int(query: dict[str, list[str]], name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(query.get(name, [str(default)])[0])
    except ValueError:
        return default
    return min(maximum, max(minimum, value))


def start_fixture_server(host: str = "127.0.0.1", port: int = 0) -> tuple[ProtocolFixtureServer, threading.Thread]:
    server = ProtocolFixtureServer((host, port), ProtocolFixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="protocol-fixture")
    thread.start()
    return server, thread


def stop_fixture_server(server: ProtocolFixtureServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def run_case(base_url: str, case: dict[str, Any]) -> dict[str, Any]:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must use http or https and include a host")
    query = urlencode({key: value for key, value in case.items() if key in _SERVER_QUERY_KEYS})
    base_path = parsed.path.rstrip("/")
    path = f"{base_path}/fixture?{query}"
    connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port, timeout=float(case.get("timeoutSeconds", 10)))
    start = time.perf_counter()
    first_byte_ms: float | None = None
    first_sse_event_ms: float | None = None
    status: int | None = None
    received = 0
    buffer = bytearray()
    error: str | None = None
    aborted = False
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        status = response.status
        while True:
            chunk = response.read(int(case.get("readBytes", 4096)))
            now = time.perf_counter()
            if not chunk:
                if response.length not in {None, 0}:
                    error = f"IncompleteRead: {response.length} bytes missing"
                break
            if first_byte_ms is None:
                first_byte_ms = (now - start) * 1000
            received += len(chunk)
            if first_sse_event_ms is None and case.get("mode") == "sse":
                buffer.extend(chunk)
                if b"\n\n" in buffer or b"\r\n\r\n" in buffer:
                    first_sse_event_ms = (now - start) * 1000
            abort_after = case.get("abortAfterBytes")
            if isinstance(abort_after, int) and received >= abort_after:
                aborted = True
                break
            slow_ms = case.get("slowReadMs", 0)
            if slow_ms:
                time.sleep(float(slow_ms) / 1000)
    except (OSError, http.client.HTTPException) as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        connection.close()
    total_ms = (time.perf_counter() - start) * 1000
    return {
        "name": str(case.get("name") or case.get("mode") or "case"),
        "mode": str(case.get("mode") or "fixed"),
        "status": status,
        "firstByteMs": _rounded(first_byte_ms),
        "firstSseEventMs": _rounded(first_sse_event_ms),
        "totalMs": _rounded(total_ms),
        "receivedBytes": received,
        "abortedByClient": aborted,
        "error": error,
    }


_SERVER_QUERY_KEYS = {"mode", "size", "chunks", "delay_ms", "interval_ms"}


def _rounded(value: float | None) -> float | None:
    return round(value, 3) if value is not None else None


def run_benchmark(base_url: str, config: dict[str, Any]) -> dict[str, Any]:
    return {
        "reportVersion": 1,
        "baseUrl": base_url.rstrip("/"),
        "cases": [run_case(base_url, case) for case in config.get("cases", [])],
    }


def load_config(path: Path) -> dict[str, Any]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict) or not isinstance(loaded.get("cases"), list):
        raise ValueError("benchmark config must be an object with a cases array")
    return loaded


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="Run the local upstream fixture server.")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=0)
    run = subparsers.add_parser("run", help="Benchmark any HTTP base URL.")
    run.add_argument("base_url")
    run.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    run.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.command == "serve":
        server = ProtocolFixtureServer((args.host, args.port), ProtocolFixtureHandler)
        print(json.dumps({"event": "ready", "baseUrl": f"http://{args.host}:{server.server_address[1]}"}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0

    report = run_benchmark(args.base_url, load_config(args.config))
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8", newline="\n")
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
