from __future__ import annotations

import unittest

from scripts.normalize_parity_json import normalize_json


class ParityNormalizerTests(unittest.TestCase):
    def test_normalizes_dynamic_values_and_preserves_relationships(self) -> None:
        request_id = "0123456789abcdef0123456789abcdef"
        value = {
            "timestamp": "2026-01-02T03:04:05+08:00",
            "updated_at": "2026-01-02T03:05:05+08:00",
            "client_port": 43124,
            "actual_listen_port": 43124,
            "temp_path": "/tmp/fixture-a/config.json",
            "id": request_id,
            "link": f"record:{request_id}",
            "url": "http://127.0.0.1:43124/v1/responses",
        }

        normalized = normalize_json(value)

        self.assertEqual(normalized["timestamp"], "<timestamp:1>")
        self.assertEqual(normalized["updated_at"], "<timestamp:2>")
        self.assertEqual(normalized["client_port"], "<port:1>")
        self.assertEqual(normalized["actual_listen_port"], "<port:1>")
        self.assertEqual(normalized["temp_path"], "<path:1>")
        self.assertEqual(normalized["id"], "<request_id:1>")
        self.assertEqual(normalized["link"], "record:<request_id:1>")
        self.assertEqual(normalized["url"], "http://127.0.0.1:<localhost_port:1>/v1/responses")

    def test_tokens_are_stable_when_object_key_order_changes(self) -> None:
        first = {
            "started_at": "2026-01-01T00:00:02+00:00",
            "timestamp": "2026-01-01T00:00:01+00:00",
        }
        second = {
            "timestamp": "2026-01-01T00:00:01+00:00",
            "started_at": "2026-01-01T00:00:02+00:00",
        }

        self.assertEqual(normalize_json(first), normalize_json(second))


if __name__ == "__main__":
    unittest.main()
