"""Entry point for running the package via ``python -m llm_proxy``."""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    # main() returns the process exit code; SystemExit passes it to the OS.
    raise SystemExit(main())
