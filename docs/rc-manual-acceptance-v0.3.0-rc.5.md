# v0.3.0-rc.5 手工验收记录

- 验收日期：2026-07-18
- 候选版本：`v0.3.0-rc.5`
- 平台：Windows 10.0.26100 x64、Windows Node.js 24.18.0、GitHub Actions Windows/Ubuntu Node.js 24
- GitHub Release：<https://github.com/hongguifeng/local_ai_proxy/releases/tag/v0.3.0-rc.5>
- 结论：通过，作为正式 `v0.3.0` 的有效 RC。

## 远程发布门禁

- [x] tag CI `29645598787` 成功：Ubuntu、Windows 和 Windows packaged database smoke 全部通过。
- [x] tag Windows Electron Release `29645598783` 成功：构建、portable smoke、CLI ZIP、checksum、附件上传全部通过。
- [x] GitHub Release 正确标记为 prerelease。
- [x] Release 附件包含 installer、portable、CLI ZIP 和 `SHA256SUMS.txt`。

## 产物

| 产物 | 大小 | SHA-256 | 结果 |
| --- | ---: | --- | --- |
| `LLM-Proxy-0.3.0-rc.5-x64-setup.exe` | 99,521,393 bytes | `86548815814eec3169369e2a34af2b21499fd9a442c527ad7827c962bf61672f` | 通过 |
| `LLM-Proxy-0.3.0-rc.5-x64-portable.exe` | 99,291,505 bytes | `1474f2b60c261bb92e54de39147c9781919ddc1d1483889cb41c4a2d47886151` | 通过 |
| `llm-proxy-cli-0.3.0-rc.5.zip` | 351,869 bytes | `3a7b19c979e79077623bb12882c23e8364394c2440612b841f8addd7f9aa535a` | 通过 |

从 GitHub Release 重新下载全部四个附件后执行 `sha256sum -c SHA256SUMS.txt`，三个二进制产物均返回 `OK`。

## Windows 运行验收

- [x] clean clone 执行 `npm ci` 和完整 `npm run check`，72 个测试文件、497 个测试通过。
- [x] Electron 对 `better-sqlite3` 完成 ABI rebuild，installer 和 portable 构建成功。
- [x] portable EXE 启动后 `/api/health` 返回 `ok`，退出信号走优雅关闭路径且端口释放。
- [x] CLI ZIP 解压后 `npm ci --omit=dev` 安装 136 个 production packages，0 vulnerabilities。
- [x] CLI 启动后 `/api/health` 返回 `ok`、管理 UI 返回 HTTP 200，Ctrl+C 后端口释放。

## UI 与功能复核

- [x] 中英文 Proxy/History 四张视觉基线均低于 pixel difference 阈值。
- [x] 760 px 响应式断点、卡片、JSON tree、splitter 和 pending 自动刷新测试通过。
- [x] UI 测试固定语言状态并等待 `/api/pairs` 初始化完成，不依赖浏览器 profile、系统语言或网络空闲计时。
- [x] Proxy、SSE、SQLite、TaskMatcher、History、导出、cleanup、配置回滚和关闭释放测试全部通过。
- [x] 7.58 GB 活跃真实数据库副本迁移、关系校验和 SHA-256 回滚通过。

## 已知非阻塞事项

- 当前 Windows 产物未使用商业代码签名证书，SmartScreen 可能提示；release note 和签名文档已说明。
- `OPT-001` 至 `OPT-012` 是正式切换后的 P2 优化池，不属于本 RC 的 parity 缺陷。
