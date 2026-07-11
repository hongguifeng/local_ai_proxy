# Performance baseline

Current Node.js performance verification is self-contained:

```bash
pnpm benchmark
```

The script builds the server, starts controlled upstream fixtures, exercises ordinary streaming and SSE concurrency, and writes bounded measurements suitable for comparison with `doc/performance_baseline.md`.

The removed Python protocol harness and its exact invocation are preserved in the `python-runtime-final` tag. The frozen report at `doc/benchmarks/python-v0.2.0-windows-x64.json` remains a historical behavioral and measurement reference, not a minimum Node.js target. Compare reports only when machine, load, runtime, and configuration are recorded.
