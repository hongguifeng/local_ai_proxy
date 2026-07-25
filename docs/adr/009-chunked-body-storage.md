# ADR-009：正文分块去重与 contentless FTS

- 状态：已接受
- 日期：2026-07-25
- 决策范围：SQLite 流量正文存储、全文搜索和数据库压缩迁移

## 背景

长对话会在每次请求中重复携带完整历史上下文。旧 schema 同时在 `records` 和 contentful FTS5
表保存正文，并额外维护倒排索引。真实数据库中 5,000 余条记录因此占用约 8.9 GB，其中约 95%
来自请求正文、FTS 内容副本和索引。

64 KiB 固定分块实测可将约 3.93 GB 请求正文去重为约 258 MB；唯一块使用 level 1 raw DEFLATE
后约 109 MB。

## 决策

1. schema v3 新增 `body_chunks`，以正文块 SHA-256 为主键，保存 codec、原始长度、压缩数据和引用数。
2. `record_body_chunks` 按 record、正文类型和顺序引用块，能够逐字节还原原 JSON 文本。
3. 请求、原始请求和响应都使用同一块存储；`records` 中旧正文列迁移后置为 `NULL`。
4. 删除块引用时由 SQLite trigger 更新引用数并回收最后一个引用。
5. 搜索改用 `record_search_fts` contentless FTS5 与 `record_search_map`，不保存第二份正文。
6. FTS 查询采用 token/prefix `MATCH`。任务自身的元数据仍支持原有大小写无关子串匹配。
7. `compact:traffic` 只迁移在线备份副本，并在交付前验证正文摘要、关系数量、完整性和外键。

## 后果

- 长对话存储增长接近新增内容量，不再随完整上下文长度重复增长。
- 正文读取需要查询块、解压并拼接；管理端按页读取，成本受单页记录数限制。
- 正文搜索从任意 `LIKE '%term%'` 子串语义调整为 FTS token/prefix 语义。
- v3 代码不为旧内部表结构提供写入兼容层；迁移前必须保留可回滚的完整数据库备份。
