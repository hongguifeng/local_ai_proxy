# LLM Proxy Node.js 重构计划

## 1. 重构目标

把当前 Python 3.10+ 实现完整迁移到 Node.js 24 LTS + TypeScript，在不丢失现有功能、数据和界面显示的前提下，建立更清晰的模块边界、可维护的数据迁移机制和更稳健的流式代理实现。

本计划遵循以下优先级：

1. 用户数据安全。
2. HTTP/SSE 代理行为等价。
3. 任务归并和日志内容等价。
4. UI 视觉与交互等价。
5. CLI/托盘/发布能力等价。
6. 在 parity 完成后再做性能和设计优化。

## 2. 范围

### 2.1 包含

- Python 核心运行时迁移为 Node.js/TypeScript。
- 管理 HTTP API 和静态 UI 服务迁移。
- 多代理实例、模型路由、请求改写、Header 和流式转发迁移。
- SQLite schema、repository、搜索、任务归并、导出、清理迁移。
- 配置文件加载、保存和数据兼容。
- Windows 托盘和打包流水线迁移。
- 测试、CI、文档和发布说明迁移。

### 2.2 不包含

- UI 视觉重设计。
- 引入 React/Vue 等前端框架。
- 新增用户登录、多租户或云端部署。
- 新增 HTTP/2、WebSocket、CONNECT 隧道。
- 改变模型路由业务规则。
- 改变任务归并策略，除非修复明确 bug 并单独审批。

### 2.3 兼容原则

项目仍在开发期，内部 API 不保留兼容层。Node.js 内部模块直接按目标设计重建。

以下属于用户数据或外部行为，应保留或提供明确迁移：

- `proxies.json`。
- `traffic.db`。
- CLI 参数和环境变量。
- 代理 HTTP 行为。
- UI 可见功能和视觉。

管理 API 是 UI 与后端共同拥有的内部产品合同。第一阶段保留现有路径以减少变量；未来若简化，前后端和测试一次性同步修改，不增加双版本 shim。

## 3. 建议技术方案

### 3.1 运行时与语言

- Node.js 24 LTS。
- TypeScript strict，ESM。
- 包管理器建议 `npm`，避免对用户增加额外工具要求。
- 最低 Windows 目标与当前 GitHub Actions `windows-latest` 保持一致。

### 3.2 依赖建议

| 用途 | 建议 | 备注 |
| --- | --- | --- |
| 管理服务 | Fastify | 仅控制面；代理数据面不用框架 |
| 运行时校验 | Zod | 配置、API DTO、环境变量 |
| SQLite | `better-sqlite3` | 成熟、事务简单；实现前与 `node:sqlite` 做一次 ADR 对比 |
| ZIP | `archiver` | 支持流式生成，避免整包驻留内存 |
| 测试 | Vitest | 单元和集成测试统一 |
| HTTP 客户端测试 | Node `http`/`https`、undici | 流时序测试优先用原生 client |
| 代码质量 | ESLint + Prettier + `tsc --noEmit` | 对应 Ruff/Mypy/compileall |
| Windows 托盘 | Electron + electron-builder | 托盘宿主与核心业务分离 |

依赖版本在实现时固定到 lockfile，不在文档中写易过期的精确次版本。

### 3.3 仓库布局策略

重构期间 Python 和 Node.js 暂时共存：

```text
llm_proxy/           # 旧 Python 基线，parity 完成前只修关键 bug
tests/               # 旧 Python 测试
src/                 # 新 TypeScript 源码
electron/            # 新托盘宿主
test-node/           # 新 Node 测试，最终可改名 tests/
package.json
tsconfig.json
```

完成切换后：

- 删除 Python package、Python 测试、pyproject 和 PyInstaller 入口。
- 把 Node 测试目录统一为 `tests/`。
- 更新 README、截图路径和发布工作流。

此共存只用于迁移验证，不实现 Python/Node 双运行的长期兼容层。

## 4. 重构策略

采用“行为基线 -> 纯逻辑移植 -> 存储移植 -> 数据面移植 -> 控制面/UI -> 托盘/发布 -> 切换清理”的顺序。

不建议先重写 UI，也不建议一次性删除 Python 后再补功能。原因是项目最复杂的风险在流式 HTTP 和任务归并，必须能持续与已通过测试的 Python 版本对照。

### 4.1 Parity Harness

建立一套语言无关的 fixture：

- 输入：配置、HTTP 请求、SSE 文本、数据库初始文件或 JSON fixture。
- 期望：目标选择、最终上游 body、stream summary、task assignment、API JSON。
- Python 版本导出 golden result。
- Node 版本读取同一 fixture 并比较规范化结果。

对动态字段执行规范化：

- UUID 替换为占位符。
- 时间戳只比较格式、顺序和关键关系。
- 临时端口映射为逻辑名称。
- ZIP 只比较 entry 路径和内容，不比较压缩字节。

## 5. 分阶段实施计划

## 阶段 0：冻结基线与决策记录

### 目标

把“完整保留功能”的含义转换为可执行验收条件。

### 工作

1. 将当前 66 个 Python 测试固定为迁移基线。
2. 保存四张现有 UI 截图作为视觉基线。
3. 增加缺失的 Python 契约测试：
   - 所有 HTTP 方法。
   - Header 覆盖优先级和重复 Header。
   - 502 与响应中途失败。
   - 多目标不同 log root。
   - 管理 API 错误响应。
   - 配置损坏、监听端口冲突。
4. 创建 ADR：SQLite 驱动、原始/上游 body、日志大小策略、配置失败策略、托盘交付物。
5. 复制真实但已脱敏的 `proxies.json` 和 `traffic.db` 为兼容 fixture。

### 交付物

- `docs/adr/*.md`
- `fixtures/parity/*`
- 基线测试报告
- 明确的兼容矩阵

### 退出条件

- 所有现有和新增 Python 契约测试通过。
- 待决设计事项有明确结论。

## 阶段 1：Node.js 工程骨架

### 目标

建立可编译、可测试、可发布的 TypeScript 工程，但不接管真实代理。

### 工作

1. 创建 `package.json`、lockfile、TypeScript/ESLint/Prettier/Vitest 配置。
2. 定义 Node.js 版本约束和 `.nvmrc`/`.node-version`。
3. 建立目录和依赖边界。
4. 创建 `npm run build/typecheck/lint/test/dev/start`。
5. 创建基础错误类型、时间、ID、JSON helper。
6. 在 CI 中增加 Node job，Python job暂时保留。

### 退出条件

- clean checkout 后 `npm ci && npm run check` 成功。
- 空应用可启动并响应健康检查。

## 阶段 2：配置领域与文件持久化

### 目标

Node 版本能够读取、规范化和保存现有 `proxies.json`。

### 工作

1. 用 Zod 定义 persisted config 和 runtime config。
2. 移植默认 pair、target、model mappings 规范化。
3. 保留空 `log_root` 表示禁用日志。
4. 实现 temp file + flush + rename 原子写入；Windows rename 行为单独测试。
5. 区分 file missing、invalid JSON、invalid schema。
6. 对当前 Python 行为不理想的错误处理增加明确错误对象，但不改合法配置语义。
7. 用真实 fixture round-trip，验证没有丢失 API Key、mapping、空字符串和布尔值。

### 退出条件

- Node 读取 Python 配置后的规范化结果与 Python golden 相同。
- Node 保存后能被旧 Python 版本读取。
- 写入失败不破坏原文件，不残留临时文件。

## 阶段 3：纯领域逻辑移植

### 目标

先迁移无 I/O、容易建立完全等价测试的逻辑。

### 工作包

1. Target URL 与 path join。
2. model 提取、target selection、model rewrite。
3. strip/inject 解析和 transform 顺序。
4. Header 常量和 override 解析。
5. redaction。
6. body JSON/text 解析。
7. endpoint、message count、token count。
8. request fingerprints、boundary fingerprints、context message 过滤。
9. SSE parse 和三类 stream accumulator。
10. 时间格式和本地时区。

### 实施方式

- 每迁移一个 Python 测试文件，就建立对应 TypeScript 测试。
- 对 JSON object key 顺序、Unicode、非 UTF-8 replacement 行为增加跨语言 fixture。
- 不在此阶段“顺便优化”归并或摘要规则。

### 退出条件

- 纯逻辑 parity fixture 100% 通过。
- TypeScript 单元测试覆盖主要分支。

## 阶段 4：SQLite schema、migration 与 repository

### 目标

Node 版本直接读取和更新现有 `traffic.db`。

### 工作

1. 实现连接 PRAGMA：WAL、foreign keys、busy timeout、NORMAL synchronous。
2. 创建 migration runner：读取 `schema_meta.schema_version`，按事务升级。
3. 实现 schema v1 兼容，不重新创建或破坏已有表。
4. 拆分 task、record、link、query repository。
5. 保留 JSON 编码的 `ensure_ascii=false` 等价语义。
6. 保留 upsert、sequence、cascade 和 search escaping。
7. 验证 FTS5 在 Windows 打包环境可用。
8. 在 ADR 批准后决定是否新增 schema v2；若新增，提供备份、迁移和回滚说明。

### 兼容测试

- Python 创建 DB -> Node 查询/写入 -> Python 再查询。
- Node 创建 DB -> Python 查询。
- v1 fixture 完整导出前后数据一致。
- 非法 foreign key 被拒绝。
- 多 connection 并发写和 busy timeout。

### 退出条件

- 所有 repository parity 测试通过。
- 原数据库在副本上完成无损 round-trip。

## 阶段 5：TaskMatcher 与 TrafficLogService

### 目标

迁移任务归并和请求生命周期 upsert。

### 工作

1. 移植 TaskAssignment 和策略版本 4。
2. 实现 pending -> finished 同 record/task/sequence。
3. 实现 previous_response_id、context link、24 小时 heuristic。
4. 保持 model/path/system/first user 静态边界。
5. 使用单个 SQLite transaction 写 task、record 和 links。
6. 为每个 log root 建立写队列或串行 executor。
7. 日志错误捕获并转成结构化内部告警，不抛回已进行的 HTTP 响应。
8. 明确 original/upstream body 存储并加入 schema/API 测试。

### 退出条件

- Python `test_task_matcher.py` 与 `test_sqlite_logger.py` 的所有语义在 Node 测试中覆盖。
- 并发写入不会产生重复 sequence 或 database locked 泄漏。

## 阶段 6：代理数据面

### 目标

Node 版本完整接管单个 proxy listener 的 HTTP 转发。

### 设计

- 使用 `node:http.createServer()` 接收请求。
- 使用 `node:http.request()` / `node:https.request()` 连接上游。
- 请求和响应使用 stream pipeline，保留 backpressure。
- 在需要按 model 路由和 JSON 改写时收集请求 body；无 body 或未来可判定不改写时可直接流转。
- 响应使用 tee：一支发给客户端，一支增量构建日志摘要/有限 body 缓冲。

### 工作

1. 支持当前七种 HTTP 方法和任意其他非 CONNECT 普通方法的通用处理。
2. 实现 Header 过滤、Host、X-Forwarded-*、API Key 和 override。
3. 实现 path join 和 query 保留。
4. 实现 timeout、客户端断开和上游 abort。
5. 保持当前响应 Header 和 `Connection: close` parity。
6. SSE 不得缓冲；测试第一行在上游结束前到达客户端。
7. 正确支持 incoming chunked request body，这是相对 Python 版的兼容增强。
8. 增加最大 body/日志策略，但默认不能破坏常规 LLM 大请求。
9. 集成 pending/final logging。

### 关键测试

- 本地真实 upstream server 端到端。
- model 路由两个上游。
- model rewrite + strip + inject 组合。
- binary body 和 binary response。
- duplicate/set-cookie Header。
- SSE 分两段、慢速、无 `[DONE]`、中途断开。
- 普通 chunked response。
- incoming chunked request。
- timeout 前后是否已发 Header。
- client abort。
- 10+ 并发请求。

### 退出条件

- 当前 `test_server.py` 所有行为通过 Node 版本。
- 新增流和中断测试通过。
- 对比 Python，首行延迟无明显回退。

## 阶段 7：ProxyManager 与运行态

### 目标

管理多个 listener，并使配置变更安全生效。

### 工作

1. 实现 runtime registry 和 pair lifecycle 状态机。
2. start、stop、restart、startEnabled、stopAll。
3. 公开 running 和 actual listen port。
4. 配置替换计算 diff，删除、变更、启停分别处理。
5. 检测重复 pair ID、target ID 和监听地址冲突。
6. 支持启动失败返回到 admin API。
7. 关闭时等待活跃连接到 grace period，再强制 abort。

### 建议状态

```text
stopped -> starting -> running -> stopping -> stopped
                   \-> failed
```

### 退出条件

- 多代理可独立启停。
- 一个代理失败不使其他已运行代理丢失。
- stopAll 后无监听 socket、timer 或 DB handle 泄漏。

## 阶段 8：管理 API、日志查询和维护

### 目标

Node 控制面满足当前 UI 所需全部接口。

### 工作

1. 静态资源服务。
2. pairs list/replace/enable routes。
3. task list、task records、record detail。
4. 多日志根合并分页。
5. 搜索 term/escaping/本地时间语义。
6. ZIP 改为流式响应。
7. cleanup selected/older/keep latest。
8. Zod 校验请求和 query，统一错误 DTO。
9. 增加 `/health` 或 `/api/health` 供自动化检查。

### API 策略

第一阶段保持现有路径和主要 JSON shape。非法请求改成明确 400 是允许的设计修正，但必须同步前端错误处理和测试，不保留旧的“静默空对象”路径。

### 退出条件

- 当前 `test_admin_ui.py` 和 repository/search/export/cleanup 测试在 Node 版本全部覆盖。
- 大 ZIP 导出不需要在内存中构建完整 Buffer。

## 阶段 9：UI 原样迁移与视觉回归

### 目标

保持当前界面显示与交互，不把运行时重构扩大为前端重写。

### 工作

1. 复制现有 index.html、app.css、app.js。
2. 用构建时生成的配置常量或独立 `/api/meta` 替代 Python 字符串占位替换。
3. 保持中英文、localStorage、Tab、卡片、splitter、JSON tree、Toast。
4. 修复 Node API 严格校验暴露出的前端输入错误提示。
5. 建立 Playwright 浏览器测试：
   - 创建/编辑/删除 pair 和 target。
   - API Key 显隐与复制。
   - 默认目标和 enable 行为。
   - History 搜索、分页、展开、详情、清理、导出。
   - 自动刷新 pending response。
   - JSON 控件和拖动 splitter。
   - 中文/英文切换。
6. 在固定 viewport 做截图差异测试，允许字体渲染小误差。

### 退出条件

- 与四张基线截图布局和关键颜色一致。
- Playwright 关键路径通过。
- 不存在 Python 服务才能提供的前端动态替换。

## 阶段 10：CLI、托盘与 Windows 打包

### 目标

恢复完整桌面启动体验和发布产物。

### CLI 工作

- 实现现有参数和环境变量。
- 默认打开浏览器，`--no-browser` 禁用。
- 输出管理 URL、配置文件和日志路径。
- SIGINT/SIGTERM 优雅关闭。

### 托盘工作

- Electron main process 创建 Tray，不创建可见 BrowserWindow。
- 菜单保留 Open Admin UI 和 Exit。
- `--open-on-start` 保留。
- 启动失败显示系统对话框。
- Exit 等待 admin、proxy、DB 完成关闭。

### 打包工作

- `electron-builder` 生成 Windows portable 或安装包。
- 生成 SHA-256。
- GitHub Actions 上传 artifact。
- `v*` tag 创建/更新 Release。
- 评估同时发布轻量 CLI zip，避免所有 CLI 用户必须下载 Electron。

### 退出条件

- Windows clean machine 可双击启动。
- 无控制台窗口。
- Tray 打开/退出正常。
- 退出后端口立即或在 grace period 内释放。

## 阶段 11：切换、清理与发布

### 目标

把 Node.js 设为唯一实现，并安全移除 Python。

### 工作

1. 在真实配置和 DB 副本上完成迁移演练。
2. 启动前自动备份首次写入的数据库和配置，或提供独立 backup 命令。
3. 更新 README/README.cn、安装、运行、打包、故障排查。
4. 更新截图，确认只因浏览器渲染差异而变化。
5. 删除 Python 源码、Python 测试、pyproject、PyInstaller workflow。
6. `run.bat` 改为 Node/Electron 启动方式。
7. Node CI 设为唯一必需检查。
8. 生成 release candidate，执行 Windows 手工验收。
9. 标记正式版本，并提供回滚说明。

### 退出条件

- 功能验收矩阵全部通过。
- 现有用户数据可读取。
- 仓库不再需要 Python 运行时。
- 正式发布产物可安装/启动/卸载或直接运行。

## 6. 测试策略

### 6.1 测试金字塔

| 层 | 内容 |
| --- | --- |
| 纯单元 | routing、URL、sanitize、redaction、records、streams、time |
| Repository | SQLite schema、upsert、search、pagination、cascade、migration |
| 服务集成 | task matcher、logger、manager、admin routes |
| HTTP 端到端 | client -> proxy -> fake upstream -> client + DB |
| UI 端到端 | 浏览器操作管理 UI |
| 打包冒烟 | Windows artifact 启动、Tray、端口、退出 |
| 跨语言 parity | Python golden fixture 与 Node 输出比较 |

### 6.2 必须保留的回归测试

- 当前 66 项测试语义一一映射。
- Python 创建的数据可由 Node 查询。
- SSE 第一行及时到达。
- pending/finished 只有一条 record。
- previous_response_id/context/user sequence 归并。
- disabled non-default target 跳过、default target 兜底。
- strip 后 inject，注入值最终覆盖。
- Header 和 JSON 脱敏。
- 搜索 `%`、`_`、本地时间。
- ZIP 路径和 JSON 内容。

### 6.3 新增可靠性测试

- chunked incoming body。
- 客户端中断和上游中断。
- 大响应和日志大小限制。
- 配置文件损坏与恢复。
- DB migration 中途失败回滚。
- 多 DB root 同时查询和清理。
- 端口冲突与部分启动失败。
- 关闭期间新请求。
- Windows 路径、Unicode 路径、文件占用。

## 7. 数据迁移与回滚

### 7.1 配置

- Node 直接读取当前 JSON schema。
- 首次保存前创建时间戳备份，例如 `proxies.json.before-node-<timestamp>.bak`。
- 写入继续采用原子替换。
- 若 Node 增加字段，旧 Python 应忽略未知字段；若不确定，切换前不写新必需字段。

### 7.2 SQLite

- schema v1 必须直接读取。
- migration 在单事务中执行。
- 第一次 schema upgrade 前复制 `traffic.db`，同时考虑 `-wal`、`-shm`：先 checkpoint/关闭写连接，再备份。
- `schema_meta` 只在 migration 完成后更新。
- 大数据库备份应提供进度或使用 SQLite backup API，而非简单复制活跃文件。

### 7.3 回滚

- 在 schema 未升级阶段：停止 Node，恢复旧启动命令即可。
- schema 升级后：使用备份 DB 和配置回滚，不要求 Python 理解新 schema。
- 正式切换的首个版本保留旧 Python release artifact 下载链接，但仓库主干不保留双实现 shim。

## 8. 风险清单与应对

| 风险 | 影响 | 概率 | 应对 |
| --- | --- | --- | --- |
| Node stream 处理改变首字节延迟 | Agent 流式体验下降 | 中 | 原生 stream、时序集成测试、基准对比 |
| Header 语义差异 | 上游鉴权或协议失败 | 中 | rawHeaders fixture、重复 Header 测试 |
| SQLite 驱动/FTS5 打包差异 | History 无法运行 | 中 | Windows artifact 内集成测试、ADR 评估 |
| task matcher 细微差异 | 历史任务被错误拆分/合并 | 高 | golden fixture、策略版本保持 4 |
| 大 body/response 内存 | 进程崩溃 | 中 | tee + 限制/落盘策略、压力测试 |
| Electron 产物过大 | 用户体验/发布成本 | 高 | 同时提供 CLI zip，托盘独立可选 |
| 原配置损坏时行为改变 | 用户无法启动 | 中 | 明确错误、备份、恢复入口 |
| DB migration 不可回滚 | 历史数据丢失 | 低但严重 | 事务、checkpoint、backup、fixture 演练 |
| 配置保存后 listener 启动失败 | 文件与运行态不一致 | 中 | validate/diff/apply 结果、ADR 决定回滚 |
| 日志写入阻塞 event loop | 代理吞吐下降 | 中 | per-DB queue、短事务、性能测试 |
| UI 重绘行为在严格 API 下暴露问题 | 表单数据丢失 | 中 | Playwright 完整表单测试 |

## 9. 性能与稳定性验收

至少记录以下指标，比较 Python 与 Node：

- 非流请求端到端额外延迟。
- SSE 首行转发延迟。
- 10、50 并发请求时的成功率和 P95 延迟。
- 1 MB、10 MB 请求/响应的内存峰值。
- 10,000 task 数据库的搜索和分页时间。
- 100 MB 日志 ZIP 的内存峰值。
- 启动、启停代理和关闭耗时。

建议验收阈值：

- SSE 首行不能等待完整响应。
- 常规代理额外延迟不高于 Python 基线的明显可感知范围。
- ZIP 流式导出内存不随 ZIP 总大小线性增长。
- 关闭后无悬挂端口和未完成 timer。

## 10. 发布策略

### 10.1 预发布

- `0.x-node-alpha`：核心代理和数据库 parity，暂不推荐替换正式版。
- `0.x-node-beta`：UI、CLI、托盘和数据迁移完整。
- `0.x-node-rc`：只修阻断问题，完成真实环境验收。

### 10.2 正式切换

- 发布说明列出运行时从 Python 改为 Node.js。
- 说明数据路径不变、首次启动备份位置和回滚方法。
- 提供 Windows 托盘产物校验和。
- 提供 CLI 安装/运行方式。

## 11. 完成定义

只有同时满足下列条件，重构才算完成：

1. 功能说明书全部必需功能通过验收。
2. Node 测试覆盖当前 66 项语义和新增可靠性用例。
3. 原 `proxies.json` 和 `traffic.db` 在副本演练中无损读取。
4. UI 截图回归和关键 Playwright 流程通过。
5. Windows 托盘 artifact 可用。
6. CI 通过 typecheck、lint、unit、integration、UI 和 packaging smoke test。
7. README 和运维文档只引用 Node.js 启动方式。
8. Python 运行时代码被移除，不存在长期双实现。
9. 已知行为差异均有 ADR、release note 和测试。
10. 有可执行的数据备份与回滚方案。

## 12. 关联文档

- [软件功能说明书](./software-functional-specification.md)
- [模块设计文档](./module-design.md)
- [Node.js 重构 Todo](./nodejs-refactoring-todo.md)
