# ADR-004：配置应用采用整体回滚

- 状态：已接受
- 日期：2026-07-18
- 决策范围：PUT pairs、监听器启停和配置文件保存

## 背景

当前 Python `replace_pairs()` 先替换内存配置并保存文件，再逐个停止或重启 listener。若中途遇到端口冲突：

- 新配置已经写入磁盘。
- 前面的 pair 可能已经成功重启。
- 失败 pair 没有运行。
- UI 收到错误，但无法知道哪些变更已经生效。

管理 API 的语义是整体替换 `pairs`，因此部分成功会使用户难以恢复。

## 选项

1. 允许部分成功，返回逐 pair 状态。
2. 以 pair 为单位提交，磁盘保存所有成功项。
3. 整份配置作为一个应用事务，失败时回滚到旧配置和旧运行态。

## 决策

选择方案 3：整体回滚。

### 应用流程

1. 解析并验证完整新配置。
2. 检测重复 ID、重复监听地址、非法 target 和明显端口冲突。
3. 保存旧配置和旧 runtime snapshot。
4. 计算 add/update/remove/enable/disable diff。
5. 尽可能预创建不与旧 listener 冲突的新 listener，但暂不对外接受请求。
6. 停止需要替换的旧 listener。
7. 启动/激活全部新 listener。
8. 所有 listener 成功后，原子保存新配置文件。
9. 更新 manager 当前配置并释放旧资源。

### 失败回滚

任一步失败时：

1. 停止本轮已启动的新 listener。
2. 重新启动本轮停止的旧 listener。
3. 保持或恢复旧内存配置。
4. 不覆盖旧配置文件；若文件保存阶段失败，同样回滚 runtime。
5. 返回单个结构化 400/409/500 错误，包含失败 pair ID 和阶段。

若旧 listener 回滚也失败，应用进入 `degraded` 状态：

- 错误响应明确列出未恢复 pair。
- `/api/health` 返回 degraded。
- UI 重新 GET pairs 后显示真实 running 状态。
- 不伪造成功，也不自动写入一份部分配置。

### 单 pair enable

`POST /api/pairs/:id/enabled` 也是小事务：

- enable：listener 启动成功后才保存 `enabled=true`。
- disable：停止成功后保存 `enabled=false`。
- 保存失败时尝试恢复原运行态。

## 并发

- Config apply 使用全局异步 mutex。
- 同一时间只允许一个 replace/enable 操作。
- GET pairs 可读取上一个已提交 snapshot；不暴露中间状态。

## 后果

- 配置 API 语义清晰，失败不会正常产生部分成功。
- Manager 实现比当前 Python 更复杂，需要 snapshot、staged listener 和 rollback 测试。
- 无法保证操作系统端口在回滚窗口内绝对可重新绑定，因此保留 degraded 状态。
- 不实现旧的“先保存再尽力启动”兼容路径。
