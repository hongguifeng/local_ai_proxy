# LLM Proxy 模块设计文档

## 1. 文档范围

本文档记录 Python 基线和迁移过程，不描述现行实现。现行实现请读
[现行架构](./current-architecture.md)。

各小节的状态如下：

| 小节 | 内容                            | 状态                                                       |
| ---- | ------------------------------- | ---------------------------------------------------------- |
| 1    | 文档范围                        | 现行                                                       |
| 2、3 | Python 进程、模块与文件设计      | Python 基线（v0.3.0 之前）的历史记录                        |
| 4    | 前端脚本、CSS 与 DOM 检查        | 现行                                                       |
| 5    | 配置聚合与 SQLite 关系           | 现行；schema 版本以 `CURRENT_SCHEMA_VERSION` 为准            |
| 6    | 并发与关闭顺序                  | Python 基线（v0.3.0 之前）的历史记录                        |
| 7    | Node 目标架构                    | 切换前的目标；标有“已实现”的小节除外                          |
| 8    | Python 到 Node 模块映射          | 迁移记录                                                    |
| 9    | 合同清单                        | 外部合同仍然有效，内部合同已经落地                            |
| 10   | 原待决事项                      | 已由 [ADR-001～ADR-013](./adr/) 决定，下表给出对应关系        |
| 11   | 设计验收原则                    | 现行                                                       |

软件功能和用户行为详见[软件功能说明书](./software-functional-specification.md)。迁移步骤详见[Node.js 重构计划](./nodejs-refactoring-plan.md)。

## 2. Python 基线总体架构（历史记录）

以下描述 v0.3.0 之前的 Python 实现。Python 版本是单进程、多线程架构：管理服务监听一个固定
端口，每个启用的 proxy pair 创建一个独立 `ThreadingHTTPServer` 和后台线程，每个 HTTP 请求
再由服务器创建请求线程。现行运行模型见[现行架构](./current-architecture.md)第 1 节。

```mermaid
flowchart TB
  CLI["CLI / Tray 启动入口"] --> Manager["ProxyManager"]
  CLI --> Admin["AdminServer"]
  Admin --> UI["静态 HTML / CSS / JS"]
  Admin --> Store["LogStore / LogMaintenance"]
  Admin --> Manager

  Manager --> P1["ProxyServer A"]
  Manager --> P2["ProxyServer B"]
  P1 --> Route["Routing + Sanitize"]
  P2 --> Route
  Route --> Upstream["HTTP/HTTPS 上游"]
  P1 --> Logger["TrafficLogger"]
  P2 --> Logger
  Logger --> Matcher["TaskMatcher"]
  Matcher --> Repo["LogRepository"]
  Store --> Repo
  Repo --> SQLite[("traffic.db")]
  Manager --> Config[("proxies.json")]
```

### 2.1 分层

| 层 | 职责 | 当前模块 |
| --- | --- | --- |
| 启动与宿主 | 参数解析、浏览器、托盘、生命周期 | `cli.py`, `tray.py`, `__main__.py` |
| 管理应用 | 静态页面、管理 API、代理实例管理 | `admin_server.py`, `manager.py`, `ui.py` |
| 代理传输 | HTTP 接收、路由、Header、请求改写、响应流 | `server.py`, `routing.py`, `target.py`, `sanitize.py`, `http_utils.py` |
| 日志领域 | 记录规范化、任务匹配、摘要和脱敏 | `logger.py`, `records.py`, `task_matcher.py`, `streams.py`, `redaction.py`, `payloads.py` |
| 持久化 | SQLite schema、repository、读取、导出、清理 | `log_db.py`, `log_repository.py`, `log_store.py`, `log_maintenance.py`, `log_roots.py` |
| 通用基础 | 类型、常量、时间、原子文件 | `models.py`, `constants.py`, `time_utils.py`, `file_io.py` |
| 前端 | 双语代理配置与日志查看器 | `static/index.html`, `static/app.css`, `static/app.js` |

## 3. Python 基线模块详细设计（历史记录）

### 3.1 启动模块

#### `llm_proxy/__main__.py`

- `python -m llm_proxy` 入口。
- 调用 `cli.main()` 并把返回值作为进程退出码。

#### `llm_proxy/cli.py`

职责：

- 解析 `--host`、`--port`、`--config-file`、`--log-root`、`--no-browser`。
- 从对应环境变量读取默认值。
- 创建 `ProxyManager`。
- 可延迟 0.5 秒打开浏览器。
- 调用 `serve_admin()` 阻塞运行。
- 捕获 Ctrl+C 并正常退出。

依赖方向：`cli -> admin_server -> manager`。

#### `llm_proxy/tray.py`

职责：

- 创建 Windows/桌面托盘图标和菜单。
- 在后台线程运行 `AdminServer`。
- 启动已启用代理。
- 打开外部浏览器管理页面。
- 退出时按顺序停止管理服务和所有代理。
- 缺少 `pystray`/Pillow 时显示可理解错误。

设计特点：托盘是可选功能，核心代理不依赖托盘第三方包。

#### `llm_proxy/__init__.py`

- 聚合导出 manager、server、logger 和多组 helper，形成当前 Python import 面。
- 这些导出没有独立版本或兼容策略。Node.js 重构应只导出有明确使用场景的模块，不照搬 Python 聚合导出结构。

### 3.2 管理服务模块

#### `llm_proxy/admin_server.py`

`AdminHandler` 同时承担：

- 静态资源服务。
- JSON 管理 API 路由。
- JSON body 读取。
- 文本、JSON、二进制响应序列化。

`AdminServer` 保存两个共享对象：

- `manager: ProxyManager`
- `log_store: LogStore`

生命周期：

```mermaid
sequenceDiagram
  participant Entry as CLI/Tray
  participant Manager as ProxyManager
  participant Admin as AdminServer
  Entry->>Manager: start_enabled()
  Entry->>Admin: serve_forever()
  loop 管理请求
    Admin->>Manager: 配置/启停
    Admin->>Admin: LogStore 查询/导出/清理
  end
  Entry->>Manager: stop_all()
  Entry->>Admin: server_close()
```

当前限制：路由通过 `if` 链实现，参数校验较弱，非法 JSON 被转换为空对象。

#### `llm_proxy/ui.py`

- 从 Python package resource 读取三个静态文件。
- 把建议删除字段列表序列化后替换 `app.js` 中占位符。
- 模块导入时形成 `INDEX_HTML`、`APP_CSS`、`APP_JS` 常量。

### 3.3 代理管理模块

#### `llm_proxy/manager.py`

`ProxyManager` 是配置与运行实例的聚合根。

内部状态：

```text
config_path: Path
log_root: Path | None
lock: RLock
pairs: ProxyPair[]
runtimes: Map<pair_id, ProxyRuntime>
```

核心职责：

- 加载、规范化、保存完整配置。
- 列出配置并附加运行态。
- 整体替换配置。
- 启动、停止、重启单个代理。
- 启动所有 `enabled=true` 的代理。
- 把持久化 TargetConfig 编译成 RuntimeTarget。

`ProxyRuntime` 持有：

- `ProxyServer`
- 后台 `Thread`
- 主 `TrafficLogger`

配置变更事务边界：先把新配置写入内存并保存文件，再停止/重启运行实例。若后续监听启动失败，配置已写入但运行态可能失败；管理 API 返回错误，当前没有配置回滚。

#### `llm_proxy/config.py`

- 提供默认配置路径、默认日志根和建议删除字段。
- 对 pair/target/model mapping 做宽松规范化。
- 保证 pair 至少一个 target。
- 保证 `default_target_id` 指向存在的 target。
- 将 object 类型的 inject 配置转为紧凑 JSON 字符串。

#### `llm_proxy/models.py`

通过 `TypedDict` 表达配置、运行时目标和记录形状。只提供静态检查，不提供运行时验证。

### 3.4 HTTP 代理模块

#### `llm_proxy/server.py`

`ProxyHandler` 是核心传输编排器，承担以下职责：

1. 接收请求和读取 body。
2. 生成 request ID 和初始日志。
3. 选择目标并改写请求。
4. 构造上游 Header 和路径。
5. 建立 HTTP/HTTPS 连接。
6. 流式转发上游响应。
7. 聚合响应 body。
8. 写入最终日志。

主流程：

```mermaid
sequenceDiagram
  participant Client
  participant Proxy as ProxyHandler
  participant Route as Routing/Sanitize
  participant Log as TrafficLogger
  participant Upstream

  Client->>Proxy: HTTP request
  Proxy->>Log: request_received（单目标可早写）
  Proxy->>Proxy: 读取 Content-Length body
  Proxy->>Route: select_target_by_model
  Route-->>Proxy: target + requested/upstream model
  Proxy->>Route: rewrite model, strip, inject
  Proxy->>Log: request_pending_response
  Proxy->>Upstream: method + path + headers + body
  Upstream-->>Proxy: status + headers
  Proxy-->>Client: status + filtered headers
  loop SSE 行或普通 64 KiB chunk
    Upstream-->>Proxy: bytes
    Proxy-->>Client: bytes + flush
    Proxy->>Proxy: 累积日志副本
  end
  Proxy->>Log: request_finished
```

`ProxyServer` 继承 `ThreadingHTTPServer`，关闭时去重并关闭所有 target logger，再关闭监听 socket。

设计问题：`ProxyHandler` 同时承担传输、路由编排和日志生命周期，职责偏重；Node.js 版本应拆分。

#### `llm_proxy/routing.py`

纯函数模块：

- `request_model_from_body`
- `select_target_by_model`
- `rewrite_request_model`

优点：无 I/O，已有独立测试，适合直接逐函数移植。

#### `llm_proxy/target.py`

- 校验目标 URL 只使用 HTTP/HTTPS。
- 解析 scheme、host、port 和 base path。
- 拼接基础路径与客户端请求路径，并防止重复前缀。

#### `llm_proxy/sanitize.py`

- 解析逗号分隔删除字段。
- 校验注入内容必须是 JSON object。
- 先删除后注入，只处理顶层 JSON object。

#### `llm_proxy/http_utils.py`

- 把重复 Header 转成 `name -> values[]`。
- 解析 `Name: value` 自定义 Header。

### 3.5 日志领域模块

#### `llm_proxy/logger.py`

`TrafficLogger` 是写日志的应用服务，内部串联：

```text
TrafficRecord
  -> optional redact_record
  -> TaskMatcher.assign
  -> upsert_task
  -> upsert_record
  -> upsert_response_link/context_link
```

每个 logger 使用 `RLock` 串行化一次完整写入流程。若 `log_root=None`，repository 和 matcher 均为空，写入成为 no-op。

`_record_row()` 将传输层 TrafficRecord 转成数据库领域记录，并计算 endpoint、message_count、token_count。

#### `llm_proxy/records.py`

纯领域解析模块，职责包括：

- endpoint 类型识别。
- JSON body 提取。
- 消息数和 Token 数统计。
- 各 API 请求的稳定内容摘要。
- SHA-256 短指纹。
- system、first user、user sequence、tools、input/messages 指纹。
- 固定 Codex 上下文消息排除。
- response ID 提取。

这是任务归并正确性的核心依赖。

#### `llm_proxy/task_matcher.py`

TaskMatcher 负责将 record 分配给 task。

领域对象 `TaskAssignment` 包含：

- task
- sequence
- kind
- request/response payload
- response IDs
- context keys

匹配策略版本当前为 4。策略由显式 link 匹配和 24 小时启发式匹配组成。匹配会读取 repository 最近任务，因此它不是纯函数。

#### `llm_proxy/streams.py`

负责把 SSE 多事件压缩为单个结构化摘要。`StreamAccumulator` 根据 event type 分派到：

- Responses event handler
- Claude event handler
- Chat Completions handler

内部维护 content、reasoning、三类 tool calls、web search calls、finish reasons、usage、response metadata 和无法识别 payload。

#### `llm_proxy/payloads.py`

- 将 bytes 包装为 size/base64/text。
- JSON pretty print。
- 调用 stream compactor。
- 把 body 转成 SQLite/导出的 JSON 值。

#### `llm_proxy/redaction.py`

深拷贝记录后，对 request/response Header 和 JSON body 递归脱敏。仅当 body text 可解析为 JSON 时处理内容。

### 3.6 持久化模块

#### `llm_proxy/log_db.py`

SQLite 连接参数：

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = 5000 ms
synchronous = NORMAL
check_same_thread = false
```

Python 基线的 schema version 为 1。现行版本由 `src/persistence/database.ts` 的
`CURRENT_SCHEMA_VERSION` 给出（AI-03）。

#### `llm_proxy/log_repository.py`

repository 封装所有 SQL 和 JSON 字段编码/解码：

- task/record upsert 和读取。
- response/context link upsert 和查找。
- task/record 分页。
- recent task 查询。
- task 级联删除。
- 搜索文本写入和 LIKE 检索。

每个 repository 持有一个 SQLite connection 和一个 `RLock`。管理端查询通常为每次操作临时创建连接，写入 logger 长期持有连接。

#### `llm_proxy/log_store.py`

管理 API 面向 UI 的查询适配层：

- 跨 log root 合并任务。
- 将 task 转成 UI group summary。
- 将 record 转成 UI list item 和 detail DTO。
- 将 ISO 时间格式化为本地显示时间。

#### `llm_proxy/log_maintenance.py`

- 全量遍历 task 和 record。
- 内存生成 ZIP。
- 生成 task/record Markdown。
- 按 task ID、时间或保留数量删除。

#### `llm_proxy/log_roots.py`

从所有 target 配置中提取、去重非空日志根；没有 target log root 时回退到 manager 默认根。

### 3.7 通用模块

| 模块 | 职责 |
| --- | --- |
| `constants.py` | hop-by-hop Header、默认端口、建议删除字段 |
| `file_io.py` | 小文本文件原子写入 |
| `time_utils.py` | 带本地时区 ISO 时间、显示/文件名格式化 |

### 3.8 仓库辅助文件

| 路径 | 作用 | 重构处理 |
| --- | --- | --- |
| `examples/responses_client.py` | OpenAI Python SDK 请求示例 | 改为 Node.js OpenAI SDK 示例；修复已失效的 `--target-url` 注释 |
| `run.bat` | Windows 命令行启动 | 改为 Node CLI 或启动已打包程序 |
| `tray_launcher.py` | PyInstaller 托盘入口 | 由 Electron main 取代 |
| `.github/workflows/ci.yml` | Windows Python 3.10/3.12 质量检查 | 迁移期保留，最终改为 Node 24 多层测试 |
| `.github/workflows/release.yml` | PyInstaller exe、checksum、GitHub Release | 改为 electron-builder/CLI artifact |
| `README.md`（中文）、`README.en.md`（英文） | 双语用户说明 | 正式切换时完整改写运行和开发命令 |
| `doc/ui_*.png` | 中英文 UI 截图 | 作为视觉回归基线，必要时更新 |
| `.gitignore` | 排除 logs、Python cache/build | 增加 node_modules、coverage、Node/Electron build 输出并移除陈旧项 |

## 4. 当前前端模块设计

前端是单页、无构建步骤的原生 JavaScript 应用。

### 4.1 HTML

静态定义：

- Header、Tab 和语言选择。
- Proxy toolbar 和动态 card 容器。
- History 左侧列表、左右 splitter、Request/Response JSON pane。
- Toast。

### 4.2 CSS

- CSS 变量定义颜色和动态布局尺寸。
- Proxy target 使用响应式网格，空间不足时自动换行。
- History 使用三列 grid：sidebar、splitter、detail。
- Detail 使用三行 grid：request、splitter、response。
- JSON tree 使用 `details/summary`；`.json-pane` 使用 `contain: layout`，限制普通布局变化的重排影响范围。
- 760 px media query 切换窄屏布局。
- 统计页筛选条已经收成一个 `COMPONENT:` 块，其它区域仍是累积层；约定与测量见 §4.9。

### 4.3 JavaScript 状态

全局 `state` 包含：

- language、pairs。
- task groups、展开/加载状态、分页状态。
- selected record。
- request/response raw、meta、meta 展开、wrap、tree、format string 状态。
- 搜索和自动刷新 timer。

前端没有路由器或组件框架，使用模板字符串整块重绘。为了防止重绘丢失输入，语言切换和部分操作前先调用 `collectPairs()` 回收 DOM 值。

语言切换不再按一份手写调用清单重画。面板在自己的文件里调用 `registerLanguagePanel(id, sequence, render, when?)` 把自己登记进 `languagePanels`，`setLanguage()` 只调用 `rerenderLanguagePanels()`，按 `sequence` 排序后依次重画；`when` 用来跳过当前不在屏幕上的面板（两个对话框、按需加载的统计页）。`sequence` 沿用原来那份清单的顺序：10 pairs、20 logs、30 jsonPanes、40 metaPanes、50 requestPricing、60 taskPricing、70 metricsDialog、80 targetCheckModels、90 statistics，所以这次改动重画的函数集合和先后顺序与之前完全一致。忘了登记只会表现为切换语言后那块界面仍是旧语言，因此 `test-node/admin/static-source.test.ts` 钉住这张 (id, sequence) 表，并要求 `setLanguage` 里除了 `rerenderLanguagePanels()` 之外不得再出现任何 `render*(` 调用。

task records API 保留单次最多 200 条的边界，避免一个长期 task 生成无界管理端响应。响应同时返回 `total`、`limit` 和 `has_more`，不再静默隐藏截断状态；当前 UI 继续显示最新 200 条。

Splitter 拖动（左右分栏与上下分栏）采用“预览后提交”：pointerdown 时缓存容器和原始分栏尺寸，pointermove 只通过 `transform` 移动 splitter 预览线，不改变 grid 尺寸，因此大 JSON DOM 不参与拖动过程中的重排；pointerup 时才一次性提交新的 CSS 分栏变量。拖动期间置位 `state.splitterDragging`，跳过周期性自动刷新，避免列表 DOM 重建干扰交互。

分栏提交后不重新生成 JSON DOM。浏览器直接按现有节点完成一次布局，保留所有 `details` 展开状态和滚动位置，也避免松手后因 `innerHTML` 替换产生界面闪烁。JSON pane 在用户主动切换树形、格式化、换行等显示选项时，仍会先预扫描长字符串并批量测量宽度，把原来逐字符串触发的同步布局合并为一次。

### 4.4 JavaScript 模块切分与静态检查

前端源码全部是 ES module，位于 `src/admin/static/`：

- `entry.js`：唯一的浏览器入口，只有一句 `startAdminUi()` 调用；`/static/app.js` 就是
  `npm run bundle:ui`（`scripts/build_ui_bundle.ts`，esbuild）打包出的整张模块图，没有任何
  编号脚本或加载顺序约定。
- `modules/core.js`：i18n 字典、唯一的可变 `state`、`$`/`qs`/`api`/`toast` 等通用工具，以及
  语言面板登记表。它是模块图的根，其他模块只从这里取共享状态和工具。
- `modules/wiring.js`：组合根，构造两个配置面板（`proxy-config`、`load-balancing` 仍以依赖对象
  注入，因为二者互相引用）、挂载各模块监听器并跑一次启动顺序（含 splitter、语言下拉、按需
  统计加载）。
- 各子系统一个模块，自己拥有自己的监听器与生命周期：`history.js`（日志列表、选中、详情预取、
  摘要）、`json-pane.js`（分栏渲染、懒实现、行窗口、pane 工具栏）、`task-detail.js`（计价
  面板、趋势图、任务简介）、`statistics.js`、`metrics.js`；`money.js`、`text.js`、`time.js`、
  `numbers.js`、`chart.js`、`display-locale.js`、`request.js` 是无状态的显示/请求助手。
- 模块只通过 `import`/`export` 交互：没有任何业务函数挂在 `window`/`globalThis` 上。唯一写到
  全局的是 `modules/test-adapter.js` 的 `__adminUiTest`，由组合根在启动时装入，只供浏览器测试
  使用（合成超大正文的 `applySelectedLogDetail`、精确金额格式化、两个配置面板的
  `init`/`dispose`/`load`），生产代码从不读取它。
- 每个模块自己 `registerLanguagePanel(...)` 登记语言重绘；`setLanguage()` 只调用
  `rerenderLanguagePanels()`。

静态检查配置：

- `tsconfig.ui.json` 用 `allowJs` + `checkJs` + `strict: false` 覆盖 `entry.js` 与
  `modules/*.js`，`npm run typecheck` 会依次跑主工程和它。
- `npm run lint` 先执行 `tsx scripts/build_ui_bundle.ts`，然后直接 lint `src/admin/static/entry.js`
  与 `src/admin/static/modules/*.js`。这些文件是真正的 ES module，每个名字必须 import 或属于
  浏览器全局，所以跨模块引用漏了 import 会以 `no-undef` 报出来；不再需要拼接成一份
  `.ui-check/app.js` 再 lint。
- `static-assets.ts` 的 `ADMIN_BUNDLE_FILE`（`dist-node/src/admin/static-bundle/admin-app.js`）
  由打包装配读出，`test-node/admin/static-bridge.test.ts` 钉住「只有 `__adminUiTest` 一个全局」、
  「入口能到达每个模块」以及「服务端 `/static/app.js` 与打包产物逐字节一致（占位符替换后）」。
- `scripts/copy_static_assets.ts` 会先清掉 `dist-node` 里的旧静态副本，避免构建产物里残留已被
  删除的脚本。

### 4.5 CSS 层叠清理与中立性检查

`app.css` 是多轮布局重写叠出来的累积层，不是按子系统分区的样式表。重复只能在「上下文 + 选择器 + 属性」粒度上计数；按整块规则计数会漏掉真正可删的部分。层叠先比 `!important`，再比特异性，最后比书写顺序，所以同一组里只有排名第一的声明可达。「最后写的赢」只在同重要性、同特异性时成立。

删除非首位声明不会改变赢家，无论别的选择器是否竞争同一元素。按此清理掉 166 条不可达声明，来自 106 个组：声明 2666 降到 2500，规则 840 降到 769，`!important` 从 98 处降到 86 处。清理后的诚实性检查是「没有任何组把同一属性写两遍」，重跑审计应得到 0 组。

删行的陷阱在块起点。多行选择器必须从选择器首行删起；从 `{` 行删起会留下带逗号的悬空行，它会和下一条规则的选择器粘连，把上一块的声明泼到不相干的元素上。规则数和声明数看不出这种损坏，要对拍两份文件的「选择器 + 声明列表」清单。

文件顶部有目录注释，另有 24 个 `/* SECTION: 区域 (n 条规则) */` 头，搜索 `SECTION:` 即可跳转。区域本来就互相穿插：按 60 行间隔切分得到 81 段，request history 占 20 段，statistics 占 11 段。同一个区域名出现多次是实情，不是错误。

中立性的裁判在 UI 测试里，按需运行：

```bash
CSS_CANDIDATE=<candidate.css> npx vitest run test-node/ui/admin-ui-css-cascade.test.ts -t "candidate stylesheet"
```

它比较 4 个视口宽度、9 个页面状态下签名多重集，以及每个「属性:值」的元素计数，并点出发生变化的元素类别。实时实例不能当这个裁判：统计页每分钟都在进流量，同一份 CSS 跑两遍也会有签名出现和消失，所以实时差异在被同样的漂移复现之前都不算证据。该用例的确定性条件缺一不可——安装 `page.clock`、桩化 statistics API 并固定 overview 载荷、关掉日志自动刷新、等对话框的 settle 标记、每次抓取前移开鼠标并 blur 当前焦点。纯注释改动用浏览器里的 `cssRules` 计数对拍，两份文件必须解析出同样的规则数。

### 4.6 CSS 分层重构的测量与否决

为了让 `@layer` 的判断基于数据而不是推测，UI 测试里加了一个按需的竞争普查。它按今天的未分层排序——重要性、特异性、书写顺序——记录每个元素上每个被采样属性的两个争夺者、是谁赢了、靠什么赢的，以及去掉 `!important` 之后会不会翻盘。

```bash
CSS_CENSUS=1 CSS_CENSUS_OUT=census.json npx vitest run test-node/ui/admin-ui-css-cascade.test.ts -t "cascade census records"
```

普查覆盖 4 个视口宽度和 9 个页面状态，报出 767 条样式规则和 790 类争夺对。元素级事件的决胜因素分布如下（在删掉那 4 条 `!important` 之后重测）：

| 决胜因素 | 元素级次数 | 同值的次数 |
| --- | ---: | ---: |
| 特异性 | 41,861 | 14,134 |
| 书写顺序 | 3,087 | 1,899 |
| `!important` 压制 | 1,457 | 818 |
| 两条都带 `!important`，比顺序 | 201 | 108 |

跨区的争夺共 39,614 次，其中 30,267 次一旦跨过层边界就会改变渲染值。最多的三处是 `proxy↔shared` 15,201、`statistics↔shared` 8,525、`request↔shared` 6,713。把「靠特异性赢、而且两边取值不同」的争夺画成一条「必须同层」的边，得到 246 条边和这样一个拓扑：

| 连通块 | 区域 |
| --- | --- |
| 6 个区连成一块 | shared、proxy、price、request、statistics、target |
| 孤立 | preamble、json、load |

规则只有一条：靠特异性决胜的争夺，只有两条声明留在同一层里才维持原样；一旦跨层，层序就压倒特异性。上表说明六个区互相锁死，所以任何多于一个层的重构都会改变渲染值，除非先把选择器重写一遍、让优先级由层序而不是特异性决定。那是一次改像素的重写，要重生成像素基线、README 图和基线哈希，工作量以天计。

孤立的三个区也剥不出去。静态检查发现 140 条潜在翻盘，集中在 `background` 一个属性上，对手是 `button:hover`、`input:focus`、`button:disabled` 这类通用元素规则——它们发生在普查没覆盖的状态里（悬停、聚焦、禁用）。把通用交互规则放进更靠后的层能保住这 140 条，但就会让它们反过来赢掉本属于那些区的争夺（仅 `request↔shared` 一项就有 6,713 次有害跨区争夺），同一个矛盾。

`!important` 按声明粒度做了静态证明：同属性上任何可能与它落在同一元素的选择器，特异性必须严格更低；同特异性时它在文件里必须更靠后；并且没有对手也带 `!important`。被标记的那 9 条规则共 36 条声明，其中 4 条能通过这个论证，删掉后普查裁判 0 差异、像素基线不动，总数 86 降到 82。其余 32 条都有对手，不能动。

这里还有一个重叠判定的教训。后代组合符把类要求挂在祖先上，所以比较两个选择器末段的类名集合会把 `.stats-live input[type=checkbox]` 和 `.stats-date-row input` 判成不相干，而它们完全能同时命中一个复选框。只有当末段复合选择器在同一个元素上提出互斥要求（不同的元素类型，或同一属性要求不同的值）时，才应该判为不可能。

测量过程本身也暴露了两个脚本写法上的坑：把特异性元组交给 `Math.max` 会得到 `NaN`，于是所有候选都不被过滤，虚报出 2,201 条危害；正则捕获组用 `[, , a, b]` 解构会跳过第一个捕获组，于是「零有害跨区争夺」那张表是假的。任何全是零的结论，都应该先用一个必然看得见的改动去证伪。

### 4.7 UI 浏览器测试的按区拆分

原来 5,748 行的单文件浏览器测试拆成六个按区文件（proxy、history、load-balancing、visual、statistics、css-cascade），外加三个共享模块：`admin-ui-fixture.ts` 装桩数据与 `resetFixtureData()`，`admin-ui-server.ts` 装 `browser`、`page`、桩管理服务器和生命周期，`admin-ui-page.ts` 装页面导航与基线比对辅助。依赖只能单向：page → server → fixture。

共享的可变开关留在 fixture 模块里。ESM 的 import 是只读视图，跨模块赋值直接报错，所以测试体里的 30 处赋值改成 `setXxx()` 调用，只读引用一行没动。每个文件自己注册 `beforeAll`/`beforeEach`/`afterEach`/`afterAll`；Vitest 默认按文件隔离模块状态，并行文件之间不会串数据。按区跑用 `npx vitest run test-node/ui/admin-ui-history.test.ts`。

拆分后的实测：UI 仍是 `93 passed | 2 skipped`，计数一字不差；UI 墙钟 50.72 s 降到 24.07 s，全量测试墙钟 111.88 s 降到 29.59 s。像素基线没动，不需要重捕获。

两个坑值得记。按 AST 名字裁剪 import 会被变量遮蔽骗过去：census 里 `const pairs = {}` 遮蔽了从 fixture 导入的 `pairs`，静态看「用到了」其实没用到，这种修剪最后还得让 ESLint 当裁判。把字符偏移量和行号放在一起比较，会得出「测试体里 0 处赋值」的假结论——两者单位不同，永远不能互比。





### 4.8 DOM 查询的空值真实性

完整前端 ESM 图现在由 `tsconfig.ui.json` 启用 `strictNullChecks` 与 `exactOptionalPropertyTypes` 检查。`$` 按 id 查询必需 HTML 节点，缺失时抛出带选择器的初始化错误；`qs`、`qsOn`、`optionalId` 和事件目标查询仍返回可空值。

控件使用 `requiredTyped` / `optionalTyped`，通过真实 DOM 构造器检查得到 input、select、textarea、dialog 或 details；表单集合保留 input/select/textarea 联合类型，访问 checked、selectionStart 等成员前按具体类收窄。不存在 UiElement/DomElement 交叉类型或查询结果的非空断言。统计卡片生成前没有筛选器，相关控件在初始化与选项加载阶段必须使用可选查询。

`src/admin/ui-contracts.d.ts` 定义共享状态、可空异步面板、任务序列和 API 路径到服务端 DTO 的映射。api() 的成功结果只在 JSON 传输边界转换到对应 DTO；错误正文从 unknown 逐字段检查，保留合法的错误码和字段问题。这里没有声称对每个成功响应做运行时 schema 校验，也没有启用 noImplicitAny 等其余 strict 子选项。

`test-node/admin/ui-types.test.ts` 用真实 TypeScript 编译器验证完整图覆盖，并证明空值解引用、错误控件成员、无效 API 字段/路径和异步状态会被拒绝。`test-node/ui/admin-ui-dom-contracts.test.ts` 在 Chromium 中验证具体类型、可选节点、损坏页面初始化和统计错误恢复。维护入口见 `static-checks-and-split` 技能。

### 4.9 组件样式归属（统计筛选条）

累积层真正难的地方不是「哪条规则没用」，而是「同一个组件被几个 pass 分散写在哪些位置」。统计页筛选条是全表最集中的例子：原始表里有 59 条规则提到它那 10 个类，分散在 17 段连续区间里，横跨 `price catalog`（19 条）与 `statistics`（40 条）两个区块。

选定的边界是 `.stats-filters` 及其后代 10 个类（`stats-filters`、`stats-filter-group`、`stats-filter-time`、`stats-filter-label`、`stats-filter-summary`、`stats-date-row`、`stats-date-separator`、`stats-presets`、`stats-presets-group`、`stats-live`）。它们在 `index.html` 中只出现在这一个组件里，重复出现的两处（`stats-filter-label`、`stats-presets`）也在组件内部。

归属约定由两行横幅与一份静态扫描固化：`/* COMPONENT: statistics filter bar */` 与 `/* END COMPONENT: statistics filter bar */` 之间是唯一可以写这些类的地方；块内同一「上下文 + 选择器 + 属性」只写一次；块内不允许嵌套 at-rule。`test-node/ui/admin-ui-css-ownership.test.ts` 解析整张表断言这三条，并把筛选条在 4 个断点上的生效布局钉成表（`display`、`grid-template-columns` 列数、`gap`、155 px 日期格、16 px 复选框、分隔符可见性）。

删掉的都是可证的：19 条规则的选择器只含已不存在的类（`.stats-select-grid`、`.stats-filter-data`、`.stats-filter-actions`）；3 条规则把死类与活类混在同一条选择器里（如 `.stats-filter-data .stats-filter-label`），整条不可达；9 条规则的每个声明都被同选择器、同上下文、更靠后的声明压住；2 条声明与更宽上下文里的同值声明重复；另有 8 处选择器列表中的死部分与 17 条被压住的声明按需裁剪，删除后空出的 `@media` 块也一并清掉（最终表里没有空的 at-rule 块）。`.stats-overview` 的两条响应式规则只删掉其中的死选择器部分，属于另一个组件的声明原样保留。

搬进块里的是 45 条规则、118 条声明，保持原书写顺序。这里有两个必须同时做对的动作：`@media` 条件要跟着规则一起搬，否则规则会从响应式上下文里掉出来；裁剪过（而非整条搬走）的规则也必须搬走，否则它留在原位置、其余规则搬到文件更靠后处，同特异性下的顺序就反了。两者都在本次测出真实偏差后才修正（顺序反转立刻把 900 px 下的 `.stats-filter-time` 从单列变回两列）。

搬到后面之所以不改像素：能命中这 26 个元素的外部规则只有 6 条（`*`、`button, input, textarea, select`、`button`、`label`、`label span`、`input, textarea`），特异性 ≤ (0,0,2)，而块内每条选择器 ≥ (0,1,0)。特异性先于书写顺序判定，所以块内相对顺序不变、与外部规则的关系也不变。

证据分三层：自建 sweep 抓 `.stats-filters` 及 25 个后代/文本节点的全部计算长属性加 `rect`/`textContent`，20 个宽度（1400…400）× 中英文共 1040 条快照，改动前后 0 差异；仓库裁判 `CSS_CANDIDATE=<基线表>` 报 0 差异（4 视口 × 9 状态）；普查从 767 条规则、790 类争夺对变为 735 与 777，按顺序决胜 4,986 → 4,608（−378）、按 `!important` 决胜 2,275 → 2,194、两条都带 `!important` 比顺序 309 → 201，而按特异性决胜的 55,995 次一条没变——被删的声明本来都由顺序或重要性决定。规模上声明 2,500 → 2,441、规则 769 → 737、`!important` 82 → 62、行数 4,526 → 4,421；10 张视觉基线重生成后逐张哈希不变。

其余区域仍是累积层。后续组件按同一约定迁移：先选定边界、记下生效规则与跨区竞争，再逐条裁剪可证不可达的部分，每步用 sweep 与普查对拍，最后才加 `COMPONENT:` 横幅与静态扫描；不要一次性重排整张表。

## 5. 当前数据模型

### 5.1 配置聚合

```mermaid
erDiagram
  PROXY_PAIR ||--|{ TARGET : contains
  PROXY_PAIR {
    string id PK
    string name
    boolean enabled
    string listen_host
    integer listen_port
    boolean access_log
    string default_target_id FK
  }
  TARGET {
    string id PK
    string name
    boolean enabled
    string target_url
    string target_api_key
    string log_root
    boolean redact_logs
  }
```

配置实际存储为 JSON 嵌套结构，不是关系表。

### 5.2 SQLite 关系

```mermaid
erDiagram
  TASK ||--o{ RECORD : contains
  TASK ||--o{ RESPONSE_LINK : owns
  TASK ||--o{ CONTEXT_LINK : owns
  TASK ||--o{ RECORD_SEARCH : indexed_by
```

#### `tasks`

字段分组：

- 标识：`id`, `kind`, `endpoint`, `anchor`。
- 业务：`model`, `target`。
- 时间：`started_at`, `last_seen_at`（最近一次活动，含进行中请求，按旧值、记录时间和观察时间的最大值单调更新）， `last_response_at`（最近一次收到响应；不变式 `last_seen_at >= last_response_at`，任务列表排序与清理均优先使用 `last_seen_at`）。
- 状态：`request_count`, `pending_request_only`, `match_confidence`, `match_strategy_version`。
- 归并证据：`fingerprints_json`, `boundary_fingerprints_json`, `last_user_messages_json`。
- 审计：`created_at`, `updated_at`。

#### `records`

字段分组：

- 标识与关系：`id`, `task_id`, `sequence`，并有 `UNIQUE(task_id, sequence)`。
- 生命周期：`event`, `timestamp`, `started_at`, `first_token_ms`, `duration_ms`。
- 来源：proxy/client/target 字段。
- HTTP：method/path/endpoint/status/error。
- 摘要：message_count/token_count。
- 内容：request/response headers 和 body JSON。
- 改写：model_route、stripped/injected fields、added upstream headers。
- 审计：created_at/updated_at。

#### `response_links`

将上游 response ID 唯一映射到 task。

#### `context_links`

将 `prefix:value` 上下文 key 唯一映射到 task。

#### `body_chunks` / `record_body_chunks`

请求、原始请求和响应正文按 64 KiB 切块，以 SHA-256 寻址、raw DEFLATE 压缩并跨记录去重；引用表
保留块顺序，删除记录时通过引用计数回收不再使用的块。

#### `record_search_fts` / `record_search_map`

contentless FTS5 虚表只保存倒排索引，映射表保存 record/task 关系，不再复制完整搜索正文。

## 6. Python 基线并发与资源管理（历史记录）

以下并发与关闭顺序描述 v0.3.0 之前的 Python 实现。现行模型见
[现行架构](./current-architecture.md)第 1 节和第 4 节。

### 6.1 并发模型

- AdminServer：一个请求一个线程。
- 每个 ProxyServer：独立 serve_forever 线程。
- 每个代理请求：独立处理线程。
- 每个 TrafficLogger：RLock 串行 DB 写入。
- 每个 LogRepository：RLock 保护同一连接。

### 6.2 关闭顺序

1. 停止接受管理请求。
2. `ProxyManager.stop_all()`。
3. 对每个 proxy 调用 `shutdown()`。
4. 关闭并去重 TrafficLogger/SQLite connection。
5. join proxy thread，最多等待 2 秒。
6. 关闭 AdminServer。

### 6.3 失败行为

- 单个上游失败返回/记录 502，不终止其他请求。
- 某代理监听端口冲突会使启动或配置保存请求失败。
- Python 基线在配置替换过程中没有整体事务和运行时回滚。Node 版本改为整体回滚（ADR-004），
  保存失败时恢复旧配置和旧监听器（ADR-011）。
- SQLite busy timeout 后的错误会沿调用栈传播。Python 基线的代理日志写入异常可能影响请求
  处理流程；Node 版本的数据面与日志旁路分离，日志写入失败不改变客户端已收到的响应。

## 7. Node.js 目标架构（切换前的设计）

本节写于 v0.3.0 切换之前。标有“已实现”的小节描述现行行为；其余描述当时的目标，
现行结构见[现行架构](./current-architecture.md)第 5 节。

### 7.1 技术基线

- Node.js 24 LTS。
- TypeScript，ESM，严格模式。
- 原生 `node:http` / `node:https` 实现代理数据面，直接使用 Node stream/backpressure。
- 管理端可使用轻量 HTTP 框架；建议 Fastify，仅承载控制面和静态资源。
- SQLite 使用 `better-sqlite3`，由单进程 repository 管理事务；通过写队列避免并发重入。
- 运行时校验使用 Zod。
- 测试使用 Vitest；HTTP 集成测试使用 Node 原生 client 或 undici。
- Windows 托盘使用独立 Electron host，并用 electron-builder 打包；核心服务保持普通 Node 模块，可独立 CLI 运行。
- 前端第一阶段原样复用现有 HTML/CSS/JS，不引入 React/Vue。

选择原生 HTTP 数据面的原因：代理需要保持 Header、状态、字节流、SSE 延迟和 backpressure；通用 Web 框架不应接管或缓冲模型响应。

### 7.2 目标运行结构

```mermaid
flowchart TB
  CLI["CLI Host"] --> App["Application Lifecycle"]
  Tray["Electron Tray Host"] --> App
  App --> Admin["Admin Control Plane / Fastify"]
  App --> Manager["ProxyManager"]

  Manager --> Registry["ProxyRuntimeRegistry"]
  Registry --> Listener["原生 HTTP ProxyListener"]
  Listener --> Pipeline["ProxyRequestPipeline"]
  Pipeline --> Router["TargetRouter"]
  Pipeline --> Transformer["RequestTransformer"]
  Pipeline --> Forwarder["UpstreamForwarder"]
  Pipeline --> LogService["TrafficLogService"]

  LogService --> Matcher["TaskMatcher"]
  LogService --> Repos["SQLite Repositories"]
  Admin --> Query["LogQueryService"]
  Admin --> Maintenance["LogMaintenanceService"]
  Query --> Repos
  Maintenance --> Repos
```

### 7.3 建议目录

```text
src/
  main.ts
  app/
    application.ts
    shutdown.ts
  cli/
    args.ts
    browser.ts
  config/
    config-schema.ts
    config-normalizer.ts
    config-repository.ts
    defaults.ts
  admin/
    admin-server.ts
    routes/
      pairs.ts
      logs.ts
    dto.ts
  proxy/
    proxy-manager.ts
    proxy-runtime-registry.ts
    proxy-listener.ts
    proxy-request-pipeline.ts
    target-router.ts
    request-transformer.ts
    upstream-forwarder.ts
    headers.ts
    target-url.ts
    task-identity.ts
    node-identity.ts
    load-affinity.ts
    load-balancer.ts
    load-metrics.ts
    load-monitor.ts
    load-balancer-admin.ts
  logging/
    traffic-log-service.ts
    record-analyzer.ts
    task-matcher.ts
    stream-summary.ts
    redaction.ts
    payload.ts
  persistence/
    database.ts
    migrations/
      001-initial.ts
    task-repository.ts
    record-repository.ts
    link-repository.ts
    log-query-repository.ts
  maintenance/
    log-export.ts
    log-cleanup.ts
    log-roots.ts
  ui/
    static/
      index.html
      app.css
      app.js
  shared/
    errors.ts
    time.ts
    ids.ts
    types.ts
electron/
  main.ts
  tray.ts
tests/
  unit/
  integration/
  parity/
```

### 7.4 目标模块职责

#### Application Lifecycle

- 组合 config repository、DB factory、manager 和 admin server。
- 捕获 SIGINT、SIGTERM、uncaught error。
- 保证只执行一次幂等关闭。
- 对启用代理启动失败提供结构化结果，不让部分状态静默丢失。

#### ConfigRepository

- 只负责文件读取/原子保存。
- 使用 Zod 校验，再由 normalizer 补默认值。
- 区分“文件不存在”和“文件损坏”。
- 支持读取现有 Python 版 JSON。

#### ProxyManager / ProxyRuntimeRegistry

- Manager 管理配置意图。
- Registry 管理实际 listener 资源。
- `applyConfiguration()` 先验证所有配置，再计算 add/update/remove diff。
- 对同地址冲突提前检查。
- 监听地址不变且仍启用的 pair 通过 `reloadPair()` 原地换掉 pipeline；listener、端口和已在途的请求保持不变，只有被替换掉的一代资源进入 drain（见 ADR-011）。
- 失败时按 ADR-004 整体回滚，返回带阶段的 `ProxyConfigurationApplyError`。

#### ProxyRequestPipeline

编排而不实现细节：

```text
create pending record
-> collect/tee request body
-> choose target
-> transform request
-> open upstream
-> pipe response with backpressure
-> collect bounded or spooled log copy
-> finalize record
```

#### UpstreamForwarder

- 原样支持 HTTP/HTTPS。
- 正确处理 incoming chunked body。
- 使用 `stream.pipeline()` 和 backpressure。
- 不设置上游响应超时；请求截止时间由客户端控制。
- 支持 AbortController：客户端断开和应用关闭。
- 保留当前 `Connection: close` 合同作为 parity 阶段默认行为；性能优化另做变更。

#### TrafficLogService

- 日志失败不得破坏已正常进行的代理响应。
- 单个请求的 task、record 和 links 在一个 SQLite transaction 中写入。
- 通过 per-database queue 串行写入。
- 明确 original body 和 upstream body 的存储合同。

#### LogQueryService

- 组合多个日志根的查询结果。
- DTO 与 repository row 解耦。
- 保持搜索和分页语义。

#### LoadBalancing（已实现，ADR-013）

一个代理端口一份 `LoadBalancer`，它活在 runtime entry 上，不在 pipeline 里，
所以 `reloadPair()` 重建 pipeline 不会清空亲和和进行中计数。

- `task-identity.ts`：任务身份的单一来源，task matcher 与选路共用同一投影。
  路由能用的证据永远是 matcher 的子集，不会多出 matcher 看不到的键。
- `node-identity.ts`：把 scheme/host/默认端口/base path/回环别名归一成 canonical key，
  只用于采样单飞和物理聚合；亲和继续用 pair 内部的 `targetId`。
- `load-affinity.ts`：exact key 索引 + 前缀桶，桶容量 32，每组上限 4096，24 小时过期，
  按最近最少使用淘汰。绑定不存请求文本。
- `load-balancer.ts`：选路、预留、失败计数、冷却、派发时间。
  负载 = `max(本地进行中, 上游 running + waiting)`。
- `load-metrics.ts` / `load-monitor.ts`：解析 vLLM / SGLang / llama.cpp 指标名，
  每 5 秒采样，单飞按 canonical key，4 秒超时，定时器 `unref()`，
  失败与恢复每个 key 只写一行日志。采样失败不影响转发。
- `load-balancer-admin.ts`：状态接口的内存读数，响应里不包含 key、
  请求文本或会话 id。
- 组成员存成 `members: [{ target_id, model_id }]`（config schema + normalizer）。
  `loadBalancerMemberTargetIds()` 取 id，`loadBalancerMemberModelId()` 取映射，
  空字符串归一成 `undefined`；旧的 `node_target_ids` 由 normalizer 折成 `members`。

pipeline 只做三件事：问组要一个节点、预留它、请求结束时释放一次。
上游模型名取该成员的 `model_id`，为空时透传请求模型；成员自己的 `model_mappings` 不参与。
切换只发生在连接阶段且响应头未发出时，一次为限，改投后按新成员的 `model_id` 重发请求体，
`model_route.upstream_model` 记真正发出去的模型名。

#### StreamSummary

- 纯函数/小型状态机。
- 每种协议使用独立 accumulator adapter。
- 未知事件不影响已知事件摘要。
- 增加流式增量摘要接口，避免只能在响应结束后重新解析全部文本。

#### Electron Tray Host

- 仅负责 Tray、菜单、打开浏览器和核心应用生命周期。
- 不包含业务逻辑。
- Exit 必须 await 核心关闭完成后退出进程。

### 7.5 Admin 路由按功能拆分（已实现）

`createAdminServer` 原来是 752 行的单函数，里面直接写 33 条路由注册和 11 个条件块。现在拆成共享模块加八个功能文件：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `src/admin/admin-server.ts` | 147 | 建 server、请求日志钩子、错误处理、`/api/health`，然后调用各 registrar |
| `src/admin/admin-contracts.ts` | 212 | 服务接口、DTO、`adminError`、`applicationHealth`、`csvCell`、`errorProperty` |
| `src/admin/admin-schemas.ts` | 336 | 22 个 JSON schema 常量 |
| `src/admin/routes/logs.ts` | 319 | 14 条日志路由 |
| `src/admin/routes/statistics.ts` | 164 | 4 条统计路由 |
| `src/admin/routes/targets.ts` | 117 | target-check、metrics、models |
| `src/admin/routes/static-files.ts` | 30 | 页面和两个静态资源 |
| `src/admin/routes/pairs.ts` | 49 | 配置读写和启用 |
| `src/admin/routes/model-catalog.ts` | 47 | 价格导入 |
| `src/admin/routes/settings.ts` | 18 | summary-model |
| `src/admin/routes/load-balancer.ts` | 18 | 状态查询 |

条件仍然留在调用处：`if (options.logService !== undefined) registerLogRoutes(server, options.logService)`，所以“服务没接上就 404”这个行为没变。`targets.ts` 保留三个独立判断，因为三个服务各自可选。

中立性证明，全部可复跑：

- 用 TypeScript AST 比较拆分前后的路由注册：前后各 33 条，只有 1 条文本不同，差在 prettier 去掉的多余括号。
- `test-node/admin/api-contract.test.ts` 全绿：路由表、顶层响应键、错误码、静态资源的 content type 和 cache header 都没变。
- 全量测试 `957 passed | 2 skipped`，UI 像素基线不动。
- 编辑锚点重复率：拆分前单文件 `169 / 598 = 28.3%`；拆分后合计 `156 / 636 = 24.5%`，其中五个功能文件落在 0% 到 12%。

两个坑：

- 行扫描会漏掉写成多行的泛型，`server.post<{ Body: ... }>(` 跨了三行，所以计数和拆分都得用 AST。
- 静态源码守卫 `test-node/admin/usage-statistics-schema.test.ts` 读的是 `src/admin/admin-server.ts`。枚举搬进 `routes/statistics.ts` 以后守卫必须跟着换路径，否则它检查的文件里已经没有那段 schema 了。

## 8. Python 到 Node.js 模块映射

| Python 模块 | Node.js 目标模块 | 迁移方式 |
| --- | --- | --- |
| `cli.py`, `__main__.py` | `main.ts`, `cli/*` | 重写参数和信号处理 |
| `tray.py`, `tray_launcher.py` | `electron/*` | 用 Electron Tray 重写 |
| `admin_server.py` | `admin/admin-server.ts`, `admin/routes/*` | 路由拆分并加入 schema |
| `manager.py` | `proxy/proxy-manager.ts`, `proxy-runtime-registry.ts` | 拆分配置意图和运行资源 |
| `config.py`, `models.py` | `config/*`, `shared/types.ts` | Zod + inferred TypeScript types |
| `server.py` | `proxy/proxy-listener.ts`, `proxy-request-pipeline.ts`, `upstream-forwarder.ts` | 按职责拆分，使用 Node streams |
| `routing.py` | `proxy/target-router.ts` | 逐函数等价移植 |
| `target.py` | `proxy/target-url.ts` | 使用 WHATWG URL，保留路径测试 |
| `sanitize.py` | `proxy/request-transformer.ts` | 等价移植并增加契约测试 |
| `http_utils.py`, `constants.py` | `proxy/headers.ts` | 保留重复 Header 与覆盖优先级 |
| `logger.py` | `logging/traffic-log-service.ts` | 加事务、隔离日志错误 |
| `records.py` | `logging/record-analyzer.ts` | 逐测试移植 |
| `task_matcher.py` | `logging/task-matcher.ts` | 保持策略版本 4 和数据证据 |
| `streams.py` | `logging/stream-summary.ts` | 移植状态机并支持增量输入 |
| `redaction.py` | `logging/redaction.ts` | 深拷贝/不可变变换 |
| `payloads.py` | `logging/payload.ts` | 明确原始 bytes 与解析值 |
| `log_db.py` | `persistence/database.ts`, `migrations/*` | 引入显式 migration runner |
| `log_repository.py` | `persistence/*-repository.ts` | 按实体和查询职责拆分 |
| `log_store.py` | `maintenance/log-query-service.ts` | DTO 适配 |
| `log_maintenance.py` | `maintenance/log-export.ts`, `log-cleanup.ts` | ZIP 改为流式输出 |
| `log_roots.py` | `maintenance/log-roots.ts` | 纯函数移植 |
| `file_io.py` | `config/config-repository.ts` | temp + fsync + rename |
| `time_utils.py` | `shared/time.ts` | ISO 带 offset，显示用本地时区 |
| `static/*` | `src/ui/static/*` | 第一阶段原样复制 |

## 9. 目标设计关键合同

### 9.1 必须稳定的外部合同

- 本地代理的 HTTP 字节和流式时序。
- 配置字段语义和默认路径。
- 现有 SQLite 数据可读。
- 用户可见 UI 功能与视觉。
- CLI 环境变量。
- task grouping 行为。
- Admin API 的路径集合与顶层响应键。

`test-node/admin/api-contract.test.ts` 把这份 admin 合同钉住：

- 用 Fastify 的 `printRoutes` 跟源码声明比对，33 条注册全部写死在表里（多行泛型会让行扫描漏掉 4 条，所以表格来自运行时打印 + 源码交叉校验）。
- 启动一个真实应用（临时目录里的 `proxies.json`，端口 0），检查 19 个 `/api` GET 都不返回“路由未注册”的 `not_found`。
- 钉住顶层响应键，例如 `/api/logs` 的 `groups,total,limit,offset,next_offset,has_more`、`/api/usage-statistics/trend` 的 `dataVersion,granularity,points`。
- 响应 schema 只覆盖 33 条里的 17 条，请求体校验 7 条；没有响应 schema 的 16 条里，动态接口是统计 4 条、summary-model 3 条、任务摘要 2 条、日志摘要 2 条、cleanup、export，其余 3 条是页面和静态资源。schema 覆盖的接口改名会被 Fastify 自己报错（实测 `/api/health` 返回错误包），没覆盖的接口改名只会让 UI 安静地显示 `undefined`。

### 9.2 可自由调整的内部合同

根据项目 AGENTS.md，内部 API 不要求兼容。以下可直接采用最简单当前设计：

- TypeScript 内部 class/function 签名。
- repository 拆分方式。
- admin API DTO，只要同步更新当前 UI 且无需保留 Python 内部兼容层。
- 配置 normalizer 内部结构。
- logger 内部事件对象。

### 9.3 建议保留但不做兼容 shim 的合同

- 第一阶段保留现有 `/api/*` 路径，因为前端原样复用且合同简单。
- 若后续简化 API，应一次性同步更新 UI 和测试，不实现双版本路由。

## 10. 原待决设计与已作出的决策

以下事项在实现前需要 ADR，现在全部已有结论：

| 原问题                                       | 结论                                                   | 依据                                        |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| SQLite 驱动选择                               | `better-sqlite3`，同步访问，WAL                        | [ADR-001](./adr/001-sqlite-driver.md)       |
| schema v2 是否同时保存两份请求体              | 同时保存原始请求体与上游请求体                          | [ADR-002](./adr/002-original-and-upstream-request-body.md) |
| 日志 body 的内存与大小上限                    | 内存阈值 + 临时文件 spool + 硬上限后结构化截断          | [ADR-003](./adr/003-log-body-memory-and-size-limits.md) |
| 客户端断开后的行为                            | 立即中止上游                                           | [ADR-005](./adr/005-client-abort-behavior.md) |
| 配置应用失败时的策略                          | 整体回滚，不允许部分代理成功                            | [ADR-004](./adr/004-configuration-apply-transaction.md) |
| Windows 交付物                                | NSIS 安装包、portable EXE 与轻量 CLI ZIP               | [ADR-006](./adr/006-windows-artifacts.md)   |
| 是否继续强制 `Connection: close`              | 首个 Node 版本继续强制关闭                             | [ADR-007](./adr/007-connection-close-parity.md) |
| 搜索保持 LIKE 还是迁移到 FTS                  | 首版保留 LIKE；现行改用 contentless FTS5 与单一 FTS 谓词 | [ADR-008](./adr/008-search-semantics.md)、[ADR-009](./adr/009-chunked-body-storage.md)、[ADR-010](./adr/010-history-group-fts-consistency.md) |

切换后新增的决策：保存配置时复用监听器并保留在途请求（[ADR-011](./adr/011-listener-reuse-on-config-save.md)）、
日志记录解码后的响应体（[ADR-012](./adr/012-decoded-response-body-in-logs.md)）、负载均衡采用粘性路由
加最少在途选择（[ADR-013](./adr/013-load-balancing-sticky-routing.md)）。

## 11. 设计验收原则

- 数据面优先：流式代理不能被控制面框架缓冲。
- 日志旁路：日志失败不能改变上游成功响应。
- 先 parity 后优化：视觉、API、数据和任务归并先等价，再单独做性能/体验变更。
- 单向依赖：transport 不依赖 admin，domain 不依赖 UI，repository 不反向依赖 service。
- 可测试：routing、transform、redaction、record analysis、stream summary 尽量保持纯函数。
- 可关闭：所有 listener、socket、timer、DB 和 Electron 资源必须可追踪、可幂等关闭。
