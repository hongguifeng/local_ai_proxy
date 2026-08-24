# LLM Proxy 软件功能说明书

## 1. 文档目的

本文档描述当前 Python 版本 LLM Proxy 的实际软件功能、用户操作、外部行为、数据规则和已知边界，作为 Node.js 重构的功能基线与验收依据。

- 代码基线：`main@cae3d73`
- 梳理日期：2026-07-17
- 验证结果：`python3 -m unittest discover -s tests -v`，66 项测试全部通过
- 事实来源：当前源码、静态前端、README、自动化测试和界面截图

本文档优先描述代码实际行为。若 README 与实现存在差异，以“当前实现行为”为准，并在“已知边界”中说明。

## 2. 产品定位

LLM Proxy 是面向本地开发和调试场景的 LLM HTTP 代理与流量审查工具。它通过一个 Web 管理控制台同时管理多个本地监听端口，将请求转发到 OpenAI-compatible 或 Anthropic/Claude Messages 风格的上游服务，并把请求、响应和任务关系写入 SQLite，供浏览、搜索、导出和清理。

系统主要由三类入口组成：

1. Web 管理控制台：配置代理、启停服务、查看历史日志。
2. 本地代理监听端口：接收 Agent、SDK 或其他 HTTP 客户端的请求并转发。
3. Windows 托盘启动器：无控制台窗口运行管理服务，并提供打开管理页面和退出菜单。

## 3. 用户角色与典型场景

### 3.1 本地开发者

- 把 OpenAI SDK、Claude SDK、Agent 或自研客户端的 Base URL 指向本地代理。
- 检查实际发送的请求字段、模型名、Header 和上游响应。
- 对比不同模型服务或网关的兼容性。

### 3.2 模型服务调试人员

- 将多个本地模型服务挂到同一个监听端口。
- 按 `model` 字段选择不同上游并改写模型名。
- 移除不兼容的采样参数，或注入固定元数据。

### 3.3 Agent 工作流分析人员

- 查看一次 Agent 工作中产生的多次模型请求。
- 按任务展开请求序列，查看消息数、Token 数、状态和耗时。
- 导出任务为 ZIP，或删除不再需要的任务记录。

## 4. 系统级功能清单

| 编号 | 功能 | 当前实现 |
| --- | --- | --- |
| F-01 | 多代理实例管理 | 一个管理端可管理多个本地监听地址和端口 |
| F-02 | 多上游管理 | 每个代理实例可配置一个或多个上游目标 |
| F-03 | 按模型路由 | 读取顶层 JSON `model`，按目标顺序匹配模型映射 |
| F-04 | 默认上游回退 | 未匹配、无模型或非 JSON 请求走默认目标 |
| F-05 | 模型名改写 | 映射命中后可把本地模型名改为上游模型名 |
| F-06 | HTTP 转发 | 支持 GET、POST、PUT、PATCH、DELETE、OPTIONS、HEAD |
| F-07 | Header 处理 | 过滤 hop-by-hop Header，重写 Host，增加 X-Forwarded-* |
| F-08 | 上游鉴权 | 每个目标可配置 API Key 或自定义 Header |
| F-09 | 请求字段改写 | 顶层 JSON 字段先删除、后注入 |
| F-10 | 流式响应透传 | SSE 按行及时转发，普通响应按 64 KiB 分块转发 |
| F-11 | 流量日志 | SQLite 保存请求、响应、状态、耗时、目标、消息数、Token 数等 |
| F-12 | 请求生命周期日志 | 记录 received、pending response、finished 状态并更新同一记录 |
| F-13 | 任务归并 | 按 response id、上下文 key、请求指纹和消息序列归并多轮请求 |
| F-14 | 日志搜索 | 搜索任务、请求、响应、Header、状态、时间、ID、目标和错误 |
| F-15 | 日志分页 | 任务列表支持 limit/offset，单页上限 500 |
| F-16 | 日志详情 | 请求/响应 JSON 树、元信息、换行、展开、格式化和复制 |
| F-17 | 日志导出 | 所有日志按任务导出 ZIP，包含 Markdown、request.json、response.json |
| F-18 | 日志清理 | 可按选中任务、保留最近 N 项或早于 N 天删除 |
| F-19 | 日志脱敏 | 可按上游目标开启 Header 和常见 JSON 密钥字段脱敏 |
| F-20 | 配置持久化 | 原子写入 `proxies.json`，启动时自动加载 |
| F-21 | 中英文界面 | 中文/英文切换并保存到浏览器 localStorage |
| F-22 | 自动刷新 | History 页面默认每 3 秒刷新；同步更新展开列表中的 pending 请求，页面不可见时跳过实际加载 |
| F-23 | Windows 托盘 | 托盘菜单打开管理 UI 或退出，可选启动后自动打开浏览器 |

## 5. 代理配置功能

### 5.1 代理实例 Proxy Pair

每个代理实例包含：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 自动生成或 `default` | 配置和运行时标识 |
| `name` | string | ID 或“新代理” | UI 显示名称 |
| `enabled` | boolean | `false` | 是否在保存/启动后运行 |
| `listen_host` | string | `127.0.0.1` | 本地监听地址 |
| `listen_port` | integer | `1234` | 本地监听端口，可在测试中使用 0 获取随机端口 |
| `access_log` | boolean | `false` | 是否输出 Python HTTP Server 访问日志；当前 UI 未提供编辑控件 |
| `targets` | array | 一个默认目标 | 上游目标列表，至少保留一个 |
| `default_target_id` | string | 第一个目标 ID | 未匹配请求的回退目标 |

运行状态通过管理 API 附加返回：

- `running`：当前是否存在对应监听服务。
- `actual_listen_port`：实际绑定端口；未运行时为 `null`。

### 5.2 上游目标 Target

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `id` | string | `target-N` | 目标标识 |
| `name` | string | 目标 ID | UI 显示名称 |
| `enabled` | boolean | `true` | 非默认目标是否参与模型匹配 |
| `target_url` | string | `http://127.0.0.1:1235` | 仅支持 `http`、`https`，可含基础路径 |
| `target_api_key` | string | 空 | 自动生成/替换 `Authorization: Bearer ...` |
| `target_headers` | string[] | 空 | 每项格式为 `Name: value`，覆盖同名客户端 Header |
| `strip_request_fields` | string | 空 | 逗号分隔的顶层 JSON 删除字段 |
| `inject_request_fields` | string | 空 | JSON object 字符串，作为顶层字段注入或覆盖 |
| `log_root` | string | `logs` | 该目标的 SQLite 日志根目录；空字符串表示不记录 |
| `redact_logs` | boolean | `false` | 是否在写入存储前脱敏 |
| `model_mappings` | array | 空 | `{listen, upstream}` 模型映射列表 |

默认目标在 UI 中始终视为启用。非默认目标关闭后不参与模型匹配，但配置仍保留。

代理不设置上游响应超时。请求截止时间由客户端控制，客户端断开时中止对应上游请求。

### 5.3 配置加载与保存

- 默认配置文件：`logs/proxies.json`。
- 首次启动且配置文件不存在时，内存中创建一个关闭状态的默认代理。
- 配置保存采用同目录临时文件、flush、fsync、原子替换，降低部分写入风险。
- 配置文件存在但无法读取、JSON 非法或顶层结构错误时，当前实现返回空代理列表，不自动恢复默认配置，也不在 UI 中显示明确告警。
- 保存整个 `pairs` 数组后：
  - 已删除代理停止运行。
  - 启用代理执行重启，使新配置立即生效。
  - 关闭代理停止运行。
- 单独切换启用状态时，前端会先保存整份配置，再调用启停接口。

## 6. 模型路由规则

### 6.1 路由输入

系统尝试把完整请求体按 UTF-8 JSON 解析，并读取顶层字符串字段 `model`。

下列情况视为没有可路由模型：

- 空请求体。
- 非 UTF-8 或非法 JSON。
- JSON 顶层不是 object。
- `model` 不存在或不是 string。

### 6.2 路由算法

1. 从 `default_target_id` 找到默认目标；找不到时使用目标列表第一项。
2. 若请求存在字符串模型名，则按目标配置顺序遍历。
3. 对非默认且 `enabled=false` 的目标跳过匹配。
4. 在目标的 `model_mappings` 中按顺序匹配；监听模型中的 `*` 可匹配任意长度字符串，其余字符按字面值、区分大小写匹配，不支持正则表达式。
5. 第一个匹配项立即选定目标。
6. 若映射中的 `upstream` 非空，则重写请求 JSON 顶层 `model`。
7. 无匹配时使用默认目标，不改写模型名。

默认目标也可以配置模型映射并在遍历中被命中；其关闭状态不影响兜底能力。

### 6.3 路由示例

```text
Target A: A-gpt-5.5 => gpt-5.5
Target B: qwen-local => qwen3
Default: Target C
```

- `model=A-gpt-5.5`：发往 A，上游收到 `model=gpt-5.5`。
- `model=qwen-local`：发往 B，上游收到 `model=qwen3`。
- `model=unknown`：发往 C，模型名保持 `unknown`。
- 无 JSON `model`：发往 C，请求体保持原样。

## 7. HTTP 转发行为

### 7.1 支持的客户端方法

当前显式支持：`GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS`、`HEAD`。

当前未实现 `CONNECT`、WebSocket Upgrade 和透明 TCP 隧道。

### 7.2 请求路径拼接

`target_url` 可携带基础路径，例如 `https://host/api/v1`。

- 客户端路径未包含基础路径时：基础路径前置。
- 客户端路径已经等于基础路径或以 `基础路径/`、`基础路径?` 开头时：不重复拼接。
- 请求 query string 保留。
- `target_url` 自身的 query 和 fragment 不参与转发。

### 7.3 请求 Header

系统执行以下处理：

1. 丢弃客户端的 `Host`。
2. 丢弃 hop-by-hop Header：`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`。
3. 设置上游 `Host`，非默认端口时附带端口。
4. 增加 `X-Forwarded-For`，值为当前客户端 IP。
5. 增加 `X-Forwarded-Host`，值为原始 Host。
6. 自定义上游 Header 覆盖所有同名 Header。
7. 若配置 API Key，覆盖 `Authorization`：
   - 已以 `Bearer ` 开头时原样使用。
   - 否则自动加 `Bearer `。
8. 根据实际转发请求体重新计算 `Content-Length`。

### 7.4 请求体改写顺序

请求体处理顺序固定为：

1. 读取客户端请求体。
2. 根据模型映射改写 `model`。
3. 删除 `strip_request_fields` 指定的顶层字段。
4. 注入 `inject_request_fields`，同名字段覆盖现有值。
5. 用最终字节长度更新上游 `Content-Length`。

只有合法 UTF-8 JSON object 才会执行字段删除和注入。非 JSON、JSON array、字符串、数字等请求体保持原样。

### 7.5 请求体读取边界

当前实现只读取 `Content-Length` 指定的请求体；没有 `Content-Length` 时按空请求体处理。因此，传入端使用 `Transfer-Encoding: chunked` 的请求不在完整支持范围内。这是 Node.js 重构必须加入回归用例的兼容边界。

### 7.6 上游响应

- 上游返回状态码和 reason phrase 原样发给客户端。
- 响应 Header 中移除 hop-by-hop Header 和 `Content-Length`。
- 强制返回 `Connection: close`，每次响应后关闭客户端连接。
- `HEAD` 不转发响应体。
- 连接或上游处理失败时，若尚未发送响应 Header，则返回 HTTP 502。
- 若响应已经开始后发生错误，保留已转发内容，并在日志中记录错误。

### 7.7 流式响应

- `Content-Type` 包含 `text/event-stream` 时，通过 `readline()` 按行读取，每行写入客户端后立即 flush。
- 其他响应按 64 KiB 分块读取和写入。
- 两种响应都会同时在内存中累积完整响应体，用于最终日志写入。

因此，当前实现具备低延迟透传，但对超大或无限响应存在内存持续增长风险。

## 8. 日志与任务功能

### 8.1 日志存储位置

- 每个上游目标可使用独立 `log_root`。
- 每个日志根目录下使用 `traffic.db`。
- 同一管理端可以同时读取多个目标对应的数据库，并按时间合并任务列表。
- `log_root` 为空时，该目标不写入日志。

### 8.2 请求生命周期

每个请求使用 32 位十六进制 UUID 作为记录 ID，生命周期事件如下：

1. `request_received`：请求到达。
2. `request_pending_response`：请求体已读取、目标已选择，等待上游响应。
3. `request_finished`：上游结束或失败，包含最终状态、响应体、耗时和错误。

这些事件通过 SQLite upsert 更新同一个 record，而不是产生三条历史记录。最终正常状态下每个客户端请求对应一个 record。

单目标代理会在读取请求体前写入 received 日志，便于观察客户端上传卡住的请求；多目标代理必须先读取请求体完成模型路由，才知道日志应写入哪个目标的数据库。

### 8.3 日志记录字段

记录包含或派生出：

- 请求 ID、任务 ID、任务内序号。
- 生命周期事件、开始时间、更新时间、耗时。
- 代理 ID/名称。
- 客户端 host/port。
- 目标 ID/名称/完整目标 URL。
- HTTP method、原始 path、去 query 的 endpoint。
- 响应状态、错误文本。
- 请求消息数、响应 Token 数。
- 请求/响应 Header。
- 请求/响应解析后的 JSON 或文本包装对象。
- 模型路由信息。
- 删除字段、注入字段和新增上游 Header 名称。

重要的当前行为：当请求发生模型改写、字段删除或字段注入时，SQLite 的 `request_body` 优先保存最终发往上游的 `upstream_body`。原始客户端 body 虽然存在于转发过程的内存记录中，但不会作为独立数据库字段保留。重构时应明确选择继续这一行为，或新增 `original_request_body`；不得在未决定数据合同前静默改变。

### 8.4 Body 解析与保存

- 合法 JSON：保存为解析后的 JSON 值。
- 可识别 SSE：保存为 `stream_summary` JSON。
- 其他文本或二进制替换文本：保存 `{text, size_bytes}`。
- 内部转发记录短暂保留 `size_bytes`、完整 Base64 和 UTF-8 replacement text，但 SQLite 只保存解析后的业务值，不保存 Base64 原始字节。

### 8.5 消息数统计

- Responses API：`input` 项数，加上存在的 `instructions`。
- Claude Messages：`system` 项数加 `messages` 数量。
- Chat Completions：`messages` 数量。
- Completions：`prompt` 为列表时取长度，否则存在时为 1。
- 其他请求：尝试统计 `messages` 或 `input`。

### 8.6 Token 统计

按以下顺序寻找 usage：

1. `stream_summary.usage`
2. 顶层 `usage`
3. `response.usage`

优先使用 `total_tokens`。若没有，则合计存在的：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

### 8.7 SSE 摘要

系统识别仅含 JSON `data:` 行的 SSE。任一非 JSON data 片段会使摘要失败，并回退为普通文本。

摘要支持：

- OpenAI Responses：输出文本、reasoning、function call 参数、web search call、usage、状态、紧凑 response 元数据。
- OpenAI Chat Completions：content、reasoning_content/reasoning/reasoning_text、tool_calls、finish_reason、usage。
- Anthropic Messages：text、thinking、tool_use、input_json_delta、stop_reason、usage、紧凑 message 元数据。
- `[DONE]` 是否出现和 JSON 事件数。

陌生摘要值有保护限制：单字符串 2,000 字符、列表 20 项、嵌套深度 5。已识别的最终 content/reasoning 当前没有统一总长度限制。

### 8.8 任务归并

系统把多个相关 LLM 请求归入 task。已识别类型：

- `/responses`
- `/messages`
- `/chat/completions`
- `/completions`
- 其他路径作为独立请求任务

匹配优先级：

1. 同一 request ID 的 pending 记录。
2. Responses 的 `previous_response_id` 对应已有 response link。
3. 显式上下文 key：conversation、conversation_id、thread_id、metadata 中的 conversation/thread/session、prompt_cache_key 等。
4. 最近 24 小时内的启发式匹配。
5. 无匹配时创建新 task。

静态边界包括：

- endpoint 类型和具体 path。
- model。
- Responses：`instructions` 和第一条非固定上下文用户消息。
- Chat/Messages：system/developer 内容和第一条非固定上下文用户消息。
- Completions：prompt。

启发式续接还要求：

- 当前用户消息序列以前一任务的用户消息序列开头。
- 当前序列比旧序列更长，或完整 input/messages 指纹发生变化，提供真正的后续证据。

为避免 Codex 环境块导致误分组，以下前缀的上下文消息不参与用户序列和内容指纹：`<environment_context>`、`<permissions instructions>`、`<app-context>`、`# Codex desktop context`。

## 9. 日志检索、详情、导出与清理

### 9.1 任务列表

- 默认每页 100，前端可继续“加载更多”。
- 后端单次 limit 最小 1、最大 500。
- 按 `last_response_at`、`last_seen_at`、`started_at` 的优先级倒序。
- 多日志根时，各数据库分别读取 `offset + limit` 项，再在内存中合并排序和截页。

### 9.2 搜索语义

搜索字符串按空白拆成多个 term，多个 term 之间为 AND。

可匹配：

- task 的 ID、类型、endpoint、anchor、model、target、时间、指纹等。
- record 的 ID、序号、事件、代理、客户端、目标、method、path、status、错误、计数。
- 请求/响应 Header 和 Body。
- 模型路由、删除/注入字段、上游 Header。
- ISO 时间和格式化后的本地时间。

`%`、`_` 和反斜杠按字面字符转义处理。

### 9.3 详情读取

详情 API 返回：

- `request`：请求业务内容。
- `response`：响应业务内容。
- `request_meta`：ID、序号、时间、耗时、method、path、endpoint、target、proxy、client、message_count、路由/改写信息和 Header。
- `response_meta`：status、首字耗时、总耗时、token_count、error 和 Header。

前端对未完成响应持续刷新详情，直到 response meta 出现 status 或 error。

### 9.4 ZIP 导出

当前导出所有已配置日志根中的全部 task，不支持只导出勾选项。ZIP 结构：

```text
tasks/
  <时间>__<模型>__<类型>__<task-id>/
    index.md
    <序号>__<endpoint>__<record-id>/
      summary.md
      request.json
      response.json
```

ZIP 当前整体在内存中生成后一次性返回。

### 9.5 清理

后端支持三种策略：

- `group_ids`：删除明确选择的 task。
- `older_than_days`：删除最后活动时间早于指定天数的 task。
- `keep_latest`：保留每个日志根中最近 N 个 task，删除其余 task。

当前 UI 只暴露勾选 task 后按 `group_ids` 清理。删除 task 时通过外键级联删除 records、response links、context links，并显式删除对应搜索记录。

## 10. 日志脱敏与安全

### 10.1 脱敏范围

敏感 Header 名称大小写不敏感：

- `Authorization`
- `Proxy-Authorization`
- `X-API-Key`
- `Api-Key`

敏感 JSON key 名称大小写不敏感，递归处理 object 和 array：

- `api_key`
- `apikey`
- `authorization`
- `access_token`
- `refresh_token`
- `token`
- `password`
- `secret`

替换值统一为 `[redacted]`。

### 10.2 生效时机

- 脱敏只影响写入存储的记录。
- 实际转发请求保持真实值。
- API Key 仍以明文写入 `proxies.json`。
- 非 JSON 文本 body 不执行敏感内容扫描。

### 10.3 安全边界

- 管理 API 无登录、无 CSRF 防护、无访问控制。
- 管理服务默认绑定 `127.0.0.1`；绑定公网地址需要用户自行增加网络保护。
- 代理监听端口同样无鉴权，是否暴露由 `listen_host` 决定。
- 日志可能含 prompt、文件内容、工具参数、密钥和模型输出。

## 11. Web 管理界面

### 11.1 总体布局

- 顶部固定高度 Header：产品名、Proxy/History Tab、语言选择。
- Proxy 页面：纵向代理卡片，每个卡片内的上游目标按可用宽度自动换行。
- History 页面：左侧任务/请求列表，右侧上下分栏 Request/Response 详情。
- 桌面端支持左右列表分隔条、上下请求响应分隔条拖动。
- 小于 760 px 时转为移动布局，日志列表位于详情上方，目标卡使用单列布局。

视觉基线：浅灰背景、白色主卡片；目标卡使用浅蓝、浅绿、浅灰分别表示默认、启用、未启用；绿色运行/主按钮状态；系统字体和等宽 JSON 字体。重构应复用现有 HTML/CSS 或以截图回归保证等价。

### 11.2 Proxy 页面交互

- 添加/删除代理。
- 修改名称、监听地址、端口。
- 通过开关启停代理，绿色圆点显示正在运行。
- 添加/删除上游目标，目标至少保留一个。
- 选择默认目标。
- 修改目标名称、URL、API Key 和模型映射。
- API Key 默认密码显示，可切换可见和复制。
- 非默认目标可启停。
- 目标卡背景色随默认、启用、未启用状态即时变化。
- “更多配置”展开 log root、脱敏、Header、删除字段、注入字段。
- 保存配置后显示 Toast。
- 目标列表随容器宽度自动调整每行数量。

### 11.3 History 页面交互

- 点击“搜索”按钮后执行搜索；搜索进行中时搜索框下方显示动画进度条，搜索完成后自动隐藏。
- 全选/取消全选、清理选中、导出、手动刷新按钮；自动刷新开关位于刷新按钮之后（文字位于复选框下方，纵向排列，靠右对齐，空间不足时自动换到下一行右侧）。
- task 可独立勾选用于清理；“全选”按钮选中列表中全部 task，全部选中后按钮切换为“取消全选”，再次点击取消全部选中。
- 自动刷新默认开启，正常间隔约 3 秒；展开列表中的 pending 请求完成后自动更新并停止轮询。
- task 默认折叠；点击 task header 展开并按需加载请求列表。
- 请求标题显示任务内序号、消息数、Token 数或状态。
- 当前选中请求使用绿色浅背景。
- task 列表支持“加载更多”。

### 11.4 JSON 查看器

- Object/array 以可折叠树显示，默认展开深度为 2。
- 展开按钮每次向下展开一级；全部展开后再次点击恢复默认展开深度。
- Request 和 Response 独立控制自动换行。
- 支持把含转义符、换行或超过 200 字符的 string 格式化显示。
- 长 string 使用摘要和可展开正文，并可复制格式化文本。
- 支持复制完整 JSON。
- 支持显示/隐藏请求和响应元信息。
- Response 标题栏显示首字耗时和总耗时，使用 `分:秒` 格式并按最接近的整秒显示；旧记录缺少首字数据时仅显示总耗时。
- 记录包含首字耗时、总耗时和 token 数时，标题栏额外显示 Prefill 和 Decode 速度（token/s）：Prefill = 请求 token 数 / 首字耗时；Decode = 响应 token 数 / (总耗时 - 首字耗时)。速度 ≥ 1000 时显示为 `k`（如 `1.2k`），≥ 100 取整，否则保留 1 位小数；对应耗时或 token 数缺失/非正时不显示该速度。
- 自动刷新 selected record 时保留对象、数组、格式化长字符串的展开状态、滚动位置和视图选项。

### 11.5 国际化

- 支持 `zh` 和 `en`。
- 首次使用按浏览器语言选择中文或英文。
- 用户选择保存在 `localStorage.llmProxyLanguage`。
- 切换语言会重新渲染代理、日志和 JSON 控件标题，但不丢失表单输入。

## 12. 管理 HTTP API

所有 JSON 响应使用 UTF-8。当前接口如下：

| 方法 | 路径 | 功能 | 主要输入/输出 |
| --- | --- | --- | --- |
| GET | `/` | 管理页面 | HTML |
| GET | `/static/app.css` | 样式 | CSS |
| GET | `/static/app.js` | 前端逻辑 | JavaScript，启动时注入建议删除字段 |
| GET | `/api/pairs` | 代理列表 | `{pairs}`，含运行状态 |
| PUT | `/api/pairs` | 整体替换配置 | 请求 `{pairs: [...]}`，返回 `{pairs}` |
| POST | `/api/pairs/{id}/enabled` | 启停代理 | 请求 `{enabled}`，返回 `{pair}` |
| GET | `/api/logs` | task 分页 | query: `q`,`limit`,`offset` |
| GET | `/api/log-groups/{id}/logs` | task 请求列表 | query: `q` |
| GET | `/api/logs/{id}` | 单条详情 | request/response/meta |
| GET | `/api/logs/export` | 导出全部日志 | ZIP 下载 |
| POST | `/api/logs/cleanup` | 清理日志 | `group_ids` / `older_than_days` / `keep_latest` |

错误主要以 `{error: string}` 返回 400 或 404。非法 JSON 请求体当前会被当作空 object，而不是单独返回 JSON 解析错误。

## 13. 启动、环境变量与托盘

### 13.1 CLI

```text
python -m llm_proxy
```

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--host` | `LLM_PROXY_UI_HOST` | `127.0.0.1` |
| `--port` | `LLM_PROXY_UI_PORT` | `18080` |
| `--application-config` | `LLM_PROXY_APPLICATION_CONFIG_FILE` | `llm-proxy.json` |
| `--config-file` | `LLM_PROXY_CONFIG_FILE` | `logs/proxies.json` |
| `--log-root` | `LLM_PROXY_LOG_ROOT` | `logs` |
| `--no-browser` | `LLM_PROXY_NO_BROWSER=1` | false |

CLI 默认延迟 0.5 秒打开管理页面；Ctrl+C 后停止管理端和全部代理。

### 13.2 Windows run.bat

`run.bat` 执行 `python -m llm_proxy --no-browser`，与 README 中“自动打开浏览器”的默认 CLI 行为不同。

### 13.3 托盘模式

- 参数与 CLI 基本相同，另有 `--open-on-start` / `LLM_PROXY_OPEN_ON_START=1`。
- 菜单：Open Admin UI、Exit。
- 左键默认菜单项打开管理页面。
- 使用随 Electron 应用打包的 Windows ICO 和 PNG 托盘图标。
- portable 版本使用原始 EXE 所在目录保存配置和日志，installer 版本使用用户数据目录。

### 13.4 Python 包调用面

`llm_proxy.__init__` 当前导出一组可被其他 Python 代码直接 import 的对象，包括 `ProxyManager`、`ProxyServer`、`ProxyHandler`、`TrafficLogger`，以及 target、sanitize、payload、stream 和 time helper。README 没有把这些 import 作为稳定 SDK 进行说明，自动化测试也主要通过模块直接导入。

Node.js 重构不可能保持 Python import 兼容，但应在新的 npm package 中导出有实际复用价值的 TypeScript 模块，例如 config、routing、request transform、stream summary 和应用启动函数。是否把底层 listener/repository 作为正式公共 API，应在发布前明确，避免无意形成新的长期兼容负担。

项目还包含 `examples/responses_client.py`，演示 OpenAI Python SDK 指向 `http://localhost:1234/v1`。其中注释引用了当前 CLI 不存在的 `--target-url` 参数，重构时应改为 Node/OpenAI SDK 示例，并通过 Web UI 或配置文件设置上游。

## 14. 非功能特性与当前限制

### 14.1 已具备

- Python 运行时核心无第三方依赖。
- 多线程管理服务和多线程代理服务。
- SQLite WAL、foreign keys、5 秒 busy timeout、NORMAL synchronous。
- 配置原子写入。
- 流式响应及时透传。
- 对本地时区的时间戳存储和显示。
- 完整单元/集成测试覆盖核心路径。

### 14.2 当前限制

- 仅支持 HTTP/1.1 代理，不支持 HTTP/2、CONNECT、WebSocket。
- 客户端 chunked request body 不完整支持。
- 每次请求强制关闭客户端连接，不复用连接。
- 上游响应完整累积在内存中，日志无单条大小上限。
- 导出 ZIP 完整累积在内存中。
- 管理端和代理端没有鉴权与速率限制。
- 配置中的 API Key 明文存储。
- SQLite schema version 只写版本号，没有迁移框架。
- 多日志根的分页在应用层合并，日志根很多时效率下降。
- schema v4 延续 v3 的 contentless FTS5 和 64 KiB 去重压缩正文，并为请求记录新增首字耗时字段。
- History task 内请求固定最多读取 200 条，UI 没有 task 内继续分页入口。
- UI 的导出按钮导出全部任务，而非仅勾选任务。
- 原始请求体与最终上游请求体没有同时持久化。
- 无健康检查、结构化运行日志和可观测性指标。
- 无配置文件损坏的显式错误提示。
- Python 示例中的 `--target-url` 启动说明已经与当前 Web UI 配置方式不一致。

## 15. Node.js 重构验收基线

Node.js 版本至少必须满足：

1. 本文 F-01 至 F-23 的用户可见能力全部可用。
2. 现有四类 LLM API 的请求摘要、流摘要和任务归并测试结果等价。
3. HTTP Header、路径拼接、模型路由、字段改写顺序与当前行为一致，除非在重构决策记录中明确批准变更。
4. 原有 `proxies.json` 和 `traffic.db` 可被新版本直接读取，或提供一次性、可回滚的数据迁移工具。
5. 现有 HTML/CSS/JS 视觉和交互首先原样复用；任何视觉重做必须另立需求，不与运行时迁移混合。
6. SSE 首字节/首行不能等待上游结束后才到达客户端。
7. pending record 与 finished record 必须保持同一 record ID、task ID 和 sequence。
8. Windows 托盘启动、打开管理页面、退出并停止全部监听服务的功能保留。
9. 自动化测试覆盖当前 66 项行为，并增加 chunked、超大流、关闭中断和数据迁移测试。

## 16. 关联文档

- [模块设计文档](./module-design.md)
- [Node.js 重构计划](./nodejs-refactoring-plan.md)
- [Node.js 重构 Todo](./nodejs-refactoring-todo.md)
