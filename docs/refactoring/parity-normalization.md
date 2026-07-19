# 跨语言 Parity 动态值规范化规则

Python 与 Node.js 的结果比较前，使用 `fixtures/parity/normalization-rules.json` 规范化运行时动态值。

当前规则版本为 1，处理：

- 时间字段：按真实时间排序后替换为 `<timestamp:N>`，保留先后关系和相同值关系。
- 动态端口字段：按数值排序后替换为 `<port:N>`。
- 临时路径字段：按字符串排序后替换为 `<path:N>`。
- 标准 UUID：替换为 `<uuid:N>`。
- 32 位十六进制 request ID：替换为 `<request_id:N>`。
- `127.0.0.1` 的高位临时端口：替换为 `<localhost_port:N>`。

规范化不处理以下稳定业务值：

- pair/target/task fixture ID。
- 固定监听端口，例如 1234、2234。
- model、path、status 和 sequence。
- request/response 正文。

相同原值必须得到相同 token；时间和数字 token 按值排序，不依赖 JSON object key 遍历顺序。Node.js parity harness 必须读取同一份规则文件并实现相同语义。

Python 参考实现：

```bash
python3 scripts/normalize_parity_json.py input.json --output normalized.json
```

JSON 输出固定为 UTF-8、非 ASCII 转义、2 空格缩进和 key 排序。ZIP 比较不比较压缩后的二进制字节，而是先读取 entry path 和内容，再对 JSON entry 应用上述规则。
