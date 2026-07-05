# 日志存储重构 TODO

本文档是日志存储重构的执行清单。当前项目无需兼容旧存储格式，因此每个阶段都按“直接替换旧实现”的方式推进。

## 执行规则

- 每完成一个编号任务，先提交对应代码或文档变更。
- 提交完成后，把该任务的状态、提交号和验证结果记录到本文档。
- 记录进度本身也需要提交，避免 TODO 文档和 git 历史脱节。
- 如果某个任务拆分出新的必要子任务，先补充到本文档，再继续实现。

## 进度记录

| 任务 | 状态 | 提交 | 验证 |
| --- | --- | --- | --- |
| 0.1 设计收紧与 TODO 文档 | 已完成 | `87124a8` | 文档检查 |
| 1.1 SQLite schema 与连接基础 | 已完成 | `91bf67f` | `python -m unittest tests.test_log_db` |
| 1.2 SQLite repository 读写骨架 | 已完成 | `e1bb90c` | `python -m unittest tests.test_log_db tests.test_log_repository` |
| 2.1 任务匹配迁移到 SQLite | 已完成 | `4131632` | `python -m unittest tests.test_log_db tests.test_log_repository tests.test_task_matcher` |
| 2.2 TrafficLogger 改为 SQLite 写入 | 已完成 | `515b62a` | `python -m unittest tests.test_log_db tests.test_log_repository tests.test_task_matcher tests.test_sqlite_logger tests.test_redaction` |
| 3.1 Admin 日志查询切换到 SQLite | 待开始 |  |  |
| 3.2 清理与导出切换到 SQLite | 待开始 |  |  |
| 4.1 删除旧文件索引实现 | 待开始 |  |  |
| 4.2 文档、测试和收尾 | 待开始 |  |  |

## 0. 设计与计划

### 0.1 设计收紧与 TODO 文档

- [x] 重写 `doc/log_storage_design.md`，明确 SQLite 是唯一在线存储。
- [x] 明确不保留 `.task-index.json`、`tasks/` 目录、运行时 Markdown/JSON 写入兼容。
- [x] 编写本文档作为分阶段执行清单。
- [x] 提交文档基线。
- [x] 回填进度记录。

## 1. SQLite 存储基础

### 1.1 SQLite schema 与连接基础

- [x] 新增 `llm_proxy/log_db.py`。
- [x] 定义 `traffic.db` 路径规则。
- [x] 初始化 SQLite 连接。
- [x] 执行 PRAGMA：WAL、foreign keys、busy timeout、synchronous NORMAL。
- [x] 创建 `schema_meta`、`tasks`、`records`、`response_links`、`context_links`、`record_search`。
- [x] 增加基础单元测试，验证 schema 和 PRAGMA。
- [x] 提交代码。
- [x] 回填进度记录。

### 1.2 SQLite repository 读写骨架

- [x] 新增 `llm_proxy/log_repository.py`。
- [x] 实现 JSON 编解码辅助。
- [x] 实现 task upsert。
- [x] 实现 record upsert。
- [x] 实现 response/context link upsert。
- [x] 实现基础 list/get/delete 方法。
- [x] 增加 repository 单元测试。
- [x] 提交代码。
- [x] 回填进度记录。

## 2. 写入链路重构

### 2.1 任务匹配迁移到 SQLite

- [x] 从旧 `TaskGrouper` 中提取与文件路径无关的任务匹配逻辑。
- [x] 移除对 `TaskIndexStore`、`dir_name`、request directory 的依赖。
- [x] 实现 request id、previous response id、context key、启发式匹配的 SQLite 查询。
- [x] 保留 pending request 归类能力。
- [x] 增加任务匹配测试。
- [x] 提交代码。
- [x] 回填进度记录。

### 2.2 TrafficLogger 改为 SQLite 写入

- [x] `TrafficLogger` 使用 `LogRepository`。
- [x] 删除运行时 Markdown/JSON 写入。
- [x] pending -> finished 更新同一 record。
- [x] 入库前保留现有脱敏行为。
- [x] manager/server 中继续按 target log root 创建 logger。
- [x] 更新 server/logger/redaction 测试。
- [x] 提交代码。
- [x] 回填进度记录。

## 3. 管理端读取、清理和导出

### 3.1 Admin 日志查询切换到 SQLite

- [ ] `LogStore` 改为 SQLite 查询，或用 repository 替代。
- [ ] `/api/logs` 从 `tasks` 分页查询。
- [ ] `/api/log-groups/{id}/logs` 从 `records` 分页查询。
- [ ] `/api/logs/{id}` 从 `records` 查询详情。
- [ ] 搜索至少覆盖 task id、record id、model、target、endpoint、method、path、status。
- [ ] 更新 admin UI 测试。
- [ ] 提交代码。
- [ ] 回填进度记录。

### 3.2 清理与导出切换到 SQLite

- [ ] `cleanup_logs` 删除 SQLite task。
- [ ] `export_logs_zip` 从 SQLite 动态生成 Markdown/JSON。
- [ ] 删除目录递归导出和删除逻辑。
- [ ] 更新导出/清理测试。
- [ ] 提交代码。
- [ ] 回填进度记录。

## 4. 移除旧实现与收尾

### 4.1 删除旧文件索引实现

- [ ] 删除或清空 `task_index.py`。
- [ ] 删除或清空 `log_files.py`。
- [ ] 删除旧文件扫描路径。
- [ ] 删除测试中对旧目录结构的断言。
- [ ] 确认 `rg ".task-index|tasks/" llm_proxy tests` 不再命中运行时依赖。
- [ ] 提交代码。
- [ ] 回填进度记录。

### 4.2 文档、测试和收尾

- [ ] 更新 README / README.cn 中的磁盘日志说明。
- [ ] 更新工程结构说明。
- [ ] 运行 `python -m unittest discover -s tests`。
- [ ] 运行 `python -m compileall -q llm_proxy tests`。
- [ ] 如环境可用，运行 `python -m ruff check .`。
- [ ] 最终检查 git 状态。
- [ ] 提交代码。
- [ ] 回填进度记录。
