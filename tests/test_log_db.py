import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from llm_proxy.log_db import SCHEMA_VERSION, connect_log_db, log_db_path


class LogDbTests(unittest.TestCase):
    def test_log_db_path_uses_traffic_db_name(self) -> None:
        self.assertEqual(log_db_path(Path("logs")), Path("logs") / "traffic.db")
        self.assertIsNone(log_db_path(None))

    def test_connect_initializes_schema_and_pragmas(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection = connect_log_db(root)
            try:
                self.assertTrue((root / "traffic.db").exists())
                self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
                self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
                self.assertEqual(connection.execute("PRAGMA busy_timeout").fetchone()[0], 5000)

                version = connection.execute(
                    "SELECT value FROM schema_meta WHERE key = 'schema_version'"
                ).fetchone()[0]
                self.assertEqual(version, SCHEMA_VERSION)

                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')"
                    )
                }
                self.assertIn("tasks", tables)
                self.assertIn("records", tables)
                self.assertIn("response_links", tables)
                self.assertIn("context_links", tables)
                self.assertIn("record_search", tables)

                connection.execute(
                    """
                    INSERT INTO record_search(record_id, task_id, task_text, request_text, response_text, error_text)
                    VALUES ('record-1', 'task-1', 'gpt-5', 'hello world', 'response text', '')
                    """
                )
                match = connection.execute(
                    "SELECT record_id FROM record_search WHERE record_search MATCH 'hello'"
                ).fetchone()
                self.assertEqual(match[0], "record-1")
            finally:
                connection.close()

    def test_foreign_keys_cascade_records(self) -> None:
        with TemporaryDirectory() as temp_dir:
            connection = connect_log_db(Path(temp_dir))
            try:
                connection.execute(
                    """
                    INSERT INTO tasks(
                      id, kind, started_at, last_seen_at, match_strategy_version, created_at, updated_at
                    )
                    VALUES ('task-1', 'responses', '2026-07-06T00:00:00+00:00',
                            '2026-07-06T00:00:00+00:00', 1,
                            '2026-07-06T00:00:00+00:00', '2026-07-06T00:00:00+00:00')
                    """
                )
                connection.execute(
                    """
                    INSERT INTO records(
                      id, task_id, sequence, event, timestamp, started_at, method, path, endpoint,
                      created_at, updated_at
                    )
                    VALUES ('record-1', 'task-1', 1, 'request_finished',
                            '2026-07-06T00:00:00+00:00', '2026-07-06T00:00:00+00:00',
                            'POST', '/v1/responses', '/v1/responses',
                            '2026-07-06T00:00:00+00:00', '2026-07-06T00:00:00+00:00')
                    """
                )
                connection.commit()

                connection.execute("DELETE FROM tasks WHERE id = 'task-1'")
                connection.commit()

                count = connection.execute("SELECT COUNT(*) FROM records").fetchone()[0]
                self.assertEqual(count, 0)
            finally:
                connection.close()

    def test_missing_parent_directory_is_created(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "nested" / "logs"
            connection = connect_log_db(root)
            try:
                self.assertTrue((root / "traffic.db").exists())
            finally:
                connection.close()

    def test_bad_foreign_key_is_rejected(self) -> None:
        with TemporaryDirectory() as temp_dir:
            connection = connect_log_db(Path(temp_dir))
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        """
                        INSERT INTO records(
                          id, task_id, sequence, event, timestamp, started_at, method, path, endpoint,
                          created_at, updated_at
                        )
                        VALUES ('record-1', 'missing-task', 1, 'request_finished',
                                '2026-07-06T00:00:00+00:00', '2026-07-06T00:00:00+00:00',
                                'POST', '/v1/responses', '/v1/responses',
                                '2026-07-06T00:00:00+00:00', '2026-07-06T00:00:00+00:00')
                        """
                    )
            finally:
                connection.close()
