"""Create the deterministic SQLite traffic fixture used by Python/Node parity tests."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "fixtures" / "parity" / "database" / "comprehensive"
sys.path.insert(0, str(ROOT))

from llm_proxy.log_repository import LogRepository  # noqa: E402


def task(
    task_id: str,
    kind: str,
    endpoint: str,
    model: str,
    started_at: str,
    request_count: int,
    *,
    pending: bool = False,
) -> dict[str, Any]:
    return {
        "id": task_id,
        "kind": kind,
        "endpoint": endpoint,
        "anchor": f"fixture-{kind}",
        "model": model,
        "target": "https://fixture-upstream.example:443/v1",
        "started_at": started_at,
        "last_seen_at": started_at,
        "last_response_at": None if pending else started_at,
        "request_count": request_count,
        "pending_request_only": pending,
        "match_confidence": 1.0,
        "match_strategy_version": 4,
        "fingerprints": {"fixture": f"{kind}-fingerprint"},
        "boundary_fingerprints": {"first_user": f"{kind}-first-user"},
        "last_user_messages": [{"role": "user", "content": f"fixture {kind} request"}],
        "created_at": started_at,
        "updated_at": started_at,
    }


def record(
    record_id: str,
    task_id: str,
    sequence: int,
    timestamp: str,
    method: str,
    path: str,
    request_body: object,
    response_body: object,
    *,
    event: str = "request_finished",
    status: int | None = 200,
    message_count: int | None = 1,
    token_count: int | None = 10,
    duration_ms: float = 125.5,
    error: str | None = None,
) -> dict[str, Any]:
    endpoint = path.split("?", 1)[0].rstrip("/") or "/"
    return {
        "id": record_id,
        "task_id": task_id,
        "sequence": sequence,
        "event": event,
        "timestamp": timestamp,
        "started_at": timestamp,
        "duration_ms": duration_ms,
        "proxy_id": "proxy-fixture",
        "proxy_name": "Parity fixture proxy",
        "client_host": "127.0.0.1",
        "client_port": 43123 + sequence,
        "target_id": "target-fixture",
        "target_name": "Fixture target",
        "target_url": f"https://fixture-upstream.example:443{path}",
        "method": method,
        "path": path,
        "endpoint": endpoint,
        "status": status,
        "error": error,
        "message_count": message_count,
        "token_count": token_count,
        "request_headers": {
            "Content-Type": ["application/json"],
            "Authorization": ["Bearer fixture-not-a-secret"],
            "X-Repeated": ["one", "two"],
        },
        "response_headers": {
            "Content-Type": ["application/json" if response_body is not None else "text/event-stream"],
            "X-Fixture": ["response"],
        },
        "request_body": request_body,
        "response_body": response_body,
        "model_route": {
            "requested_model": "fixture-alias",
            "upstream_model": "fixture-upstream-model",
            "target_id": "target-fixture",
            "target_name": "Fixture target",
        },
        "stripped_fields": ["temperature"],
        "injected_fields": ["metadata"],
        "added_upstream_headers": ["X-Fixture-Header"],
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def create_fixture() -> None:
    FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
    for name in ("traffic.db", "traffic.db-wal", "traffic.db-shm"):
        (FIXTURE_ROOT / name).unlink(missing_ok=True)

    with LogRepository(FIXTURE_ROOT) as repository:
        responses_task = task(
            "task-responses-fixture",
            "responses",
            "/v1/responses",
            "gpt-fixture",
            "2026-01-02T03:04:05.100+08:00",
            2,
        )
        responses_task["last_seen_at"] = "2026-01-02T03:05:06.200+08:00"
        responses_task["last_response_at"] = "2026-01-02T03:05:06.200+08:00"
        repository.upsert_task(responses_task)
        repository.upsert_record(
            record(
                "record-responses-1",
                responses_task["id"],
                1,
                "2026-01-02T03:04:05.100+08:00",
                "POST",
                "/v1/responses",
                {
                    "model": "gpt-fixture",
                    "instructions": "You are a parity fixture.",
                    "input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
                    "stream": True,
                },
                {
                    "stream_summary": {
                        "event_count": 7,
                        "done_seen": False,
                        "content": "hello from fixture",
                        "reasoning": "fixture reasoning",
                        "response_tool_calls": [
                            {
                                "item_id": "item_fixture_1",
                                "call_id": "call_fixture_1",
                                "arguments": "{\"value\":1}",
                                "arguments_json": {"value": 1},
                            }
                        ],
                        "web_search_calls": [
                            {
                                "id": "search_fixture_1",
                                "type": "web_search_call",
                                "status": "completed",
                                "action": {"type": "search", "query": "fixture query"},
                            }
                        ],
                        "finish_reasons": ["completed"],
                        "usage": {"input_tokens": 12, "output_tokens": 8, "total_tokens": 20},
                        "response": {
                            "id": "resp_fixture_1",
                            "object": "response",
                            "status": "completed",
                            "model": "gpt-fixture",
                        },
                    }
                },
                message_count=2,
                token_count=20,
            )
        )
        repository.upsert_record(
            record(
                "record-responses-2",
                responses_task["id"],
                2,
                "2026-01-02T03:05:06.200+08:00",
                "POST",
                "/v1/responses?trace=fixture",
                {
                    "model": "gpt-fixture",
                    "previous_response_id": "resp_fixture_1",
                    "conversation_id": "conversation-fixture",
                    "input": [{"role": "user", "content": "continue"}],
                },
                {"id": "resp_fixture_2", "status": "completed", "usage": {"total_tokens": 9}},
                token_count=9,
            )
        )
        repository.upsert_response_link("resp_fixture_1", responses_task["id"])
        repository.upsert_response_link("resp_fixture_2", responses_task["id"])
        repository.upsert_context_link("conversation:conversation-fixture", responses_task["id"])

        chat_task = task(
            "task-chat-fixture",
            "chat",
            "/v1/chat/completions",
            "chat-fixture",
            "2026-02-03T04:05:06.300+08:00",
            1,
        )
        repository.upsert_task(chat_task)
        repository.upsert_record(
            record(
                "record-chat-1",
                chat_task["id"],
                1,
                "2026-02-03T04:05:06.300+08:00",
                "POST",
                "/v1/chat/completions",
                {
                    "model": "chat-fixture",
                    "messages": [
                        {"role": "system", "content": "fixture system"},
                        {"role": "user", "content": "call the tool"},
                    ],
                    "tools": [{"type": "function", "function": {"name": "fixture_tool"}}],
                    "stream": True,
                },
                {
                    "stream_summary": {
                        "event_count": 4,
                        "done_seen": True,
                        "content": "tool result",
                        "reasoning": "selecting fixture tool",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "chat_call_fixture",
                                "type": "function",
                                "function": {
                                    "name": "fixture_tool",
                                    "arguments": "{\"query\":\"fixture\"}",
                                    "arguments_json": {"query": "fixture"},
                                },
                            }
                        ],
                        "finish_reasons": ["tool_calls"],
                        "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
                    }
                },
                message_count=2,
                token_count=12,
            )
        )

        messages_task = task(
            "task-messages-fixture",
            "messages",
            "/v1/messages",
            "claude-fixture",
            "2026-03-04T05:06:07.400+08:00",
            1,
        )
        repository.upsert_task(messages_task)
        repository.upsert_record(
            record(
                "record-messages-1",
                messages_task["id"],
                1,
                "2026-03-04T05:06:07.400+08:00",
                "POST",
                "/v1/messages",
                {
                    "model": "claude-fixture",
                    "system": [{"type": "text", "text": "fixture system"}],
                    "messages": [{"role": "user", "content": "use the fixture tool"}],
                    "stream": True,
                },
                {
                    "stream_summary": {
                        "event_count": 8,
                        "done_seen": False,
                        "content": "claude fixture output",
                        "reasoning": "claude fixture thinking",
                        "claude_tool_calls": [
                            {
                                "index": 1,
                                "id": "toolu_fixture_1",
                                "name": "fixture_tool",
                                "type": "tool_use",
                                "input": {"path": "/fixture"},
                            }
                        ],
                        "finish_reasons": ["tool_use"],
                        "usage": {
                            "input_tokens": 10,
                            "output_tokens": 6,
                            "cache_creation_input_tokens": 2,
                            "cache_read_input_tokens": 1,
                        },
                        "response": {
                            "id": "msg_fixture_1",
                            "type": "message",
                            "role": "assistant",
                            "model": "claude-fixture",
                        },
                    }
                },
                message_count=2,
                token_count=19,
            )
        )
        repository.upsert_context_link("prompt_cache:prompt-cache-fixture", messages_task["id"])

        completions_task = task(
            "task-completions-fixture",
            "completions",
            "/v1/completions",
            "completion-fixture",
            "2026-04-05T06:07:08.500+08:00",
            1,
        )
        repository.upsert_task(completions_task)
        repository.upsert_record(
            record(
                "record-completions-1",
                completions_task["id"],
                1,
                "2026-04-05T06:07:08.500+08:00",
                "POST",
                "/v1/completions",
                {"model": "completion-fixture", "prompt": ["one", "two"]},
                {
                    "id": "cmpl_fixture_1",
                    "choices": [{"text": "fixture completion", "finish_reason": "stop"}],
                    "usage": {"total_tokens": 6},
                },
                message_count=2,
                token_count=6,
            )
        )

        pending_task = task(
            "task-pending-fixture",
            "responses",
            "/v1/responses",
            "pending-fixture",
            "2026-05-06T07:08:09.600+08:00",
            1,
            pending=True,
        )
        repository.upsert_task(pending_task)
        repository.upsert_record(
            record(
                "record-pending-1",
                pending_task["id"],
                1,
                "2026-05-06T07:08:09.600+08:00",
                "POST",
                "/v1/responses",
                {"model": "pending-fixture", "input": "pending request"},
                None,
                event="request_pending_response",
                status=None,
                token_count=None,
                duration_ms=4.25,
            )
        )


if __name__ == "__main__":
    create_fixture()
