import json
import tempfile
import unittest
from pathlib import Path

from llm_proxy import (
    parse_inject_request_fields,
    parse_strip_request_fields,
    transform_request_json_fields,
)
from llm_proxy.manager import SUGGESTED_STRIP_REQUEST_FIELDS_TEXT, ProxyManager
from llm_proxy.ui import APP_JS, INDEX_HTML


class RequestSanitizationConfigTests(unittest.TestCase):
    def test_unset_strip_request_fields_removes_nothing(self) -> None:
        self.assertEqual(parse_strip_request_fields(None), set())

    def test_unset_inject_request_fields_adds_nothing(self) -> None:
        self.assertEqual(parse_inject_request_fields(None), {})
        self.assertEqual(parse_inject_request_fields(""), {})

    def test_parse_inject_request_fields_requires_json_object(self) -> None:
        self.assertEqual(parse_inject_request_fields({"stream": True}), {"stream": True})
        self.assertEqual(
            parse_inject_request_fields('{"metadata":{"source":"proxy"},"stream":true}'),
            {"metadata": {"source": "proxy"}, "stream": True},
        )
        with self.assertRaises(ValueError):
            parse_inject_request_fields("[1, 2]")
        with self.assertRaises(ValueError):
            parse_inject_request_fields(123)

    def test_transform_request_json_fields_strips_then_injects(self) -> None:
        body, stripped, injected = transform_request_json_fields(
            b'{"temperature":0.8,"model":"demo","metadata":{"source":"client"}}',
            {"temperature", "metadata"},
            {"metadata": {"source": "proxy"}, "stream": True},
        )
        self.assertEqual(json.loads(body), {"model": "demo", "metadata": {"source": "proxy"}, "stream": True})
        self.assertEqual(stripped, ["metadata", "temperature"])
        self.assertEqual(injected, ["metadata", "stream"])

    def test_transform_request_json_fields_ignores_non_object_json(self) -> None:
        body, stripped, injected = transform_request_json_fields(
            b'["not","object"]',
            {"temperature"},
            {"stream": True},
        )
        self.assertEqual(body, b'["not","object"]')
        self.assertEqual(stripped, [])
        self.assertEqual(injected, [])

    def test_default_proxy_pair_leaves_strip_fields_empty(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(temp_dir.name)
            manager = ProxyManager(root / "proxies.json", root)
            pairs = manager.list_pairs()
            self.assertEqual(pairs[0]["targets"][0]["strip_request_fields"], "")
            self.assertEqual(pairs[0]["targets"][0]["inject_request_fields"], "")
        finally:
            temp_dir.cleanup()

    def test_proxy_manager_treats_log_setting_as_root_directory(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        try:
            root = Path(temp_dir.name)
            manager = ProxyManager(root / "proxies.json", root / "logs")

            self.assertEqual(manager.list_pairs()[0]["targets"][0]["readable_log_dir"], str(root / "logs"))
            self.assertEqual(manager._readable_dir_for({"readable_log_dir": str(root / "custom")}), root / "custom" / "readable")
            self.assertEqual(manager._readable_dir_for({}), root / "logs" / "readable")
        finally:
            temp_dir.cleanup()

    def test_admin_html_uses_suggested_strip_fields_as_placeholder(self) -> None:
        self.assertIn('/static/app.js', INDEX_HTML)
        self.assertIn(json.dumps(SUGGESTED_STRIP_REQUEST_FIELDS_TEXT), APP_JS)
        self.assertIn('strip_request_fields: ""', APP_JS)
        self.assertIn('placeholder="${escapeHtml(suggestedStripRequestFields)}"', APP_JS)
        self.assertIn("inject_request_fields", APP_JS)
