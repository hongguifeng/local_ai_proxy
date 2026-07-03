import json
import unittest

from llm_proxy.routing import request_model_from_body, rewrite_request_model, select_target_by_model


class RequestRoutingTests(unittest.TestCase):
    def _target(
        self,
        target_id: str,
        *,
        enabled: bool = True,
        mappings: list[dict[str, str]] | None = None,
    ) -> dict[str, object]:
        return {
            "id": target_id,
            "name": target_id,
            "enabled": enabled,
            "target_scheme": "http",
            "target_host": "127.0.0.1",
            "target_port": 1235,
            "target_base_path": "",
            "target_api_key": "",
            "target_headers": [],
            "strip_request_fields": set(),
            "inject_request_fields": {},
            "timeout": 5.0,
            "model_mappings": mappings or [],
        }

    def test_request_model_from_body_reads_top_level_model(self) -> None:
        self.assertEqual(request_model_from_body(b'{"model":"demo"}'), "demo")
        self.assertIsNone(request_model_from_body(b'{"model":123}'))
        self.assertIsNone(request_model_from_body(b"not json"))

    def test_select_target_by_model_skips_disabled_non_default_targets(self) -> None:
        targets = [
            self._target("a", enabled=False, mappings=[{"listen": "demo", "upstream": "upstream-demo"}]),
            self._target("b"),
        ]

        selection = select_target_by_model(targets, "b", b'{"model":"demo"}')  # type: ignore[arg-type]

        self.assertEqual(selection.target["id"], "b")
        self.assertEqual(selection.request_model, "demo")
        self.assertIsNone(selection.upstream_model)

    def test_select_target_by_model_returns_rewrite_target(self) -> None:
        targets = [
            self._target("a", mappings=[{"listen": "demo", "upstream": "upstream-demo"}]),
            self._target("b"),
        ]

        selection = select_target_by_model(targets, "b", b'{"model":"demo"}')  # type: ignore[arg-type]

        self.assertEqual(selection.target["id"], "a")
        self.assertEqual(selection.request_model, "demo")
        self.assertEqual(selection.upstream_model, "upstream-demo")

    def test_rewrite_request_model_preserves_non_json_and_rewrites_json_object(self) -> None:
        rewritten = rewrite_request_model(b'{"model":"demo","messages":[]}', "upstream-demo")

        self.assertEqual(json.loads(rewritten), {"model": "upstream-demo", "messages": []})
        self.assertEqual(rewrite_request_model(b"not json", "upstream-demo"), b"not json")
