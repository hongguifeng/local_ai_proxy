"""Pure helpers for request model routing and model-name rewrites."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from .models import RuntimeTarget


@dataclass(frozen=True)
class TargetSelection:
    target: RuntimeTarget
    request_model: str | None
    upstream_model: str | None


def request_model_from_body(request_body: bytes) -> str | None:
    try:
        loaded = json.loads(request_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(loaded, dict):
        return None
    model = loaded.get("model")
    return model if isinstance(model, str) else None


def select_target_by_model(
    targets: Sequence[RuntimeTarget],
    default_target_id: str,
    request_body: bytes,
) -> TargetSelection:
    """Select a target using the top-level request model field."""
    if not targets:
        raise ValueError("ProxyServer config must include at least one target.")
    default_target = next((target for target in targets if str(target.get("id")) == default_target_id), targets[0])
    request_model = request_model_from_body(request_body)
    if request_model:
        for target in targets:
            if target is not default_target and not bool(target.get("enabled", True)):
                continue
            mappings = target.get("model_mappings")
            if not isinstance(mappings, list):
                continue
            for mapping in mappings:
                if not isinstance(mapping, dict):
                    continue
                listen_model = mapping.get("listen")
                if listen_model == request_model:
                    upstream_model = mapping.get("upstream")
                    return TargetSelection(
                        target=target,
                        request_model=request_model,
                        upstream_model=upstream_model if isinstance(upstream_model, str) and upstream_model else None,
                    )
    return TargetSelection(target=default_target, request_model=request_model, upstream_model=None)


def rewrite_request_model(request_body: bytes, upstream_model: str | None) -> bytes:
    if not upstream_model:
        return request_body
    try:
        loaded = json.loads(request_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return request_body
    if not isinstance(loaded, dict):
        return request_body
    loaded["model"] = upstream_model
    return json.dumps(loaded, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
