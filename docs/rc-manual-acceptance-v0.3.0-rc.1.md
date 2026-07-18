# v0.3.0-rc.1 手工验收记录

- 验收日期：2026-07-18
- 候选版本：`v0.3.0-rc.1`
- 平台：Windows 10.0.26100 x64、Windows Node.js 24.18.0、WSL2 Ubuntu
- 结论：通过，可以发布 RC。

## 产物

| 产物 | 大小 | SHA-256 | 结果 |
| --- | ---: | --- | --- |
| `LLM Proxy-0.3.0-rc.1-x64-setup.exe` | 99,521,014 bytes | `cf4e4d69e529ec38333186a78441d1a47d5322a8cf908b71cc0987b1cf2efc45` | 通过 |
| `LLM Proxy-0.3.0-rc.1-x64-portable.exe` | 99,291,137 bytes | `01128e9e210c7701573cd53ec5814660446a487a63d31b7e4f657098d9fcf8c6` | 通过 |
| `llm-proxy-cli-0.3.0-rc.1.zip` | 351,862 bytes | `e4851ba6d2a06e257307af009c603a97006b702cbcdeec8412ebd5333bc493d4` | 通过 |

`sha256sum -c SHA256SUMS.txt` 对三个文件均返回 `OK`。

## Windows 运行验收

- [x] clean clone 执行 `npm ci` 后可生成 NSIS installer 和 portable EXE。
- [x] Electron 对 `better-sqlite3` 完成 ABI rebuild。
- [x] portable EXE 无主窗口启动，管理端 `/api/health` 返回 `ok`。
- [x] portable 使用隔离配置、日志和 user-data，不受已运行旧版本影响。
- [x] smoke 退出信号走应用优雅关闭路径；管理端口释放且无遗留进程。
- [x] CLI ZIP 可正常解压，`npm ci --omit=dev` 安装 136 个 production packages，0 vulnerabilities。
- [x] CLI ZIP 启动后 `/api/health` 返回 `ok`、管理 UI 返回 HTTP 200，退出后端口释放。

## UI 手工复核

- [x] 逐张检查 `doc/ui_proxy_cn.png`、`doc/ui_proxy_en.png`、`doc/ui_logs_cn.png`、`doc/ui_logs_en.png`。
- [x] 中英文导航、表单字段、target 横向卡片、开关、按钮、History 三栏布局和 JSON tree 无明显裁切、遮挡或错位。
- [x] API Key 在视觉基线中保持遮罩显示。
- [x] 当前 Playwright 截图与四张人工批准基线的 pixel difference 均低于规定阈值。
- [x] 760 px 响应式断点可操作且页面不是空白。

## 功能验收证据

- [x] Proxy pair/target 新增、删除、默认项、启停、保存失败回滚由 UI、admin 和 manager 测试覆盖。
- [x] Responses、Chat Completions、Completions、Claude Messages、普通响应和 SSE 代理测试通过。
- [x] model route/rewrite、strip、inject、Header、API Key、redaction 测试通过。
- [x] History grouping、搜索、分页、详情、pending 自动刷新、ZIP 导出和 cleanup 测试通过。
- [x] config 与 SQLite parity fixtures 通过。
- [x] 7.58 GB 活跃真实数据库副本的迁移、关系校验和 SHA-256 回滚通过。
- [x] 完整 `npm run check` 通过，无已知 P0 bug。

## 已知非阻塞事项

- 当前 Windows 产物未使用商业代码签名证书，SmartScreen 可能提示；release note 和签名文档已说明。
- `OPT-001` 至 `OPT-012` 是正式切换后处理的 P2 优化池，不属于本 RC 的 parity 缺陷。
