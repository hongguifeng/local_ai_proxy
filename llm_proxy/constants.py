"""Shared constants for the entire proxy project.

This file only contains values that "do not change during execution". Centralizing constants here avoids duplicating strings across multiple modules and makes it easier to update them in the future.
"""

from __future__ import annotations

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
"""HTTP headers that should not be forwarded to upstream servers.

These headers describe only the state of "this hop connection", such as whether the connection is kept alive or whether the protocol is upgraded. After the proxy receives the client's request, it establishes a new connection to the upstream, so these headers should be discarded.
"""


DEFAULT_PORTS = {
    "http": 80,
    "https": 443,
}
"""Default ports for different protocols. When parsing target addresses, if the user does not specify a port, the values here are used."""

DEFAULT_STRIP_REQUEST_FIELDS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "typical_p",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "seed",
)
"""Sampling parameters recommended for removal from request JSON.

These fields appear as placeholders in the UI when creating a new proxy, and will only be actually removed after the user enters the configuration.
"""
