# LLM Proxy Node.js 重构 Todo 清单

## 1. 使用说明

本清单是[Node.js 重构计划](./nodejs-refactoring-plan.md)的执行版。建议按阶段顺序完成；同一阶段内，标记为“可并行”的工作可分支进行。

标记约定：

- `[ ]` 未开始
- `[-]` 进行中
- `[x]` 已完成
- `P0` 阻断正式切换
- `P1` 正式发布前应完成
- `P2` parity 后优化，可另开版本

每个任务完成时至少补充：实现 PR/commit、测试名称、行为差异、数据迁移影响。

## 2. 里程碑

- [x] M0：行为基线和 ADR 完成
- [x] M1：Node 工程和纯逻辑 parity 完成
- [x] M2：SQLite、TaskMatcher、Logger parity 完成
- [x] M3：单代理和多代理数据面完成
- [x] M4：管理 API 和现有 UI 完成
- [ ] M5：CLI、Windows 托盘和发布流水线完成
- [ ] M6：数据迁移演练、正式切换和 Python 清理完成

## 3. 阶段 0：基线与决策

### 3.1 基线资产

- [x] `BASE-001` P0 记录当前 commit、Python 版本和 66 项测试结果。
  - 验收：仓库内有可复现命令和测试报告。
- [x] `BASE-002` P0 将现有四张 UI 截图登记为视觉基线。
  - 验收：记录 viewport、浏览器、语言和页面状态。
- [x] `BASE-003` P0 创建脱敏的真实 `proxies.json` fixture。
  - 验收：包含多 pair、多 target、默认目标、disabled target、API key 占位、Header、strip/inject、不同 log root。
- [x] `BASE-004` P0 创建脱敏的真实 `traffic.db` fixture。
  - 验收：包含 responses/chat/messages/completions、pending、SSE、tool call、response/context link、多 task。
- [x] `BASE-005` P0 建立 fixture 动态值规范化规则。
  - 验收：UUID、时间、端口、临时路径不会导致跨语言比较误报。

### 3.2 补齐 Python 契约测试

- [x] `BASE-010` P0 测试 GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD。
- [x] `BASE-011` P0 测试自定义 Header 覆盖、API Key 优先级和重复 Header。
- [x] `BASE-012` P0 测试上游 502、timeout、响应开始后断开。
- [x] `BASE-013` P0 测试多 target 使用不同 log root。
- [x] `BASE-014` P0 测试 config invalid JSON、invalid shape、port conflict。
- [x] `BASE-015` P0 测试管理 API 400/404 和非法 query。
- [x] `BASE-016` P0 测试所有 stream summary 字段和未知事件。
- [x] `BASE-017` P0 测试 task 24 小时边界、user message 前缀和 context key 优先级。
- [x] `BASE-018` P1 测试导出全部任务与 cleanup 三种策略。
- [x] `BASE-019` P1 记录当前 incoming chunked request 的实际限制，不把失败误当 parity 要求。

### 3.3 ADR

- [x] `ADR-001` P0 选择 `better-sqlite3` 或 `node:sqlite`。
  - 决策要点：FTS5、Windows/Electron 打包、Node 24 稳定性、事务 API、性能、原生模块风险。
- [x] `ADR-002` P0 决定是否新增 `original_request_body`。
- [x] `ADR-003` P0 决定日志 body 内存上限和超限策略。
- [x] `ADR-004` P0 决定 config apply 失败时整体回滚还是部分成功。
- [x] `ADR-005` P0 决定 client abort 后的 upstream/log 行为。
- [x] `ADR-006` P0 决定 Windows 产物：portable、installer、CLI zip。
- [x] `ADR-007` P1 决定是否继续强制 `Connection: close`。
- [x] `ADR-008` P1 决定 LIKE 搜索或真正 FTS MATCH。

## 4. 阶段 1：Node 工程骨架

### 4.1 工程配置

- [x] `BOOT-001` P0 创建 `package.json`，声明 Node 24 engine。
- [x] `BOOT-002` P0 生成并提交 lockfile。
- [x] `BOOT-003` P0 创建 strict ESM `tsconfig.json`。
- [x] `BOOT-004` P0 配置 ESLint 和 Prettier。
- [x] `BOOT-005` P0 配置 Vitest 和 coverage。
- [x] `BOOT-006` P0 添加 `.node-version` 或 `.nvmrc`。
- [x] `BOOT-007` P0 添加 scripts：`dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`, `check`。
- [x] `BOOT-008` P0 创建目标目录和 barrel export 规则。
- [x] `BOOT-009` P1 设置 source map 和 production stack trace。

### 4.2 基础设施

- [x] `BOOT-010` P0 创建应用入口和空 lifecycle。
- [x] `BOOT-011` P0 创建统一错误类型和 error-to-HTTP 映射。
- [x] `BOOT-012` P0 创建时间、ID、JSON、path helper。
- [x] `BOOT-013` P0 创建幂等 shutdown coordinator。
- [x] `BOOT-014` P1 创建结构化内部日志接口，敏感字段默认不输出。
- [x] `BOOT-015` P1 添加 health route。

### 4.3 CI

- [x] `CI-001` P0 在 GitHub Actions 增加 Node 24 job。
- [x] `CI-002` P0 执行 `npm ci`、typecheck、lint、test、build。
- [x] `CI-003` P0 暂时保留 Python CI 作为 parity gate。
- [x] `CI-004` P1 缓存 npm 依赖。
- [x] `CI-005` P1 上传 coverage/test report artifact。

## 5. 阶段 2：配置与类型

### 5.1 类型和校验

- [x] `CFG-001` P0 定义 `ModelMapping` schema/type。
- [x] `CFG-002` P0 定义 `TargetConfig` schema/type。
- [x] `CFG-003` P0 定义 `ProxyPair` schema/type。
- [x] `CFG-004` P0 定义 public/runtime config 类型。
- [x] `CFG-005` P0 校验 URL、port、timeout、header line、inject JSON object。
- [x] `CFG-006` P1 检测重复 pair ID 和 target ID。

### 5.2 默认值和规范化

- [x] `CFG-010` P0 移植 default pair/target。
- [x] `CFG-011` P0 保证至少一个 target。
- [x] `CFG-012` P0 修正不存在的 default target ID。
- [x] `CFG-013` P0 规范化 model mappings，保留同名映射。
- [x] `CFG-014` P0 保留空 `log_root` 禁用日志语义。
- [x] `CFG-015` P0 兼容 dict/string 类型 inject 配置。
- [x] `CFG-016` P1 对非法配置返回字段级错误。

### 5.3 文件 repository

- [x] `CFG-020` P0 读取文件不存在时返回默认 pair。
- [x] `CFG-021` P0 区分 invalid JSON 和 invalid schema。
- [x] `CFG-022` P0 实现同目录临时文件写入。
- [x] `CFG-023` P0 flush/fsync 后 rename/replace。
- [x] `CFG-024` P0 失败时删除临时文件且保留旧文件。
- [x] `CFG-025` P0 Windows 文件替换集成测试。
- [x] `CFG-026` P0 Python -> Node -> Python round-trip。
- [x] `CFG-027` P1 首次 Node 保存前创建配置备份。

## 6. 阶段 3：纯逻辑模块

### 6.1 Target 和 Routing

- [x] `PURE-001` P0 移植 target URL parser。
- [x] `PURE-002` P0 移植 base path join 全部边界。
- [x] `PURE-003` P0 移植 top-level model 提取。
- [x] `PURE-004` P0 移植 target selection 顺序。
- [x] `PURE-005` P0 跳过 disabled non-default target。
- [x] `PURE-006` P0 default target 永远兜底。
- [x] `PURE-007` P0 移植 model rewrite，保留非 JSON。

### 6.2 Request transform

- [x] `PURE-010` P0 移植 strip field parser。
- [x] `PURE-011` P0 移植 inject JSON object parser。
- [x] `PURE-012` P0 先 strip 后 inject。
- [x] `PURE-013` P0 非 object JSON 不变。
- [x] `PURE-014` P0 记录排序后的 stripped/injected field names。

### 6.3 Header

- [x] `PURE-020` P0 定义 hop-by-hop Header 集合。
- [x] `PURE-021` P0 解析 `Name: value` override。
- [x] `PURE-022` P0 保留多值 Header 表达。
- [x] `PURE-023` P0 实现 override 和 API Key 优先级测试。
- [x] `PURE-024` P0 实现 Host 和 X-Forwarded-* helper。

### 6.4 Payload 与 redaction

- [x] `PURE-030` P0 bytes/text/JSON payload 转换。
- [x] `PURE-031` P0 非 JSON 文本包装 `{text,size_bytes}`。
- [x] `PURE-032` P0 Header redaction。
- [x] `PURE-033` P0 JSON key 递归 redaction。
- [x] `PURE-034` P0 redaction 不改变实际转发对象。
- [x] `PURE-035` P1 Unicode 和无效 UTF-8 fixture。

### 6.5 Record analysis

- [x] `PURE-040` P0 endpoint kind 和 display endpoint。
- [x] `PURE-041` P0 Responses message count。
- [x] `PURE-042` P0 Messages message count。
- [x] `PURE-043` P0 Chat/Completions message count。
- [x] `PURE-044` P0 usage/total token 读取。
- [x] `PURE-045` P0 stable JSON SHA-256 fingerprint。
- [x] `PURE-046` P0 Chat fingerprints。
- [x] `PURE-047` P0 Responses fingerprints。
- [x] `PURE-048` P0 Claude fingerprints。
- [x] `PURE-049` P0 固定 Codex context message 排除。
- [x] `PURE-050` P0 response ID 提取。

### 6.6 Stream summary

- [x] `SSE-001` P0 parse `data:` JSON 和 `[DONE]`。
- [x] `SSE-002` P0 非 JSON data 回退普通文本。
- [x] `SSE-003` P0 Responses output text/reasoning。
- [x] `SSE-004` P0 Responses function call delta/done。
- [x] `SSE-005` P0 Responses web search events。
- [x] `SSE-006` P0 Responses compact metadata/usage/status。
- [x] `SSE-007` P0 Chat content/reasoning/finish/usage。
- [x] `SSE-008` P0 Chat tool call delta merge 和 arguments JSON。
- [x] `SSE-009` P0 Claude text/thinking/tool_use/input delta。
- [x] `SSE-010` P0 Claude stop reason/usage/message metadata。
- [x] `SSE-011` P0 unknown event 行为。
- [x] `SSE-012` P0 summary truncation 深度/长度/数量。
- [x] `SSE-013` P1 增量 `addChunk/finalize` API，避免结束后全量二次解析。

## 7. 阶段 4：SQLite 与 Repository

### 7.1 数据库初始化

- [x] `DB-001` P0 实现 log root -> `traffic.db`。
- [x] `DB-002` P0 创建缺失目录。
- [x] `DB-003` P0 设置 WAL、foreign keys、busy timeout、synchronous。
- [x] `DB-004` P0 实现 migration runner 和 schema version 读取。
- [x] `DB-005` P0 实现 v1 schema 创建。
- [x] `DB-006` P0 验证 FTS5 可用。
- [x] `DB-007` P0 migration 事务和失败回滚测试。
- [x] `DB-008` P1 SQLite checkpoint/backup helper。

### 7.2 Task repository

- [x] `DB-010` P0 upsert task。
- [x] `DB-011` P0 decode JSON/boolean fields。
- [x] `DB-012` P0 get task。
- [x] `DB-013` P0 recent non-pending tasks。
- [x] `DB-014` P0 task list query/pagination/sort。

### 7.3 Record repository

- [x] `DB-020` P0 upsert record。
- [x] `DB-021` P0 update existing pending record。
- [x] `DB-022` P0 get record/task ID。
- [x] `DB-023` P0 next sequence 和 record count。
- [x] `DB-024` P0 task records query/pagination/order。
- [x] `DB-025` P0 unique task/sequence 冲突测试。

### 7.4 Link/Search/Delete

- [x] `DB-030` P0 response link upsert/query。
- [x] `DB-031` P0 context link upsert/query。
- [x] `DB-032` P0 record search text 生成。
- [x] `DB-033` P0 多 term AND 搜索。
- [x] `DB-034` P0 `%`, `_`, `\\` 字面转义。
- [x] `DB-035` P0 ISO 和本地时间搜索。
- [x] `DB-036` P0 task delete cascade。
- [x] `DB-037` P0 清理 search/link 记录。

### 7.5 跨语言兼容

- [x] `DB-040` P0 Python DB -> Node read。
- [x] `DB-041` P0 Python DB -> Node write -> Python read。
- [x] `DB-042` P0 Node DB -> Python read。
- [x] `DB-043` P0 多 connection 并发写测试。
- [x] `DB-044` P1 Windows packaged DB smoke test。

## 8. 阶段 5：TaskMatcher 和日志服务

### 8.1 TaskMatcher

- [x] `TASK-001` P0 定义 TaskAssignment。
- [x] `TASK-002` P0 pending task 创建和提升。
- [x] `TASK-003` P0 同 request ID 保持 task/sequence。
- [x] `TASK-004` P0 Responses previous_response_id link。
- [x] `TASK-005` P0 conversation/thread/session/prompt cache context keys。
- [x] `TASK-006` P0 static boundary 比较。
- [x] `TASK-007` P0 model/path/kind 不同创建新 task。
- [x] `TASK-008` P0 24 小时最近任务窗口。
- [x] `TASK-009` P0 user message sequence prefix。
- [x] `TASK-010` P0 continuation evidence。
- [x] `TASK-011` P0 request_count/last_seen/last_response 更新。
- [x] `TASK-012` P0 strategy version 保持 4。

### 8.2 TrafficLogService

- [x] `LOG-001` P0 redaction 可选执行。
- [x] `LOG-002` P0 task/record/link 单事务写入。
- [x] `LOG-003` P0 per-log-root 串行写队列。
- [x] `LOG-004` P0 disabled logger no-op。
- [x] `LOG-005` P0 target URL、message/token summary row mapping。
- [x] `LOG-006` P0 original/upstream body 按 ADR 实现。
- [x] `LOG-007` P0 日志错误不破坏代理响应。
- [x] `LOG-008` P1 写队列关闭和 drain。
- [x] `LOG-009` P1 日志失败内部告警脱敏。

## 9. 阶段 6：HTTP 代理数据面

### 9.1 Listener 和请求生命周期

- [x] `HTTP-001` P0 创建原生 HTTP listener。
- [x] `HTTP-002` P0 生成 request ID 和时间。
- [x] `HTTP-003` P0 单目标早期 received logging。
- [x] `HTTP-004` P0 多目标读取 body 后 selected logger。
- [x] `HTTP-005` P0 pending/final logging。
- [x] `HTTP-006` P0 active request registry。

### 9.2 请求读取与变换

- [x] `HTTP-010` P0 Content-Length body。
- [x] `HTTP-011` P0 incoming chunked body。
- [x] `HTTP-012` P0 空 body 和 HEAD。
- [x] `HTTP-013` P0 model route/rewrite/strip/inject 全链路。
- [x] `HTTP-014` P0 重新计算 Content-Length。
- [x] `HTTP-015` P1 body 大小/落盘策略。

### 9.3 上游连接

- [x] `HTTP-020` P0 HTTP target。
- [x] `HTTP-021` P0 HTTPS target。
- [x] `HTTP-022` P0 base path/query。
- [x] `HTTP-023` P0 Header 过滤和覆盖。
- [x] `HTTP-024` P0 timeout。
- [x] `HTTP-025` P0 AbortController 连接 client/upstream/shutdown。
- [x] `HTTP-026` P1 TLS 错误和 DNS 错误测试。

### 9.4 响应流

- [x] `HTTP-030` P0 状态和 reason phrase。
- [x] `HTTP-031` P0 过滤 response hop-by-hop/Content-Length。
- [x] `HTTP-032` P0 parity 阶段发送 `Connection: close`。
- [x] `HTTP-033` P0 SSE 第一行立即转发。
- [x] `HTTP-034` P0 普通 response chunk/backpressure。
- [x] `HTTP-035` P0 HEAD 不发 body。
- [x] `HTTP-036` P0 Header 前错误返回 502。
- [x] `HTTP-037` P0 Header 后错误只关闭流并写日志。
- [x] `HTTP-038` P0 response log tee/summary。
- [x] `HTTP-039` P1 超大/无限流内存保护。

### 9.5 数据面测试

- [x] `HTTP-040` P0 两上游模型路由集成测试。
- [x] `HTTP-041` P0 rewrite + strip + inject 集成测试。
- [x] `HTTP-042` P0 SSE 慢速两段测试。
- [x] `HTTP-043` P0 chunked request/response 测试。
- [x] `HTTP-044` P0 duplicate Header/Set-Cookie 测试。
- [x] `HTTP-045` P0 client abort/upstream abort 测试。
- [x] `HTTP-046` P0 10+ 并发请求测试。
- [x] `HTTP-047` P1 binary body/response 测试。
- [x] `HTTP-048` P1 latency 和 memory benchmark。

## 10. 阶段 7：多代理管理

- [x] `MGR-001` P0 实现 runtime state machine。
- [x] `MGR-002` P0 start pair。
- [x] `MGR-003` P0 stop pair。
- [x] `MGR-004` P0 restart pair。
- [x] `MGR-005` P0 start enabled / stop all。
- [x] `MGR-006` P0 public pair running/actual port。
- [x] `MGR-007` P0 config diff：add/update/remove。
- [x] `MGR-008` P0 监听端口冲突检测。
- [x] `MGR-009` P0 一个 pair 失败不影响其他 pair。
- [x] `MGR-010` P0 apply failure 按 ADR 处理。
- [x] `MGR-011` P0 graceful shutdown timeout。
- [x] `MGR-012` P0 关闭后 socket/timer/DB 无泄漏测试。

## 11. 阶段 8：管理 API 和日志维护

### 11.1 Admin server

- [x] `API-001` P0 启动 Fastify control plane。
- [x] `API-002` P0 服务 index/CSS/JS。
- [x] `API-003` P0 统一 JSON error DTO。
- [x] `API-004` P0 请求/响应 schema 和日志脱敏。
- [x] `API-005` P1 health endpoint。

### 11.2 Pair API

- [x] `API-010` P0 GET `/api/pairs`。
- [x] `API-011` P0 PUT `/api/pairs`。
- [x] `API-012` P0 POST `/api/pairs/:id/enabled`。
- [x] `API-013` P0 400/404/port conflict 测试。

### 11.3 Log query API

- [x] `API-020` P0 GET `/api/logs` query/limit/offset。
- [x] `API-021` P0 多 log root 合并排序分页。
- [x] `API-022` P0 GET task group logs。
- [x] `API-023` P0 GET record detail/meta。
- [x] `API-024` P0 pending detail refresh 数据。
- [x] `API-025` P1 task 内 200 条限制是否保留的决策/实现。

### 11.4 Export/Cleanup

- [x] `API-030` P0 task/record 目录名生成。
- [x] `API-031` P0 task index Markdown。
- [x] `API-032` P0 record summary Markdown。
- [x] `API-033` P0 request/response JSON entry。
- [x] `API-034` P0 GET export 流式 ZIP。
- [x] `API-035` P0 selected group cleanup。
- [x] `API-036` P0 older-than cleanup。
- [x] `API-037` P0 keep-latest cleanup。
- [x] `API-038` P0 cleanup 后搜索和 links 一致。

## 12. 阶段 9：UI 与浏览器测试

### 12.1 静态 UI 迁移

- [x] `UI-001` P0 复制 index.html。
- [x] `UI-002` P0 复制 app.css。
- [x] `UI-003` P0 复制 app.js。
- [x] `UI-004` P0 替换建议 strip fields 注入方式。
- [x] `UI-005` P0 保持中文/英文和 localStorage key。
- [x] `UI-006` P0 保持所有 DOM ID/data attribute 或同步更新测试。

### 12.2 Proxy 页面 E2E

- [x] `UI-010` P0 load/render pair。
- [x] `UI-011` P0 add/delete pair。
- [x] `UI-012` P0 add/delete target，至少保留一个。
- [x] `UI-013` P0 default target 与 enabled 规则。
- [x] `UI-014` P0 API Key 显隐/复制。
- [x] `UI-015` P0 More settings。
- [x] `UI-016` P0 save 和 enable toggle。
- [x] `UI-017` P0 语言切换不丢表单值。
- [x] `UI-018` P1 target 横向滚动位置。

### 12.3 History 页面 E2E

- [x] `UI-020` P0 search 180 ms debounce。
- [x] `UI-021` P0 refresh/auto refresh。
- [x] `UI-022` P0 group lazy expand。
- [x] `UI-023` P0 load more。
- [x] `UI-024` P0 selected task cleanup。
- [x] `UI-025` P0 ZIP download。
- [x] `UI-026` P0 record detail 和 pending refresh。
- [x] `UI-027` P0 JSON tree expand/collapse。
- [x] `UI-028` P0 wrap/format/copy/meta。
- [x] `UI-029` P0 row/column splitter drag。

### 12.4 视觉回归

- [x] `UI-030` P0 Proxy 中文截图 diff。
- [x] `UI-031` P0 Proxy 英文截图 diff。
- [x] `UI-032` P0 History 中文截图 diff。
- [x] `UI-033` P0 History 英文截图 diff。
- [x] `UI-034` P1 760 px 窄屏截图/交互。

## 13. 阶段 10：CLI、托盘和打包

### 13.1 CLI

- [x] `CLI-001` P0 实现 `--host`。
- [x] `CLI-002` P0 实现 `--port`。
- [x] `CLI-003` P0 实现 `--config-file`。
- [x] `CLI-004` P0 实现 `--log-root`。
- [x] `CLI-005` P0 实现 `--no-browser`。
- [x] `CLI-006` P0 实现全部 `LLM_PROXY_*` 环境变量。
- [x] `CLI-007` P0 默认延迟打开浏览器。
- [x] `CLI-008` P0 SIGINT/SIGTERM 优雅关闭。
- [x] `CLI-009` P1 输出路径和启动错误可读。

### 13.2 Electron Tray

- [x] `TRAY-001` P0 创建无可见窗口的 Electron main。
- [x] `TRAY-002` P0 创建 Tray 图标。
- [x] `TRAY-003` P0 Open Admin UI 菜单和默认动作。
- [x] `TRAY-004` P0 Exit 菜单等待 shutdown。
- [x] `TRAY-005` P0 `--open-on-start` 和环境变量。
- [x] `TRAY-006` P0 启动失败系统对话框。
- [x] `TRAY-007` P0 重复启动/端口占用行为。
- [x] `TRAY-008` P1 Windows 开机启动不在本次默认范围，确认不误加。

### 13.3 构建与发布

- [x] `PKG-001` P0 配置 electron-builder。
- [x] `PKG-002` P0 选择并生成 portable/installer。
- [x] `PKG-003` P0 打包静态 UI 和 SQLite native module。
- [x] `PKG-004` P0 artifact 启动 smoke test。
- [x] `PKG-005` P0 生成 SHA-256。
- [x] `PKG-006` P0 GitHub Actions 上传 artifact。
- [x] `PKG-007` P0 `v*` tag 发布 Release。
- [x] `PKG-008` P1 发布轻量 CLI zip。
- [ ] `PKG-009` P1 代码签名需求评估和文档。

## 14. 阶段 11：迁移、切换和清理

### 14.1 数据迁移演练

- [ ] `MIG-001` P0 对 config fixture 执行备份/读取/保存/回滚。
- [ ] `MIG-002` P0 对小型 DB 执行 migration/查询/写入/回滚。
- [ ] `MIG-003` P0 对含 WAL 的活跃 DB 执行 checkpoint/backup 演练。
- [ ] `MIG-004` P0 对大型 DB 记录耗时和磁盘需求。
- [ ] `MIG-005` P0 验证 task/record/link/search 数量和抽样内容。
- [ ] `MIG-006` P0 编写用户回滚步骤。

### 14.2 文档切换

- [ ] `DOC-001` P0 更新 README.md 为 Node 运行方式。
- [ ] `DOC-002` P0 更新 README.cn.md。
- [ ] `DOC-003` P0 更新安装、开发、测试、打包命令。
- [ ] `DOC-004` P0 更新项目结构。
- [ ] `DOC-005` P0 增加数据备份/迁移/回滚章节。
- [ ] `DOC-006` P0 增加 Node/Electron 故障排查。
- [ ] `DOC-007` P1 更新截图（只有必要时）。
- [ ] `DOC-008` P0 用 Node.js OpenAI SDK 示例替换 `examples/responses_client.py`，删除失效的 `--target-url` 说明。

### 14.3 删除 Python

- [ ] `CLEAN-001` P0 删除 `llm_proxy/` Python 包。
- [ ] `CLEAN-002` P0 删除旧 Python tests 或迁移后重命名 Node tests。
- [ ] `CLEAN-003` P0 删除 `pyproject.toml`。
- [ ] `CLEAN-004` P0 删除 `tray_launcher.py`。
- [ ] `CLEAN-005` P0 更新或删除旧 `run.bat`。
- [ ] `CLEAN-006` P0 删除 Python/PyInstaller CI job。
- [ ] `CLEAN-007` P0 `rg` 检查 README/workflow 中无陈旧 Python 命令。
- [ ] `CLEAN-008` P0 clean clone 只安装 Node 依赖即可开发和运行。

### 14.4 Release gate

- [ ] `REL-001` P0 所有 Node unit/integration/E2E 通过。
- [ ] `REL-002` P0 parity fixture 通过。
- [ ] `REL-003` P0 Windows artifact smoke test 通过。
- [ ] `REL-004` P0 真实数据副本演练通过。
- [ ] `REL-005` P0 无 P0 bug。
- [ ] `REL-006` P0 release note 列出所有批准的行为差异。
- [ ] `REL-007` P0 发布 RC 并完成手工验收。
- [ ] `REL-008` P0 正式 tag、artifact、checksum、回滚文档齐全。

## 15. P2 后续优化池

这些项目不应阻塞 Python -> Node.js 的功能等价切换：

- [ ] `OPT-001` P2 管理端鉴权和 CSRF 防护。
- [ ] `OPT-002` P2 API Key 系统密钥库/加密存储。
- [ ] `OPT-003` P2 HTTP keep-alive 与连接池。
- [ ] `OPT-004` P2 HTTP/2 上游支持。
- [ ] `OPT-005` P2 真正 FTS MATCH 与高级搜索语法。
- [ ] `OPT-006` P2 task 内 record 分页 UI。
- [ ] `OPT-007` P2 仅导出选中 task。
- [ ] `OPT-008` P2 自动 retention 配置和数据库 vacuum/checkpoint。
- [ ] `OPT-009` P2 结构化 metrics 和诊断页面。
- [ ] `OPT-010` P2 前端组件化/框架化评估。
- [ ] `OPT-011` P2 代理端访问控制和速率限制。
- [ ] `OPT-012` P2 WebSocket/CONNECT 支持评估。

## 16. 最终验收清单

- [ ] 用户可以用 Node CLI 启动管理 UI。
- [ ] 用户可以用 Windows Tray 启动、打开 UI、退出。
- [ ] 所有现有 Proxy 页面字段可编辑、保存并立即生效。
- [ ] 多 pair、多 target、default/disabled target 正常。
- [ ] OpenAI Responses、Chat Completions、Completions、Claude Messages 正常代理。
- [ ] 模型路由、改写、strip、inject、Header、API Key 正常。
- [ ] SSE 在上游完成前持续到达客户端。
- [ ] SQLite 历史、task grouping、搜索、分页、详情正常。
- [ ] stream summary、消息数、Token 数正常。
- [ ] redaction 正常且不影响真实转发。
- [ ] ZIP 导出和三种 cleanup 正常。
- [ ] 现有配置和数据库可读取。
- [ ] UI 中英文、布局、颜色、卡片、JSON 控件、splitter 与基线一致。
- [ ] 自动刷新 pending 请求并更新为 finished。
- [ ] 应用关闭后管理端和全部代理端口释放。
- [ ] 仓库不再要求 Python。
