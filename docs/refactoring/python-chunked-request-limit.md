# Python 版本 incoming chunked request 限制

## 当前行为

Python 代理只通过 `Content-Length` 读取客户端请求体。客户端发送：

```http
POST /chunked HTTP/1.1
Transfer-Encoding: chunked

4
test
3
123
0
```

当前代理会：

1. 因为没有 `Content-Length`，把请求体视为空 bytes。
2. 在转发 Header 时删除 `Transfer-Encoding`。
3. 向上游发送空 body，且不发送 `Content-Length` 或 `Transfer-Encoding`。
4. 正常返回上游响应，因此客户端可能无法从状态码发现 body 已丢失。

该行为由 `test_current_python_proxy_does_not_decode_incoming_chunked_body` 固定记录。它是迁移基线中的已知缺陷，不是 Node.js 必须复制的正确行为。

## Node.js 要求

Node.js 实现应利用 IncomingMessage stream 正确读取已由 Node HTTP parser 解码的 chunked body，再执行 model route、model rewrite、strip 和 inject。发往上游时可以由 Node 重新使用 chunked encoding，或在 body 已完整收集后发送正确的 `Content-Length`。

新增 Node 回归测试必须验证：

- 上游收到完整 `test123`。
- 客户端 `Transfer-Encoding` 不被盲目原样转发为第二层 chunk framing。
- JSON chunked body 仍可参与模型路由和字段改写。
- 超过 body 限制时返回明确错误，而不是静默转发空 body。
