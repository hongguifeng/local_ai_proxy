"""Export deterministic, language-neutral fixtures from the frozen Python baseline."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from llm_proxy.payloads import body_json_value
from llm_proxy.redaction import redact_headers, redact_json_value
from llm_proxy.routing import request_model_from_body, rewrite_request_model, select_target_by_model
from llm_proxy.sanitize import transform_request_json_fields
from llm_proxy.target import join_target_path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "packages" / "test-fixtures"
PACKAGE_METADATA = {"README.md", "package.json"}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def write_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


def target(target_id: str, *, enabled: bool = True, mappings: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {
        "id": target_id,
        "name": target_id,
        "enabled": enabled,
        "target_scheme": "http",
        "target_host": "127.0.0.1",
        "target_port": 1235,
        "target_base_path": "",
        "target_api_key": "",
        "target_headers": [],
        "strip_request_fields": set(),
        "inject_request_fields": {},
        "timeout": 5.0,
        "model_mappings": mappings or [],
    }


def proxy_cases() -> dict[str, object]:
    path_inputs = [
        {"basePath": "/v1", "requestPath": "/chat/completions"},
        {"basePath": "/v1", "requestPath": "/v1/models?limit=10"},
        {"basePath": "/v1", "requestPath": "/v10/models"},
        {"basePath": "/api/v1", "requestPath": "models"},
        {"basePath": "", "requestPath": "/v1/responses?stream=true"},
    ]
    path_cases = [
        {**item, "expected": join_target_path(item["basePath"], item["requestPath"])} for item in path_inputs
    ]

    model_bodies = [b'{"model":"demo"}', b'{"model":123}', b"not json", b"[1,2]"]
    model_cases = [
        {
            "bodyBase64": _base64(body),
            "expectedModel": request_model_from_body(body),
        }
        for body in model_bodies
    ]

    targets = [
        target("disabled", enabled=False, mappings=[{"listen": "demo", "upstream": "ignored"}]),
        target("mapped", mappings=[{"listen": "demo", "upstream": "upstream-demo"}]),
        target("default"),
    ]
    selection = select_target_by_model(targets, "default", b'{"model":"demo"}')  # type: ignore[arg-type]

    rewrite_input = b'{"model":"demo","messages":[]}'
    rewrite_output = rewrite_request_model(rewrite_input, "upstream-demo")
    transform_input = b'{"model":"demo","temperature":0.2,"metadata":{"old":true}}'
    transform_output, stripped, injected = transform_request_json_fields(
        transform_input,
        {"temperature", "missing"},
        {"metadata": {"source": "fixture"}, "stream": True},
    )

    return {
        "$schema": "../schema/fixture-set.schema.json",
        "kind": "proxy",
        "pathJoin": path_cases,
        "modelExtraction": model_cases,
        "targetSelection": {
            "requestModel": selection.request_model,
            "expectedTargetId": selection.target["id"],
            "expectedUpstreamModel": selection.upstream_model,
        },
        "modelRewrite": {
            "inputBase64": _base64(rewrite_input),
            "upstreamModel": "upstream-demo",
            "expectedBase64": _base64(rewrite_output),
        },
        "fieldTransform": {
            "inputBase64": _base64(transform_input),
            "strip": ["missing", "temperature"],
            "inject": {"metadata": {"source": "fixture"}, "stream": True},
            "expectedBase64": _base64(transform_output),
            "expectedStripped": stripped,
            "expectedInjected": injected,
        },
        "redaction": {
            "headers": {"Authorization": ["Bearer secret"], "X-API-Key": ["sk-secret"], "Accept": ["*/*"]},
            "expectedHeaders": redact_headers(
                {"Authorization": ["Bearer secret"], "X-API-Key": ["sk-secret"], "Accept": ["*/*"]}
            ),
            "json": {"model": "demo", "nested": {"password": "secret", "ok": True}},
            "expectedJson": redact_json_value(
                {"model": "demo", "nested": {"password": "secret", "ok": True}}
            ),
        },
    }


STREAMS = {
    "openai-responses": (
        b'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'
        b'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
        b'data: {"type":"response.reasoning_text.delta","delta":"Think"}\n\n'
        b'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","call_id":"call_1","delta":"{\\"q\\":"}\n\n'
        b'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"\\"docs\\"}"}\n\n'
        b'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
        b"data: [DONE]\n\n"
    ),
    "openai-chat": (
        b'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n'
        b'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
        b'data: {"choices":[{"delta":{"text":" world"},"finish_reason":"stop"}],"usage":{"total_tokens":9}}\n\n'
        b"data: [DONE]\n\n"
    ),
    "openai-completions": (
        b'data: {"id":"cmpl_1","choices":[{"text":"Hello","finish_reason":null}]}\n\n'
        b'data: {"id":"cmpl_1","choices":[{"text":" world","finish_reason":"stop"}],"usage":{"total_tokens":4}}\n\n'
        b"data: [DONE]\n\n"
    ),
    "claude-messages": (
        b'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","usage":{"input_tokens":8}}}\n\n'
        b'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan "}}\n\n'
        b'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
        b'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\n\n'
        b'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"docs\\"}"}}\n\n'
        b'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n'
        b"data: [DONE]\n\n"
    ),
}


def export_streams(root: Path) -> None:
    for name, body in STREAMS.items():
        write_bytes(root / "streams" / f"{name}.sse", body)
        summary = body_json_value({"size_bytes": len(body), "base64": "", "text": body.decode("utf-8")})
        write_json(
            root / "streams" / f"{name}.expected.json",
            {"$schema": "../schema/fixture-set.schema.json", "kind": "stream-summary", "expected": summary},
        )


def task_cases() -> dict[str, object]:
    return {
        "$schema": "../schema/fixture-set.schema.json",
        "kind": "task-assignment",
        "cases": [
            {
                "name": "pending record is promoted in place",
                "requests": [
                    {"recordId": "req_1", "event": "request_received", "bodyPending": True},
                    {"recordId": "req_1", "event": "request_finished", "path": "/v1/responses", "body": {"model": "gpt-5", "input": "hello"}},
                ],
                "expectedTaskRelation": ["same"],
                "expectedSequences": [1, 1],
            },
            {
                "name": "previous response continues Responses task",
                "requests": [
                    {"recordId": "req_1", "path": "/v1/responses", "body": {"model": "gpt-5", "input": "hello"}, "responseIds": ["resp_1"]},
                    {"recordId": "req_2", "path": "/v1/responses", "body": {"model": "gpt-5", "previous_response_id": "resp_1", "input": "next"}},
                ],
                "expectedTaskRelation": ["same"],
                "expectedSequences": [1, 2],
            },
            {
                "name": "conversation context continues Claude task",
                "requests": [
                    {"recordId": "req_1", "path": "/v1/messages", "body": {"model": "claude", "conversation_id": "conv_1", "messages": [{"role": "user", "content": "a"}]}},
                    {"recordId": "req_2", "path": "/v1/messages", "body": {"model": "claude", "conversation_id": "conv_1", "messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]}},
                ],
                "expectedTaskRelation": ["same"],
                "expectedSequences": [1, 2],
            },
            {
                "name": "model change starts a new task",
                "requests": [
                    {"recordId": "req_1", "path": "/v1/chat/completions", "body": {"model": "model-a", "messages": [{"role": "user", "content": "hello"}]}},
                    {"recordId": "req_2", "path": "/v1/chat/completions", "body": {"model": "model-b", "messages": [{"role": "user", "content": "hello"}]}},
                ],
                "expectedTaskRelation": ["different"],
                "expectedSequences": [1, 1],
            },
        ],
    }


def export_edge_cases(root: Path) -> None:
    write_json(
        root / "proxy" / "duplicate-headers.json",
        {
            "$schema": "../schema/fixture-set.schema.json",
            "kind": "header-pairs",
            "headers": [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"], ["X-Test", "one"], ["X-Test", "two"]],
        },
    )
    write_bytes(root / "binary" / "invalid-utf8.bin", bytes([0x66, 0x6F, 0x80, 0xFF, 0x6F]))
    write_bytes(root / "binary" / "payload.json.gz", gzip.compress(b'{"ok":true,"message":"fixture"}', mtime=0))
    write_bytes(root / "binary" / "malformed.json", b'{"model":"demo",')


def _base64(value: bytes) -> str:
    import base64

    return base64.b64encode(value).decode("ascii")


def export(root: Path) -> None:
    if root.exists():
        for child in root.iterdir():
            if child.name in PACKAGE_METADATA:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    write_json(root / "proxy" / "cases.json", proxy_cases())
    export_streams(root)
    write_json(root / "tasks" / "cases.json", task_cases())
    export_edge_cases(root)
    write_json(
        root / "schema" / "fixture-set.schema.json",
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://llm-proxy.local/schemas/fixture-set.schema.json",
            "title": "LLM Proxy language-neutral fixture set",
            "type": "object",
            "required": ["kind"],
            "properties": {"kind": {"type": "string"}},
            "additionalProperties": True,
        },
    )
    hashes = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name not in PACKAGE_METADATA | {"manifest.json"}
    }
    write_json(root / "manifest.json", {"formatVersion": 1, "source": "python-v0.2.0", "sha256": hashes})


def check(expected: Path) -> bool:
    with tempfile.TemporaryDirectory() as temporary:
        actual = Path(temporary) / "test-fixtures"
        export(actual)
        expected_files = {
            path.relative_to(expected)
            for path in expected.rglob("*")
            if path.is_file() and path.name not in PACKAGE_METADATA
        }
        actual_files = {
            path.relative_to(actual)
            for path in actual.rglob("*")
            if path.is_file() and path.name not in PACKAGE_METADATA
        }
        if expected_files != actual_files:
            return False
        return all((expected / relative).read_bytes() == (actual / relative).read_bytes() for relative in expected_files)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="Fail when committed fixtures differ from a fresh export.")
    args = parser.parse_args()
    output = args.output.resolve()
    if args.check:
        if not output.is_dir() or not check(output):
            print(f"Fixtures are stale: {output}")
            return 1
        print(f"Fixtures are reproducible: {output}")
        return 0
    export(output)
    print(f"Exported fixtures: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
