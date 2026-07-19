# LLM Proxy v0.3.0-rc.2

这是将应用从 Python 完整切换到 Node.js 24 + TypeScript + Electron 的候选版本。代理、管理 UI、历史记录、SQLite 数据、CLI 和 Windows Tray 功能均已迁移；运行和开发不再需要 Python。

相较 `v0.3.0-rc.1`，本版本修复了 Windows CI 的路径可移植性、Chrome 启动路径和浏览器语言状态隔离问题。随后发现 GitHub Windows checkout 的 CRLF 转换会触发格式检查失败，因此本版本已由 `v0.3.0-rc.3` 替代，不作为有效候选版本。

## 已批准的行为差异

以下差异是有意设计并经过 ADR 批准，不属于待修复的 parity 缺陷。

1. 原始请求与上游请求可同时持久化（[ADR-002](adr/002-original-and-upstream-request-body.md)）。`request_body` 和 `request.json` 仍表示最终发往上游的内容；发生 model rewrite、strip 或 inject 时，新增 `original_request` / `original-request.json` 保存改写前内容。两者相同时不重复存储。
2. Body 具有明确资源上限（[ADR-003](adr/003-log-body-memory-and-size-limits.md)）。超过 64 MiB 的请求返回 413；超过完整日志上限的响应仍完整转发给客户端，但持久化内容会带 size、SHA-256 和 truncation metadata。常规请求行为不变。
3. 配置应用改为整份事务（[ADR-004](adr/004-configuration-apply-transaction.md)）。端口冲突、listener 启动或保存失败时，Node 版本回滚全部新配置和运行态，不再保留 Python 版本可能出现的部分成功状态。
4. 客户端提前断开会立即取消上游（[ADR-005](adr/005-client-abort-behavior.md)）。这会减少无消费者请求的 Token 和连接消耗；对应 History 记录可能只包含部分响应，并标记为 aborted/truncated。
5. Windows 桌面版改为 Electron（[ADR-006](adr/006-windows-artifacts.md)）。提供 NSIS installer、portable EXE 和轻量 CLI ZIP；桌面产物比旧 PyInstaller 单文件更大。当前构建未使用商业代码签名证书，Windows SmartScreen 可能显示提示。

## 保持不变的关键合同

- 首版继续对客户端和上游使用 `Connection: close`，不启用 keep-alive pool（[ADR-007](adr/007-connection-close-parity.md)）。
- History 搜索继续使用大小写归一、空白分词、term 间 AND 的字面子串语义，不切换为 FTS `MATCH`（[ADR-008](adr/008-search-semantics.md)）。
- `request_body`、History 主 Request pane 和 `request.json` 继续展示实际上游请求。
- 现有 `proxies.json` 与 SQLite 数据库可直接读取；首次保存配置前会创建 `before-node` 备份。

## 运行时与发布说明

- 源码开发需要 Node.js 24；执行 `npm ci` 后可运行、测试和打包。
- Windows x64 Electron 产物内置运行时，不要求用户预装 Node.js；轻量 CLI ZIP 需要 Node.js 24，并在解压目录执行 `npm ci --omit=dev`。
- SQLite 使用 `better-sqlite3`，Windows 产物已针对 Electron ABI 重建并完成 FTS5 smoke。
- 正式切换前请按 [迁移回滚说明](migration-rollback.md) 备份配置、`traffic.db`、WAL/SHM，并确认至少有数据库大小 2.4 倍的可用空间。

## 验证摘要

- 72 个 Node test files、496 个测试在 Linux 和 Windows 全部通过。
- Windows x64 installer 和 portable 构建成功；portable 健康检查、优雅关闭和端口释放通过。
- 7.58 GB 活跃真实数据库完成 online backup、迁移、关系校验、SHA-256 回滚和重新打开验证。
