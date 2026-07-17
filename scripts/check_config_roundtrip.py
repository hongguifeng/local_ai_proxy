from __future__ import annotations

import argparse
import json
from pathlib import Path

from llm_proxy.manager import ProxyManager


def main() -> None:
    parser = argparse.ArgumentParser(description="Load a proxy configuration with the Python manager.")
    parser.add_argument("config_path", type=Path)
    args = parser.parse_args()

    manager = ProxyManager(config_path=args.config_path)
    print(json.dumps({"pairs": manager.pairs}, ensure_ascii=False))


if __name__ == "__main__":
    main()
