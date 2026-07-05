import http.client
import json
import tempfile
import threading
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from llm_proxy.admin_server import AdminServer
from llm_proxy.log_repository import LogRepository
from llm_proxy.manager import ProxyManager


class AdminUiTests(unittest.TestCase):
    def test_admin_static_assets_are_served(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/static/app.css")
            css_response = conn.getresponse()
            css_body = css_response.read().decode("utf-8")
            conn.close()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/static/app.js")
            js_response = conn.getresponse()
            js_body = js_response.read().decode("utf-8")
            conn.close()

            self.assertEqual(css_response.status, 200)
            self.assertIn("text/css", css_response.getheader("Content-Type", ""))
            self.assertIn(".app", css_body)
            self.assertEqual(js_response.status, 200)
            self.assertIn("javascript", js_response.getheader("Content-Type", ""))
            self.assertIn("suggestedStripRequestFields", js_body)
            self.assertNotIn("__SUGGESTED_STRIP_REQUEST_FIELDS__", js_body)
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_proxy_pairs_can_be_saved_and_listed(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            body = json.dumps(
                {
                    "pairs": [
                        {
                            "id": "one",
                            "name": "One",
                            "enabled": False,
                            "listen_host": "127.0.0.1",
                            "listen_port": 1234,
                            "targets": [
                                {
                                    "id": "target-one",
                                    "name": "Target one",
                                    "target_url": "http://127.0.0.1:1235/v1",
                                    "target_headers": ["X-Test: yes"],
                                }
                            ],
                            "default_target_id": "target-one",
                        }
                    ]
                }
            )
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("PUT", "/api/pairs", body=body, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            saved = json.loads(response.read())
            conn.close()

            self.assertEqual([pair["id"] for pair in saved["pairs"]], ["one"])
            with (root / "proxies.json").open(encoding="utf-8") as file:
                on_disk = json.load(file)
            self.assertEqual([pair["id"] for pair in on_disk["pairs"]], ["one"])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_group_logs_and_detail_read_sqlite(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            self._write_log(root, "task-one", "req_1", "gpt-5", "http://target/v1/responses", status=200)
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["total"], 1)
            group = payload["groups"][0]
            self.assertEqual(group["id"], "task-one")
            self.assertEqual(group["model"], "gpt-5")
            self.assertIn("1 requests", group["meta"])

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", f"/api/log-groups/{group['id']}/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            group_payload = json.loads(response.read())
            conn.close()

            self.assertEqual(group_payload["logs"][0]["id"], "req_1")
            self.assertEqual(group_payload["logs"][0]["endpoint"], "/v1/responses")

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/req_1")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            detail = json.loads(response.read())
            conn.close()

            self.assertEqual(detail["request"]["body_json"], {"input": "hello"})
            self.assertNotIn("path", detail["request"])
            self.assertEqual(detail["response"]["body_json"], {"ok": True})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_searches_and_paginates_sqlite_tasks(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            self._write_log(root, "task-1", "req_1", "gpt-5", "http://target-a/v1/responses", status=200)
            self._write_log(root, "task-2", "req_2", "claude", "http://target-b/v1/messages", status=201)
            self._write_log(root, "task-3", "req_3", "gpt-5", "http://target-c/v1/responses", status=202)
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs?q=gpt-5&limit=1&offset=0")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["total"], 2)
            self.assertEqual(len(payload["groups"]), 1)
            self.assertTrue(payload["has_more"])

            group_id = payload["groups"][0]["id"]
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", f"/api/log-groups/{group_id}/logs?q=202")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            group_payload = json.loads(response.read())
            conn.close()

            self.assertEqual(group_payload["logs"][0]["status"], 202)
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_reads_all_target_log_databases(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            first_root = root / "first-logs"
            second_root = root / "second-logs"
            self._write_log(first_root, "task-first", "req_first", "gpt-5", "http://target-a/v1/responses")
            self._write_log(second_root, "task-second", "req_second", "claude", "http://target-b/v1/messages")

            manager = ProxyManager(root / "proxies.json", root / "default-logs")
            manager.replace_pairs(
                [
                    {
                        "id": "one",
                        "name": "One",
                        "enabled": False,
                        "listen_host": "127.0.0.1",
                        "listen_port": 1234,
                        "targets": [
                            {
                                "id": "first",
                                "name": "First",
                                "target_url": "http://127.0.0.1:1235/v1",
                                "log_root": str(first_root),
                            },
                            {
                                "id": "second",
                                "name": "Second",
                                "target_url": "http://127.0.0.1:1236/v1",
                                "log_root": str(second_root),
                            },
                        ],
                    }
                ]
            )
            server = AdminServer(("127.0.0.1", 0), manager)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual({group["id"] for group in payload["groups"]}, {"task-first", "task-second"})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_export_downloads_zip_from_sqlite(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            self._write_log(root, "task-one", "req_1", "gpt-5", "http://target/v1/responses")
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/export")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), "application/zip")
            archive_bytes = response.read()
            conn.close()

            with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
                names = archive.namelist()
                self.assertTrue(any(name.endswith("/index.md") for name in names))
                request_names = [name for name in names if name.endswith("/request.json")]
                self.assertEqual(len(request_names), 1)
                request_body = json.loads(archive.read(request_names[0]).decode("utf-8"))
                self.assertEqual(request_body, {"input": "hello"})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_cleanup_deletes_selected_sqlite_task(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            self._write_log(root, "task-one", "req_1", "gpt-5", "http://target/v1/responses")
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/api/logs/cleanup",
                body=json.dumps({"group_ids": ["task-one"]}),
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["deleted_count"], 1)
            with LogRepository(root) as repository:
                self.assertIsNone(repository.get_task("task-one"))
                self.assertIsNone(repository.get_record("req_1"))
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def _write_log(
        self,
        root: Path,
        task_id: str,
        record_id: str,
        model: str,
        target: str,
        *,
        status: int = 200,
    ) -> None:
        with LogRepository(root) as repository:
            repository.upsert_task(
                {
                    "id": task_id,
                    "kind": "responses",
                    "endpoint": "/v1/responses",
                    "model": model,
                    "target": target,
                    "started_at": f"2026-07-06T00:00:0{status % 10}+00:00",
                    "last_seen_at": f"2026-07-06T00:00:0{status % 10}+00:00",
                    "last_response_at": f"2026-07-06T00:00:0{status % 10}+00:00",
                    "request_count": 1,
                    "match_strategy_version": 4,
                }
            )
            repository.upsert_record(
                {
                    "id": record_id,
                    "task_id": task_id,
                    "sequence": 1,
                    "event": "request_finished",
                    "timestamp": f"2026-07-06T00:00:0{status % 10}+00:00",
                    "started_at": f"2026-07-06T00:00:0{status % 10}+00:00",
                    "method": "POST",
                    "path": "/v1/responses",
                    "endpoint": "/v1/responses",
                    "target_url": target,
                    "status": status,
                    "message_count": 1,
                    "token_count": 2,
                    "request_body": {"input": "hello"},
                    "response_body": {"ok": True},
                }
            )
