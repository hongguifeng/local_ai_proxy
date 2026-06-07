"""HTTP header helpers."""

from __future__ import annotations

from typing import Iterable

def headers_to_dict(headers: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for key, value in headers:
        result.setdefault(key, []).append(value)
    return result


def parse_header_overrides(raw_headers: list[str] | None) -> list[tuple[str, str]]:
    parsed: list[tuple[str, str]] = []
    for raw in raw_headers or []:
        if ":" not in raw:
            raise ValueError(f"Invalid header override {raw!r}. Expected 'Name: value'.")
        key, value = raw.split(":", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Invalid header override {raw!r}. Header name is empty.")
        parsed.append((key, value.strip()))
    return parsed


