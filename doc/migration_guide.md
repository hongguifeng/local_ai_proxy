# Python 到 Node.js 数据迁移指南

Node.js 版本使用独立的新数据目录，不会在运行时读取或写入 Python 数据目录，也不提供长期双读、双写兼容层。切换前请停止 Python 进程，再执行一次性迁移。

## 迁移命令

```powershell
llm-proxy migrate --source <python-data-dir> --target <node-data-dir>
```

- `source` 是包含旧版 `proxies.json` 以及各日志目录中 `traffic.db` 的共同根目录。
- `target` 必须不存在或为空，且不能与 `source` 相同。
- 迁移不会自动收集 `source` 之外由 `log_root` 指向的文件；请先把这些目录纳入共同根目录，或分别保留其备份。
- 配置中的 API key、完整请求和响应正文属于敏感数据。目标目录及备份应仅允许服务账号访问，不应上传到问题单或公共制品。

迁移会把 Python snake_case 配置转换为 Node.js v1 配置，复制 SQLite 数据库并执行当前 Node schema migration。原始文件会原样复制到 `<node-data-dir>/backup`，随后执行记录数、SQLite integrity check 和 foreign key check。

## 重复执行和失败语义

成功后，目标目录包含 `.migration-complete.json`，记录源文件哈希。对完全相同的源数据重复执行会返回 `already_migrated`，不会重复导入。若目标非空、标记无效、源数据发生变化或目标来自另一份数据，命令会拒绝继续。

迁移使用临时 staging 目录，完成全部复制、schema 升级、校验及源哈希复查后才原子切换为目标目录。失败时只清理 staging，不修改或删除唯一源数据。

## 切换与回滚

1. 停止 Python 服务并对整个 Python 数据目录做离线备份。
2. 执行迁移命令，保存 `migration_complete` 输出。
3. 使用 Node.js 服务的 `--config-file <node-data-dir>/proxies.json` 和相应日志根目录启动。
4. 验证管理界面、代理请求、历史记录和健康检查后再开放流量。

需要回滚时停止 Node.js 服务，保留失败现场或删除整个 Node 目标目录，然后用未被修改的 Python source 重新启动旧版本。不要尝试把 Node schema 数据库反向覆盖到 Python source。
