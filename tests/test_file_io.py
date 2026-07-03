import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from llm_proxy.file_io import atomic_write_text


class AtomicWriteTextTests(unittest.TestCase):
    def test_replaces_file_contents(self) -> None:
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "config.json"
            path.write_text("old", encoding="utf-8")

            atomic_write_text(path, "new")

            self.assertEqual(path.read_text(encoding="utf-8"), "new")
            self.assertEqual(list(path.parent.glob(".*.tmp")), [])

    def test_failed_write_keeps_existing_file_and_removes_temp_file(self) -> None:
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "config.json"
            path.write_text("old", encoding="utf-8")

            with patch("os.fsync", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    atomic_write_text(path, "new")

            self.assertEqual(path.read_text(encoding="utf-8"), "old")
            self.assertEqual(list(path.parent.glob(".*.tmp")), [])
