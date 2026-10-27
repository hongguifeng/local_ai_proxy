# ADR-012：日志记录解码后的响应体，客户端保留原始编码字节

> 状态：决策记录
> 权威性：已作出的架构决策；当前实现以代码和 current/ 为准。
> 更新条件：决策被替代或发现事实错误时更新。

- 状态：已接受
- 日期：2026-10-21
- 决策范围：代理响应转发、流量日志正文、SSE 观测与计费用量

## 背景

代理把客户端的 `Accept-Encoding` 原样转发给上游，上游因此可以返回 `gzip`、`br`、`zstd` 或
`deflate` 编码的响应。Node.js 的 `http`/`https` 客户端不会自动解压，代理收到的是仍然压缩的字节。

0.4.10 及之前，日志采集器把这些字节直接当作文本保存，后果是：

- 日志正文变成替换字符组成的乱码（落库成 `{"text": ..., "size_bytes": ...}`），UI 的 JSON 面板不可读。
- SSE 累加器解析不到任何 `data:` 行，`first_token_ms` 缺失、`decode_window_ms` 为 0，速度指标只剩端到端。
- 用量累加器读不到 usage 事件，`pricing_reason=incomplete_usage`，请求/响应 token 计数为空，整条任务显示 unpriced。
- 非流式响应同样解析不出 JSON，计费和 token 计数一起丢失。

DeepSeek 是主要受害者：客户端只要声明支持 gzip，它就会压缩响应。生产库里 2070 条带
`content-encoding` 的记录（deepseek 占 1915 条）全部落在上述几种情况里，且压缩字节在写入
`body_chunks` 前已被 UTF-8 解码破坏，事后无法恢复。

## 选项

1. 向上游只请求 identity（去掉客户端的 `Accept-Encoding`）。
   - 实现最简单，日志永远是纯文本。
   - 但改变了客户端收到的内容（不再有压缩），同时放弃上游到代理的带宽节省。
   - 上游仍可无视协商自行压缩，问题依旧。
2. 只在 `finalize()` 时整体解压。
   - SSE 的首 token、decode window 和用量必须边到边解码，整体解压给不出这些时序。
3. 在客户端路径旁边挂一个解码分支：转发给客户端的字节和 Header 保持不变，只有日志侧看到解压后的字节。

## 决策

采用选项 3，实现在 `src/proxy/response-decoder.ts`。

- 客户端路径完全不变：仍然逐 chunk 透传原始字节，`content-encoding` 原样保留，由客户端自己解压
  （Node 24 / undici 已支持 gzip、deflate、br、zstd，代理转发后客户端行为与修复前一致）。
- 日志侧按 `content-encoding` 建立解压链：`gzip`/`x-gzip`、`deflate`（用两字节头探测 zlib 框还是
  raw deflate）、`br`、`zstd`；多层编码按 Header 列表逆序撤销（Header 按施加顺序列出）。
- 解压后的字节喂给 `ResponseLogCapture`，SSE 摘要、用量累加、`first_token_ms` 和
  `decode_window_ms` 全部恢复；日志的 `size_bytes`、`sha256`、`base64` 描述的也是解压后的正文，
  与客户端最终看到的正文一致。
- 失败策略：无法识别的编码或运行时缺少该编解码器（例如没有 zstd 的旧 Node）退回原样记录，不崩；
  流中途解码失败（截断、损坏的 trailer）丢弃剩余部分，保留已解出的前缀，`finish()` 既不抛错也不挂起；
  下游采集器抛异常时同样立即停止投递，而不是让异常在流事件里无人监听。
- `forwardResponseBody()` 在 `finally` 里 `await decoder.finish()`，保证
  `ResponseLogCapture.finalize()` 之前所有可解码的字节都已经送达采集器。

## 后果

- 压缩响应的日志正文、JSON 面板、token 计数、首 token/Decode 速度和计费恢复正确。
- 日志记录的是逻辑正文而不是线路字节，`size_bytes` 因此大于压缩后的网络字节数；ADR-003 的
  64 MiB 日志上限现在约束的是解压后的体积，这正是日志需要存储的大小。
- 代理到上游的压缩带宽节省保留，代理到客户端仍然传输压缩字节（本部署里客户端在 loopback，代价可忽略）。
- 修复前写入的历史乱码记录无法修复：原始压缩字节在存库时已经被破坏。
