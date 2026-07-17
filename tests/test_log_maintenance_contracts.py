from __future__ import annotations

import datetime as dt
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from llm_proxy.log_maintenance import cleanup_logs, export_logs_zip
from llm_proxy.log_repository import LogRepository
from llm_proxy.manager import ProxyManager


class LogMaintenanceContractTests(unittest.TestCase):
    def manager_for_roots(self, root: Path, log_roots: list[Path]) -> ProxyManager:
        manager = ProxyManager(root / "proxies.json", root / "fallback-logs")
        targets = [
            {
                "id": f"target-{index}",
                "name": f"Target {index}",
                "target_url": "http://127.0.0.1:1235",
                "log_root": str(log_root),
            }
            for index, log_root in enumerate(log_roots, start=1)
        ]
        manager.replace_pairs(
            [
                {
                    "id": "maintenance",
                    "name": "Maintenance",
                    "enabled": False,
                    "listen_host": "127.0.0.1",
                    "listen_port": 1234,
                    "targets": targets,
                    "default_target_id": targets[0]["id"],
                }
            ]
        )
        return manager

    def write_task(self, log_root: Path, task_id: str, timestamp: str) -> None:
        with LogRepository(log_root) as repository:
            repository.upsert_task(
                {
                    "id": task_id,
                    "kind": "responses",
                    "endpoint": "/v1/responses",
                    "anchor": f"anchor-{task_id}",
                    "model": "fixture-model",
                    "target": "http://fixture/v1/responses",
                    "started_at": timestamp,
                    "last_seen_at": timestamp,
                    "last_response_at": timestamp,
                    "request_count": 1,
                    "match_strategy_version": 4,
                }
            )
            repository.upsert_record(
                {
                    "id": f"record-{task_id}",
                    "task_id": task_id,
                    "sequence": 1,
                    "event": "request_finished",
                    "timestamp": timestamp,
                    "started_at": timestamp,
                    "duration_ms": 10,
                    "method": "POST",
                    "path": "/v1/responses",
                    "endpoint": "/v1/responses",
                    "target_url": "http://fixture/v1/responses",
                    "status": 200,
                    "request_body": {"input": task_id},
                    "response_body": {"output": task_id},
                }
            )

    def task_ids(self, log_root: Path) -> set[str]:
        with LogRepository(log_root) as repository:
            return {str(task["id"]) for task in repository.list_tasks("", 100, 0)["tasks"]}

    def test_export_contains_every_task_from_every_log_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first_root = root / "first"
            second_root = root / "second"
            self.write_task(first_root, "task-first-export", "2026-01-01T00:00:00+00:00")
            self.write_task(second_root, "task-second-export", "2026-01-02T00:00:00+00:00")
            manager = self.manager_for_roots(root, [first_root, second_root])

            archive_bytes = export_logs_zip(manager)

            with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
                names = archive.namelist()
                index_names = [name for name in names if name.endswith("/index.md")]
                request_names = [name for name in names if name.endswith("/request.json")]
                response_names = [name for name in names if name.endswith("/response.json")]
                self.assertEqual(len(index_names), 2)
                self.assertEqual(len(request_names), 2)
                self.assertEqual(len(response_names), 2)
                combined_indexes = "\n".join(archive.read(name).decode("utf-8") for name in index_names)
                self.assertIn("task-first-export", combined_indexes)
                self.assertIn("task-second-export", combined_indexes)

    def test_cleanup_supports_selected_older_than_and_keep_latest_strategies(self) -> None:
        now = dt.datetime.now().astimezone().replace(microsecond=0)

        with self.subTest(strategy="selected"), tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            log_root = root / "logs"
            for task_id in ("task-selected", "task-kept"):
                self.write_task(log_root, task_id, now.isoformat())
            manager = self.manager_for_roots(root, [log_root])

            result = cleanup_logs(manager, group_ids=["task-selected"])

            self.assertEqual(result["deleted"], ["task-selected"])
            self.assertEqual(self.task_ids(log_root), {"task-kept"})

        with self.subTest(strategy="older-than"), tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            log_root = root / "logs"
            self.write_task(log_root, "task-old", (now - dt.timedelta(days=10)).isoformat())
            self.write_task(log_root, "task-new", now.isoformat())
            manager = self.manager_for_roots(root, [log_root])

            result = cleanup_logs(manager, older_than_days=5)

            self.assertEqual(result["deleted"], ["task-old"])
            self.assertEqual(self.task_ids(log_root), {"task-new"})

        with self.subTest(strategy="keep-latest"), tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            log_root = root / "logs"
            self.write_task(log_root, "task-oldest", (now - dt.timedelta(minutes=2)).isoformat())
            self.write_task(log_root, "task-middle", (now - dt.timedelta(minutes=1)).isoformat())
            self.write_task(log_root, "task-latest", now.isoformat())
            manager = self.manager_for_roots(root, [log_root])

            result = cleanup_logs(manager, keep_latest=1)

            self.assertEqual(set(result["deleted"]), {"task-oldest", "task-middle"})
            self.assertEqual(self.task_ids(log_root), {"task-latest"})


if __name__ == "__main__":
    unittest.main()
