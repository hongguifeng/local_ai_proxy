# Python 原型外部行为清单

- 基线版本：`a70f8b5`（Python `v0.2.0`）
- 清单日期：2026-07-10
- 验证基线：`python -m pytest`，66 项通过
- 用途：定义 Node.js 重构的黑盒对照范围，不把 Python 模块、类或函数签名视为 contract

## 1. 分类规则

| 分类 | 含义 |
| --- | --- |
| 必须保留 | 用户可依赖的产品能力或协议语义；Node 实现需有自动化对照测试 |
| 允许改变 | 能力保留，但路径、字段、错误格式、默认值或内部表示按 Node 设计简化 |
| 明确删除 | 原型偶然行为、内部 API 或与正式安全/可靠性目标冲突的行为 |

本清单描述迁移所需的最低产品行为。Node 管理 API 统一迁移到 `/api/v1`，不为旧 `/api/*` 增加兼容层。

## 2. CLI、路径与环境变量

依据：`llm_proxy/cli.py`、`llm_proxy/config.py`、`pyproject.toml`、`README.md`。

| 当前行为 | 当前值 | 分类 | Node 约束 |
| --- | --- | --- | --- |
| 服务命令 | `llm-proxy` | 必须保留 | npm/便携包均提供同名可执行入口 |
| 托盘命令 | `llm-proxy-tray` | 允许改变 | 桌面外壳由阶段 10 ADR 决定，不属于 server contract |
| `--host` | admin bind host | 允许改变 | 默认 `127.0.0.1`；非 loopback 需显式 flag 和 token |
| `--port` | admin port，默认 `8088` | 必须保留 | 范围校验失败返回配置错误 exit code |
| `--config-file` | 默认 `logs/proxies.json` | 必须保留 | 支持显式路径；正式默认数据目录可在切换前按平台规范调整 |
| `--log-root` | 默认 `logs` | 必须保留 | 空值代表关闭默认日志；target 可覆盖 |
| `--no-browser` | 禁止启动后打开浏览器 | 必须保留 | 仅在 admin ready 后打开，失败只警告 |
| `LLM_PROXY_UI_HOST` | 对应 `--host` | 允许改变 | 若保留，CLI 参数优先 |
| `LLM_PROXY_UI_PORT` | 对应 `--port` | 允许改变 | 非整数产生可诊断错误 |
| `LLM_PROXY_CONFIG_FILE` | 对应 `--config-file` | 必须保留 | CLI 参数优先 |
| `LLM_PROXY_LOG_ROOT` | 对应 `--log-root` | 必须保留 | CLI 参数优先 |
| `LLM_PROXY_NO_BROWSER=1` | 等价 `--no-browser` | 允许改变 | Node schema 明确接受值，不沿用 Python truthiness |
| 启动输出 | UI、config、log 路径 | 允许改变 | 改为 Pino 结构化 ready/error event |
| 正常中断 | `KeyboardInterrupt` 后返回 0 | 必须保留 | SIGINT/SIGTERM 统一 drain |

Node 新增 `--help`、`--version`、`--allow-remote-admin` 和认证 token 配置。Python 包内函数和 `python -m llm_proxy` 的实现细节不保留。

## 3. 持久化配置

依据：`llm_proxy/config.py`、`llm_proxy/models.py`、`llm_proxy/manager.py`、`tests/test_sanitize_manager.py`。

配置文件当前为 `{ "pairs": ProxyPair[] }`。Node 使用 versioned config v1；一次性迁移接受下表中的 Python 字段，在线 API 使用新的共享 schema。

### 3.1 Proxy 字段

| 字段 | Python 默认/语义 | 分类 |
| --- | --- | --- |
| `id` | 缺失时由对象长度生成不稳定值 | 必须保留 ID 能力，删除不稳定生成规则 |
| `name` | 默认等于 `id` | 必须保留 |
| `enabled` | 默认 `false`；启动时监听启用项 | 必须保留 |
| `listen_host` | 默认 `127.0.0.1` | 必须保留 |
| `listen_port` | 默认 `1234`；测试允许 `0` 获取临时端口 | 必须保留 |
| `access_log` | 是否打印简要访问日志 | 允许改变为结构化日志级别 |
| `targets` | 至少一个；空值时原型自动补默认 target | 保留至少一个约束，删除在线静默补全 |
| `default_target_id` | 不存在时回退第一个 target | 保留 fallback 能力，非法显式 ID 改为拒绝 |
| runtime `running` | 是否存在 listener | 必须保留为 public DTO 派生字段 |
| runtime `actual_listen_port` | 实际监听端口或 `null` | 必须保留 |

### 3.2 Target 字段

| 字段 | Python 默认/语义 | 分类 |
| --- | --- | --- |
| `id`、`name` | 默认 `target-N`，name 默认 ID | 必须保留字段，Node 要求同 proxy 内 ID 唯一 |
| `enabled` | 默认 `true` | 必须保留 |
| `target_url` | 默认 `http://127.0.0.1:1235`；只接受 HTTP/HTTPS host | 必须保留 |
| `target_api_key` | 空或 token；转发时规范为 Bearer | 保留转发能力；public DTO 禁止返回完整值 |
| `target_headers` | `Name: value` 数组，同名覆盖客户端 header | 保留语义，在线 schema 可改为结构化数组 |
| `strip_request_fields` | 逗号字符串或列表；只删除 JSON 顶层字段 | 必须保留 |
| `inject_request_fields` | JSON object 字符串；写入 JSON 顶层 | 保留，Node 在线 schema 直接用 object |
| `timeout` | 默认 600 秒 | 保留可配置能力；Node 分离超时阶段并限制范围 |
| `log_root` | target 优先于全局；空字符串关闭该 target 日志 | 必须保留 |
| `redact_logs` | 默认 `false` | 保留，但 secret 在 Worker 前始终强制移除 |
| `model_mappings` | `{listen, upstream}[]` | 保留；listen 唯一、值非空 |

跨字段约束：proxy ID、监听地址必须唯一；target ID 必须唯一；`default_target_id` 必须指向存在的 target；启用 proxy 必须至少有一个可用 target；端口、timeout、capture limit 必须在 schema 范围内。Python 对这些约束的静默归一化属于明确删除行为。

## 4. 管理 API 基线

依据：`llm_proxy/admin_server.py`、`llm_proxy/log_store.py`、`tests/test_admin_ui.py`。能力必须保留，旧路径和旧错误格式允许改变。

| Python endpoint | 能力 | 典型 response | 分类与 Node endpoint |
| --- | --- | --- | --- |
| `GET /api/pairs` | 列出配置和 runtime 状态 | `{ "pairs": [...] }` | 改为 `GET /api/v1/proxies`，隐藏 secret |
| `PUT /api/pairs` | 整体替换配置并启停 listener | `{ "pairs": [...] }` | 原子 `PUT /api/v1/proxies` |
| `POST /api/pairs/:id/enabled` | 启停单个 proxy | `{ "pair": {...} }` | 改为 `/api/v1/proxies/:id/enabled` |
| `GET /api/logs?q&limit&offset` | 跨 root 搜索、分页 task | `{groups,total,limit,offset,has_more}` | 改为 `/api/v1/tasks` |
| `GET /api/log-groups/:id/logs?q` | task 和 record 列表 | `{...task,logs:[...]}` | 拆为 task/record 分页 contract |
| `GET /api/logs/:id` | record 详情 | `{request,response,request_meta,response_meta}` | 改为 `/api/v1/records/:id` |
| `POST /api/logs/cleanup` | 按天数、数量或 task ID 删除 | `{deleted_count,...}` | 保留并设置 schema/并发边界 |
| `GET /api/logs/export` | 下载 task index 和 payload ZIP | ZIP bytes | 保留，Node 必须流式生成 |
| `GET /`、静态资源 | 提供管理 UI | HTML/CSS/JS | 保留，资源路径和 cache header 可变 |

请求示例：

```json
{"pairs":[{"id":"local","enabled":true,"listen_host":"127.0.0.1","listen_port":1234,"targets":[{"id":"openai","target_url":"https://api.openai.com"}],"default_target_id":"openai"}]}
```

```json
{"enabled":false}
```

```json
{"older_than_days":30,"keep_latest":1000,"group_ids":["task-id"]}
```

Node 错误统一为 `{ "error": { "code", "message", "details"? }, "requestId": "..." }`。Python 的 `{error: string}`、未知字段忽略、坏 JSON 当空对象、非法 query 回退默认值和未限制 body 均明确删除。

## 5. 代理协议行为

依据：`llm_proxy/server.py`、`llm_proxy/routing.py`、`llm_proxy/target.py`、相关测试。

### 5.1 请求、URL 与路由

- 必须保留 HTTP/1.1 常见 method 原样转发：`GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS`、`HEAD`。
- 必须保留 target base path 前置；已位于相同 path boundary 时不重复；query 原样随 path 转发。
- 只从 UTF-8 JSON object 的顶层 string `model` 路由；无效 JSON、非 object 或非 string model 走 default target。
- 按配置顺序匹配 `model_mappings.listen`，跳过禁用的非默认 target；匹配后可改写顶层 `model`。
- 顶层 strip 后 inject，再应用 model rewrite；无效 JSON 或非 object body 原样转发。日志记录实际 transform metadata。
- Python 只读 `Content-Length` 且缓存完整 request。Node 改为有界读取、取消和明确拒绝超限；首发不承诺 chunked request passthrough。
- 明确删除 CONNECT、WebSocket upgrade、入站 HTTP/2/3 和正向代理 absolute-form URL。

### 5.2 Header

- 保留 header 多值，不用普通 object 合并不可合并字段。
- 删除固定 hop-by-hop header：`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`。
- 解析 `Connection` 中动态列出的 token 并删除对应 header。这是对 Python 缺陷的修正。
- 重写 `Host`；设置 `X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto`，明确定义防伪造规则。
- target header 覆盖客户端同名 header；API key 最后覆盖 `Authorization`，裸 token增加 `Bearer `。
- body 变换后重算 `Content-Length`；Node API 拒绝 CR/LF 注入和非法 header 字符。

### 5.3 Response、流式和故障

- 保留 upstream status、reason 和 end-to-end response header 多值语义。
- 普通响应和 SSE 必须流式转发；首个 SSE event 不等待 upstream 完成；慢客户端通过 backpressure 限制内存。
- `HEAD` 不转发 body。客户端断开取消 upstream；timeout/DNS/TLS/socket 错误映射为稳定 502/504。
- capture、SSE 摘要和日志是旁路逻辑；解析、存储或队列过载失败不能中断转发。
- Python 强制下游 `Connection: close` 且删除 response `Content-Length`；Node 可安全复用连接，但必须正确 framing。

## 6. Traffic record 与 SQLite 语义

依据：`llm_proxy/logger.py`、`llm_proxy/log_db.py`、`llm_proxy/log_repository.py` 及测试。

### 6.1 生命周期

| event | 语义 | 分类 |
| --- | --- | --- |
| `request_received` | body 尚未完整处理的 pending record | 允许改名，必须保留 in-flight 可见性 |
| `request_finished` | 同一 record ID 原位更新为最终状态 | 必须保留 |
| failure | 最终 record 带 error 和可用 status/partial response | 必须保留，错误结构可变 |

每个 record 保留稳定 string ID、时间、duration、client、proxy、target、request、response/error 和 transform metadata。observed bytes、captured bytes、truncated 是 Node 新增必需字段。

### 6.2 schema v1 语义

- `tasks`：分组 ID、endpoint、model/target、时间、请求数、pending、匹配版本和 fingerprints。
- `records`：task 外键和 sequence、请求/响应元数据、状态、错误、统计、payload 和 transform metadata；task 内 sequence 唯一。
- `response_links`：Responses response ID 到 task；`context_links`：conversation/session key 到 task。
- `record_search`：FTS5 task/request/response/error 搜索。
- 保留 foreign key cascade、WAL、busy timeout、分页、literal `%`/`_` 搜索、跨 root 聚合、按 task 删除和 ZIP 导出。
- 表结构和 API DTO 可变，但 migration 后计数、关联、顺序和用户内容等价。
- SQLite 在线访问移至 Worker，主事件循环不得执行同步 SQL。

## 7. Endpoint 摘要与 task 匹配

依据：`llm_proxy/records.py`、`llm_proxy/streams.py`、`llm_proxy/task_matcher.py` 及测试。

| path suffix | kind | 摘要/分组 |
| --- | --- | --- |
| `/responses` | `responses` | input/instructions/tools、response ID、usage、SSE text/reasoning/tool call |
| `/messages` | `messages` | Claude system/messages/tools、usage、SSE content/tool blocks |
| `/chat/completions` | `chat` | messages/tools、delta content/tool call、usage |
| `/completions` | `completions` | prompt、text/usage |
| 其他 | `other` | 单请求 task、通用 message/input 计数 |

path 判断忽略 query、尾斜杠和大小写。匹配优先级：

1. 相同 record ID 的 pending/final 得到相同 task 和 sequence。
2. Responses `previous_response_id` 或 conversation/session context link，且 kind、endpoint、model 和 boundary 相容。
3. 24 小时窗口内按 boundary fingerprint、user-message 前缀和最近时间做 continuation。
4. model/boundary 改变或无 continuation evidence 时新建 task。
5. 非模型 endpoint 每个 request 单独建 task。

策略版本当前为 4。Node 可升级算法，但保留显式链接、pending promotion、稳定 sequence，并用 fixture 固定有意行为。所有遍历新增深度、项数和字节上限。

## 8. 脱敏与 payload 表示

- Python 保存完整 base64、UTF-8 replacement text 和 byte size；有效 JSON 转对象，SSE 转摘要，其他文本包装为 `{text,size_bytes}`。
- 保留 binary/text/JSON/SSE 的可辨识表示，但 Node 改为有界 capture。
- header 脱敏至少覆盖 Authorization、Proxy-Authorization、X-API-Key、Api-Key，大小写不敏感。
- JSON key 脱敏至少覆盖 api key、authorization、access/refresh token、token、password、secret，并设置遍历上限。
- target secret 在进入日志事件和 Worker 队列前移除。public config API 不得返回完整 secret。

## 9. 禁止复制的原型缺陷

以下行为均为“明确删除”，Node 测试应证明不会重现：

- request、response、SSE 和 ZIP export 在内存中无界聚合。
- SQLite 同步调用与请求路径耦合；日志失败可影响代理。
- API 列表直接回显 `target_api_key`。
- 配置替换先保存/停止旧 runtime，再启动新 runtime；失败会导致状态不一致。
- 配置损坏、非法字段、坏 JSON 或 query 被静默当作空值/default。
- 重复 ID、非法 default target、端口和 timeout 缺少严格校验。
- 只删除固定 hop-by-hop header，不解析 `Connection` 动态 token。
- 客户端断开不保证取消 upstream；timeout 未区分阶段。
- 原始 exception message 返回客户端，可能泄漏路径、header 或 secret。
- admin 可任意绑定且没有认证、Origin/CORS、body limit。
- response capture 通过 chunk 数组保留完整 body，造成线性内存增长。
- 配置无 size limit、schema version、权限检查和并发版本。
- 递归脱敏和 fingerprint 无统一深度/项数上限。
- 管理 API 的 404/405、malformed JSON 和 content type 行为不统一。

## 10. 对照覆盖关系

| 行为域 | Python 测试 | 后续 fixture/Node 测试 |
| --- | --- | --- |
| URL、model 路由和改写 | `test_target.py`、`test_routing.py`、`test_server.py` | `0.3`、`2.3`/`2.4`、`5.x` |
| strip/inject、脱敏 | `test_sanitize_manager.py`、`test_redaction.py` | `0.3`、`2.5` |
| 普通/SSE 转发 | `test_server.py`、`test_streams.py` | `0.4`、`3.x`/`5.x` |
| SQLite/task/search | `test_log_db.py`、`test_log_repository.py`、`test_task_matcher.py` | `0.3`、`4.x` |
| 管理 API/UI | `test_admin_ui.py` | `7.x`、`8.4` |

阶段 11 以本清单和语言无关 fixture 为准；Python 内部对象布局、线程类型、旧 API path 和错误字符串不构成兼容要求。

