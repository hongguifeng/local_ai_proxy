# Node.js 重构发布就绪报告

更新日期：2026-07-18

## REL-001：Node 测试门禁

- 命令：`PATH=/tmp/llm-proxy-node24/bin:$PATH npm run check`
- 结果：通过。
- 测试：68 个 test files 通过，487 个测试通过，1 个测试按设计跳过。
- 静态检查：Prettier、ESLint、TypeScript typecheck 全部通过。
- 构建：TypeScript 编译和管理端静态资源复制成功。

唯一跳过项是配置仓库的 Windows 专用原子替换重试场景；该场景由 Windows CI 执行，不属于 Linux 本地失败。

## REL-002：Parity fixture 门禁

- 覆盖：综合配置 fixture、原始字节 payload fixture、HTTP/HTTPS 代理 fixture、综合 SQLite fixture、迁移关系校验。
- 结果：5 个 test files 通过，71 个测试通过，1 个 Windows 专用测试按设计跳过。
- 数据校验：fixture 中 task、record、response link、context link 和 search 文档的计数、关系及抽样内容一致。

## REL-003：Windows artifact smoke 门禁

- 环境：Windows 10.0.26100（WSL2 宿主），Windows Node.js 24.18.0。
- 构建：`electron-builder 26.15.3` 成功生成 x64 NSIS installer 与 portable EXE。
- 原生依赖：`better-sqlite3` 按 Electron 40.9.3 ABI 重建成功。
- Smoke：portable EXE 使用隔离的 user-data、配置和日志目录启动，`/api/health` 返回成功。
- 关闭：测试通过退出信号执行应用自身的优雅关闭路径，管理端口释放，且没有遗留的打包进程。

本门禁首次执行时发现 ESM main 顶层等待 `app.whenReady()` 的启动死锁；修复后重新进行完整 Windows 打包和 smoke，最终通过。
