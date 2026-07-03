import json
import tempfile
import unittest
from pathlib import Path

from llm_proxy import (
    TrafficLogger,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
)


class TrafficLoggerTaskGroupingTests(unittest.TestCase):
    """验证 readable 日志里的任务归组逻辑。"""

    def test_keeps_pending_and_finished_records_in_one_task(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")
            timestamp = "2026-06-07T08:00:00.000+00:00"
            base_record = {
                "id": "req_1",
                "timestamp": timestamp,
                "started_timestamp": timestamp,
                "client": {"host": "127.0.0.1", "port": 1000},
                "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                "request": {
                    "method": "POST",
                    "path": "/v1/responses",
                    "headers": {},
                    "body": {
                        "size_bytes": 0,
                        "base64": "",
                        "text": json.dumps(
                            {
                                "model": "gpt-5.5",
                                "instructions": "system",
                                "tools": [{"type": "function", "name": "shell"}],
                                "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
                            }
                        ),
                    },
                },
            }
            logger.update_readable(
                # 先模拟“请求已读完，但响应还没回来”的中间状态。
                {
                    **base_record,
                    "event": "request_pending_response",
                    "duration_ms": 1,
                    "response": {"status": None, "headers": {}, "body": {"size_bytes": 0, "base64": "", "text": ""}},
                }
            )
            logger.write(
                # 再模拟同一个请求完成，应该仍然归到同一个任务。
                {
                    **base_record,
                    "timestamp": "2026-06-07T08:00:02.000+00:00",
                    "event": "request_finished",
                    "duration_ms": 2000,
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"id": "resp_1"}),
                        },
                    },
                }
            )

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 1)
            self.assertEqual(list(only_task["requests"]), ["req_1"])
        finally:
            log_dir.cleanup()

    def test_groups_responses_requests_without_previous_response_id_using_input_prefix(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "instructions": "codex-system",
                                    "tools": [{"type": "function", "name": "shell_command"}],
                                    "input": input_items,
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            first_input = [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix proxy logging"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking at code"}]},
            ]
            second_input = [
                # 第二次请求没有 previous_response_id，但前几条 input 和第一次相同，
                # 日志器应通过 input_prefix 指纹判断它们属于同一个任务。
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix proxy logging"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking at code"}]},
                {"type": "function_call", "call_id": "call_1", "name": "shell_command", "arguments": "{\"command\":\"rg\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "runner.py"},
            ]
            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first_input, "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second_input, "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
            self.assertEqual(sorted(only_task["requests"]), ["req_1", "req_2"])
        finally:
            log_dir.cleanup()

    def test_does_not_group_responses_by_environment_context_only(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def input_items(user_text: str) -> list[object]:
                return [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>"}],
                    },
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": user_text}]},
                ]

            def record(request_id: str, timestamp: str, user_text: str, response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "input": input_items(user_text)}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "fix proxy logging", "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "change UI defaults", "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_does_not_group_chat_by_environment_context_only(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def record(request_id: str, timestamp: str, user_text: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/chat/completions"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/chat/completions",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "messages": [
                                        {"role": "user", "content": "<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>"},
                                        {"role": "user", "content": user_text},
                                    ],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"chatcmpl_{request_id}"})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "fix proxy logging"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "change UI defaults"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_model_change_starts_new_responses_task(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def record(request_id: str, timestamp: str, model: str, response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": model,
                                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "same task text"}]}],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "gpt-5.5", "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "qwen3.6", "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_static_boundary_change_starts_new_task(self) -> None:
        for changed_field in ("instructions", "first_user"):
            with self.subTest(changed_field=changed_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "readable")

                    def record(request_id: str, timestamp: str, instructions: str, tools: list[object], first_user: str, response_id: str) -> dict[str, object]:
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/responses",
                                "headers": {},
                                "body": {
                                    "size_bytes": 0,
                                    "base64": "",
                                    "text": json.dumps(
                                        {
                                            "model": "gpt-5.5",
                                            "instructions": instructions,
                                            "tools": tools,
                                            "input": [
                                                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": first_user}]},
                                                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "follow up"}]},
                                            ],
                                        }
                                    ),
                                },
                            },
                            "response": {
                                "status": 200,
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                            },
                        }

                    first = {"instructions": "system A", "tools": [{"type": "function", "name": "shell"}], "first_user": "same first user"}
                    second = dict(first)
                    if changed_field == "instructions":
                        second["instructions"] = "system B"
                    else:
                        second["first_user"] = "different first user"

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first["instructions"], first["tools"], first["first_user"], "resp_1"))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second["instructions"], second["tools"], second["first_user"], "resp_2"))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 2)
                finally:
                    log_dir.cleanup()

    def test_responses_prompt_cache_key_links_compaction_without_tools(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def record(request_id: str, timestamp: str, input_text: str, tools: list[object] | None) -> dict[str, object]:
                payload: dict[str, object] = {
                    "model": "gpt-5.5",
                    "instructions": "same instructions",
                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": input_text}]}],
                }
                if tools is not None:
                    payload["tools"] = tools
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "prompt_cache_key": "cache-thread-1",
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps(payload)},
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"resp_{request_id}"})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "original request", [{"type": "function", "name": "shell"}]))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "compressed request", None))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_responses_client_metadata_links_compaction_without_tools(self) -> None:
        for metadata_field in ("thread_id", "session_id"):
            with self.subTest(metadata_field=metadata_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "readable")

                    def record(request_id: str, timestamp: str, input_text: str, tools: list[object] | None) -> dict[str, object]:
                        payload: dict[str, object] = {
                            "model": "gpt-5.5",
                            "instructions": "same instructions",
                            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": input_text}]}],
                        }
                        if tools is not None:
                            payload["tools"] = tools
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client_metadata": {metadata_field: "client-thread-1"},
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/responses",
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps(payload)},
                            },
                            "response": {
                                "status": 200,
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"resp_{request_id}"})},
                            },
                        }

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "original request", [{"type": "function", "name": "shell"}]))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "compressed request", None))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 1)
                    only_task = next(iter(index["tasks"].values()))
                    self.assertEqual(only_task["request_count"], 2)
                finally:
                    log_dir.cleanup()

    def test_responses_requires_previous_user_messages_to_be_contained(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "instructions": "same", "input": input_items}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("start"), message("detail A")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("start"), message("detail B")], "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_groups_when_previous_user_messages_are_contained(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "instructions": "same", "input": input_items}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("start"), message("detail A")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("start"), message("detail A"), message("next")], "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_responses_heuristic_does_not_group_identical_initial_requests(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def record(request_id: str, timestamp: str, response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "instructions": "same",
                                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "same initial task"}]}],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_heuristic_requires_user_messages_prefix(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(request_id: str, timestamp: str, input_items: list[object], response_id: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "gpt-5.5", "instructions": "same", "input": input_items}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("start"), message("detail A")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("start"), message("inserted"), message("detail A"), message("next")], "resp_2"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
        finally:
            log_dir.cleanup()

    def test_responses_previous_response_id_groups_even_when_first_user_changes(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}

            def record(
                request_id: str,
                timestamp: str,
                input_items: list[object],
                response_id: str,
                previous_response_id: str | None = None,
            ) -> dict[str, object]:
                payload: dict[str, object] = {
                    "model": "gpt-5.5",
                    "instructions": "same",
                    "tools": [{"type": "function", "name": "shell"}],
                    "input": input_items,
                }
                if previous_response_id:
                    payload["previous_response_id"] = previous_response_id
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps(payload)},
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", [message("original first user")], "resp_1"))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", [message("compressed follow up")], "resp_2", previous_response_id="resp_1"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_chat_static_boundary_change_starts_new_task(self) -> None:
        for changed_field in ("system", "first_user"):
            with self.subTest(changed_field=changed_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "readable")

                    def record(request_id: str, timestamp: str, system: str, tools: list[object], first_user: str) -> dict[str, object]:
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/chat/completions"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/chat/completions",
                                "headers": {},
                                "body": {
                                    "size_bytes": 0,
                                    "base64": "",
                                    "text": json.dumps(
                                        {
                                            "model": "gpt-5.5",
                                            "tools": tools,
                                            "messages": [
                                                {"role": "system", "content": system},
                                                {"role": "user", "content": first_user},
                                                {"role": "user", "content": "follow up"},
                                            ],
                                        }
                                    ),
                                },
                            },
                            "response": {
                                "status": 200,
                                "headers": {},
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"chatcmpl_{request_id}"})},
                            },
                        }

                    first = {"system": "system A", "tools": [{"type": "function", "function": {"name": "shell"}}], "first_user": "same first user"}
                    second = dict(first)
                    if changed_field == "system":
                        second["system"] = "system B"
                    else:
                        second["first_user"] = "different first user"

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first["system"], first["tools"], first["first_user"]))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second["system"], second["tools"], second["first_user"]))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 2)
                finally:
                    log_dir.cleanup()

    def test_updates_task_dir_with_latest_response_time(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def record(request_id: str, started_at: str, finished_at: str, previous_response_id: str | None, response_id: str) -> dict[str, object]:
                payload: dict[str, object] = {
                    "model": "gpt-5.5",
                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue task"}]}],
                }
                if previous_response_id:
                    payload["previous_response_id"] = previous_response_id
                return {
                    "id": request_id,
                    "timestamp": finished_at,
                    "started_timestamp": started_at,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(payload),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": response_id})},
                    },
                }

            first = record("req_1", "2026-06-07T08:00:00.000+00:00", "2026-06-07T08:00:02.000+00:00", None, "resp_1")
            second = record("req_2", "2026-06-07T08:00:10.000+00:00", "2026-06-07T08:00:15.000+00:00", "resp_1", "resp_2")

            logger.write(first)
            first_expected = (
                f"{local_datetime_for_filename(first['started_timestamp'])}"
                f"__{local_time_from_timestamp_for_filename(first['timestamp'])}__gpt-5.5__responses__"
            )
            tasks_root = root / "tasks"
            task_dirs = [path for path in tasks_root.iterdir() if path.is_dir()]
            self.assertEqual(len(task_dirs), 1)
            first_task_dir = task_dirs[0]
            self.assertTrue(first_task_dir.name.startswith(first_expected))

            logger.write(second)
            second_expected = (
                f"{local_datetime_for_filename(first['started_timestamp'])}"
                f"__{local_time_from_timestamp_for_filename(second['timestamp'])}__gpt-5.5__responses__"
            )
            task_dirs = [path for path in tasks_root.iterdir() if path.is_dir()]
            self.assertEqual(len(task_dirs), 1)
            second_task_dir = task_dirs[0]
            self.assertTrue(second_task_dir.name.startswith(second_expected))
            self.assertFalse(first_task_dir.exists())
        finally:
            log_dir.cleanup()
