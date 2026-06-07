"""请求体/响应体的序列化与展示工具。

日志既要保存完整原始字节，又要方便人阅读。这里负责把 bytes 转成可写入
JSON 的结构，并在 readable 日志里尽量把 JSON 或 SSE 流整理得更清楚。
"""

from __future__ import annotations

import base64
import json
from typing import Mapping

from .streams import compact_sse_json

def bytes_payload(data: bytes) -> dict[str, object]:
    """把原始 bytes 包装成日志里的 body 字段。

    - ``size_bytes``：原始字节数。
    - ``base64``：无损保存原始内容，二进制也能记录。
    - ``text``：按 UTF-8 解码后的文本，方便人工阅读。
    """
    payload: dict[str, object] = {
        "size_bytes": len(data),
        "base64": base64.b64encode(data).decode("ascii"),
        "text": data.decode("utf-8", errors="replace"),
    }
    return payload


def try_pretty_json(text: str) -> str:
    """如果文本是 JSON，就格式化缩进；否则原样返回。"""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text
    return json.dumps(parsed, ensure_ascii=False, indent=2)



def render_headers(headers: Mapping[str, list[str]]) -> str:
    """把头信息渲染成 Markdown 里可读的多行文本。"""
    if not headers:
        return "(none)"
    lines: list[str] = []
    for key in sorted(headers):
        for value in headers[key]:
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def render_body(body: Mapping[str, object]) -> str:
    """把 body 渲染成适合人工阅读的文本。

    OpenAI 兼容接口常用 SSE 流式返回。对于这类内容，先尝试压缩成摘要；
    如果不是 SSE，再尝试按普通 JSON 美化。
    """
    size = body.get("size_bytes", 0)
    text = str(body.get("text", ""))
    if not text:
        return f"(empty body, {size} bytes)"
    compacted = compact_sse_json(text)
    if compacted:
        return compacted
    return try_pretty_json(text)


def body_json_value(body: Mapping[str, object]) -> object:
    """把日志 body 转成 JSON 文件里应写入的值。

    readable 日志会额外生成 request.json 和 response.json。这个函数负责决定
    里面写什么：合法 JSON 写解析后的对象，SSE 写压缩摘要，普通文本则包装保存。
    """
    text = str(body.get("text", ""))
    if not text:
        return None
    compacted = compact_sse_json(text)
    if compacted:
        return json.loads(compacted)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "text": text,
            "size_bytes": body.get("size_bytes", 0),
        }

