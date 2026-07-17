import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from llm_proxy.log_repository import LogRepository
from llm_proxy.task_matcher import TaskAssignment, TaskMatcher


def body(value: object) -> dict[str, object]:
    return {"size_bytes": 0, "base64": "", "text": json.dumps(value)}


def response_body(value: object) -> dict[str, object]:
    return {"size_bytes": 0, "base64": "", "text": json.dumps(value)}


def responses_record(request_id: str, timestamp: str, payload: object, response_payload: object | None = None) -> dict[str, object]:
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
            "body": body(payload),
        },
        "response": {
            "status": 200,
            "headers": {},
            "body": response_body(response_payload or {}),
        },
    }


def chat_record(request_id: str, timestamp: str, messages: list[object]) -> dict[str, object]:
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
            "body": body({"model": "gpt-5", "messages": messages}),
        },
        "response": {
            "status": 200,
            "headers": {},
            "body": response_body({"id": f"chatcmpl_{request_id}"}),
        },
    }


def persist(repository: LogRepository, assignment: TaskAssignment, record: dict[str, object]) -> None:
    repository.upsert_task(assignment.task)
    request = record["request"]
    response = record["response"]
    assert isinstance(request, dict)
    assert isinstance(response, dict)
    repository.upsert_record(
        {
            "id": record["id"],
            "task_id": assignment.task["id"],
            "sequence": assignment.sequence,
            "event": record.get("event"),
            "timestamp": record.get("timestamp"),
            "started_at": record.get("started_timestamp"),
            "duration_ms": record.get("duration_ms"),
            "method": request["method"],
            "path": request["path"],
            "endpoint": request["path"],
            "status": response.get("status"),
            "request_body": assignment.request_payload,
            "response_body": assignment.response_payload,
        }
    )
    for response_id in assignment.response_ids:
        repository.upsert_response_link(response_id, str(assignment.task["id"]))
    for context_key in assignment.context_keys:
        repository.upsert_context_link(context_key, str(assignment.task["id"]))


class TaskMatcherTests(unittest.TestCase):
    def test_pending_and_finished_record_use_same_task_and_sequence(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                pending = {
                    "id": "req_1",
                    "timestamp": "2026-07-06T00:00:00+00:00",
                    "started_timestamp": "2026-07-06T00:00:00+00:00",
                    "event": "request_received",
                    "duration_ms": 0,
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": body({}),
                        "body_pending": True,
                    },
                    "response": {"status": None, "headers": {}, "body": response_body({})},
                }
                assignment = matcher.assign(pending)
                assert assignment is not None
                persist(repository, assignment, pending)

                finished = responses_record(
                    "req_1",
                    "2026-07-06T00:00:02+00:00",
                    {"model": "gpt-5", "input": [{"role": "user", "content": "hello"}]},
                    {"id": "resp_1"},
                )
                finished_assignment = matcher.assign(finished)
                assert finished_assignment is not None
                persist(repository, finished_assignment, finished)

                self.assertEqual(finished_assignment.task["id"], assignment.task["id"])
                self.assertEqual(finished_assignment.sequence, 1)
                self.assertFalse(repository.get_task(str(assignment.task["id"]))["pending_request_only"])
                self.assertEqual(repository.list_task_records(str(assignment.task["id"]))["total"], 1)
            finally:
                repository.close()

    def test_previous_response_id_groups_followup(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                first = responses_record(
                    "req_1",
                    "2026-07-06T00:00:00+00:00",
                    {"model": "gpt-5", "instructions": "system", "input": [{"role": "user", "content": "start"}]},
                    {"id": "resp_1"},
                )
                first_assignment = matcher.assign(first)
                assert first_assignment is not None
                persist(repository, first_assignment, first)

                second = responses_record(
                    "req_2",
                    "2026-07-06T00:00:10+00:00",
                    {
                        "model": "gpt-5",
                        "instructions": "system",
                        "previous_response_id": "resp_1",
                        "input": [{"role": "user", "content": "continue"}],
                    },
                    {"id": "resp_2"},
                )
                second_assignment = matcher.assign(second)
                assert second_assignment is not None

                self.assertEqual(second_assignment.task["id"], first_assignment.task["id"])
                self.assertEqual(second_assignment.sequence, 2)
            finally:
                repository.close()

    def test_context_key_groups_followup(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                first = responses_record(
                    "req_1",
                    "2026-07-06T00:00:00+00:00",
                    {
                        "model": "gpt-5",
                        "conversation_id": "conv_1",
                        "input": [{"role": "user", "content": "start"}],
                    },
                    {"id": "resp_1"},
                )
                first_assignment = matcher.assign(first)
                assert first_assignment is not None
                persist(repository, first_assignment, first)

                second = responses_record(
                    "req_2",
                    "2026-07-06T00:00:10+00:00",
                    {
                        "model": "gpt-5",
                        "conversation_id": "conv_1",
                        "input": [{"role": "user", "content": "continue"}],
                    },
                    {"id": "resp_2"},
                )
                second_assignment = matcher.assign(second)
                assert second_assignment is not None

                self.assertEqual(second_assignment.task["id"], first_assignment.task["id"])
            finally:
                repository.close()

    def test_model_change_starts_new_task(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                first = responses_record(
                    "req_1",
                    "2026-07-06T00:00:00+00:00",
                    {"model": "gpt-5", "input": [{"role": "user", "content": "same"}]},
                    {"id": "resp_1"},
                )
                first_assignment = matcher.assign(first)
                assert first_assignment is not None
                persist(repository, first_assignment, first)

                second = responses_record(
                    "req_2",
                    "2026-07-06T00:00:10+00:00",
                    {"model": "qwen3", "input": [{"role": "user", "content": "same"}]},
                    {"id": "resp_2"},
                )
                second_assignment = matcher.assign(second)
                assert second_assignment is not None

                self.assertNotEqual(second_assignment.task["id"], first_assignment.task["id"])
            finally:
                repository.close()

    def test_chat_user_message_continuation_groups_heuristically(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                first = chat_record("req_1", "2026-07-06T00:00:00+00:00", [{"role": "user", "content": "hello"}])
                first_assignment = matcher.assign(first)
                assert first_assignment is not None
                persist(repository, first_assignment, first)

                second = chat_record(
                    "req_2",
                    "2026-07-06T00:00:10+00:00",
                    [
                        {"role": "user", "content": "hello"},
                        {"role": "assistant", "content": "hi"},
                        {"role": "user", "content": "next"},
                    ],
                )
                second_assignment = matcher.assign(second)
                assert second_assignment is not None

                self.assertEqual(second_assignment.task["id"], first_assignment.task["id"])
            finally:
                repository.close()

    def test_heuristic_matching_uses_an_inclusive_24_hour_window(self) -> None:
        cases = [
            ("2026-07-07T00:00:00+00:00", True),
            ("2026-07-07T00:00:01+00:00", False),
        ]
        for followup_timestamp, should_match in cases:
            with self.subTest(followup_timestamp=followup_timestamp), TemporaryDirectory() as temp_dir:
                repository = LogRepository(Path(temp_dir))
                try:
                    matcher = TaskMatcher(repository)
                    first = chat_record(
                        "req_1",
                        "2026-07-06T00:00:00+00:00",
                        [{"role": "user", "content": "hello"}],
                    )
                    first_assignment = matcher.assign(first)
                    assert first_assignment is not None
                    persist(repository, first_assignment, first)

                    second = chat_record(
                        "req_2",
                        followup_timestamp,
                        [
                            {"role": "user", "content": "hello"},
                            {"role": "assistant", "content": "hi"},
                            {"role": "user", "content": "continue"},
                        ],
                    )
                    second_assignment = matcher.assign(second)
                    assert second_assignment is not None

                    self.assertEqual(
                        second_assignment.task["id"] == first_assignment.task["id"],
                        should_match,
                    )
                finally:
                    repository.close()

    def test_heuristic_matching_requires_the_previous_user_sequence_as_prefix(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                first = chat_record(
                    "req_1",
                    "2026-07-06T00:00:00+00:00",
                    [
                        {"role": "user", "content": "first"},
                        {"role": "assistant", "content": "answer"},
                        {"role": "user", "content": "second"},
                    ],
                )
                first_assignment = matcher.assign(first)
                assert first_assignment is not None
                persist(repository, first_assignment, first)

                changed_history = chat_record(
                    "req_2",
                    "2026-07-06T00:00:10+00:00",
                    [
                        {"role": "user", "content": "first"},
                        {"role": "assistant", "content": "different answer"},
                        {"role": "user", "content": "replacement second"},
                        {"role": "user", "content": "third"},
                    ],
                )
                changed_assignment = matcher.assign(changed_history)
                assert changed_assignment is not None

                self.assertNotEqual(changed_assignment.task["id"], first_assignment.task["id"])
            finally:
                repository.close()

    def test_explicit_context_link_wins_over_more_recent_heuristic_candidates(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                matcher = TaskMatcher(repository)
                conversation_a = responses_record(
                    "req_a1",
                    "2026-07-06T00:00:00+00:00",
                    {
                        "model": "gpt-5",
                        "instructions": "same instructions",
                        "conversation_id": "conversation-a",
                        "input": [{"role": "user", "content": "same first message"}],
                    },
                    {"id": "resp_a1"},
                )
                assignment_a = matcher.assign(conversation_a)
                assert assignment_a is not None
                persist(repository, assignment_a, conversation_a)

                conversation_b = responses_record(
                    "req_b1",
                    "2026-07-06T00:01:00+00:00",
                    {
                        "model": "gpt-5",
                        "instructions": "same instructions",
                        "conversation_id": "conversation-b",
                        "input": [{"role": "user", "content": "same first message"}],
                    },
                    {"id": "resp_b1"},
                )
                assignment_b = matcher.assign(conversation_b)
                assert assignment_b is not None
                persist(repository, assignment_b, conversation_b)
                self.assertNotEqual(assignment_b.task["id"], assignment_a.task["id"])

                followup_a = responses_record(
                    "req_a2",
                    "2026-07-06T00:02:00+00:00",
                    {
                        "model": "gpt-5",
                        "instructions": "same instructions",
                        "conversation_id": "conversation-a",
                        "input": [{"role": "user", "content": "new explicit-context message"}],
                    },
                    {"id": "resp_a2"},
                )
                followup_assignment = matcher.assign(followup_a)
                assert followup_assignment is not None

                self.assertEqual(followup_assignment.task["id"], assignment_a.task["id"])
                self.assertNotEqual(followup_assignment.task["id"], assignment_b.task["id"])
            finally:
                repository.close()
