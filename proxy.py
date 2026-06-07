#!/usr/bin/env python3
"""Compatibility entry point for the packaged LLM proxy.

Prefer ``python -m llm_proxy`` for new scripts; ``python proxy.py`` remains supported.
"""

from __future__ import annotations

from llm_proxy import *  # noqa: F403 - preserve the historical top-level API.
from llm_proxy.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
