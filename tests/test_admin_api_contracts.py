from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from llm_proxy.admin_server import AdminServer
from llm_proxy.manager import ProxyManager


class AdminApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.manager = ProxyManager(root / "proxies.json", root / "logs")
        self.server = AdminServer(("127.0.0.1", 0), self.manager)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.manager.stop_all()
        self.temp_dir.cleanup()

    def request(
        self,
        method: str,
        path: str,
        body: str | bytes | None = None,
    ) -> tuple[int, dict[str, object]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        status = response.status
        connection.close()
        return status, payload

    def test_returns_json_400_for_invalid_pair_payloads_and_missing_pair(self) -> None:
        for body in ("{}", '{"pairs":"not-a-list"}', "{invalid-json"):
            status, payload = self.request("PUT", "/api/pairs", body)
            self.assertEqual(status, 400, body)
            self.assertEqual(payload, {"error": "Expected pairs list."})

        status, payload = self.request(
            "POST",
            "/api/pairs/missing/enabled",
            json.dumps({"enabled": True}),
        )
        self.assertEqual(status, 400)
        self.assertIn("missing", str(payload["error"]))

    def test_returns_json_404_for_unknown_routes_and_missing_logs(self) -> None:
        requests = [
            ("GET", "/api/not-found", None),
            ("PUT", "/api/not-found", "{}"),
            ("POST", "/api/not-found", "{}"),
            ("GET", "/api/log-groups/missing/logs", None),
            ("GET", "/api/logs/missing", None),
        ]
        for method, path, body in requests:
            status, payload = self.request(method, path, body)
            self.assertEqual(status, 404, (method, path))
            self.assertIn("error", payload)

    def test_invalid_log_query_values_fall_back_or_are_clamped(self) -> None:
        status, payload = self.request("GET", "/api/logs?limit=invalid&offset=invalid")
        self.assertEqual(status, 200)
        self.assertEqual(payload["limit"], 100)
        self.assertEqual(payload["offset"], 0)

        status, payload = self.request("GET", "/api/logs?limit=-20&offset=-30")
        self.assertEqual(status, 200)
        self.assertEqual(payload["limit"], 1)
        self.assertEqual(payload["offset"], 0)

        status, payload = self.request("GET", "/api/logs?limit=0&offset=0")
        self.assertEqual(status, 200)
        self.assertEqual(payload["limit"], 100)
        self.assertEqual(payload["offset"], 0)


if __name__ == "__main__":
    unittest.main()
