"""PyInstaller launcher for the windowed tray app."""

from __future__ import annotations

from llm_proxy.tray import main

if __name__ == "__main__":
    raise SystemExit(main())
