import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llm_proxy import (
    ProxyHandler,
    ProxyServer,
    TrafficLogger,
    body_json_value,
    join_target_path,
    local_datetime_for_filename,
    local_time_from_timestamp_for_filename,
    parse_inject_request_fields,
    parse_target_url,
    parse_strip_request_fields,
    transform_request_json_fields,
)
from llm_proxy.manager import ProxyManager, SUGGESTED_STRIP_REQUEST_FIELDS_TEXT
from llm_proxy.ui import AdminServer, INDEX_HTML


class AdminUiTests(unittest.TestCase):
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
            readable_path = root / "readable" / "2026-06-07__08-00-00.000__post__v1-responses__req_1"
            readable_path.mkdir(parents=True)
            (readable_path / "08-00-00.000__08-00-00.010.md").write_text(
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
            (readable_path / "request.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            (readable_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            manager = ProxyManager(root / "proxies.json", root)
            server = AdminServer(("127.0.0.1", 0), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/api/logs/req_1")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            detail = json.loads(response.read())
            conn.close()

            self.assertEqual(detail["request"]["body_json"], {"a": 1})
            self.assertEqual(detail["response"]["body_json"], {"ok": True})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
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
            (root / "readable").mkdir(exist_ok=True)
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
            self.assertEqual(payload["groups"][0]["id"], "2026-06-07__08-00-00.000__08-00-00.010__responses__fp-demo")
            self.assertEqual(payload["groups"][0]["title"], "2026-06-07 08:00:00.000 - 08:00:00.010")
            self.assertEqual(payload["groups"][0]["logs"][0]["id"], "req_1")
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

            (root / "readable").mkdir(exist_ok=True)
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

            logs = payload["groups"][0]["logs"]
            self.assertEqual([item["id"] for item in logs], ["req_2", "req_1"])
            self.assertEqual([item["sequence"] for item in logs], ["002", "001"])
            self.assertEqual(logs[0]["timestamp"], "2026-06-07 08:00:20.000")
            self.assertEqual(logs[1]["timestamp"], "2026-06-07 08:00:00.000")
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

            def write_readable(log_root: Path, record_id: str, target: str) -> None:
                readable_path = log_root / "readable" / f"2026-06-07__08-00-00.000__post__v1-responses__{record_id}"
                readable_path.mkdir(parents=True)
                (readable_path / "08-00-00.000__08-00-00.010.md").write_text(
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
                (readable_path / "request.json").write_text(json.dumps({"id": record_id}), encoding="utf-8")
                (readable_path / "response.json").write_text(json.dumps({"ok": True}), encoding="utf-8")

            first_root = root / "first-logs"
            second_root = root / "second-logs"
            write_readable(first_root, "req_first", "http://127.0.0.1:1235/v1/responses")
            write_readable(second_root, "req_second", "http://127.0.0.1:1236/v1/responses")

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
                                "readable_log_dir": str(first_root),
                            },
                            {
                                "id": "second",
                                "name": "Second",
                                "target_url": "http://127.0.0.1:1236/v1",
                                "readable_log_dir": str(second_root),
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

            ids = {item["id"] for group in payload["groups"] for item in group["logs"]}
            self.assertEqual(ids, {"req_first", "req_second"})
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            temp_dir.cleanup()
