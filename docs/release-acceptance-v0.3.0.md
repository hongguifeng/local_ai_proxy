# v0.3.0 正式发布验收记录

- 发布日期：2026-07-18
- 正式版本：`v0.3.0`
- GitHub Release：<https://github.com/hongguifeng/local_ai_proxy/releases/tag/v0.3.0>
- 结论：正式发布成功，tag、跨平台 CI、Windows 产物、checksum 和回滚文档齐全。

## 发布门禁

- [x] 分支 CI `29645846276` 成功。
- [x] 分支 Windows Electron Release `29645846298` 成功。
- [x] tag CI `29645934772` 成功：Ubuntu、Windows 和 Windows packaged database smoke 全部通过。
- [x] tag Windows Electron Release `29645934776` 成功：构建、portable smoke、CLI ZIP、checksum 和正式 Release 上传全部通过。
- [x] GitHub Release 为非 draft、非 prerelease 的正式版本。

## 正式附件

| 产物 | 大小 | SHA-256 | 结果 |
| --- | ---: | --- | --- |
| `LLM-Proxy-0.3.0-x64-setup.exe` | 99,521,163 bytes | `7d916770fc2e4e172319ade848717174e048235584b0e876e5dfc53c8728c9a1` | 通过 |
| `LLM-Proxy-0.3.0-x64-portable.exe` | 99,291,249 bytes | `7bd8874ef2d093c8015ae7cdaeb6d50a967a2bd29d58fc8b97ca4c0890d644a2` | 通过 |
| `llm-proxy-cli-0.3.0.zip` | 351,857 bytes | `a4fbf297a79dffbd45ff3d7826242842785b40fa2d5fe2e52163bee60ebc193c` | 通过 |

从正式 GitHub Release 重新下载 installer、portable、CLI ZIP 和 `SHA256SUMS.txt` 后执行 `sha256sum -c SHA256SUMS.txt`，三个产物均返回 `OK`。

## 数据与回滚

- [x] [迁移回滚说明](migration-rollback.md) 已包含切换前备份、WAL/SHM、磁盘空间、恢复和重新打开验证步骤。
- [x] 7.58 GB 活跃真实数据库已使用 SQLite online backup 完成迁移演练，task/record/link/search 关系无孤儿记录。
- [x] 演练回滚 SHA-256 与原始备份一致，回滚后数据库可重新打开。
- [x] 现有 `proxies.json` 与 `traffic.db` 可由正式 Node 版本直接读取。

## 发布内容

- [x] [正式版说明](release-notes-v0.3.0.md)列出所有已批准行为差异、安装方式、迁移与 SmartScreen 提示。
- [x] installer、portable 和 CLI ZIP 文件名与 checksum 条目完全一致。
- [x] Windows portable 健康检查、优雅退出和端口释放由 tag workflow 验证。
- [x] 仓库开发、测试和运行不再需要 Python。
