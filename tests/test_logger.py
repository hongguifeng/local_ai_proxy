import json
import tempfile
import unittest
from pathlib import Path

from llm_proxy import (
    TrafficLogger,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
)
from llm_proxy.task_index import TASK_MATCH_STRATEGY_VERSION, TaskIndexStore


class TrafficLoggerTaskGroupingTests(unittest.TestCase):
    """Verify task grouping logic in readable logs."""

    def test_writes_list_summary_fields_when_recording_log(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")
            logger.write(
                {
                    "id": "req_1",
                    "timestamp": "2026-06-07T08:00:00.000+00:00",
                    "started_timestamp": "2026-06-07T08:00:00.000+00:00",
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
                                    "instructions": "system",
                                    "input": [{"role": "user"}, {"type": "function_call"}],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"usage": {"input_tokens": 3, "output_tokens": 2}}),
                        },
                    },
                }
            )

            markdown = next((root / "readable").glob("*/*.md")).read_text(encoding="utf-8")
            self.assertIn("- Endpoint: /v1/responses", markdown)
            self.assertIn("- Message count: 3", markdown)
            self.assertIn("- Token count: 5", markdown)
            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["target"], "http://127.0.0.1:1235/v1/responses")
            self.assertEqual(only_task["targets"], ["http://127.0.0.1:1235/v1/responses"])
            task_markdown = next((root / "tasks").glob("*/index.md")).read_text(encoding="utf-8")
            self.assertIn("- Target: http://127.0.0.1:1235/v1/responses", task_markdown)
        finally:
            log_dir.cleanup()

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
                # Simulate the intermediate state where the request is read but the response has not yet returned.
                {
                    **base_record,
                    "event": "request_pending_response",
                    "duration_ms": 1,
                    "response": {"status": None, "headers": {}, "body": {"size_bytes": 0, "base64": "", "text": ""}},
                }
            )
            logger.write(
                # Simulate the same request completing; it should still be grouped into the same task.
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
                # The second request has no previous_response_id, but the first few inputs match the first request,
                # so the logger should group them into the same task via input_prefix fingerprint.
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

    def test_does_not_group_claude_messages_by_environment_context_only(self) -> None:
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
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/messages"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/messages",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "claude-sonnet-4",
                                    "messages": [
                                        {
                                            "role": "user",
                                            "content": "<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>",
                                        },
                                        {"role": "user", "content": user_text},
                                    ],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"msg_{request_id}"})},
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

                    def record(
                        request_id: str,
                        timestamp: str,
                        input_text: str,
                        tools: list[object] | None,
                        metadata_key: str = metadata_field,
                    ) -> dict[str, object]:
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
                            "client_metadata": {metadata_key: "client-thread-1"},
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

    def test_responses_requires_previous_user_messages_to_be_prefix(self) -> None:
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

    def test_responses_groups_when_previous_user_messages_are_prefix(self) -> None:
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

    def test_claude_messages_group_when_previous_user_messages_are_prefix(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def message(text: str) -> dict[str, object]:
                return {"role": "user", "content": [{"type": "text", "text": text}]}

            def record(request_id: str, timestamp: str, messages: list[object]) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/messages"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/messages",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "claude-sonnet-4",
                                    "system": "same system",
                                    "tools": [{"name": "lookup", "input_schema": {"type": "object"}}],
                                    "messages": messages,
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"msg_{request_id}"})},
                    },
                }

            first_messages = [message("start"), {"role": "assistant", "content": "working"}]
            second_messages = [message("start"), {"role": "assistant", "content": "working"}, message("next")]
            logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first_messages))
            logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second_messages))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 1)
            only_task = next(iter(index["tasks"].values()))
            self.assertEqual(only_task["kind"], "messages")
            self.assertEqual(only_task["request_count"], 2)
        finally:
            log_dir.cleanup()

    def test_claude_messages_static_boundary_change_starts_new_task(self) -> None:
        for changed_field in ("system", "first_user"):
            with self.subTest(changed_field=changed_field):
                log_dir = tempfile.TemporaryDirectory()
                try:
                    root = Path(log_dir.name)
                    logger = TrafficLogger(root / "readable")

                    def record(request_id: str, timestamp: str, system: str, first_user: str) -> dict[str, object]:
                        return {
                            "id": request_id,
                            "timestamp": timestamp,
                            "started_timestamp": timestamp,
                            "event": "request_finished",
                            "duration_ms": 100,
                            "client": {"host": "127.0.0.1", "port": 1000},
                            "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/messages"},
                            "request": {
                                "method": "POST",
                                "path": "/v1/messages",
                                "headers": {},
                                "body": {
                                    "size_bytes": 0,
                                    "base64": "",
                                    "text": json.dumps(
                                        {
                                            "model": "claude-sonnet-4",
                                            "system": system,
                                            "messages": [
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
                                "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"msg_{request_id}"})},
                            },
                        }

                    first = {"system": "system A", "first_user": "same first user"}
                    second = dict(first)
                    if changed_field == "system":
                        second["system"] = "system B"
                    else:
                        second["first_user"] = "different first user"

                    logger.write(record("req_1", "2026-06-07T08:00:00.000+00:00", first["system"], first["first_user"]))
                    logger.write(record("req_2", "2026-06-07T08:00:10.000+00:00", second["system"], second["first_user"]))

                    with (root / ".task-index.json").open(encoding="utf-8") as file:
                        index = json.load(file)
                    self.assertEqual(len(index["tasks"]), 2)
                finally:
                    log_dir.cleanup()

    def test_claude_messages_start_new_task_when_first_user_is_dropped(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            logger = TrafficLogger(root / "readable")

            def user(text: str) -> dict[str, object]:
                return {"role": "user", "content": [{"type": "text", "text": text}]}

            def assistant(text: str) -> dict[str, object]:
                return {"role": "assistant", "content": [{"type": "text", "text": text}]}

            def record(request_id: str, timestamp: str, messages: list[object]) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/messages"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/messages",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "claude-haiku-4-5-20251001",
                                    "tools": [{"name": "str_replace_editor", "input_schema": {"type": "object"}}],
                                    "messages": messages,
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"msg_{request_id}"})},
                    },
                }

            logger.write(record("req_1", "2026-07-04T09:08:10.000+00:00", [user("你好")]))
            logger.write(
                record(
                    "req_2",
                    "2026-07-04T09:08:47.000+00:00",
                    [user("你好"), assistant("你好！我是 Claude Code。"), user("你和 chatgpt 哪个厉害")],
                )
            )
            logger.write(
                record(
                    "req_3",
                    "2026-07-04T09:09:34.000+00:00",
                    [
                        user("你好"),
                        assistant("你好！我是 Claude Code。"),
                        user("你和 chatgpt 哪个厉害"),
                        assistant("各有优势。"),
                        user("写个 C++ 的快排，要支持自定义数据格式"),
                    ],
                )
            )
            logger.write(
                record(
                    "req_4",
                    "2026-07-04T09:12:58.000+00:00",
                    [
                        user("你和 chatgpt 哪个厉害"),
                        assistant("各有优势。"),
                        user("写个 C++ 的快排，要支持自定义数据格式"),
                        assistant("这是 C++ 快排。"),
                        user("改成并行排序"),
                        assistant("这是并行排序。"),
                        user("优化策略"),
                    ],
                )
            )
            logger.write(
                record(
                    "req_5",
                    "2026-07-04T09:18:52.000+00:00",
                    [
                        user("你好"),
                        assistant("你好！我是 Claude Code。"),
                        user("你和 chatgpt 哪个厉害"),
                        assistant("各有优势。"),
                        user("写个 C++ 的快排，要支持自定义数据格式"),
                        assistant("这是 C++ 快排。"),
                        user("改成并行排序"),
                    ],
                )
            )

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertEqual(len(index["tasks"]), 2)
            request_counts = sorted(task["request_count"] for task in index["tasks"].values())
            self.assertEqual(request_counts, [1, 4])
        finally:
            log_dir.cleanup()

    def test_task_index_save_preserves_entries_from_sibling_loggers(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            first_logger = TrafficLogger(root / "readable")
            second_logger = TrafficLogger(root / "readable")

            def user(text: str) -> dict[str, object]:
                return {"role": "user", "content": [{"type": "text", "text": text}]}

            def claude_record(request_id: str, timestamp: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/messages"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/messages",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "claude-haiku-4-5-20251001",
                                    "messages": [user("数据大小差距较大的怎么优化")],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"msg_{request_id}"})},
                    },
                }

            def responses_record(request_id: str, timestamp: str) -> dict[str, object]:
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
                                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "other task"}]}],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"resp_{request_id}"})},
                    },
                }

            first_logger.write(claude_record("req_claude", "2026-07-04T10:19:18.000+00:00"))
            second_logger.write(responses_record("req_responses", "2026-07-04T10:20:00.000+00:00"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            kinds = sorted(task["kind"] for task in index["tasks"].values())
            self.assertEqual(kinds, ["messages", "responses"])
            self.assertIn("req_claude", index["request_to_task"])
            self.assertIn("req_responses", index["request_to_task"])
        finally:
            log_dir.cleanup()

    def test_task_index_load_ignores_outdated_or_incomplete_index(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            index_path = root / ".task-index.json"
            for payload in (
                {"tasks": {"old": {}}, "request_to_task": {}},
                {
                    "task_match_strategy_version": TASK_MATCH_STRATEGY_VERSION - 1,
                    "tasks": {"old": {}},
                    "request_to_task": {},
                    "response_to_task": {},
                    "context_to_task": {},
                },
                {
                    "task_match_strategy_version": TASK_MATCH_STRATEGY_VERSION,
                    "tasks": {},
                    "request_to_task": {},
                    "response_to_task": {},
                    "context_to_task": {},
                    "extra": {},
                },
            ):
                index_path.write_text(json.dumps(payload), encoding="utf-8")
                loaded = TaskIndexStore(index_path).load()
                self.assertEqual(loaded["task_match_strategy_version"], TASK_MATCH_STRATEGY_VERSION)
                self.assertEqual(loaded["tasks"], {})
                self.assertEqual(loaded["request_to_task"], {})
                self.assertEqual(loaded["response_to_task"], {})
                self.assertEqual(loaded["context_to_task"], {})
        finally:
            log_dir.cleanup()

    def test_sibling_logger_refreshes_index_before_grouping_claude_messages(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            first_logger = TrafficLogger(root / "readable")
            second_logger = TrafficLogger(root / "readable")

            def user(text: str) -> dict[str, object]:
                return {"role": "user", "content": [{"type": "text", "text": text}]}

            def assistant(text: str) -> dict[str, object]:
                return {"role": "assistant", "content": [{"type": "text", "text": text}]}

            def record(request_id: str, timestamp: str, messages: list[object]) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/messages"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/messages",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "claude-haiku-4-5-20251001",
                                    "messages": messages,
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"msg_{request_id}"})},
                    },
                }

            first_logger.write(
                record(
                    "req_1",
                    "2026-07-04T10:20:00.000+00:00",
                    [
                        user("数据重复度高怎么优化"),
                        assistant("可以优化 partition。"),
                        user("数据大小差距较大的怎么优化"),
                        assistant("可以分块。"),
                        user("要"),
                        assistant("好的。"),
                        user("要更细颗粒度的"),
                    ],
                )
            )
            second_logger.write(
                record(
                    "req_2",
                    "2026-07-04T10:38:36.000+00:00",
                    [
                        user("数据重复度高怎么优化"),
                        assistant("可以优化 partition。"),
                        user("数据大小差距较大的怎么优化"),
                        assistant("可以分块。"),
                        user("要"),
                        assistant("好的。"),
                        user("要更细颗粒度的"),
                        assistant("这是细颗粒度方案。"),
                        user("优化一下代码性能"),
                    ],
                )
            )

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            message_tasks = [task for task in index["tasks"].values() if task["kind"] == "messages"]
            self.assertEqual(len(message_tasks), 1)
            self.assertEqual(message_tasks[0]["request_count"], 2)
            self.assertIn("req_1", index["request_to_task"])
            self.assertIn("req_2", index["request_to_task"])
        finally:
            log_dir.cleanup()

    def test_stale_sibling_logger_save_does_not_roll_back_newer_task_metadata(self) -> None:
        log_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(log_dir.name)
            first_logger = TrafficLogger(root / "readable")
            second_logger = TrafficLogger(root / "readable")

            def record(request_id: str, timestamp: str, path: str, text: str) -> dict[str, object]:
                return {
                    "id": request_id,
                    "timestamp": timestamp,
                    "started_timestamp": timestamp,
                    "event": "request_finished",
                    "duration_ms": 100,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": path},
                    "request": {
                        "method": "POST",
                        "path": path,
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "input": [
                                        {
                                            "type": "message",
                                            "role": "user",
                                            "content": [{"type": "input_text", "text": text}],
                                        }
                                    ],
                                }
                            ),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"id": f"resp_{request_id}"})},
                    },
                }

            first_logger.write(record("req_1", "2026-07-04T10:00:00.000+00:00", "/v1/responses", "start"))
            first_logger.write(
                {
                    **record("req_2", "2026-07-04T10:05:00.000+00:00", "/v1/responses", "start"),
                    "request": {
                        **record("req_2", "2026-07-04T10:05:00.000+00:00", "/v1/responses", "start")["request"],
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps(
                                {
                                    "model": "gpt-5.5",
                                    "previous_response_id": "resp_req_1",
                                    "input": [
                                        {
                                            "type": "message",
                                            "role": "user",
                                            "content": [{"type": "input_text", "text": "next"}],
                                        }
                                    ],
                                }
                            ),
                        },
                    },
                }
            )
            second_logger.write(record("req_other", "2026-07-04T10:06:00.000+00:00", "/v1/responses", "other"))

            with (root / ".task-index.json").open(encoding="utf-8") as file:
                index = json.load(file)
            self.assertIn("req_2", index["request_to_task"])
            task = index["tasks"][index["request_to_task"]["req_2"]]
            self.assertEqual(task["last_seen_at"], "2026-07-04T10:05:00.000+00:00")
            self.assertIn("req_1", task["requests"])
            self.assertIn("req_2", task["requests"])
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
