# ADR-0004: 桌面外壳与首发分发形式

- 状态：已接受
- 日期：2026-07-10
- 决策阶段：0.1

## 背景

Python 原型提供 Windows 托盘和单文件打包。Node.js 版本包含 native SQLite addon、Worker 文件、migration 和 Web 静态资源，立即追求单文件会增加隐式解包路径和签名风险。

## 候选方案

1. 首发使用 Electron 承载全部应用。
2. 首发使用 Node SEA 和托盘 native addon，输出单文件。
3. 首发使用固定 Node runtime 的便携目录，托盘作为独立 spike。
4. 仅发布 npm 包。

## 决策

选择方案 3，同时发布可安装的 CLI/npm 产物。核心 server 不依赖桌面外壳，托盘只负责启动/停止 server、打开 UI 和展示错误，不包含代理或存储业务逻辑。阶段 10 对 Electron、平台原生薄外壳和 Node SEA 做实测后另立 ADR 选择正式托盘方案。

## 原因

便携目录能显式携带所有运行时文件，最容易在干净 Windows runner 上验证。把托盘延后为薄外壳避免桌面技术选择阻塞数据面重构，也避免业务逻辑与特定平台绑定。

## 影响

- 首发不承诺单文件 exe。
- 便携包必须处理空格和非 ASCII 路径，并提供 checksum。
- server CLI 必须具备完整生命周期和机器可识别的 ready/error 输出。
- 托盘 spike 必须记录体积、启动时间、空闲内存、签名和 native addon 兼容性。

## 重新评估条件

- 分发渠道强制要求单文件或安装器。
- 托盘 spike 中某方案在支持平台上满足打包、签名和资源目标。
- 产品需要自动更新或更深的系统集成。

