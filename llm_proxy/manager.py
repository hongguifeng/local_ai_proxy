from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import DEFAULT_STRIP_REQUEST_FIELDS
from .file_io import atomic_write_text
from .http_utils import parse_header_overrides
from .logger import TrafficLogger
from .models import JsonObject, ProxyPair, PublicProxyPair, RuntimeTarget, TargetConfig
from .sanitize import parse_inject_request_fields, parse_strip_request_fields
from .server import ProxyHandler, ProxyServer
from .target import parse_target_url

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


@dataclass
class ProxyRuntime:
    server: ProxyServer
    thread: threading.Thread
    logger: TrafficLogger


class ProxyManager:
    def __init__(
        self,
        config_path: Path = DEFAULT_CONFIG_PATH,
        readable_log_dir: Path | None = DEFAULT_LOG_ROOT,
    ) -> None:
        self.config_path = config_path
        self.readable_log_dir = log_root_from_setting(readable_log_dir)
        self.lock = threading.RLock()
        self.pairs: list[ProxyPair] = self._load_pairs()
        self.runtimes: dict[str, ProxyRuntime] = {}

    def _load_pairs(self) -> list[ProxyPair]:
        if not self.config_path.exists():
            return [
                self._normalize_pair(
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
                                "readable_log_dir": str(self.readable_log_dir or DEFAULT_LOG_ROOT),
                                "redact_logs": False,
                                "model_mappings": [],
                            }
                        ],
                        "default_target_id": "target-1",
                    }
                )
            ]
        try:
            loaded = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        raw_pairs = loaded.get("pairs") if isinstance(loaded, dict) else None
        if not isinstance(raw_pairs, list):
            return []
        return [self._normalize_pair(pair) for pair in raw_pairs if isinstance(pair, dict)]

    def save(self) -> None:
        with self.lock:
            payload = json.dumps({"pairs": self.pairs}, ensure_ascii=False, indent=2)
            atomic_write_text(self.config_path, payload)

    def start_enabled(self) -> None:
        with self.lock:
            for pair in self.pairs:
                if pair.get("enabled"):
                    self._start_pair(pair)

    def stop_all(self) -> None:
        with self.lock:
            ids = list(self.runtimes)
        for pair_id in ids:
            self.stop(pair_id)

    def list_pairs(self) -> list[PublicProxyPair]:
        with self.lock:
            return [self._public_pair(pair) for pair in self.pairs]

    def replace_pairs(self, pairs: list[JsonObject]) -> list[PublicProxyPair]:
        normalized = [self._normalize_pair(pair) for pair in pairs]
        with self.lock:
            old_ids = {str(pair["id"]) for pair in self.pairs}
            new_ids = {str(pair["id"]) for pair in normalized}
            self.pairs = normalized
            self.save()
        for removed_id in old_ids - new_ids:
            self.stop(removed_id)
        for pair in normalized:
            pair_id = str(pair["id"])
            if pair.get("enabled"):
                self.restart(pair_id)
            else:
                self.stop(pair_id)
        return self.list_pairs()

    def set_enabled(self, pair_id: str, enabled: bool) -> PublicProxyPair:
        with self.lock:
            pair = self._find_pair(pair_id)
            pair["enabled"] = enabled
            self.save()
        if enabled:
            self.restart(pair_id)
        else:
            self.stop(pair_id)
        with self.lock:
            return self._public_pair(self._find_pair(pair_id))

    def restart(self, pair_id: str) -> None:
        self.stop(pair_id)
        with self.lock:
            pair = self._find_pair(pair_id)
            if pair.get("enabled"):
                self._start_pair(pair)

    def stop(self, pair_id: str) -> None:
        with self.lock:
            runtime = self.runtimes.pop(pair_id, None)
        if not runtime:
            return
        runtime.server.shutdown()
        runtime.server.server_close()
        runtime.thread.join(timeout=2)

    def _start_pair(self, pair: ProxyPair) -> None:
        pair_id = str(pair["id"])
        if pair_id in self.runtimes:
            return
        targets = [self._runtime_target(target, pair) for target in pair["targets"]]
        logger = targets[0].get("traffic_logger")
        if not isinstance(logger, TrafficLogger):
            logger = TrafficLogger(self._readable_dir_for(pair))
        config = {
            "targets": targets,
            "default_target_id": pair.get("default_target_id") or targets[0]["id"],
            "access_log": bool(pair.get("access_log", False)),
            "proxy_pair_id": pair_id,
            "proxy_pair_name": pair.get("name", pair_id),
        }
        server = ProxyServer((str(pair["listen_host"]), int(pair["listen_port"])), ProxyHandler, config, logger)
        thread = threading.Thread(target=server.serve_forever, daemon=True, name=f"llm-proxy-{pair_id}")
        thread.start()
        self.runtimes[pair_id] = ProxyRuntime(server=server, thread=thread, logger=logger)

    def _readable_dir_for(self, pair: ProxyPair | TargetConfig) -> Path | None:
        raw_value = pair.get("readable_log_dir")
        if raw_value == "":
            return None
        if raw_value:
            return readable_dir_from_log_root(str(raw_value))
        return readable_dir_from_log_root(self.readable_log_dir)

    def _runtime_target(self, target_pair: TargetConfig, pair: ProxyPair) -> RuntimeTarget:
        target = parse_target_url(str(target_pair.get("target_url") or "http://127.0.0.1:1235"))
        return {
            "id": str(target_pair.get("id") or "default"),
            "name": str(target_pair.get("name") or target_pair.get("id") or "Default target"),
            "target_scheme": target["scheme"],
            "target_host": target["host"],
            "target_port": target["port"],
            "target_base_path": target["base_path"],
            "target_api_key": str(target_pair.get("target_api_key") or "").strip(),
            "target_headers": parse_header_overrides(list(target_pair.get("target_headers") or [])),
            "strip_request_fields": parse_strip_request_fields(target_pair.get("strip_request_fields")),
            "inject_request_fields": parse_inject_request_fields(target_pair.get("inject_request_fields")),
            "timeout": float(target_pair.get("timeout", 600)),
            "model_mappings": list(target_pair.get("model_mappings") or []),
            "enabled": bool(target_pair.get("enabled", True)),
            "traffic_logger": TrafficLogger(
                self._readable_dir_for(target_pair),
                redact_logs=bool(target_pair.get("redact_logs", False)),
            ),
        }

    def _find_pair(self, pair_id: str) -> ProxyPair:
        for pair in self.pairs:
            if str(pair["id"]) == pair_id:
                return pair
        raise KeyError(pair_id)

    def _public_pair(self, pair: ProxyPair) -> PublicProxyPair:
        public = dict(pair)
        runtime = self.runtimes.get(str(pair["id"]))
        public["running"] = runtime is not None
        public["actual_listen_port"] = runtime.server.server_address[1] if runtime else None
        return public

    def _normalize_pair(self, pair: JsonObject) -> ProxyPair:
        pair_id = str(pair.get("id") or f"proxy-{len(pair)}").strip()
        targets = pair.get("targets")
        normalized_targets = [self._normalize_target(target, index) for index, target in enumerate(targets) if isinstance(target, dict)] if isinstance(targets, list) else []
        if not normalized_targets:
            normalized_targets = [self._normalize_target({}, 0)]
        default_target_id = str(pair.get("default_target_id") or normalized_targets[0]["id"])
        if default_target_id not in {target["id"] for target in normalized_targets}:
            default_target_id = str(normalized_targets[0]["id"])
        normalized: ProxyPair = {
            "id": pair_id,
            "name": str(pair.get("name") or pair_id),
            "enabled": bool(pair.get("enabled", False)),
            "listen_host": str(pair.get("listen_host") or "127.0.0.1"),
            "listen_port": int(pair.get("listen_port") or 1234),
            "access_log": bool(pair.get("access_log", False)),
            "targets": normalized_targets,
            "default_target_id": default_target_id,
        }
        return normalized

    def _normalize_target(self, target: JsonObject, index: int) -> TargetConfig:
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
            "readable_log_dir": "" if target.get("readable_log_dir") == "" else str(log_root_from_setting(target.get("readable_log_dir") or self.readable_log_dir) or ""),
            "redact_logs": bool(target.get("redact_logs", False)),
            "model_mappings": self._normalize_model_mappings(target.get("model_mappings") or target.get("models") or []),
            "enabled": bool(target.get("enabled", True)),
        }

    def _normalize_model_mappings(self, mappings: Any) -> list[dict[str, str]]:
        normalized: list[dict[str, str]] = []
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
