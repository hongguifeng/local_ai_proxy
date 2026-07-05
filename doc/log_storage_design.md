# 日志存储重构设计

本文档记录日志存储的重构设计。当前项目仍处在初期开发和功能验证阶段，因此本设计不保留旧内部 API、旧存储字段或旧日志目录格式的兼容性。目标是把日志系统直接调整到更合理的形态，而不是在旧的 JSON 文件索引上继续补丁式演进。

## 结论

新的唯一在线日志存储是：

```text
{log_root}/traffic.db
```

SQLite 数据库是 source of truth。旧的这些在线写入路径会被移除：

- `{log_root}/.task-index.json`
- `{log_root}/tasks/**/index.md`
- `{log_root}/tasks/**/request.json`
- `{log_root}/tasks/**/response.json`
- 运行时 Markdown 摘要文件

Markdown、JSON 文件和 ZIP 仍可以作为导出格式存在，但不再作为在线查询或任务归类的数据源。

## 当前方案复盘

当前实现是“目录 + Markdown 摘要 + request/response JSON + 全局 JSON 索引”。

典型结构：

```text
logs/
  .task-index.json
  tasks/
    {task-dir}/
      index.md
      {request-dir}/
        {summary}.md
        request.json
        response.json
```

关键模块：

- `llm_proxy/logger.py`：写入请求目录、Markdown、JSON。
- `llm_proxy/task_index.py`：维护 `.task-index.json`。
- `llm_proxy/task_grouper.py`：基于内存 JSON 索引做任务归类。
- `llm_proxy/log_store.py`：读取 `.task-index.json` 和目录文件供 UI 展示。
- `llm_proxy/log_maintenance.py`：递归导出和删除任务目录。

这个方案适合早期验证，但它把“归档格式”和“在线查询索引”混在了一起。随着日志增长，会出现几个结构性问题：

- 每次写入都会合并并重写整份 `.task-index.json`。
- 列表查询读取全量任务索引后再排序和过滤。
- 展开单个任务组时遍历该任务目录下的所有请求目录。
- 搜索只是在少量元数据字符串上做包含匹配。
- 多文件写入无法形成一个真正的事务。
- 清理任务目录后，索引可能残留无效映射。
- 大量小文件在 Windows 上容易受到目录遍历、杀毒、同步工具影响。

本地合成数据的粗略验证结果：

```text
1,000 tasks   index 0.6MB   list 7ms     save rewrite 22ms
10,000 tasks  index 6.5MB   list 75ms    save rewrite 221ms
50,000 tasks  index 32MB    list 590ms   save rewrite 1.25s
```

这说明主要瓶颈不是 JSON 语法本身，而是“全量索引文件 + 目录扫描”的数据结构。

## 新方案原则

### 不保留兼容层

本次重构不实现 `FileLogRepository`，不提供旧 `.task-index.json` 到 SQLite 的自动导入，不让 UI 同时读取两套存储。

原因：

- 当前项目处于早期阶段，旧日志不是稳定产品数据格式。
- 保留双路径会增加测试矩阵和长期维护成本。
- 旧字段和目录名本来就是为文件系统妥协出来的，不应该进入新模型。

如果未来真的需要旧日志迁移，可以单独写一次性脚本，而不是把兼容逻辑留在运行时代码里。

### 数据库是在线模型

UI 列表、详情、搜索、清理、任务归类都直接查询 SQLite。导出时从 SQLite 生成文件。

### 元数据列化

列表页和过滤常用字段必须是普通列，不从 JSON body 或 Markdown 中解析：

- task 时间、模型、类型、目标、请求数
- record 时间、序号、method、path、endpoint、status、token count
- request id、response id、context key

### 正文按需读取

request/response body 可以很大，列表页不读取正文。详情页读取完整正文。全文搜索只索引提取后的文本摘要，不把所有原始 JSON 强行塞进 FTS。

### 短事务

每个 request 状态更新使用一个 SQLite 事务。pending、request body 已读、response finished 都可以 `UPSERT` 同一条 record。

### 多 log root 仍保留

当前 target 可以配置不同 `log_root`。这个概念仍然有价值，因为不同上游可能需要不同日志目录。每个 log root 对应一个独立的 `traffic.db`。

## 数据库位置与连接

数据库路径：

```text
{log_root}/traffic.db
```

初始化连接时执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

说明：

- WAL 让 UI 读取和代理写入可以更自然地并发。
- foreign keys 让删除 task 时自动删除 records、response links、context links。
- busy timeout 避免短暂写锁直接导致失败。
- synchronous NORMAL 适合本地日志场景，性能和可靠性比较平衡。

## Schema

### `schema_meta`

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

保存 `schema_version`，初始版本为 `1`。

### `tasks`

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  endpoint TEXT,
  anchor TEXT,
  model TEXT,
  target TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_response_at TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  pending_request_only INTEGER NOT NULL DEFAULT 0,
  match_confidence REAL NOT NULL DEFAULT 1.0,
  match_strategy_version INTEGER NOT NULL,
  fingerprints_json TEXT NOT NULL DEFAULT '{}',
  boundary_fingerprints_json TEXT NOT NULL DEFAULT '{}',
  last_user_messages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_tasks_sort ON tasks(COALESCE(last_response_at, last_seen_at, started_at) DESC);
CREATE INDEX idx_tasks_model ON tasks(model);
CREATE INDEX idx_tasks_kind ON tasks(kind);
CREATE INDEX idx_tasks_target ON tasks(target);
```

说明：

- 不保存旧的 `dir_name`。
- `request_count` 是冗余字段，用于快速列表展示。
- 指纹字段保留为 JSON 文本，因为它们只由任务匹配逻辑读写，不需要频繁独立过滤。

### `records`

```sql
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms REAL NOT NULL DEFAULT 0,

  proxy_id TEXT,
  proxy_name TEXT,
  client_host TEXT,
  client_port INTEGER,

  target_id TEXT,
  target_name TEXT,
  target_url TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  endpoint TEXT NOT NULL,

  status INTEGER,
  error TEXT,
  message_count INTEGER,
  token_count INTEGER,

  request_headers_json TEXT NOT NULL DEFAULT '{}',
  response_headers_json TEXT NOT NULL DEFAULT '{}',
  request_body_json TEXT,
  response_body_json TEXT,

  model_route_json TEXT,
  stripped_fields_json TEXT NOT NULL DEFAULT '[]',
  injected_fields_json TEXT NOT NULL DEFAULT '[]',
  added_upstream_headers_json TEXT NOT NULL DEFAULT '[]',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(task_id, sequence)
);

CREATE INDEX idx_records_task_sequence ON records(task_id, sequence);
CREATE INDEX idx_records_timestamp ON records(timestamp DESC);
CREATE INDEX idx_records_endpoint ON records(endpoint);
CREATE INDEX idx_records_status ON records(status);
CREATE INDEX idx_records_target_url ON records(target_url);
```

说明：

- 初版直接用 TEXT 保存 JSON body，避免过早引入压缩逻辑。
- 如果后续真实 body 规模明显过大，再把 body 字段迁移为 gzip BLOB。
- `event` 存当前状态，例如 `request_received`、`request_pending_response`、`request_finished`。

### `response_links`

```sql
CREATE TABLE response_links (
  response_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
```

用于 Responses API 的 `previous_response_id` 链接。

### `context_links`

```sql
CREATE TABLE context_links (
  context_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
```

用于 conversation、thread、session、prompt cache 等上下文。

### `record_search`

```sql
CREATE VIRTUAL TABLE record_search USING fts5(
  record_id UNINDEXED,
  task_id UNINDEXED,
  task_text,
  request_text,
  response_text,
  error_text
);
```

FTS 内容只保存提取文本：

- task id、model、target、endpoint
- request messages、input、tool call 参数
- response text、reasoning、tool result 摘要
- error

原始 JSON body 不直接全量索引。

## 写入流程

`TrafficLogger` 改为 SQLite 写入器。它仍然是 server 层使用的入口，但不再写文件。

写入步骤：

1. 收到 `TrafficRecord`。
2. 如果 target 开启 `redact_logs`，先脱敏。
3. 解析 request/response body 为 JSON 值。
4. 根据 endpoint 判断 task kind。
5. 如果 request body 还 pending，创建或复用 pending task。
6. 如果 body 已读：
   - 先按 request id 查找已有 record/task。
   - 再按 `previous_response_id` 查 `response_links`。
   - 再按 context key 查 `context_links`。
   - 最后用现有启发式规则查最近 task。
7. 在一个事务中：
   - upsert task
   - upsert record
   - 更新 task request_count、last_seen_at、last_response_at
   - upsert response links 和 context links
   - 更新 FTS

## 读取流程

### 任务列表

```sql
SELECT ...
FROM tasks
WHERE query filters
ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC
LIMIT ? OFFSET ?;
```

返回给 UI 的 group shape 可以保持简洁：

```json
{
  "id": "task-id",
  "title": "2026-07-06 12:00:00 - 12:03:10",
  "meta": "gpt-5 | 8 requests | http://...",
  "model": "gpt-5",
  "target": "http://...",
  "request_count": 8
}
```

### 任务内请求

```sql
SELECT ...
FROM records
WHERE task_id = ?
ORDER BY sequence DESC
LIMIT ? OFFSET ?;
```

不扫描目录，不解析 Markdown。

### 单条详情

```sql
SELECT *
FROM records
WHERE id = ?;
```

详情接口直接返回 request/response JSON。

## 清理与导出

清理选中任务：

```sql
DELETE FROM tasks WHERE id IN (...);
```

外键级联删除 records、links。FTS 表需要在同一事务中按 task id 删除。

导出 ZIP 时动态生成：

```text
tasks/
  {task-title}/
    index.md
    {sequence}-{record-id}/
      summary.md
      request.json
      response.json
```

导出目录名不承诺稳定，不作为数据 API。

## 废弃模块

重构完成后，这些模块应该删除或明显缩减：

- `task_index.py`
- `log_files.py`
- 文件扫描型 `log_store.py`
- 目录删除型 `log_maintenance.py`

新的核心模块：

- `log_db.py`：连接、schema、基础 JSON 编解码。
- `log_repository.py`：SQLite 写入、查询、清理、导出。
- `task_matcher.py` 或重构后的 `task_grouper.py`：只负责任务匹配，不负责文件路径。

## 测试策略

测试不再验证旧目录结构。新的测试重点：

- schema 初始化会创建 `traffic.db` 并启用必要 PRAGMA。
- `TrafficLogger.write/update` 会 upsert task 和 record。
- pending -> finished 会更新同一个 record，不产生重复请求。
- previous response id 和 context key 能归到同一 task。
- UI `/api/logs`、`/api/log-groups/{id}/logs`、`/api/logs/{id}` 从 SQLite 返回数据。
- 清理任务会级联删除 records 和 links。
- 导出 ZIP 能从 SQLite 生成 Markdown/JSON 文件。
- 脱敏发生在入库前。

## 参考

- SQLite WAL: https://sqlite.org/wal.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
- SQLite JSON1: https://sqlite.org/json1.html
- OpenTelemetry Logs Data Model: https://opentelemetry.io/docs/specs/otel/logs/data-model/
