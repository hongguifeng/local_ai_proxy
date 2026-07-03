from __future__ import annotations

import json
from importlib import resources

from .config import SUGGESTED_STRIP_REQUEST_FIELDS_TEXT


def read_static_text(name: str) -> str:
    return resources.files(__package__).joinpath(f"static/{name}").read_text(encoding="utf-8")


def render_index_html() -> str:
    return read_static_text("index.html")


def render_app_js() -> str:
    template = read_static_text("app.js")
    return template.replace(
        "__SUGGESTED_STRIP_REQUEST_FIELDS__",
        json.dumps(SUGGESTED_STRIP_REQUEST_FIELDS_TEXT),
    )


INDEX_HTML = render_index_html()
APP_CSS = read_static_text("app.css")
APP_JS = render_app_js()
