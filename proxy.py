#!/usr/bin/env python3
"""Legacy entry point compatibility file.

The main project has moved to the ``llm_proxy`` package. This file is kept so that old usages
``python proxy.py`` and ``from proxy import ...`` continue to work.

New scripts are encouraged to use ``python -m llm_proxy``.
"""

from __future__ import annotations

from llm_proxy import *  # noqa: F403 - Preserve legacy top-level API for backward compatibility.
from llm_proxy.cli import main


if __name__ == "__main__":
    # When running proxy.py directly, enter the new package entry point.
    raise SystemExit(main())
