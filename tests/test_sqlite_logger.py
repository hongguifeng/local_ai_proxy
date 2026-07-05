import json
import tempfile
import unittest
from pathlib import Path

from llm_proxy.logger import TrafficLogger


def log_body(value: object) -> dict[str, object]:
    return {"size_bytes": 0, "base64": "", "text": json.dumps(value)}


class SqliteTrafficLoggerTests(unittest.TestCase):
    def test_write_stores_task_and_record_in_sqlite(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        logger: TrafficLogger | None = None
        try:
            root = Path(temp_dir.name)
            logger = TrafficLogger(root)
            logger.write(
                {
                    "id": "req_1",
                    "timestamp": "2026-07-06T00:00:00+00:00",
                    "started_timestamp": "2026-07-06T00:00:00+00:00",
                    "event": "request_finished",
                    "duration_ms": 10,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": log_body({"model": "gpt-5", "input": [{"role": "user", "content": "hi"}]}),
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": log_body({"id": "resp_1", "usage": {"input_tokens": 3, "output_tokens": 2}}),
                    },
                }
            )

            self.assertTrue((root / "traffic.db").exists())
            self.assertFalse((root / "tasks").exists())
            assert logger.repository is not None
            tasks = logger.repository.list_tasks()
            self.assertEqual(tasks["total"], 1)
            self.assertEqual(tasks["tasks"][0]["request_count"], 1)
            record = logger.repository.get_record("req_1")
            assert record is not None
            self.assertEqual(record["status"], 200)
            self.assertEqual(record["message_count"], 1)
            self.assertEqual(record["token_count"], 5)
        finally:
            if logger is not None:
                logger.close()
            temp_dir.cleanup()

    def test_update_and_write_keep_one_record(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        logger: TrafficLogger | None = None
        try:
            root = Path(temp_dir.name)
            logger = TrafficLogger(root)
            base_record = {
                "id": "req_1",
                "timestamp": "2026-07-06T00:00:00+00:00",
                "started_timestamp": "2026-07-06T00:00:00+00:00",
                "duration_ms": 1,
                "client": {"host": "127.0.0.1", "port": 1000},
                "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                "request": {
                    "method": "POST",
                    "path": "/v1/responses",
                    "headers": {},
                    "body": log_body({"model": "gpt-5", "input": [{"role": "user", "content": "hi"}]}),
                },
            }
            logger.update(
                {
                    **base_record,
                    "event": "request_pending_response",
                    "response": {"status": None, "headers": {}, "body": log_body({})},
                }
            )
            logger.write(
                {
                    **base_record,
                    "timestamp": "2026-07-06T00:00:02+00:00",
                    "event": "request_finished",
                    "duration_ms": 2000,
                    "response": {"status": 200, "headers": {}, "body": log_body({"id": "resp_1"})},
                }
            )

            assert logger.repository is not None
            tasks = logger.repository.list_tasks()
            task_id = tasks["tasks"][0]["id"]
            records = logger.repository.list_task_records(task_id)
            self.assertEqual(records["total"], 1)
            self.assertEqual(records["records"][0]["event"], "request_finished")
            self.assertEqual(records["records"][0]["status"], 200)
        finally:
            if logger is not None:
                logger.close()
            temp_dir.cleanup()

    def test_disabled_logger_drops_records(self) -> None:
        logger = TrafficLogger(None)
        logger.write({"id": "req_1"})
        self.assertIsNone(logger.repository)
