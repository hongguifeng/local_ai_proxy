# Protocol benchmark harness

The harness uses only the Python standard library and has two independent modes.

Start a configurable upstream fixture server:

```powershell
python scripts/protocol_benchmark.py serve --host 127.0.0.1 --port 9000
```

Run the fixed case set against any proxy or upstream base URL:

```powershell
python scripts/protocol_benchmark.py run http://127.0.0.1:1234 --config benchmarks/protocol-config.json
```

Capture the frozen Python proxy reference:

```powershell
python scripts/benchmark_python_proxy.py --output doc/benchmarks/python-v0.2.0-windows-x64.json
```

The server accepts `/fixture` query parameters: `mode`, `size`, `chunks`, `delay_ms`, and `interval_ms`. Modes are `fixed`, `chunked`, `sse`, `disconnect`, and `malformed`. Delay can be combined with fixed/chunked/SSE modes.

Client-only case fields are `timeoutSeconds`, `readBytes`, `slowReadMs`, and `abortAfterBytes`. Every report uses `reportVersion: 1` and includes status, first-byte time, first-SSE-event time, total time, received bytes, client-abort state, and a normalized diagnostic string. Timing values are milliseconds.

The committed Python report is a behavioral and measurement reference, not a minimum Node.js performance target. Compare reports only when machine, load, runtime, and configuration are recorded.

