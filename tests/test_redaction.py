import json
import tempfile
import unittest
from pathlib import Path

from llm_proxy.logger import TrafficLogger


class LogRedactionTests(unittest.TestCase):
    def _only_request_log_path(self, root: Path) -> Path:
        return next((root / "tasks").glob("*/*"))

    def test_redacts_sensitive_headers_and_json_fields_when_enabled(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(temp_dir.name)
            logger = TrafficLogger(root, redact_logs=True)
            logger.write(
                {
                    "id": "req_1",
                    "timestamp": "2026-06-07T08:00:00.000+00:00",
                    "started_timestamp": "2026-06-07T08:00:00.000+00:00",
                    "event": "request_finished",
                    "duration_ms": 1,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {"Authorization": ["Bearer secret-token"]},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "demo", "api_key": "sk-secret"}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"ok": True})},
                    },
                }
            )

            log_path = self._only_request_log_path(root)
            request_body = json.loads((log_path / "request.json").read_text(encoding="utf-8"))
            markdown = next(log_path.glob("*.md")).read_text(encoding="utf-8")

            self.assertEqual(request_body, {"model": "demo", "api_key": "[redacted]"})
            self.assertIn("Authorization: [redacted]", markdown)
            self.assertNotIn("secret-token", markdown)
        finally:
            temp_dir.cleanup()

    def test_keeps_sensitive_values_when_redaction_is_disabled(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(temp_dir.name)
            logger = TrafficLogger(root)
            logger.write(
                {
                    "id": "req_1",
                    "timestamp": "2026-06-07T08:00:00.000+00:00",
                    "started_timestamp": "2026-06-07T08:00:00.000+00:00",
                    "event": "request_finished",
                    "duration_ms": 1,
                    "client": {"host": "127.0.0.1", "port": 1000},
                    "target": {"scheme": "http", "host": "127.0.0.1", "port": 1235, "path": "/v1/responses"},
                    "request": {
                        "method": "POST",
                        "path": "/v1/responses",
                        "headers": {},
                        "body": {
                            "size_bytes": 0,
                            "base64": "",
                            "text": json.dumps({"model": "demo", "api_key": "sk-secret"}),
                        },
                    },
                    "response": {
                        "status": 200,
                        "headers": {},
                        "body": {"size_bytes": 0, "base64": "", "text": json.dumps({"ok": True})},
                    },
                }
            )

            log_path = self._only_request_log_path(root)
            request_body = json.loads((log_path / "request.json").read_text(encoding="utf-8"))

            self.assertEqual(request_body, {"model": "demo", "api_key": "sk-secret"})
        finally:
            temp_dir.cleanup()
