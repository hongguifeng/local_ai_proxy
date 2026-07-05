import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from llm_proxy.log_repository import LogRepository


class LogRepositoryTests(unittest.TestCase):
    def test_upserts_task_and_record(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                repository.upsert_task(
                    {
                        "id": "task-1",
                        "kind": "responses",
                        "endpoint": "/v1/responses",
                        "model": "gpt-5",
                        "target": "http://127.0.0.1:1235/v1/responses",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "last_seen_at": "2026-07-06T00:00:00+00:00",
                        "match_strategy_version": 3,
                        "fingerprints": {"input": "abc"},
                    }
                )
                record = repository.upsert_record(
                    {
                        "id": "record-1",
                        "task_id": "task-1",
                        "sequence": 1,
                        "event": "request_finished",
                        "timestamp": "2026-07-06T00:00:01+00:00",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "duration_ms": 100.5,
                        "method": "POST",
                        "path": "/v1/responses",
                        "endpoint": "/v1/responses",
                        "status": 200,
                        "message_count": 2,
                        "token_count": 9,
                        "request_headers": {"content-type": ["application/json"]},
                        "response_headers": {"content-type": ["application/json"]},
                        "request_body": {"input": "hello"},
                        "response_body": {"output_text": "hi"},
                    }
                )

                self.assertEqual(record["id"], "record-1")
                self.assertEqual(record["request_body"], {"input": "hello"})
                self.assertEqual(record["response_body"], {"output_text": "hi"})
                self.assertEqual(repository.task_id_for_record("record-1"), "task-1")
                self.assertEqual(repository.get_task("task-1")["fingerprints"], {"input": "abc"})
            finally:
                repository.close()

    def test_upsert_record_updates_existing_row(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                repository.upsert_task(
                    {
                        "id": "task-1",
                        "kind": "responses",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "last_seen_at": "2026-07-06T00:00:00+00:00",
                        "match_strategy_version": 3,
                    }
                )
                base_record = {
                    "id": "record-1",
                    "task_id": "task-1",
                    "sequence": 1,
                    "timestamp": "2026-07-06T00:00:00+00:00",
                    "started_at": "2026-07-06T00:00:00+00:00",
                    "method": "POST",
                    "path": "/v1/responses",
                    "endpoint": "/v1/responses",
                }
                repository.upsert_record({**base_record, "event": "request_pending_response"})
                updated = repository.upsert_record(
                    {
                        **base_record,
                        "event": "request_finished",
                        "timestamp": "2026-07-06T00:00:02+00:00",
                        "status": 200,
                        "response_body": {"ok": True},
                    }
                )

                self.assertEqual(updated["event"], "request_finished")
                self.assertEqual(updated["status"], 200)
                self.assertEqual(updated["response_body"], {"ok": True})
                self.assertEqual(repository.list_task_records("task-1")["total"], 1)
            finally:
                repository.close()

    def test_response_and_context_links_find_task(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                repository.upsert_task(
                    {
                        "id": "task-1",
                        "kind": "responses",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "last_seen_at": "2026-07-06T00:00:00+00:00",
                        "match_strategy_version": 3,
                    }
                )
                repository.upsert_response_link("resp_1", "task-1")
                repository.upsert_context_link("conversation:abc", "task-1")

                self.assertEqual(repository.task_id_for_response("resp_1"), "task-1")
                self.assertEqual(repository.task_id_for_context("conversation:abc"), "task-1")
            finally:
                repository.close()

    def test_lists_tasks_and_records_with_search_and_pagination(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                for index in range(3):
                    task_id = f"task-{index}"
                    repository.upsert_task(
                        {
                            "id": task_id,
                            "kind": "responses",
                            "endpoint": "/v1/responses",
                            "model": "gpt-5" if index != 1 else "claude",
                            "target": f"http://target-{index}",
                            "started_at": f"2026-07-06T00:00:0{index}+00:00",
                            "last_seen_at": f"2026-07-06T00:00:0{index}+00:00",
                            "match_strategy_version": 3,
                            "request_count": index + 1,
                        }
                    )
                    repository.upsert_record(
                        {
                            "id": f"record-{index}",
                            "task_id": task_id,
                            "sequence": 1,
                            "event": "request_finished",
                            "timestamp": f"2026-07-06T00:00:0{index}+00:00",
                            "started_at": f"2026-07-06T00:00:0{index}+00:00",
                            "method": "POST",
                            "path": "/v1/responses",
                            "endpoint": "/v1/responses",
                            "target_url": f"http://target-{index}",
                            "status": 200 + index,
                        }
                    )

                tasks = repository.list_tasks("gpt-5", limit=1, offset=0)
                self.assertEqual(tasks["total"], 2)
                self.assertEqual(len(tasks["tasks"]), 1)
                self.assertTrue(tasks["has_more"])

                records = repository.list_task_records("task-2", "202")
                self.assertEqual(records["total"], 1)
                self.assertEqual(records["records"][0]["id"], "record-2")
            finally:
                repository.close()

    def test_search_matches_record_content_and_timestamps(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                repository.upsert_task(
                    {
                        "id": "task-1",
                        "kind": "responses",
                        "endpoint": "/v1/responses",
                        "model": "gpt-5",
                        "target": "http://target",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "last_seen_at": "2026-07-06T00:00:02+00:00",
                        "last_response_at": "2026-07-06T00:00:02+00:00",
                        "match_strategy_version": 3,
                        "request_count": 2,
                    }
                )
                repository.upsert_record(
                    {
                        "id": "record-1",
                        "task_id": "task-1",
                        "sequence": 1,
                        "event": "request_finished",
                        "timestamp": "2026-07-06T00:00:01+00:00",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "method": "POST",
                        "path": "/v1/responses",
                        "endpoint": "/v1/responses",
                        "target_url": "http://target",
                        "status": 200,
                        "request_body": {"input": "find the launch checklist", "tag": "alpha_beta"},
                        "response_body": {"output_text": "Launch window confirmed"},
                    }
                )
                repository.upsert_record(
                    {
                        "id": "record-2",
                        "task_id": "task-1",
                        "sequence": 2,
                        "event": "request_finished",
                        "timestamp": "2026-07-06T00:00:02+00:00",
                        "started_at": "2026-07-06T00:00:02+00:00",
                        "method": "POST",
                        "path": "/v1/responses",
                        "endpoint": "/v1/responses",
                        "target_url": "http://target",
                        "status": 200,
                        "request_body": {"input": "discount 50% off", "tag": "alphaXbeta"},
                        "response_body": {"output_text": "Coupon captured"},
                    }
                )

                request_match = repository.list_tasks("launch checklist")
                self.assertEqual(request_match["total"], 1)
                self.assertEqual(request_match["tasks"][0]["id"], "task-1")

                response_match = repository.list_tasks("coupon captured")
                self.assertEqual(response_match["total"], 1)
                self.assertEqual(response_match["tasks"][0]["id"], "task-1")

                repository.connection.execute("DELETE FROM record_search")
                old_database_match = repository.list_tasks("launch window")
                self.assertEqual(old_database_match["total"], 1)
                self.assertEqual(old_database_match["tasks"][0]["id"], "task-1")

                timestamp_match = repository.list_task_records("task-1", "2026-07-06 00:00:02")
                self.assertEqual(timestamp_match["total"], 1)
                self.assertEqual(timestamp_match["records"][0]["id"], "record-2")

                literal_underscore_match = repository.list_task_records("task-1", "alpha_beta")
                self.assertEqual(literal_underscore_match["total"], 1)
                self.assertEqual(literal_underscore_match["records"][0]["id"], "record-1")

                percent_match = repository.list_task_records("task-1", "50%")
                self.assertEqual(percent_match["total"], 1)
                self.assertEqual(percent_match["records"][0]["id"], "record-2")
            finally:
                repository.close()

    def test_delete_tasks_cascades_records_and_links(self) -> None:
        with TemporaryDirectory() as temp_dir:
            repository = LogRepository(Path(temp_dir))
            try:
                repository.upsert_task(
                    {
                        "id": "task-1",
                        "kind": "responses",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "last_seen_at": "2026-07-06T00:00:00+00:00",
                        "match_strategy_version": 3,
                    }
                )
                repository.upsert_record(
                    {
                        "id": "record-1",
                        "task_id": "task-1",
                        "sequence": 1,
                        "event": "request_finished",
                        "timestamp": "2026-07-06T00:00:00+00:00",
                        "started_at": "2026-07-06T00:00:00+00:00",
                        "method": "POST",
                        "path": "/v1/responses",
                        "endpoint": "/v1/responses",
                    }
                )
                repository.upsert_response_link("resp_1", "task-1")
                repository.upsert_context_link("conversation:abc", "task-1")

                self.assertEqual(repository.delete_tasks(["task-1"]), 1)
                self.assertIsNone(repository.get_task("task-1"))
                self.assertIsNone(repository.get_record("record-1"))
                self.assertIsNone(repository.task_id_for_response("resp_1"))
                self.assertIsNone(repository.task_id_for_context("conversation:abc"))
            finally:
                repository.close()
