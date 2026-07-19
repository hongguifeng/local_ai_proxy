# ADR-001：SQLite 驱动选择

- 状态：已接受
- 日期：2026-07-18
- 决策范围：Node.js 核心日志数据库和 Electron 打包

## 背景

Python 版本使用标准库 `sqlite3`，依赖以下能力：

- 同步事务和 upsert。
- WAL、foreign keys、busy timeout、NORMAL synchronous。
- FTS5 虚表。
- 多日志根、长期写连接和短期查询连接。
- Windows 桌面打包。

Node.js 目标运行时为 24 LTS。候选方案是 Node 内置 `node:sqlite` 和 `better-sqlite3`。

## 实测

在本地 Node `v24.14.0` 中执行：

```javascript
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("create virtual table f using fts5(x)");
```

FTS5 可用，但运行时仍输出：

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

## 选项

### `node:sqlite`

优点：

- 不增加 npm native dependency。
- 与 Node runtime 一起分发。
- 本地实测包含 FTS5 和同步 API。

缺点：

- Node 24.14 仍标记为 experimental。
- API 和行为在重构周期内仍可能变化。
- Electron 使用的 Node 版本不一定与 CLI 的 Node 24 小版本完全一致。

### `better-sqlite3`

优点：

- API 成熟，事务和 prepared statement 简单。
- 同步模型与当前 Python repository 接近。
- FTS5、WAL 和 SQLite backup 能力成熟。
- 社区已有 Electron 使用和 rebuild 流程。

缺点：

- 原生模块需要与 Node/Electron ABI 匹配。
- Windows CI 和 electron-builder 必须执行 native rebuild。
- 安装包体积和供应链依赖增加。

## 决策

选择 `better-sqlite3` 作为正式 SQLite 驱动。

实现规则：

1. 版本固定到 lockfile。
2. 所有 SQL 封装在 `src/persistence`，业务模块不得直接依赖驱动类型。
3. 每个数据库连接继续设置 WAL、foreign keys、busy timeout 和 NORMAL synchronous。
4. repository 操作保持短事务；task、record、links 作为一次事务提交。
5. 每个 log root 使用串行写队列，避免同步驱动长时间重入。
6. CI 必须在 Windows Node CLI 和 Electron 打包产物中验证 FTS5。
7. electron-builder 配置必须 rebuild `better-sqlite3`。

## 后果

- Node 核心会包含一个 native dependency。
- 开发环境需要可用的预编译二进制或本地编译工具链。
- 打包 smoke test 成为 P0 gate，不能只在源码测试中验证数据库。
- 若未来 `node:sqlite` 去除 experimental 状态，可单独 ADR 评估替换；repository 边界应使替换不影响领域层。
