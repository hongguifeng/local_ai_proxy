# ADR-006：Windows 发布产物

- 状态：已接受
- 日期：2026-07-18
- 决策范围：托盘、CLI、GitHub Actions 和 Release

## 背景

Python 版本发布一个 PyInstaller 单文件、无控制台窗口的托盘 exe。Node.js 核心需要同时满足：

- 普通 CLI 开发和服务器运行。
- 双击启动的 Windows 托盘体验。
- `better-sqlite3` native addon ABI 匹配。
- 用户不必为了托盘模式预装 Node.js。

Electron 能稳定提供 Tray 和系统对话框，但产物明显大于 PyInstaller。只发布 Electron 会让不需要托盘的 CLI 用户承担不必要体积。

## 决策

正式 Release 发布三个 Windows x64 产物。

### 1. NSIS installer

- 面向希望通过安装向导部署和卸载的桌面用户。
- 使用 Electron + electron-builder 的 NSIS target。
- 默认按用户安装，并允许选择安装目录。

### 2. Portable EXE

- 主要桌面产物。
- 使用 Electron + electron-builder 的 portable target。
- 无控制台窗口。
- 包含 Node/Electron runtime、静态 UI 和正确 ABI 的 `better-sqlite3`。
- 双击后只显示 Tray。
- 菜单保留 Open Admin UI 和 Exit。
- 支持现有 host/port/config/log/open-on-start 参数。

### 3. CLI ZIP

- 面向命令行和自动启动用户。
- 包含固定 Node 24 runtime、编译后的应用、静态 UI、native addon 和启动脚本。
- 解压即可运行，不要求系统全局安装 Node。
- 目录型分发，不追求单 exe。

开发者仍可通过 npm scripts 从源码运行，不把项目发布到公共 npm registry 作为本阶段要求。

## Release 附件

每个产物同时发布：

- `.sha256` 校验文件。
- 版本和构建元数据。
- Release note。

GitHub Actions 在 `windows-latest` 完成构建和 smoke test，再上传 artifact。`v*` tag 创建或更新 GitHub Release。

## 架构范围

首个版本只保证 Windows x64。arm64、macOS 和 Linux 桌面包不阻塞 Python -> Node 切换；Node CLI 源码本身保持跨平台。

## 代码签名

流水线预留签名配置，但没有证书时允许生成未签名产物。README 和 Release note 必须说明 Windows SmartScreen 可能提示。签名是独立 P1/P2 交付，不伪造或提交证书。

## 后果

- 保留现有双击托盘体验。
- Electron portable 体积增加，但 CLI zip 提供更轻选择。
- 构建流程必须分别验证 Electron ABI 和普通 Node ABI 的 native addon。
- 首期不承担安装器和自动更新复杂度。
