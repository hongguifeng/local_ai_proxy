import http.client
import json
import tempfile
import threading
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from llm_proxy.admin_server import AdminServer
from llm_proxy.log_store import LogStore
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
                        },
                        {
                            "id": "two",
                            "name": "Two",
                            "enabled": False,
                            "listen_host": "127.0.0.1",
                            "listen_port": 1236,
                            "targets": [
                                {
                                    "id": "target-two",
                                    "name": "Target two",
                                    "target_url": "http://127.0.0.1:1237",
                                }
                            ],
                            "default_target_id": "target-two",
                        },
                    ]
                }
            )
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("PUT", "/api/pairs", body=body, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            saved = json.loads(response.read())
            conn.close()

            self.assertEqual([pair["id"] for pair in saved["pairs"]], ["one", "two"])
            with (root / "proxies.json").open(encoding="utf-8") as file:
                on_disk = json.load(file)
            self.assertEqual([pair["id"] for pair in on_disk["pairs"]], ["one", "two"])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_detail_returns_request_and_response_json(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            request_path = root / "tasks" / "task-one-dir" / "001__08-00-00.000__v1-responses__req_1"
            request_path.mkdir(parents=True)
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": "task-one-dir",
                                "request_count": 1,
                                "requests": {"req_1": {"dir_name": request_path.name}},
                            }
                        },
                        "request_to_task": {"req_1": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )
            (request_path / "08-00-00.000__08-00-00.010.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses",
                        "- Request: POST /v1/responses",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            (request_path / "request.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            (request_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/log-groups/task-one/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            conn.close()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/req_1")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            detail = json.loads(response.read())
            conn.close()

            self.assertNotIn("record", detail)
            self.assertEqual(detail["request"]["body_json"], {"a": 1})
            self.assertNotIn("path", detail["request"])
            self.assertEqual(detail["request"]["endpoint"], "/v1/responses")
            self.assertEqual(detail["response"]["body_json"], {"ok": True})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_detail_hides_path_when_path_has_query(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            request_path = root / "tasks" / "task-one-dir" / "001__08-00-00.000__v1-responses__req_1"
            request_path.mkdir(parents=True)
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": "task-one-dir",
                                "request_count": 1,
                                "requests": {"req_1": {"dir_name": request_path.name}},
                            }
                        },
                        "request_to_task": {"req_1": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )
            (request_path / "08-00-00.000__08-00-00.010.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses?debug=1",
                        "- Request: POST /v1/responses?debug=1",
                        "- Endpoint: /v1/responses",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/log-groups/task-one/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            conn.close()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/req_1")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            detail = json.loads(response.read())
            conn.close()

            self.assertNotIn("path", detail["request"])
            self.assertEqual(detail["request"]["endpoint"], "/v1/responses")
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_detail_uses_group_loaded_record_path_cache(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(temp_dir.name)
            request_path = root / "tasks" / "task-one" / "001__08-00-00.000__v1-responses__req_1"
            request_path.mkdir(parents=True)
            (request_path / "08-00-00.000__08-00-00.010.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses",
                        "- Request: POST /v1/responses",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            (request_path / "request.json").write_text(json.dumps({"cached": True}), encoding="utf-8")
            (request_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": request_path.parent.name,
                                "request_count": 1,
                                "requests": {"req_1": {"dir_name": request_path.name}},
                            }
                        },
                        "request_to_task": {"req_1": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )
            store = LogStore(ProxyManager(root / "proxies.json", root))

            group = store.list_log_group_logs("task-one", "")
            self.assertEqual([item["id"] for item in (group or {}).get("logs", [])], ["req_1"])

            record = store.find_log("req_1")
            detail = store.record_detail(record or {})

            self.assertEqual(detail["request"]["body_json"], {"cached": True})
            self.assertEqual(detail["response"]["body_json"], {"ok": True})
        finally:
            temp_dir.cleanup()

    def test_log_list_groups_task_directories(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_request_path = (
                root
                / "tasks"
                / "2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo"
                / "001__08-00-00.000__v1-responses__req_1"
            )
            task_request_path.mkdir(parents=True)
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": task_request_path.parent.name,
                                "request_count": 1,
                                "last_seen_at": "2026-06-07T08:00:00.010+00:00",
                            }
                        },
                        "request_to_task": {"req_1": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )
            (task_request_path / "08-00-00.000__08-00-00.010.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses",
                        "- Request: POST /v1/responses",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            (task_request_path / "request.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            (task_request_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(len(payload["groups"]), 1)
            self.assertEqual(payload["groups"][0]["id"], "task-one")
            self.assertEqual(payload["groups"][0]["title"], "2026-06-07 08:00:00.000 - 08:00:00.010")
            self.assertNotIn("logs", payload["groups"][0])

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", f"/api/log-groups/{payload['groups'][0]['id']}/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            group_payload = json.loads(response.read())
            conn.close()

            self.assertEqual(group_payload["logs"][0]["id"], "req_1")
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_uses_directory_time_and_sorts_descending(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_path = (
                root
                / "tasks"
                / "2026-06-07__08-00-00.000__08-00-20.000__responses__fp-demo"
            )

            def write_record(dir_name: str, record_id: str, md_time: str) -> None:
                request_path = task_path / dir_name
                request_path.mkdir(parents=True)
                (request_path / "summary.md").write_text(
                    "\n".join(
                        [
                            f"# LLM Interaction {record_id}",
                            "",
                            "## Summary",
                            "",
                            f"- Time: {md_time}",
                            "- Event: request_finished",
                            "- Target: http://127.0.0.1:1235/v1/responses",
                            "- Request: POST /v1/responses",
                            "- Response: 200",
                        ]
                    ),
                    encoding="utf-8",
                )

            write_record("001__08-00-00.000__v1-responses__req_1", "req_1", "2099-01-01T00:00:00.000+00:00")
            write_record("002__08-00-20.000__v1-responses__req_2", "req_2", "2000-01-01T00:00:00.000+00:00")
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": task_path.name,
                                "request_count": 2,
                                "last_seen_at": "2026-06-07T08:00:20.000+00:00",
                            }
                        },
                        "request_to_task": {"req_1": "task-one", "req_2": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )

            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", f"/api/log-groups/{payload['groups'][0]['id']}/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            group_payload = json.loads(response.read())
            conn.close()

            logs = group_payload["logs"]
            self.assertEqual([item["id"] for item in logs], ["req_2", "req_1"])
            self.assertEqual([item["sequence"] for item in logs], ["002", "001"])
            self.assertEqual(logs[0]["timestamp"], "2026-06-07 08:00:20.000")
            self.assertEqual(logs[1]["timestamp"], "2026-06-07 08:00:00.000")
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_group_logs_sort_by_task_request_timestamp_descending(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_path = root / "tasks" / "2026-06-07__08-00-00.000__08-30-00.000__responses__fp-demo"
            for sequence, record_id in (("001", "req_old"), ("002", "req_new")):
                request_path = task_path / f"{sequence}__08-00-00.000__v1-responses__{record_id}"
                request_path.mkdir(parents=True)
                (request_path / "summary.md").write_text(
                    "\n".join(
                        [
                            f"# LLM Interaction {record_id}",
                            "",
                            "## Summary",
                            "",
                            "- Time: 2000-01-01T00:00:00.000+00:00",
                            "- Event: request_finished",
                            "- Target: http://127.0.0.1:1235/v1/responses",
                            "- Request: POST /v1/responses",
                            "- Response: 200",
                        ]
                    ),
                    encoding="utf-8",
                )
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": task_path.name,
                                "request_count": 2,
                                "last_seen_at": "2026-06-07T08:00:20.000+00:00",
                                "requests": {
                                    "req_old": {
                                        "sequence": 1,
                                        "timestamp": "2026-06-07T08:00:00.000+00:00",
                                    },
                                    "req_new": {
                                        "sequence": 2,
                                        "timestamp": "2026-06-07T08:00:20.000+00:00",
                                    },
                                },
                            }
                        },
                        "request_to_task": {"req_old": "task-one", "req_new": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )

            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/log-groups/task-one/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual([item["id"] for item in payload["logs"]], ["req_new", "req_old"])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_includes_endpoint_message_and_token_summary(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_request_path = (
                root
                / "tasks"
                / "2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo"
                / "001__08-00-00.000__v1-responses__req_1"
            )
            task_request_path.mkdir(parents=True)
            (task_request_path / "summary.md").write_text(
                "\n".join(
                    [
                        "# LLM Interaction req_1",
                        "",
                        "## Summary",
                        "",
                        "- Time: 2026-06-07T08:00:00.000+00:00",
                        "- Event: request_finished",
                        "- Target: http://127.0.0.1:1235/v1/responses",
                        "- Request: POST /v1/responses?debug=true",
                        "- Endpoint: /v1/responses",
                        "- Message count: 3",
                        "- Token count: 5",
                        "- Response: 200",
                    ]
                ),
                encoding="utf-8",
            )
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": task_request_path.parent.name,
                                "request_count": 1,
                                "last_seen_at": "2026-06-07T08:00:00.010+00:00",
                            }
                        },
                        "request_to_task": {"req_1": "task-one"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            group = payload["groups"][0]
            self.assertEqual(group["meta"], "1 requests")
            self.assertNotIn("logs", group)

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", f"/api/log-groups/{group['id']}/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            group_payload = json.loads(response.read())
            conn.close()

            self.assertNotIn("meta", group_payload)
            item = group_payload["logs"][0]
            self.assertEqual(item["endpoint"], "/v1/responses")
            self.assertEqual(item["target"], "http://127.0.0.1:1235/v1/responses")
            self.assertEqual(item["message_count"], 3)
            self.assertEqual(item["token_count"], 5)
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_paginates_top_level_groups(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            tasks: dict[str, dict[str, object]] = {}
            request_to_task: dict[str, str] = {}
            for group_index, group_start in enumerate(["08-00-00.000", "08-01-00.000", "08-02-00.000"], start=1):
                task_path = (
                    root
                    / "tasks"
                    / f"2026-06-07__{group_start}__08-30-00.000__responses__fp-demo-{group_index}"
                )
                task_id = f"task-{group_index}"
                tasks[task_id] = {
                    "dir_name": task_path.name,
                    "request_count": 2,
                    "last_seen_at": f"2026-06-07T{group_start.replace('-', ':')}+00:00",
                }
                for sequence in ("001", "002"):
                    record_id = f"req_{group_index}_{sequence}"
                    request_to_task[record_id] = task_id
                    request_path = task_path / f"{sequence}__{group_start}__v1-responses__{record_id}"
                    request_path.mkdir(parents=True)
                    (request_path / "summary.md").write_text(
                        "\n".join(
                            [
                                f"# LLM Interaction {record_id}",
                                "",
                                "## Summary",
                                "",
                                f"- Time: 2026-06-07T{group_start.replace('-', ':')}+00:00",
                                "- Event: request_finished",
                                "- Target: http://127.0.0.1:1235/v1/responses",
                                "- Request: POST /v1/responses",
                                "- Response: 200",
                            ]
                        ),
                        encoding="utf-8",
                    )
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": tasks,
                        "request_to_task": request_to_task,
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )

            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs?limit=2&offset=1")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["total"], 3)
            self.assertEqual(payload["offset"], 1)
            self.assertEqual(payload["next_offset"], 3)
            self.assertFalse(payload["has_more"])
            self.assertEqual(len(payload["groups"]), 2)
            group_dirs = [group["dir"] for group in payload["groups"]]
            self.assertTrue(group_dirs[0].endswith("fp-demo-2"))
            self.assertTrue(group_dirs[1].endswith("fp-demo-1"))
            self.assertNotIn("logs", payload["groups"][0])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_summary_uses_task_metadata_without_child_logs(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_path = root / "tasks" / "2026-06-07__08-00-00.000__08-30-00.000__responses__fp-demo"
            for sequence in ("001", "002"):
                request_path = task_path / f"{sequence}__08-00-00.000__v1-responses__req_{sequence}"
                request_path.mkdir(parents=True)
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            "task-one": {
                                "dir_name": task_path.name,
                                "model": "gpt-5.5",
                                "target": "http://127.0.0.1:1235/v1/responses",
                                "request_count": 2,
                                "last_seen_at": "2026-06-07T08:30:00.000+00:00",
                            }
                        },
                        "request_to_task": {},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )

            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs?limit=100")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["total"], 1)
            self.assertEqual(payload["groups"][0]["id"], "task-one")
            self.assertEqual(payload["groups"][0]["meta"], "gpt-5.5 | 2 requests | http://127.0.0.1:1235/v1/responses")
            self.assertNotIn("logs", payload["groups"][0])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_group_logs_loads_one_group_on_demand(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            for group_index in (1, 2):
                task_path = root / "tasks" / f"2026-06-07__08-0{group_index}-00.000__08-30-00.000__responses__fp-demo-{group_index}"
                request_path = task_path / f"001__08-0{group_index}-00.000__v1-responses__req_{group_index}"
                request_path.mkdir(parents=True)
                (request_path / "summary.md").write_text(
                    "\n".join(
                        [
                            f"# LLM Interaction req_{group_index}",
                            "",
                            "## Summary",
                            "",
                            f"- Time: 2026-06-07T08:0{group_index}:00.000+00:00",
                            "- Event: request_finished",
                            "- Target: http://127.0.0.1:1235/v1/responses",
                            "- Request: POST /v1/responses",
                            "- Response: 200",
                        ]
                    ),
                    encoding="utf-8",
                )

            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 3,
                        "tasks": {
                            f"task-{group_index}": {
                                "dir_name": f"2026-06-07__08-0{group_index}-00.000__08-30-00.000__responses__fp-demo-{group_index}",
                                "request_count": 1,
                            }
                            for group_index in (1, 2)
                        },
                        "request_to_task": {"req_1": "task-1", "req_2": "task-2"},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/log-groups/task-2/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertNotIn("meta", payload)
            self.assertEqual([item["id"] for item in payload["logs"]], ["req_2"])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_list_reads_all_target_log_directories(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)

            def write_task(log_root: Path, task_id: str, record_id: str, target: str) -> None:
                task_dir = f"2026-06-07__08-00-00.000__08-00-00.010__responses__{task_id}"
                request_dir = f"001__08-00-00.000__v1-responses__{record_id}"
                request_path = log_root / "tasks" / task_dir / request_dir
                request_path.mkdir(parents=True)
                (log_root / ".task-index.json").write_text(
                    json.dumps(
                        {
                            "task_match_strategy_version": 3,
                            "tasks": {
                                task_id: {
                                    "dir_name": task_dir,
                                    "request_count": 1,
                                    "requests": {record_id: {"dir_name": request_dir}},
                                }
                            },
                            "request_to_task": {record_id: task_id},
                            "response_to_task": {},
                            "context_to_task": {},
                        }
                    ),
                    encoding="utf-8",
                )
                (request_path / "08-00-00.000__08-00-00.010.md").write_text(
                    "\n".join(
                        [
                            f"# LLM Interaction {record_id}",
                            "",
                            "## Summary",
                            "",
                            "- Time: 2026-06-07T08:00:00.000+00:00",
                            "- Event: request_finished",
                            f"- Target: {target}",
                            "- Request: POST /v1/responses",
                            "- Response: 200",
                        ]
                    ),
                    encoding="utf-8",
                )
                (request_path / "request.json").write_text(json.dumps({"id": record_id}), encoding="utf-8")
                (request_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")

            first_root = root / "first-logs"
            second_root = root / "second-logs"
            write_task(first_root, "task-first", "req_first", "http://127.0.0.1:1235/v1/responses")
            write_task(second_root, "task-second", "req_second", "http://127.0.0.1:1236/v1/responses")

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
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            group_ids = {group["id"] for group in payload["groups"]}
            self.assertEqual(group_ids, {"task-first", "task-second"})
            self.assertNotIn("logs", payload["groups"][0])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_export_downloads_zip(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            request_path = (
                root
                / "tasks"
                / "2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo"
                / "001__08-00-00.000__v1-responses__req_1"
            )
            request_path.mkdir(parents=True)
            (request_path / "summary.md").write_text("# LLM Interaction req_1", encoding="utf-8")
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/export")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), "application/zip")
            archive_bytes = response.read()
            conn.close()

            with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
                self.assertIn(
                    "tasks/2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo/001__08-00-00.000__v1-responses__req_1/summary.md",
                    archive.namelist(),
                )
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_cleanup_deletes_selected_task(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_path = root / "tasks" / "2026-06-07__08-00-00.000__08-00-30.000__responses__fp-demo"
            for index in range(2):
                record_id = f"req_{index}"
                task_record_path = task_path / f"00{index + 1}__08-00-0{index}.000__v1-responses__{record_id}"
                task_record_path.mkdir(parents=True)
                (task_record_path / "summary.md").write_text(f"# LLM Interaction {record_id}", encoding="utf-8")

            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/api/logs/cleanup",
                body=json.dumps({"group_ids": ["2026-06-07__08-00-00.000__08-00-30.000__responses__fp-demo"]}),
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["deleted_count"], 1)
            self.assertFalse(task_path.exists())
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()

    def test_log_cleanup_ignores_outdated_task_index_ids(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        server = None
        try:
            root = Path(temp_dir.name)
            task_path = root / "tasks" / "2026-06-07__08-00-00.000__08-00-30.000__responses__fp-demo"
            request_path = task_path / "001__08-00-00.000__v1-responses__req_1"
            request_path.mkdir(parents=True)
            (request_path / "summary.md").write_text("# LLM Interaction req_1", encoding="utf-8")
            (root / ".task-index.json").write_text(
                json.dumps(
                    {
                        "task_match_strategy_version": 0,
                        "tasks": {"stale-task-id": {"dir_name": task_path.name}},
                        "request_to_task": {},
                        "response_to_task": {},
                        "context_to_task": {},
                    }
                ),
                encoding="utf-8",
            )

            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request(
                "POST",
                "/api/logs/cleanup",
                body=json.dumps({"group_ids": ["stale-task-id"]}),
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            conn.close()

            self.assertEqual(payload["deleted_count"], 0)
            self.assertTrue(task_path.exists())
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()
