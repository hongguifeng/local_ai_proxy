from __future__ import annotations

import json
from importlib import resources

from .manager import SUGGESTED_STRIP_REQUEST_FIELDS_TEXT


def render_index_html() -> str:
    template = resources.files(__package__).joinpath("static/index.html").read_text(encoding="utf-8")
    return template.replace(
        "__SUGGESTED_STRIP_REQUEST_FIELDS__",
        json.dumps(SUGGESTED_STRIP_REQUEST_FIELDS_TEXT),
    )


INDEX_HTML = render_index_html()
