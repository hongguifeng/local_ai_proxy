from __future__ import annotations

import json
import socket
import tempfile
import unittest
from pathlib import Path

from llm_proxy.manager import ProxyManager


class ProxyManagerContractTests(unittest.TestCase):
    def test_invalid_json_and_invalid_top_level_shape_load_empty_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            invalid_json = root / "invalid-json.json"
            invalid_json.write_text("{not valid json", encoding="utf-8")
            self.assertEqual(ProxyManager(invalid_json, root / "logs").list_pairs(), [])

            invalid_shapes = [
                [],
                {"pairs": "not-a-list"},
                {"pairs": ["not-an-object", 123, None]},
            ]
            for index, value in enumerate(invalid_shapes):
                path = root / f"invalid-shape-{index}.json"
                path.write_text(json.dumps(value), encoding="utf-8")
                self.assertEqual(ProxyManager(path, root / "logs").list_pairs(), [], value)

    def test_port_conflict_is_reported_after_configuration_is_saved(self) -> None:
        occupied = socket.socket()
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        occupied_port = occupied.getsockname()[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config_path = root / "proxies.json"
            manager = ProxyManager(config_path, root / "logs")
            pair = {
                "id": "conflicting",
                "name": "Conflicting proxy",
                "enabled": True,
                "listen_host": "127.0.0.1",
                "listen_port": occupied_port,
                "targets": [
                    {
                        "id": "default",
                        "name": "Default",
                        "target_url": "http://127.0.0.1:1235",
                        "log_root": "",
                    }
                ],
                "default_target_id": "default",
            }

            try:
                with self.assertRaises(OSError):
                    manager.replace_pairs([pair])

                saved = json.loads(config_path.read_text(encoding="utf-8"))
                self.assertEqual(saved["pairs"][0]["id"], "conflicting")
                self.assertTrue(saved["pairs"][0]["enabled"])
                listed = manager.list_pairs()
                self.assertEqual(len(listed), 1)
                self.assertFalse(listed[0]["running"])
            finally:
                manager.stop_all()
                occupied.close()


if __name__ == "__main__":
    unittest.main()
