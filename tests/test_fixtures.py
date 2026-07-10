import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = REPO_ROOT / "packages" / "test-fixtures"


class LanguageNeutralFixtureTests(unittest.TestCase):
    def test_manifest_hashes_every_fixture(self) -> None:
        manifest = json.loads((FIXTURE_ROOT / "manifest.json").read_text(encoding="utf-8"))
        expected_paths = {
            path.relative_to(FIXTURE_ROOT).as_posix()
            for path in FIXTURE_ROOT.rglob("*")
            if path.is_file() and path.name not in {"README.md", "package.json", "manifest.json"}
        }
        self.assertEqual(set(manifest["sha256"]), expected_paths)
        for relative, expected_hash in manifest["sha256"].items():
            actual_hash = hashlib.sha256((FIXTURE_ROOT / relative).read_bytes()).hexdigest()
            self.assertEqual(actual_hash, expected_hash, relative)

    def test_json_fixture_documents_have_known_kinds(self) -> None:
        known_kinds = {"proxy", "header-pairs", "stream-summary", "task-assignment"}
        documents = [
            path
            for path in FIXTURE_ROOT.rglob("*.json")
            if path.name not in {"manifest.json", "package.json", "fixture-set.schema.json"}
            and path.parent.name != "binary"
        ]
        self.assertGreater(len(documents), 4)
        for path in documents:
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn(document.get("kind"), known_kinds, path)

    def test_fixture_export_is_reproducible(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/export_python_fixtures.py", "--check"],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
