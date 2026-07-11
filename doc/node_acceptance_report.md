# Node.js 主实现验收报告

验收日期：2026-07-11。对照基线为 `doc/python_behavior_inventory.md` 与语言无关 fixtures。Node.js CLI、production runtime、管理 API、代理数据面、SQLite Worker、Web UI 和发布包已组成唯一候选生产链路。

## 行为域结论

| 行为域 | Node 验收证据 | 结论 |
| --- | --- | --- |
| CLI、信号和浏览器 | CLI unit test、npm/portable smoke、SIGINT/SIGTERM lifecycle test | 保留同名命令、8088 默认端口、路径和 no-browser；新增严格错误码与远程管理安全门 |
| 配置和运行时 | schema、repository、atomic config、production runtime integration | v1 严格 schema；整体替换失败会恢复旧 listener；secret 仅支持 keep/set/clear |
| HTTP 转发 | routing/header/body/timeout/fault/100 MiB response tests | 常见 HTTP/1.1 method、URL、model 路由、header、流式、取消和稳定 502/504 已覆盖 |
| SSE | OpenAI/Claude parser、首事件、60 秒 100 并发基准 | 流式转发和有界旁路摘要已覆盖 |
| Traffic/SQLite | lifecycle、repository、Worker、queue、production runtime integration | 每 root 独占 Worker；pending/final 合并；管理查询、清理、ZIP 导出可用 |
| Admin API/UI | API component、security、Playwright workflow | `/api/v1`、运行时 schema、secret 隐藏、静态 Web 与主要浏览器工作流通过 |
| 故障、安全和观测 | fault injection、health/metrics、logging、capacity tests | 故障不泄漏内部信息；健康、指标、限频告警、retention 和低磁盘降级已覆盖 |
| 发布物 | npm tarball、Windows portable、release workflow smoke | 可安装 CLI、便携包、checksum、SBOM、license 和 provenance 均有自动验证 |

## 与 Python v0.2.0 的有意差异

- 管理 API 从 `/api/*` 统一为 `/api/v1/*`，不提供内部兼容 shim。
- 配置改为 versioned camelCase 严格 schema；不再静默补默认 target、忽略未知字段或接受损坏 JSON。
- public API 不返回 API key；更新 secret 使用 `keep`、`set`、`clear` 动作。
- admin 默认仅 loopback；远程绑定必须显式允许并提供 bearer token，同时启用 Origin、body 和并发边界。
- 请求和响应 capture 有界，超限请求明确拒绝；不承诺 CONNECT、WebSocket、入站 HTTP/2/3 或正向代理 absolute-form。
- SQLite 同步工作全部移至 Worker；日志队列过载只降级记录，不中断代理转发。
- Windows 桌面入口改为管理独立 Node CLI 的 WinForms 薄壳，不再内嵌 Python runtime。

这些差异均为设计文档中允许改变或明确删除的原型行为，不存在未关闭的 P0/P1 缺陷。

## 质量门

本阶段要求运行 format、lint、typecheck、unit/component/integration、Playwright browser、build、frozen install、npm/portable package smoke，以及迁移前保留的 Python 黑盒测试。Windows 本地完成真实 upstream → proxy → Worker → admin API → live config 工作流；Linux 由 CI 的同一 Node 门禁和 npm artifact smoke 覆盖。

维护者切换确认：Node.js production runtime 已作为默认实现入口接受；后续 11.3 完成运维文档，11.4 删除 Python runtime 后仓库不再保留第二套生产入口。
