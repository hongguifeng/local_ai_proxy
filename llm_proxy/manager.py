from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .constants import DEFAULT_STRIP_REQUEST_FIELDS
from .http_utils import parse_header_overrides
from .logger import TrafficLogger
from .sanitize import parse_inject_request_fields, parse_strip_request_fields
from .server import ProxyHandler, ProxyServer
from .target import parse_target


DEFAULT_CONFIG_PATH = Path("logs/proxies.json")
SUGGESTED_STRIP_REQUEST_FIELDS_TEXT = ",".join(DEFAULT_STRIP_REQUEST_FIELDS)


@dataclass
class ProxyRuntime:
    server: ProxyServer
    thread: threading.Thread
    logger: TrafficLogger


class ProxyManager:
    def __init__(
        self,
        config_path: Path = DEFAULT_CONFIG_PATH,
        log_file: Path = Path("logs/interactions.jsonl"),
        readable_log_dir: Path | None = Path("logs/readable"),
    ) -> None:
        self.config_path = config_path
        self.log_file = log_file
        self.readable_log_dir = readable_log_dir
        self.lock = threading.RLock()
        self.pairs: list[dict[str, Any]] = self._load_pairs()
        self.runtimes: dict[str, ProxyRuntime] = {}

    def _load_pairs(self) -> list[dict[str, Any]]:
        if not self.config_path.exists():
            return [
                self._normalize_pair(
                    {
                        "id": "default",
                        "name": "Default proxy",
                        "enabled": False,
                        "listen_host": "127.0.0.1",
                        "listen_port": 1234,
                        "target_url": "http://127.0.0.1:1235",
                        "target_headers": [],
                        "strip_request_fields": "",
                        "inject_request_fields": "",
                        "timeout": 600,
                        "access_log": False,
                    }
                )
            ]
        try:
            loaded = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        raw_pairs = loaded.get("pairs", loaded) if isinstance(loaded, dict) else loaded
        if not isinstance(raw_pairs, list):
            return []
        return [self._normalize_pair(pair) for pair in raw_pairs if isinstance(pair, dict)]

    def save(self) -> None:
        with self.lock:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            self.config_path.write_text(
                json.dumps({"pairs": self.pairs}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

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

    def list_pairs(self) -> list[dict[str, Any]]:
        with self.lock:
            return [self._public_pair(pair) for pair in self.pairs]

    def replace_pairs(self, pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
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

    def set_enabled(self, pair_id: str, enabled: bool) -> dict[str, Any]:
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

    def _start_pair(self, pair: dict[str, Any]) -> None:
        pair_id = str(pair["id"])
        if pair_id in self.runtimes:
            return
        targets = [self._runtime_target(target, pair) for target in pair.get("targets", [])]
        if not targets:
            targets = [self._runtime_target(pair, pair)]
        first_target = targets[0]
        logger = targets[0].get("traffic_logger")
        if not isinstance(logger, TrafficLogger):
            logger = TrafficLogger(Path(pair.get("log_file") or self.log_file), self._readable_dir_for(pair))
        config = {
            "target_scheme": first_target["target_scheme"],
            "target_host": first_target["target_host"],
            "target_port": first_target["target_port"],
            "target_base_path": first_target["target_base_path"],
            "target_headers": first_target["target_headers"],
            "strip_request_fields": first_target["strip_request_fields"],
            "inject_request_fields": first_target["inject_request_fields"],
            "timeout": first_target["timeout"],
            "targets": targets,
            "default_target_id": pair.get("default_target_id") or first_target["id"],
            "access_log": bool(pair.get("access_log", False)),
            "proxy_pair_id": pair_id,
            "proxy_pair_name": pair.get("name", pair_id),
        }
        server = ProxyServer((str(pair["listen_host"]), int(pair["listen_port"])), ProxyHandler, config, logger)
        thread = threading.Thread(target=server.serve_forever, daemon=True, name=f"llm-proxy-{pair_id}")
        thread.start()
        self.runtimes[pair_id] = ProxyRuntime(server=server, thread=thread, logger=logger)

    def _readable_dir_for(self, pair: dict[str, Any]) -> Path | None:
        raw_value = pair.get("readable_log_dir")
        if raw_value == "":
            return None
        if raw_value:
            return Path(str(raw_value))
        return self.readable_log_dir

    def _runtime_target(self, target_pair: dict[str, Any], pair: dict[str, Any]) -> dict[str, Any]:
        target = parse_target(
            SimpleNamespace(
                target_url=target_pair.get("target_url") or None,
                target_scheme=target_pair.get("target_scheme", "http"),
                target_host=target_pair.get("target_host", "127.0.0.1"),
                target_port=int(target_pair.get("target_port", 1235)),
            )
        )
        runtime_target = {
            "id": str(target_pair.get("id") or "default"),
            "name": str(target_pair.get("name") or target_pair.get("id") or "Default target"),
            "target_scheme": target["scheme"],
            "target_host": target["host"],
            "target_port": target["port"],
            "target_base_path": target["base_path"],
            "target_headers": parse_header_overrides(list(target_pair.get("target_headers") or [])),
            "strip_request_fields": parse_strip_request_fields(target_pair.get("strip_request_fields")),
            "inject_request_fields": parse_inject_request_fields(target_pair.get("inject_request_fields")),
            "timeout": float(target_pair.get("timeout", 600)),
            "model_mappings": list(target_pair.get("model_mappings") or []),
            "enabled": bool(target_pair.get("enabled", True)),
        }
        runtime_target["traffic_logger"] = TrafficLogger(
            Path(target_pair.get("log_file") or pair.get("log_file") or self.log_file),
            self._readable_dir_for(target_pair),
        )
        return runtime_target

    def _find_pair(self, pair_id: str) -> dict[str, Any]:
        for pair in self.pairs:
            if str(pair["id"]) == pair_id:
                return pair
        raise KeyError(pair_id)

    def _public_pair(self, pair: dict[str, Any]) -> dict[str, Any]:
        public = dict(pair)
        runtime = self.runtimes.get(str(pair["id"]))
        public["running"] = runtime is not None
        public["actual_listen_port"] = runtime.server.server_address[1] if runtime else None
        return public

    def _normalize_pair(self, pair: dict[str, Any]) -> dict[str, Any]:
        pair_id = str(pair.get("id") or f"proxy-{len(pair)}").strip()
        targets = pair.get("targets")
        normalized_targets = [self._normalize_target(target, index) for index, target in enumerate(targets) if isinstance(target, dict)] if isinstance(targets, list) else []
        if not normalized_targets:
            normalized_targets = [self._normalize_target(pair, 0)]
        target_url = str(pair.get("target_url") or "").strip()
        inject_request_fields = pair.get("inject_request_fields")
        if isinstance(inject_request_fields, dict):
            inject_request_fields = json.dumps(inject_request_fields, ensure_ascii=False, separators=(",", ":"))
        elif inject_request_fields is None:
            inject_request_fields = ""
        normalized = {
            "id": pair_id,
            "name": str(pair.get("name") or pair_id),
            "enabled": bool(pair.get("enabled", False)),
            "listen_host": str(pair.get("listen_host") or "127.0.0.1"),
            "listen_port": int(pair.get("listen_port") or 1234),
            "target_url": target_url,
            "target_scheme": str(pair.get("target_scheme") or "http"),
            "target_host": str(pair.get("target_host") or "127.0.0.1"),
            "target_port": int(pair.get("target_port") or 1235),
            "target_headers": list(pair.get("target_headers") or []),
            "strip_request_fields": pair.get("strip_request_fields"),
            "inject_request_fields": str(inject_request_fields),
            "timeout": float(pair.get("timeout") or 600),
            "access_log": bool(pair.get("access_log", False)),
            "log_file": str(pair.get("log_file") or self.log_file),
            "readable_log_dir": "" if pair.get("readable_log_dir") == "" else str(pair.get("readable_log_dir") or self.readable_log_dir or ""),
            "targets": normalized_targets,
            "default_target_id": str(pair.get("default_target_id") or normalized_targets[0]["id"]),
        }
        return normalized

    def _normalize_target(self, target: dict[str, Any], index: int) -> dict[str, Any]:
        target_id = str(target.get("id") or f"target-{index + 1}").strip()
        inject_request_fields = target.get("inject_request_fields")
        if isinstance(inject_request_fields, dict):
            inject_request_fields = json.dumps(inject_request_fields, ensure_ascii=False, separators=(",", ":"))
        elif inject_request_fields is None:
            inject_request_fields = ""
        return {
            "id": target_id,
            "name": str(target.get("name") or target_id),
            "target_url": str(target.get("target_url") or "").strip(),
            "target_scheme": str(target.get("target_scheme") or "http"),
            "target_host": str(target.get("target_host") or "127.0.0.1"),
            "target_port": int(target.get("target_port") or 1235),
            "target_headers": list(target.get("target_headers") or []),
            "strip_request_fields": target.get("strip_request_fields") or "",
            "inject_request_fields": str(inject_request_fields),
            "timeout": float(target.get("timeout") or 600),
            "readable_log_dir": "" if target.get("readable_log_dir") == "" else str(target.get("readable_log_dir") or self.readable_log_dir or ""),
            "model_mappings": self._normalize_model_mappings(target.get("model_mappings") or target.get("models") or []),
            "enabled": bool(target.get("enabled", True)),
        }

    def _normalize_model_mappings(self, mappings: Any) -> list[dict[str, str]]:
        normalized: list[dict[str, str]] = []
        if not isinstance(mappings, list):
            return normalized
        for item in mappings:
            if isinstance(item, str):
                listen = item.strip()
                upstream = listen
            elif isinstance(item, dict):
                listen = str(item.get("listen") or item.get("listen_model") or item.get("model") or "").strip()
                upstream = str(item.get("upstream") or item.get("upstream_model") or listen).strip()
            else:
                continue
            if listen:
                normalized.append({"listen": listen, "upstream": upstream or listen})
        return normalized
