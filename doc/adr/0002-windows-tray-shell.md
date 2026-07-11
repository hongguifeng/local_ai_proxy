# ADR-0002: Windows 托盘外壳

- 状态：已接受
- 日期：2026-07-11
- 决策阶段：10.3

## 候选验证

| 候选 | 原型安装体积 | 启动到 ready | 空闲工作集 | native addon / 签名 / CI | 更新与多平台成本 |
| --- | ---: | ---: | ---: | --- | --- |
| Electron 39 薄壳 | 约 290 MiB | 约 0.8 s | 约 110 MiB | SQLite 可作为外部 Node 进程使用；需同时签名 Electron 壳和产物；CI 下载 Chromium | 自动更新成熟，但版本和多平台矩阵最大 |
| Node SEA | 约 88 MiB 加外部资源 | 约 0.3 s | 约 30 MiB | SEA 不能消除 `better-sqlite3.node`、Web、migration 等外部文件；注入与签名顺序复杂 | Node 原生，但 native addon/资源更新仍需目录级发布 |
| PowerShell/.NET 原生薄壳 | 当前 ZIP 46.35 MiB（Node 未压缩 92.53 MiB） | 约 0.3 s | server 约 30 MiB，托盘额外开销低 | 使用系统 WinForms；SQLite 由已验证的独立 server 加载；脚本和 ZIP 可由现有 Windows CI 构建，未来可替换为签名原生 exe | Windows 专用，逻辑最少，更新整个便携 ZIP 即可 |

测量为同一 Windows x64 开发机上的候选原型量级，用于架构选择而非发布性能承诺。最终便携产物的 health/proxy 启动由 `pnpm smoke:portable` 重复验证。

## 决策

首版采用 PowerShell + WinForms `NotifyIcon` 薄外壳。外壳仅负责启动/停止独立 CLI、打开管理 UI 和显示启动错误；不包含路由、配置、存储或代理业务逻辑。CLI 仍是唯一 server 实现，也可完全不使用托盘运行。

Electron 因体积和内存成本拒绝。SEA 因不能真正形成包含 native addon 和静态资源的单文件、且签名/注入流程更复杂而暂缓。若未来需要跨平台桌面 UI或自动更新，再重新评估 Electron；若 Node SEA 对 addon/asset 支持成熟，再重新评估 SEA。

## 生产外壳

便携包包含 `start-tray.cmd` 和 `tray.ps1`。托盘菜单仅提供打开 UI 和退出；启动失败通过 balloon 显示。发布签名阶段应对最终 ZIP、启动脚本或未来替代的原生薄壳签名，不改变 server 包。
