from __future__ import annotations

import argparse
import json
from pathlib import Path

from llm_proxy.log_repository import LogRepository


def main() -> None:
    parser = argparse.ArgumentParser(description="Read Node-written rows with the Python log repository.")
    parser.add_argument("log_root", type=Path)
    parser.add_argument("task_id")
    parser.add_argument("record_id")
    parser.add_argument("response_id")
    parser.add_argument("context_key")
    args = parser.parse_args()

    with LogRepository(args.log_root) as repository:
        print(
            json.dumps(
                {
                    "task": repository.get_task(args.task_id),
                    "record": repository.get_record(args.record_id),
                    "response_task_id": repository.task_id_for_response(args.response_id),
                    "context_task_id": repository.task_id_for_context(args.context_key),
                },
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    main()
