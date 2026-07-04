"""HTTP header processing utilities."""

from __future__ import annotations

from collections.abc import Iterable


def headers_to_dict(headers: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    """Convert HTTP headers list to a dictionary.

    The same header name may appear multiple times, so values are stored in a list instead of plain strings.
    """
    result: dict[str, list[str]] = {}
    for key, value in headers:
        result.setdefault(key, []).append(value)
    return result


def parse_header_overrides(raw_headers: list[str] | None) -> list[tuple[str, str]]:
    """Parse --target-header arguments from the command line.

    The user can pass multiple entries like ``--target-header "Authorization: Bearer xxx"``.
    This validates the format and converts them into a list of tuples for use in forwarded requests.
    """
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

