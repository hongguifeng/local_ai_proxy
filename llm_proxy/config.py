"""Proxy configuration defaults and normalization helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .constants import DEFAULT_STRIP_REQUEST_FIELDS
from .models import JsonObject, ModelMapping, ProxyPair, TargetConfig

DEFAULT_CONFIG_PATH = Path("logs/proxies.json")
DEFAULT_LOG_ROOT = Path("logs")
SUGGESTED_STRIP_REQUEST_FIELDS_TEXT = ",".join(DEFAULT_STRIP_REQUEST_FIELDS)


def log_root_from_setting(value: str | Path | None) -> Path | None:
    if value is None:
        return None
    return Path(value)


def readable_dir_from_log_root(value: str | Path | None) -> Path | None:
    root = log_root_from_setting(value)
    if root is None:
        return None
    return root / "readable"


def default_proxy_pair(readable_log_dir: Path | None) -> ProxyPair:
    return normalize_pair(
        {
            "id": "default",
            "name": "Default proxy",
            "enabled": False,
            "listen_host": "127.0.0.1",
            "listen_port": 1234,
            "access_log": False,
            "targets": [
                {
                    "id": "target-1",
                    "name": "Target",
                    "enabled": True,
                    "target_url": "http://127.0.0.1:1235",
                    "target_api_key": "",
                    "target_headers": [],
                    "strip_request_fields": "",
                    "inject_request_fields": "",
                    "timeout": 600,
                    "readable_log_dir": str(readable_log_dir or DEFAULT_LOG_ROOT),
                    "redact_logs": False,
                    "model_mappings": [],
                }
            ],
            "default_target_id": "target-1",
        },
        readable_log_dir,
    )


def normalize_pair(pair: JsonObject, readable_log_dir: Path | None) -> ProxyPair:
    pair_id = str(pair.get("id") or f"proxy-{len(pair)}").strip()
    targets = pair.get("targets")
    normalized_targets = (
        [
            normalize_target(target, index, readable_log_dir)
            for index, target in enumerate(targets)
            if isinstance(target, dict)
        ]
        if isinstance(targets, list)
        else []
    )
    if not normalized_targets:
        normalized_targets = [normalize_target({}, 0, readable_log_dir)]
    default_target_id = str(pair.get("default_target_id") or normalized_targets[0]["id"])
    if default_target_id not in {target["id"] for target in normalized_targets}:
        default_target_id = str(normalized_targets[0]["id"])
    return {
        "id": pair_id,
        "name": str(pair.get("name") or pair_id),
        "enabled": bool(pair.get("enabled", False)),
        "listen_host": str(pair.get("listen_host") or "127.0.0.1"),
        "listen_port": int(pair.get("listen_port") or 1234),
        "access_log": bool(pair.get("access_log", False)),
        "targets": normalized_targets,
        "default_target_id": default_target_id,
    }


def normalize_target(target: JsonObject, index: int, readable_log_dir: Path | None) -> TargetConfig:
    target_id = str(target.get("id") or f"target-{index + 1}").strip()
    inject_request_fields = target.get("inject_request_fields")
    if isinstance(inject_request_fields, dict):
        inject_request_fields = json.dumps(inject_request_fields, ensure_ascii=False, separators=(",", ":"))
    elif inject_request_fields is None:
        inject_request_fields = ""
    return {
        "id": target_id,
        "name": str(target.get("name") or target_id),
        "target_url": str(target.get("target_url") or "http://127.0.0.1:1235").strip(),
        "target_api_key": str(target.get("target_api_key") or "").strip(),
        "target_headers": list(target.get("target_headers") or []),
        "strip_request_fields": target.get("strip_request_fields") or "",
        "inject_request_fields": str(inject_request_fields),
        "timeout": float(target.get("timeout") or 600),
        "readable_log_dir": ""
        if target.get("readable_log_dir") == ""
        else str(log_root_from_setting(target.get("readable_log_dir") or readable_log_dir) or ""),
        "redact_logs": bool(target.get("redact_logs", False)),
        "model_mappings": normalize_model_mappings(target.get("model_mappings") or target.get("models") or []),
        "enabled": bool(target.get("enabled", True)),
    }


def normalize_model_mappings(mappings: Any) -> list[ModelMapping]:
    normalized: list[ModelMapping] = []
    if not isinstance(mappings, list):
        return normalized
    for item in mappings:
        if not isinstance(item, dict):
            continue
        listen = str(item.get("listen") or "").strip()
        upstream = str(item.get("upstream") or listen).strip()
        if listen:
            normalized.append({"listen": listen, "upstream": upstream or listen})
    return normalized
