# Node.js 正式版重构 TODO

本文档是 [`nodejs_refactor_design.md`](./nodejs_refactor_design.md) 的执行清单。任务按依赖顺序排列，每个编号项应形成一个小而完整的变更，具备明确验收结果后再进入下一项。

## 1. 执行规则

- 默认不兼容 Python 内部 API；只保留已确认的产品行为。
- 不在同一任务中同时重写代理核心、数据库和 UI。
- 每个任务开始前确认依赖项已经完成。
- 每个任务至少包含实现、自动测试和必要文档更新。
- 每完成一个编号任务，单独提交代码，并在进度表记录 commit 和验证命令。
- 发现新的必要工作时先补充 TODO，再实施，避免隐藏范围增长。
- 重构期间 Python `main` 保持可运行，直到 Node 版本达到切换门槛。
- 不允许长期双写 Python 和 Node 数据；对照运行只用于测试。
- 遇到协议行为差异时，先补黑盒测试，再决定新行为。
- 所有性能结论必须记录命令、环境和数据集。

状态取值：`未开始`、`进行中`、`阻塞`、`已完成`、`已取消`。

## 2. 全局完成标准

每个代码任务应按适用范围通过：

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

涉及 Python 基线或迁移期代码时还需要：

```powershell
python -m unittest discover -s tests
python -m ruff check .
python -m mypy
```

涉及发布产物时必须在干净 CI runner 上执行 smoke test，不能只在开发机验证。

## 3. 进度记录

| 任务 | 状态 | 提交 | 验证/备注 |
| --- | --- | --- | --- |
| 0.1 产品决策与 ADR | 已完成 | 本任务提交 | 4 份 ADR；`python -m pytest` |
| 0.2 Python 行为清单 | 已完成 | 本任务提交 | 代码与 66 项 Python 测试交叉核对 |
| 0.3 对照 fixture | 已完成 | 本任务提交 | `python scripts/export_python_fixtures.py --check`; 69 项测试 |
| 0.4 协议基准测试工具 | 已完成 | 本任务提交 | 固定配置、JSON report、Python v0.2.0 基线；72 项测试 |
| 1.1 pnpm workspace | 已完成 | 本任务提交 | Node 24.18.0 / pnpm 11.11.0；workspace install/test/build |
| 1.2 TypeScript 与代码质量 | 已完成 | 本任务提交 | lint/format/typecheck/test/coverage/build；server→web 边界 |
| 1.3 Node CI 基线 | 已完成 | 本任务提交 | YAML 校验；本地 `CI=true` 生成 JUnit/coverage |
| 1.4 contracts 包 | 已完成 | 本任务提交 | 10 项 Node 测试；100% coverage；server/web 导入验证 |
| 1.5 server CLI 骨架 | 已完成 | 本任务提交 | 21 项 Node 测试；build `--help`/`--version` smoke |
| 2.1 配置 schema | 已完成 | 本任务提交 | 26 项 Node 测试；immutable snapshot；字段路径错误 |
| 2.2 配置仓库与原子写入 | 已完成 | 本任务提交 | 34 项 Node 测试；atomic fsync/rename；失败恢复 |
| 2.3 URL 与 header 领域逻辑 | 已完成 | 本任务提交 | 41 项 Node 测试；语言无关 fixture；header 注入拒绝 |
| 2.4 路由与 request 变换 | 已完成 | 本任务提交 | 51 项 Node 测试；fixture 驱动；无效 body 字节保持 |
| 2.5 脱敏与 payload 表示 | 已完成 | 本任务提交 | 57 项 Node 测试；有界清洗；Worker 前强制脱敏 |
| 2.6 endpoint 与 record 摘要 | 已完成 | 本任务提交 | 66 项 Node 测试；有界 fingerprint；恶意 payload 容错 |
| 3.1 SSE 增量解析器 | 已完成 | 本任务提交 | 71 项 Node 测试；随机/逐字节 chunk；有界诊断 |
| 3.2 OpenAI 流式摘要 | 已完成 | 本任务提交 | 76 项 Node 测试；三类 fixture；全局容量限制 |
| 3.3 Claude 流式摘要 | 已完成 | 本任务提交 | 80 项 Node 测试；乱序/缺失容错；共享容量限制 |
| 3.4 有界 capture tap | 已完成 | 本任务提交 | 85 项 Node 测试；100 MiB 流；旁路失败隔离 |
| 4.1 migration 基础设施 | 已完成 | 本任务提交 | 91 项 Node 测试；Python v1 兼容；事务回滚 |
| 4.2 SQLite repository | 已完成 | 本任务提交 | 97 项 Node 测试；事务/FTS/级联；10 万行计划 |
| 4.3 Worker RPC | 已完成 | 本任务提交 | 103 项 Node 测试；transferable；fatal/restart/registry |
| 4.4 有界存储队列 | 已完成 | 本任务提交 | 108 项 Node 测试；10 万 producer；typed degradation |
| 4.5 任务匹配迁移 | 已完成 | 本任务提交 | 112 项 Node 测试；fixture 全通过；24h/50 候选上限 |
| 4.6 traffic event 写入事务 | 已完成 | 本任务提交 | 116 项 Node 测试；72 项 Python 测试；原子写入与幂等重试 |
| 4.7 查询、清理和维护 | 已完成 | 本任务提交 | 121 项 Node 测试；多库稳定分页；批次 retention 与维护 RPC |
| 4.8 流式 ZIP 导出 | 已完成 | 本任务提交 | 124 项 Node 测试；5,000 records 有界导出；取消与并发限制 |
| 5.1 单 proxy HTTP 骨架 | 已完成 | 本任务提交 | 127 项 Node 测试；真实 upstream GET/POST/HEAD；ephemeral port |
| 5.2 request body 与路由 | 已完成 | 本任务提交 | 131 项 Node 测试；chunked/limit/路由改写；非 JSON 流式直通 |
| 5.3 header 转发规则 | 已完成 | 本任务提交 | 132 项 Node 测试；raw 重复 header；双向 hop-by-hop 过滤 |
| 5.4 response 管线与背压 | 未开始 |  |  |
| 5.5 取消和超时 | 未开始 |  |  |
| 5.6 traffic 生命周期接入 | 未开始 |  |  |
| 5.7 连接池和资源释放 | 未开始 |  |  |
| 5.8 协议故障集成测试 | 未开始 |  |  |
| 6.1 RuntimeManager | 未开始 |  |  |
| 6.2 原子配置替换 | 未开始 |  |  |
| 6.3 优雅启动和关闭 | 未开始 |  |  |
| 6.4 runtime 故障恢复 | 未开始 |  |  |
| 7.1 Fastify 管理面骨架 | 未开始 |  |  |
| 7.2 proxy 管理 API | 未开始 |  |  |
| 7.3 task/log 管理 API | 未开始 |  |  |
| 7.4 统一错误与安全边界 | 未开始 |  |  |
| 7.5 静态资源和浏览器启动 | 未开始 |  |  |
| 8.1 现有 UI contract 迁移 | 未开始 |  |  |
| 8.2 Web TypeScript 构建 | 未开始 |  |  |
| 8.3 secret 和错误状态 | 未开始 |  |  |
| 8.4 浏览器关键流程测试 | 未开始 |  |  |
| 9.1 结构化运行日志 | 未开始 |  |  |
| 9.2 health 和内部指标 | 未开始 |  |  |
| 9.3 安全加固 | 未开始 |  |  |
| 9.4 容量和 retention | 未开始 |  |  |
| 9.5 性能基线与剖析 | 未开始 |  |  |
| 9.6 故障注入测试 | 未开始 |  |  |
| 10.1 CLI/npm 产物 | 未开始 |  |  |
| 10.2 Windows 便携包 | 未开始 |  |  |
| 10.3 托盘方案 spike | 未开始 |  |  |
| 10.4 Release pipeline | 未开始 |  |  |
| 11.1 数据迁移决策与工具 | 未开始 |  |  |
| 11.2 Node 主实现验收 | 未开始 |  |  |
| 11.3 文档和运维手册 | 未开始 |  |  |
| 11.4 删除 Python runtime | 未开始 |  |  |
| 11.5 最终发布候选验证 | 未开始 |  |  |

## 4. 阶段 0：决策与行为基线

### 0.1 产品决策与 ADR

依赖：无。

- [x] 确认正式支持的 OS 和 CPU 架构。
- [x] 确认是否必须提供 Windows 单文件 exe。
- [x] 确认是否迁移现有 `traffic.db` 和 `proxies.json`。
- [x] 确认 admin 是否允许非 loopback 访问。
- [x] 确认 request/response 默认捕获上限和 retention 默认值。
- [x] 确认 UI 第一阶段复用现状，还是同期引入框架。
- [x] 为 SQLite driver/Worker、代理 HTTP API、桌面外壳分别建立 ADR。
- [x] ADR 写清候选方案、决策、原因和重新评估条件。

验收：设计文档中列出的所有产品决策都有明确答案，或有负责人和最晚决策阶段。

### 0.2 Python 行为清单

依赖：0.1。

- [x] 列出当前公开 CLI 参数、默认路径和环境变量。
- [x] 列出配置字段、默认值和跨字段约束。
- [x] 列出管理 API request/response 示例。
- [x] 列出代理 method、path、header、路由和 body 变换规则。
- [x] 列出 traffic record 状态和 SQLite 字段语义。
- [x] 列出任务匹配策略和支持的 endpoint。
- [x] 标记每项为“必须保留”“允许改变”或“明确删除”。
- [x] 把已知原型缺陷列为禁止复制的行为。

验收：行为清单经过代码和现有 66 项测试交叉核对，不把内部函数签名当成 contract。

### 0.3 对照 fixture

依赖：0.2。

- [x] 建立语言无关的 JSON/binary fixture 目录。
- [x] 从 Python 测试提取 URL 拼接、路由、改写和脱敏样本。
- [x] 提取 OpenAI Responses/Chat/Completions SSE 样本。
- [x] 提取 Claude Messages SSE 样本。
- [x] 提取任务匹配输入和期望 assignment。
- [x] 保存重复 header、gzip、无效 JSON 和非 UTF-8 body 样本。
- [x] 为 fixture 增加 schema 和说明。
- [x] 确保预期输出不是由待测 Node 实现动态生成。

验收：Python fixture exporter 可重复运行，fixture diff 稳定；Node 测试可以直接读取。

### 0.4 协议基准测试工具

依赖：0.2。

- [x] 编写可配置的本地 upstream fixture server。
- [x] 支持固定长度、chunked、SSE、延迟、断流和 malformed response。
- [x] 编写客户端测试工具，测首字节、首 SSE event、总耗时和接收 bytes。
- [x] 支持慢速消费和中途断开。
- [x] 记录 Python 基线，但不把原型性能设为最低目标。
- [x] 固定 benchmark 配置和结果输出格式。

验收：同一命令可针对任意 base URL 执行，输出机器可读 JSON 报告。

## 5. 阶段 1：Node 工程基线

### 1.1 pnpm workspace

依赖：0.1。

- [x] 添加根 `package.json`，声明 `packageManager` 和 Node engines。
- [x] 添加 `pnpm-workspace.yaml`。
- [x] 创建 `apps/server`、`apps/web`、`packages/contracts`、`packages/test-fixtures`。
- [x] 添加 `.nvmrc` 或 `.node-version`，固定 Node 24。
- [x] 创建最小 build/test scripts。
- [x] 提交 `pnpm-lock.yaml`。
- [x] 配置 `.gitignore`，不忽略现有 Python 必需文件。

验收：全新 checkout 执行 `corepack enable`、`pnpm install --frozen-lockfile`、`pnpm build` 成功。

### 1.2 TypeScript 与代码质量

依赖：1.1。

- [x] 添加严格 `tsconfig.base.json`。
- [x] 配置 ESLint 与 TypeScript-aware rules。
- [x] 配置 Prettier，或在 ADR 中决定统一使用 Biome。
- [x] 配置 Vitest 和 coverage。
- [x] 配置 import 边界，阻止 server 反向依赖 web。
- [x] 添加未使用变量、floating promise、unsafe any 等规则。
- [x] 为 Windows/Unix 换行和 UTF-8 添加 EditorConfig。

验收：故意添加类型错误、未 await Promise 和格式错误时，对应命令会失败。

### 1.3 Node CI 基线

依赖：1.1、1.2。

- [x] 新增 Node CI workflow。
- [x] Linux 执行 install、lint、format、typecheck、test、build。
- [x] Windows 至少执行 install、test、build。
- [x] 使用 pnpm store cache，并以 lockfile 为 key。
- [x] 配置 workflow concurrency，取消同分支旧任务。
- [x] 上传测试报告和 coverage artifact。
- [x] Python CI 在迁移期继续运行。

验收：CI 在 Linux/Windows 均通过；任一质量门槛失败会阻止合并。

### 1.4 contracts 包

依赖：1.2、0.2。

- [x] 定义通用 ID、timestamp、分页和 error schema。
- [x] 定义配置 v1 schema。
- [x] 定义 proxy public DTO，排除 secret。
- [x] 定义 task list、record list、record detail DTO。
- [x] 定义 storage Worker message schema。
- [x] 从 schema 推导 TypeScript 类型。
- [x] 增加有效和无效输入测试。
- [x] 保证 package 同时可供 server 和 web 使用。

验收：contract round-trip 测试通过，无重复手写 DTO interface。

### 1.5 server CLI 骨架

依赖：1.1、1.2、1.4。

- [x] 创建 `main()` composition root。
- [x] 实现最小 CLI 参数解析和 `--help`、`--version`。
- [x] 定义 process exit code。
- [x] 添加 abort signal 和 shutdown hook 骨架。
- [x] 输出机器可识别的 ready/error 日志。
- [x] 避免 import 时产生监听端口等副作用。

验收：CLI 可启动、响应信号并退出；单元测试可调用 composition root 而不结束测试进程。

## 6. 阶段 2：配置与纯领域逻辑

### 2.1 配置 schema

依赖：1.4、0.3。

- [x] 定义 proxy、target、model mapping 和 timeout schema。
- [x] 定义 request/response capture limit。
- [x] 校验唯一 ID、default target、URL、port 和 timeout 范围。
- [x] 区分持久化配置与不可变 runtime snapshot。
- [x] 为默认配置建立 fixture。
- [x] 输出可定位到字段路径的错误。
- [x] 明确 unknown keys 是拒绝还是剥离，并测试。

验收：覆盖正常、边界和跨字段错误；所有 runtime 配置只来自 parse 后的值。

### 2.2 配置仓库与原子写入

依赖：2.1。

- [x] 实现配置文件大小限制和 JSON 读取。
- [x] 实现不存在文件时的默认配置。
- [x] 实现同目录临时文件、flush、原子 rename。
- [x] 保存失败时不破坏原文件。
- [x] 对 Windows rename/占用错误提供可诊断信息。
- [x] 限制配置文件权限。
- [x] 添加并发保存串行化。
- [x] 增加损坏 JSON、磁盘错误和中断写测试。

验收：故障注入下原配置始终可恢复；保存后重新读取结果通过 schema。

### 2.3 URL 与 header 领域逻辑

依赖：0.3、1.2。

- [x] 实现 target URL parse 和 path/query 拼接。
- [x] 实现固定 hop-by-hop header 删除。
- [x] 解析 `Connection` 动态 token 并删除对应 header。
- [x] 实现 Host 和 `X-Forwarded-*` 规则。
- [x] 实现 target header/API key 覆盖优先级。
- [x] 保留 header 多值和不可合并 header。
- [x] 对 header injection 和非法字符依赖 Node API 拒绝并测试。

验收：语言无关 fixture 全部通过，覆盖 IPv6、默认端口、base path 和重复 header。

### 2.4 路由与 request 变换

依赖：2.1、0.3。

- [x] 实现 request 顶层 model 提取。
- [x] 实现 enabled target 的有序匹配和 default fallback。
- [x] 实现 model 改写。
- [x] 实现顶层字段 strip/inject。
- [x] 明确 inject 与 model rewrite 的执行顺序。
- [x] 无效 JSON 和非 object JSON 原样处理。
- [x] 返回结构化 transform metadata 供日志使用。

验收：与已确认 Python 产品行为一致，且不接受 prototype 中的隐式类型转换。

### 2.5 脱敏与 payload 表示

依赖：1.4、0.3。

- [x] 定义 binary/text/JSON/truncated payload union。
- [x] 实现 request/response body 安全表示。
- [x] 实现大小和深度受限的 JSON 脱敏。
- [x] 实现大小写不敏感 header 脱敏。
- [x] 处理循环引用不可出现的边界和极深 JSON。
- [x] 确保 secret 在 enqueue 到 Worker 之前已被移除。

验收：fixture 通过；测试断言 API key 和常见 secret 不进入数据库消息。

### 2.6 endpoint 与 record 摘要

依赖：2.5、0.3。

- [x] 迁移 endpoint kind 判断。
- [x] 迁移 message count 和 token count 提取。
- [x] 迁移 request/response ID 和 context key 提取。
- [x] 迁移 fingerprint、boundary fingerprint 和 user message 摘要。
- [x] 所有递归/数组遍历设置最大深度和最大项数。
- [x] 为异常 payload 保证不抛出到代理管线。

验收：现有 record/task fixture 全部通过，恶意深层 JSON 测试在有限时间和内存内完成。

## 7. 阶段 3：流式解析与有界捕获

### 3.1 SSE 增量解析器

依赖：1.2、0.3。

- [x] 实现 bytes 到 UTF-8 增量 decode。
- [x] 支持 LF、CRLF、空行 event 分隔。
- [x] 支持多行 `data:`、`event:`、`id:` 和 comment。
- [x] 支持 event 跨 chunk、多个 event 同 chunk。
- [x] 设置单行、单 event 和 parser buffer 上限。
- [x] malformed event 产生诊断但不抛出到转发管线。
- [x] 增加随机 chunk boundary property test。

验收：对同一 SSE bytes 的任意合理 chunk 划分产生相同事件序列。

### 3.2 OpenAI 流式摘要

依赖：3.1、2.6、0.3。

- [x] 迁移 Responses API 文本、reasoning、tool call、usage 摘要。
- [x] 迁移 Chat/Completions delta 摘要。
- [x] 支持 `[DONE]` 和未知 event。
- [x] 设置文本、tool arguments、event 数和总摘要上限。
- [x] 保留 parser warning/truncated metadata。
- [x] 覆盖 web search 等特殊 event fixture。

验收：OpenAI fixture 输出稳定；超长 stream 内存不随总事件文本无界增长。

### 3.3 Claude 流式摘要

依赖：3.1、2.6、0.3。

- [x] 迁移 message start/delta/stop。
- [x] 迁移 text、thinking 和 tool use。
- [x] 迁移 input/output token usage。
- [x] 处理未知 content block 和乱序/缺失 event。
- [x] 应用与 OpenAI 相同的容量约束和诊断模型。

验收：Claude fixture 输出稳定，malformed stream 不影响原始 bytes 转发。

### 3.4 有界 capture tap

依赖：3.2、3.3。

- [x] 实现不修改原始 bytes 的 Transform/Tap。
- [x] 记录 observed bytes 和 captured bytes。
- [x] 达到 raw capture 上限后停止复制但继续统计。
- [x] SSE summarizer 可在 raw capture 截断后继续增量消费。
- [x] summarizer 慢或失败时不能阻塞主管线。
- [x] 添加 100 MiB 合成流内存测试。

验收：输出 bytes 与输入逐字节一致；捕获内存不超过配置上限加固定开销。

## 8. 阶段 4：SQLite Worker 与日志领域

### 4.1 migration 基础设施

依赖：1.5、0.1。

- [x] 确认 Node v1 schema 和当前 SQLite schema 的关系。
- [x] 创建顺序化 SQL migration 文件。
- [x] 实现 schema version 读取和事务 migration。
- [x] 拒绝比程序更新的未知 schema。
- [x] migration 失败时回滚并给出安全错误。
- [x] 验证 WAL、foreign keys、busy timeout、synchronous。
- [x] 添加空库、逐版本升级和损坏库测试。

验收：每个受支持的旧版本都能升级到最新；失败不会留下半迁移状态。

### 4.2 SQLite repository

依赖：4.1、1.4、2.6。

- [x] 实现 task/record/link/FTS upsert。
- [x] 实现 record 状态更新的单事务方法。
- [x] 实现 task/record list 和 detail 查询。
- [x] 实现 response/context lookup 和 recent task query。
- [x] 实现参数化搜索和 limit/offset 边界。
- [x] 实现级联删除和 FTS 同事务清理。
- [x] repository 返回 contract DTO，不暴露 driver 类型。

验收：repository 组件测试覆盖事务回滚、外键、FTS 和 10 万行基本查询计划。

### 4.3 Worker RPC

依赖：4.2、1.4。

- [x] Worker 独占 `better-sqlite3` connection。
- [x] 实现按规范化绝对 `log_root` 复用 Worker 的 registry 和引用计数。
- [x] 定义 request/response discriminated union。
- [x] 实现 request ID、Promise correlation 和 operation timeout。
- [x] 校验进出 Worker 的消息。
- [x] binary payload 使用 transferable，禁止 structured clone 复制第二份大 body。
- [x] 实现 start、ready、drain、close、fatal 生命周期。
- [x] 捕获 Worker exit/error 并拒绝 pending Promise。
- [x] 增加异常 statement、强制 exit 和 shutdown 测试。

验收：主线程测试可证明所有 SQLite 调用只发生在 Worker；相同 `log_root` 只创建一个 Worker；大 binary 消息转移所有权而不复制；Worker crash 不产生悬挂 Promise。

### 4.4 有界存储队列

依赖：4.3。

- [x] 限制 pending message count 和估算 bytes。
- [x] 对同一 request 合并可丢弃的中间状态。
- [x] final/error event 高于 pending update 优先级。
- [x] queue full 时返回 typed degraded result。
- [x] 记录 depth、wait、commit、dropped 和 coalesced 指标。
- [x] 实现限频 warning。
- [x] 压测生产者快于 SQLite 时的稳定行为。

验收：队列内存有界；满载时代理调用方可继续且能观察日志降级。

### 4.5 任务匹配迁移

依赖：4.2、2.6、0.3。

- [x] 迁移 pending task promotion。
- [x] 迁移 request ID、previous response ID、context key 匹配。
- [x] 迁移带时间窗口的 heuristic matching。
- [x] 输出 confidence、reason 和 strategy version。
- [x] recent query 设置显式 limit 和索引。
- [x] 覆盖并发相似 task 不串组的测试。
- [x] 对 fixture 差异逐项确认，不用兼容 shim 掩盖。

验收：已确认的 task fixture 全部通过；算法不扫描无界历史。

### 4.6 traffic event 写入事务

依赖：4.4、4.5、2.5。

- [x] 定义 accepted/body_read/routed/headers/finished/error event。
- [x] 将 event fold 为同一 record 的当前状态。
- [x] task、record、link 和 FTS 在一个事务中更新。
- [x] finished event 可幂等重试。
- [x] 脱敏在 enqueue 前执行。
- [x] 保存 error code/stage，不持久化不安全 stack。
- [x] 测试 pending 到 finished 不重复计数。

验收：进程在任意中间 event 后终止，数据库仍保持可查询的一致状态。

### 4.7 查询、清理和维护

依赖：4.6。

- [x] 实现跨多个 log root 的稳定合并分页。
- [x] 实现 task/record 搜索。
- [x] 实现按 task、天数和保留最新数量清理。
- [x] 实现 checkpoint、optimize 和 integrity check 操作。
- [x] 大清理分批执行，避免长事务冻结写入。
- [x] 明确多 log root 部分失败的返回模型。

验收：多库排序和分页无重复/遗漏；清理后 records、links、FTS 一致。

### 4.8 流式 ZIP 导出

依赖：4.7。

- [x] 选择支持 streaming 的 ZIP 库并记录理由。
- [x] 从 repository 分页读取，不加载全部 task/body。
- [x] 生成稳定、安全的相对文件名，防止 Zip Slip。
- [x] 支持客户端取消时停止查询和压缩。
- [x] 限制并发导出任务。
- [x] 添加大数据集内存测试和 ZIP 内容测试。

验收：大导出内存有界，取消后文件句柄和数据库查询被释放。

## 9. 阶段 5：代理核心

### 5.1 单 proxy HTTP 骨架

依赖：1.5、2.3。

- [x] 使用 `node:http` 创建可注入依赖的 ProxyServer。
- [x] 支持常见 method、原始 path 和 query。
- [x] 生成 request ID 和最小 request context。
- [x] 对 unsupported upgrade/CONNECT 明确拒绝。
- [x] 监听 error 和 clientError，避免进程崩溃。
- [x] 提供 ephemeral port 测试入口。

验收：真实 upstream 集成测试能完成 GET/POST/HEAD，不依赖 Fastify。

### 5.2 request body 与路由

依赖：5.1、2.4。

- [x] 支持 `Content-Length` 和 chunked body。
- [x] 实现 body limit 和 413。
- [x] 仅对支持的 JSON content type/encoding 改写。
- [x] 选择 target 后构造 upstream request。
- [x] 改写 body 后修正长度和 transfer encoding。
- [x] body read 期间处理 abort 和 socket error。
- [x] 不需检查 body 时提供直接流式路径。

验收：chunked、无效 JSON、非 JSON、大 body 和中途断开集成测试通过。

### 5.3 header 转发规则

依赖：5.2、2.3。

- [x] 接入 request header transform。
- [x] 接入 response hop-by-hop header transform。
- [x] 保留重复 header 和 `Set-Cookie`。
- [x] 正确处理已有 `X-Forwarded-For`。
- [x] 测试 IPv4/IPv6 Host。
- [x] 测试 `Connection: foo` 动态删除 `Foo`。
- [x] 确保 secret header 不进入运行日志。

验收：raw upstream 捕获的 header 与 fixture 一致，response header 不被错误合并。

### 5.4 response 管线与背压

依赖：5.3、3.4。

- [ ] 使用 pipeline 将 upstream response 写到 downstream。
- [ ] 接入有界 capture 和 stream summarizer。
- [ ] 支持 fixed-length、chunked、connection-close body。
- [ ] 支持 SSE 首 event 立即到达。
- [ ] 透明转发 gzip bytes。
- [ ] 正确处理 HEAD/204/304。
- [ ] 用慢客户端证明背压生效。

验收：100 MiB response hash 完全一致，进程内存不保存完整 body；SSE 首 event 不等待结束。

### 5.5 取消和超时

依赖：5.4。

- [ ] 建立单 request AbortController。
- [ ] 客户端 request aborted 时取消上游。
- [ ] downstream close-before-finish 时取消上游。
- [ ] 实现 connect/header/idle/total timeout。
- [ ] headers 未发送时返回结构化 502/504。
- [ ] headers 已发送时销毁流并记录终态。
- [ ] 清理所有 timer 和 event listener。

验收：每种终止路径没有悬挂 socket/timer；错误状态和 code 可区分。

### 5.6 traffic 生命周期接入

依赖：5.5、4.6。

- [ ] accepted 后尽早提交初始 event。
- [ ] body/routing 后更新 target 和 request metadata。
- [ ] response headers 后记录 status/header latency。
- [ ] finish/abort/timeout/error 恰好提交一个终态。
- [ ] 记录 observed/captured/truncated bytes。
- [ ] storage degraded 不改变代理响应。
- [ ] 为不记录日志的 target 提供 no-op sink。

验收：所有协议集成场景都有数据库断言；事件重复不会产生重复 record。

### 5.7 连接池和资源释放

依赖：5.5。

- [ ] 配置 per-origin keep-alive Agent。
- [ ] 设置 max sockets、max free sockets 和 idle 生命周期。
- [ ] 按 scheme/host/port 隔离。
- [ ] runtime stop 时销毁 Agent。
- [ ] 测试连接复用和目标切换。
- [ ] 记录 active/free socket 诊断信息。

验收：压测中 socket 数不无界增长，shutdown 后无活动连接残留。

### 5.8 协议故障集成测试

依赖：5.1-5.7、0.4。

- [ ] 上游拒绝连接。
- [ ] DNS/TLS/证书错误。
- [ ] header timeout 和 idle timeout。
- [ ] headers 后立即断开和半截 chunk。
- [ ] malformed status/header。
- [ ] 客户端慢读和中途断开。
- [ ] 并发 SSE 与普通请求混合。
- [ ] shutdown 中存在 active stream。

验收：测试无随机 sleep 依赖，重复运行稳定；所有资源在测试结束后关闭。

## 10. 阶段 6：多代理运行时

### 6.1 RuntimeManager

依赖：5.8、2.1。

- [ ] 按 proxy ID 管理 server/runtime 状态。
- [ ] 支持 start、stop、restart 和 list。
- [ ] 支持配置端口 0 并返回 actual port 供测试。
- [ ] 防止重复 ID 和监听冲突。
- [ ] 状态区分 configured、starting、running、stopping、failed。
- [ ] 错误包含安全化的 listen address 和 code。

验收：多个 proxy 可同时监听、独立启停，单个失败不终止其他 proxy。

### 6.2 原子配置替换

依赖：6.1、2.2。

- [ ] diff 当前和新配置。
- [ ] 不变 runtime 不重启。
- [ ] 对新增/变更监听执行 prepare。
- [ ] prepare 全部成功后 commit 配置文件和 runtime snapshot。
- [ ] 任一失败时回滚新 runtime 并保留旧状态。
- [ ] 串行化并发配置更新。
- [ ] 返回逐 proxy 应用结果。

验收：端口冲突和保存失败不会造成旧代理停服或磁盘/内存配置不一致。

### 6.3 优雅启动和关闭

依赖：6.2、4.3。

- [ ] 按设计定义启动顺序和 ready 条件。
- [ ] 处理 SIGINT/SIGTERM 和 Windows 支持的终止路径。
- [ ] 停止接收新请求并 drain active requests。
- [ ] 超过宽限期 abort active requests。
- [ ] drain/close storage Worker。
- [ ] 关闭 Agent、admin 和文件句柄。
- [ ] 定义正常、配置错误、运行错误 exit code。

验收：集成测试在 active SSE 时触发关闭，进程在期限内退出且数据库状态一致。

### 6.4 runtime 故障恢复

依赖：6.3、4.4。

- [ ] Worker crash 进入 storage degraded。
- [ ] 实现有限次数、带退避的 Worker 重启。
- [ ] listen server error 更新单个 runtime 状态。
- [ ] fatal process error 触发全局关闭。
- [ ] 防止无限重启循环和日志风暴。
- [ ] health 反映 degraded/failed 组件。

验收：故障注入结果确定且可观测，不存在静默停止记录或假健康。

## 11. 阶段 7：管理 API

### 7.1 Fastify 管理面骨架

依赖：1.5、6.3。

- [ ] 创建 Fastify app factory，依赖显式注入。
- [ ] 添加 `/api/v1/health`。
- [ ] 设置 request body limit、request ID 和超时。
- [ ] 配置 schema serializer 和统一 error handler。
- [ ] 默认 bind loopback。
- [ ] 使用 inject 测试，不要求真实端口。

验收：app 可在测试中创建/关闭多次，无全局单例污染。

### 7.2 proxy 管理 API

依赖：7.1、6.2、1.4。

- [ ] 实现 `GET /api/v1/proxies`。
- [ ] 实现原子 `PUT /api/v1/proxies`。
- [ ] 实现 `POST /api/v1/proxies/:id/enabled`。
- [ ] response 隐藏完整 API key。
- [ ] secret 空值/保持/清除语义明确。
- [ ] 映射 schema/error 到稳定 API contract。
- [ ] 覆盖端口冲突、非法配置和并发更新。

验收：API contract 测试通过，任何响应和日志都不包含测试 secret。

### 7.3 task/log 管理 API

依赖：7.1、4.7、4.8。

- [ ] 实现 task 分页搜索。
- [ ] 实现 task 内 record 分页。
- [ ] 实现 record detail。
- [ ] 实现 cleanup。
- [ ] 实现 streaming export。
- [ ] 对 limit/offset/query 设置边界。
- [ ] 多 log root 部分失败返回明确 details。

验收：API 查询不在主线程执行 SQLite，导出取消能清理后台工作。

### 7.4 统一错误与安全边界

依赖：7.2、7.3。

- [ ] 实现 `{ error, requestId }` contract。
- [ ] 建立内部 error code 到 HTTP status 映射。
- [ ] schema 错误返回字段路径但不泄漏 secret value。
- [ ] 未知 error 记录 cause，对外返回通用 message。
- [ ] 增加 404、405、content-type 和 malformed JSON 测试。
- [ ] 设置安全 response headers。

验收：错误快照不包含 stack、authorization、API key 或非必要绝对路径。

### 7.5 静态资源和浏览器启动

依赖：7.1。

- [ ] 服务 Vite build 产物。
- [ ] HTML 使用 no-cache，hash asset 使用 immutable cache。
- [ ] 防止静态路径穿越。
- [ ] CLI 支持 `--no-browser` 和延迟打开。
- [ ] 只有 admin ready 后打开浏览器。
- [ ] 浏览器打开失败只警告，不结束服务。

验收：生产 build 可直接启动并打开 UI；静态资源 MIME 和 cache header 正确。

## 12. 阶段 8：Web UI 迁移

### 8.1 现有 UI contract 迁移

依赖：7.2、7.3。

- [ ] 将现有页面接到 `/api/v1`。
- [ ] 更新 proxy/task/record 字段映射。
- [ ] 适配统一 error contract。
- [ ] 保留现有主要工作流和布局。
- [ ] 删除 Python admin API 的兼容调用。
- [ ] 为分页、刷新和详情竞态增加保护。

验收：人工和自动测试可以完成配置、启停、搜索、详情、导出和清理。

### 8.2 Web TypeScript 构建

依赖：8.1、1.4。

- [ ] 把 Web 入口迁移到 TypeScript。
- [ ] 引入统一 API client。
- [ ] 使用共享 contract parse server response。
- [ ] 消除隐式全局状态和 inline event handler。
- [ ] 是否引入 React 依据 ADR 执行。
- [ ] 配置生产 source map 策略。

验收：Web build 无 TypeScript error，API response shape 变化会在类型或 schema 测试中失败。

### 8.3 secret 和错误状态

依赖：8.2、7.4。

- [ ] UI 不回填完整 API key。
- [ ] 实现保持、替换和清除 secret 的明确交互。
- [ ] 为列表/详情提供 loading、empty、error、stale 状态。
- [ ] 配置保存期间防止重复提交。
- [ ] destructive cleanup 需要确认和结果反馈。
- [ ] 长错误文本不会破坏布局。

验收：浏览器网络记录和 DOM 中都找不到已保存 secret。

### 8.4 浏览器关键流程测试

依赖：8.3。

- [ ] 配置 Playwright。
- [ ] 测试创建/修改 proxy。
- [ ] 测试启停和运行状态。
- [ ] 通过 fixture upstream 产生普通/SSE 日志。
- [ ] 测试 task 搜索、分页和 detail。
- [ ] 测试 cleanup 和 export 下载。
- [ ] 覆盖窄屏基本可用性。

验收：浏览器测试在 CI 稳定运行，失败保留 screenshot/trace。

## 13. 阶段 9：生产加固

### 9.1 结构化运行日志

依赖：5.6、7.1。

- [ ] 接入 Pino。
- [ ] request/proxy/target ID 使用 child logger context。
- [ ] 定义启动、关闭、请求完成和组件故障 event。
- [ ] 开发 pretty 输出与生产 JSON 分离。
- [ ] 实现 secret/redaction 配置。
- [ ] 限制同类错误日志频率。

验收：日志字段稳定可解析，测试 secret 永不出现。

### 9.2 health 和内部指标

依赖：9.1、6.4、4.4。

- [ ] 区分 live、ready 和 degraded。
- [ ] 报告 runtime configured/running/failed 数量。
- [ ] 报告 storage queue depth、latency、dropped。
- [ ] 统计 active request、abort、timeout、bytes 和 truncation。
- [ ] 设置指标 label 基数上限，不以 path/request ID 作为聚合 label。
- [ ] 为未来 OpenTelemetry/Prometheus 留 adapter 边界。

验收：故障注入时 health/metrics 与真实状态一致，不返回 secret。

### 9.3 安全加固

依赖：7.4、8.3、0.1。

- [ ] 默认 admin/proxy loopback。
- [ ] 非 loopback admin 要求显式 flag 和 token。
- [ ] 配置 CORS allowlist 和 Origin 校验。
- [ ] 限制配置更新、清理和导出并发。
- [ ] 配置文件和数据库文件最小权限。
- [ ] 增加 header/body/log injection 测试。
- [ ] 执行依赖审计和 license 检查。
- [ ] 建立安全问题报告说明。

验收：安全测试覆盖远程 admin、CSRF、secret 泄漏和路径穿越。

### 9.4 容量和 retention

依赖：4.7、9.2。

- [ ] 确定 body capture 默认值和硬上限。
- [ ] 确定 storage queue 默认值和硬上限。
- [ ] 实现按天数/容量的 retention job。
- [ ] 清理任务避免与高峰写入竞争。
- [ ] 配置磁盘空间低水位告警/降级。
- [ ] 文档说明完整 body 记录的隐私和磁盘成本。

验收：长时间合成负载下内存、队列和数据库增长符合配置。

### 9.5 性能基线与剖析

依赖：5.8、9.2、0.4。

- [ ] 执行普通 JSON throughput/latency benchmark。
- [ ] 执行 100 并发 SSE 60 秒 benchmark。
- [ ] 执行 100 MiB 响应内存测试。
- [ ] 执行慢客户端测试。
- [ ] 执行 storage queue/commit benchmark。
- [ ] 执行 10 万 tasks 查询 benchmark。
- [ ] 使用 event loop delay、CPU 和 heap profile 定位瓶颈。
- [ ] 保存报告，不做没有测量依据的优化。

验收：设计文档中的性能不变量全部满足，报告可在同类机器复现。

### 9.6 故障注入测试

依赖：9.1-9.5。

- [ ] SQLite busy/locked。
- [ ] Worker crash/restart 失败。
- [ ] 磁盘满和只读目录。
- [ ] 配置 rename 失败。
- [ ] 上游 socket/TLS/DNS 故障。
- [ ] 关闭过程中持续新连接。
- [ ] 日志队列持续过载。

验收：每个故障都有预期 outcome、health 状态、运行日志和恢复方式。

## 14. 阶段 10：打包和发布

### 10.1 CLI/npm 产物

依赖：8.4、9.3。

- [ ] 定义 package exports 和 bin。
- [ ] build 产物不依赖 TypeScript 源文件。
- [ ] 包含 Web 静态资源和 migration。
- [ ] 验证安装后的工作目录/数据目录语义。
- [ ] `--help`、`--version`、启动和关闭 smoke test。
- [ ] 检查 npm package contents 和 license。

验收：从生成的 tarball 安装，不引用 workspace 源路径即可运行。

### 10.2 Windows 便携包

依赖：10.1。

- [ ] 固定并打包 Node runtime。
- [ ] 打包平台匹配的 SQLite native addon。
- [ ] 包含 JS、静态资源、migration、license 和启动脚本。
- [ ] 处理包含空格和非 ASCII 的安装路径。
- [ ] 生成 checksum。
- [ ] 在干净 Windows runner 启动 health、代理一次请求并关闭。

验收：解压即用，无需系统预装 Node/Python，不从源码目录加载文件。

### 10.3 托盘方案 spike

依赖：10.2、0.1。

- [ ] 分别验证 Electron、平台原生薄外壳、Node SEA 候选。
- [ ] 测量安装体积、启动时间和空闲内存。
- [ ] 验证启动/停止 server、打开 UI 和显示错误。
- [ ] 验证 native addon、签名和 CI 构建。
- [ ] 评估自动更新和多平台成本。
- [ ] 写 ADR 并选择方案。
- [ ] 实现选定方案的最小生产外壳。

验收：托盘不包含代理业务逻辑，server 仍可独立 CLI 运行。

### 10.4 Release pipeline

依赖：10.2，若首版含托盘则依赖 10.3。

- [ ] tag 触发干净构建。
- [ ] 注入 version、commit、build time。
- [ ] 生成 SBOM、license 清单和 checksum。
- [ ] 对最终 artifact 执行 smoke test。
- [ ] 上传 GitHub Release artifact。
- [ ] 保留构建日志和 provenance。
- [ ] 有证书后加入 Windows code signing。

验收：release 下载物与 CI 测试物完全相同，checksum 可验证。

## 15. 阶段 11：迁移、切换和清理

### 11.1 数据迁移决策与工具

依赖：4.1、2.1、0.1。

- [ ] 若不迁移，文档明确新数据目录和备份方式。
- [ ] 若迁移，设计 `llm-proxy migrate` 一次性命令。
- [ ] 迁移前备份 `traffic.db` 和 config。
- [ ] 检测源/目标 schema 和重复执行。
- [ ] 迁移后运行 foreign key、integrity 和计数校验。
- [ ] 失败不删除或修改唯一源数据。
- [ ] 使用真实脱敏样本演练。

验收：迁移策略明确，不存在运行时长期双读/双写。

### 11.2 Node 主实现验收

依赖：9.6、10.2、11.1。

- [ ] 对照阶段 0 行为清单逐项验收。
- [ ] 执行 Node/Python 黑盒差异报告。
- [ ] 对每个有意差异更新 README/changelog。
- [ ] 运行完整 unit/component/integration/browser/package test。
- [ ] 在 Windows/Linux 手工完成核心工作流。
- [ ] 关闭所有 P0/P1 缺陷。
- [ ] 确认 Node 版本成为默认文档入口。

验收：设计文档“完成定义”全部满足，维护者签字确认切换。

### 11.3 文档和运维手册

依赖：11.2。

- [ ] 重写中英文安装和快速开始。
- [ ] 更新目录结构和开发命令。
- [ ] 记录配置 schema、默认值和示例。
- [ ] 记录数据目录、备份、迁移、retention 和卸载。
- [ ] 记录代理协议支持矩阵和限制。
- [ ] 记录常见启动、端口、TLS、SQLite 和打包问题。
- [ ] 记录 release 和回滚流程。

验收：按文档可在干净环境完成开发启动和正式包运行。

### 11.4 删除 Python runtime

依赖：11.2、11.3。

- [ ] 打 release/tag 保存最后一个 Python 版本。
- [ ] 删除 Python package、入口、tray launcher 和 pyproject。
- [ ] 删除只服务 Python 的测试和 workflow。
- [ ] 保留仍有价值的语言无关 fixture 和文档历史。
- [ ] 更新 `.gitignore`、README 和贡献说明。
- [ ] 确认仓库不存在两个正式启动入口。

验收：全新 checkout 只需 Node toolchain 即可开发、测试、构建和发布。

### 11.5 最终发布候选验证

依赖：11.4、10.4。

- [ ] 从 release candidate tag 构建全部产物。
- [ ] 干净 Windows/Linux 环境 smoke test。
- [ ] 执行 60 分钟混合普通/SSE soak test。
- [ ] 执行升级/迁移和回滚演练。
- [ ] 验证 checksum、SBOM 和 license。
- [ ] 检查数据库、socket、Worker 和临时文件清理。
- [ ] 发布已知限制和 release notes。

验收：候选版本无阻塞缺陷，所有 artifact 与文档一致，可发布正式 Node.js 版本。

## 16. 建议提交边界

以下类型的变更不要混在同一个提交中：

- workspace/工具链与业务逻辑。
- schema migration 与 repository 行为变更。
- proxy 数据面与 admin API。
- API contract 与大规模 UI 视觉改版。
- 性能优化与功能行为变更。
- Python 删除与 Node 功能补齐。

每个提交消息应说明可观察结果，例如：

```text
build: initialize pnpm TypeScript workspace
feat(storage): run SQLite repository in worker thread
feat(proxy): stream upstream responses with backpressure
test(proxy): cover client abort during SSE response
docs: record Windows packaging decision
```

## 17. 暂停与回退条件

出现以下情况时应暂停当前阶段并修订设计，而不是继续堆补丁：

- Node HTTP API 无法保留已承诺的关键协议语义。
- SQLite native addon 无法在目标平台可靠构建或打包。
- Worker 消息复制导致大 body 内存出现第二份无界副本。
- 配置更新无法做到失败时保留旧 runtime。
- 代理流式延迟或内存明显劣于 Python 基线且无法解释。
- 托盘要求迫使业务逻辑进入桌面外壳。
- 为兼容未确认的旧行为开始出现多套长期代码路径。

回退意味着回到最近一个可运行的阶段提交，更新 ADR/TODO，再继续；不意味着同时维护两个正式实现。
