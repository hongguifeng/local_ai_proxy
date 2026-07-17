"""Normalize dynamic JSON values before Python/Node parity comparisons."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RULES = ROOT / "fixtures" / "parity" / "normalization-rules.json"


class ParityNormalizer:
    def __init__(self, rules: Mapping[str, Any]) -> None:
        self.rules = rules
        categories = rules.get("categories")
        patterns = rules.get("string_patterns")
        self.categories = dict(categories) if isinstance(categories, Mapping) else {}
        self.patterns = list(patterns) if isinstance(patterns, list) else []
        self.tokens: dict[str, dict[object, str]] = {}

    def normalize(self, value: object) -> object:
        collected: dict[str, set[object]] = {}
        self._collect(value, None, collected)
        self.tokens = self._build_tokens(collected)
        return self._normalize(value, None)

    def _collect(self, value: object, key: str | None, collected: dict[str, set[object]]) -> None:
        category = self._key_category(key)
        if category is not None and value is not None:
            collected.setdefault(category, set()).add(self._hashable_value(value))

        if isinstance(value, str):
            for pattern_spec in self.patterns:
                if not isinstance(pattern_spec, Mapping):
                    continue
                pattern = pattern_spec.get("pattern")
                pattern_category = pattern_spec.get("category")
                if not isinstance(pattern, str) or not isinstance(pattern_category, str):
                    continue
                for match in re.finditer(pattern, value):
                    collected.setdefault(pattern_category, set()).add(match.group(0))
            return

        if isinstance(value, Mapping):
            for child_key, child_value in value.items():
                self._collect(child_value, str(child_key), collected)
            return

        if isinstance(value, list):
            for child_value in value:
                self._collect(child_value, None, collected)

    def _build_tokens(self, collected: Mapping[str, set[object]]) -> dict[str, dict[object, str]]:
        tokens: dict[str, dict[object, str]] = {}
        for category, values in collected.items():
            category_spec = self.categories.get(category)
            sort_mode = category_spec.get("sort") if isinstance(category_spec, Mapping) else "string"
            ordered = sorted(values, key=lambda value: self._sort_key(value, str(sort_mode)))
            tokens[category] = {
                value: f"<{category}:{index}>"
                for index, value in enumerate(ordered, start=1)
            }
        return tokens

    def _normalize(self, value: object, key: str | None) -> object:
        category = self._key_category(key)
        if category is not None and value is not None:
            return self.tokens[category][self._hashable_value(value)]

        if isinstance(value, str):
            normalized = value
            for pattern_spec in self.patterns:
                if not isinstance(pattern_spec, Mapping):
                    continue
                pattern = pattern_spec.get("pattern")
                pattern_category = pattern_spec.get("category")
                if not isinstance(pattern, str) or not isinstance(pattern_category, str):
                    continue
                normalized = re.sub(
                    pattern,
                    lambda match: self.tokens[pattern_category][match.group(0)],
                    normalized,
                )
            return normalized

        if isinstance(value, Mapping):
            return {
                str(child_key): self._normalize(child_value, str(child_key))
                for child_key, child_value in value.items()
            }

        if isinstance(value, list):
            return [self._normalize(child_value, None) for child_value in value]

        return value

    def _key_category(self, key: str | None) -> str | None:
        if key is None:
            return None
        for category, spec in self.categories.items():
            if not isinstance(spec, Mapping):
                continue
            keys = spec.get("keys")
            if isinstance(keys, list) and key in keys:
                return str(category)
        return None

    @staticmethod
    def _hashable_value(value: object) -> object:
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _sort_key(value: object, mode: str) -> object:
        if mode == "number":
            try:
                return float(str(value))
            except ValueError:
                return float("inf")
        if mode == "iso_datetime":
            try:
                return dt.datetime.fromisoformat(str(value)).timestamp()
            except ValueError:
                return float("inf")
        return str(value)


def load_rules(path: Path = DEFAULT_RULES) -> dict[str, Any]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError("normalization rules must be a JSON object")
    return loaded


def normalize_json(value: object, rules: Mapping[str, Any] | None = None) -> object:
    return ParityNormalizer(rules or load_rules()).normalize(value)


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize dynamic fields in a parity JSON fixture.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--rules", type=Path, default=DEFAULT_RULES)
    args = parser.parse_args()

    loaded = json.loads(args.input.read_text(encoding="utf-8"))
    rules = load_rules(args.rules)
    normalized = normalize_json(loaded, rules)
    output_options = rules.get("json_output") if isinstance(rules.get("json_output"), Mapping) else {}
    text = json.dumps(
        normalized,
        ensure_ascii=bool(output_options.get("ensure_ascii", False)),
        indent=int(output_options.get("indent", 2)),
        sort_keys=bool(output_options.get("sort_keys", True)),
    ) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
