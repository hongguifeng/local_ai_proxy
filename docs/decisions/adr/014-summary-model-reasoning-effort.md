# ADR-014：总结模型的思考深度用一个可自定义的值取代开关

> 状态：决策记录
> 权威性：已作出的架构决策；当前实现以代码和 `docs/current/` 为准。
> 更新条件：决策被替代或发现事实错误时更新。

- 状态：已采纳并已实现（2026-10-28）
- 日期：2026-10-28
- 决策范围：`summary_model` 配置合同、总结模型请求体、管理端总结模型设置对话框
- 关联文档：[总结模型思考深度设计](../../design/accepted/summary-model-reasoning-effort.md)、[实施计划（已归档）](../../plans/archive/summary-model-reasoning-effort.md)、[产品当前行为](../../current/product.md)（第 2 节配置模型）

## 背景

总结模型原来只有一个布尔开关 `summary_model.disable_reasoning`：为 `true` 就在请求体里写 `reasoning_effort: "none"`，为 `false` 就不写。这个开关只能表达“关”和“不管”两种状态，而实际要用的深度不止两种：OpenAI Chat/Responses 认 `minimal/low/medium/high`，本项目实测的 Qwen（LM Studio）只认 `xhigh/medium/low`，厂商私有的档位（例如 `max`）根本没有入口。

## 决定

1. `summary_model` 只有一个思考字段：`reasoning_effort`，可选的单字符串。缺失就是请求里不出现这个字段，由上游决定；非空就是原样发过去，不翻译、不裁剪、不映射。
2. 校验只保证它是“一个词”：去掉首尾空白后非空、中间不含空白。带空格或空白的值在保存阶段按 `invalid_config` 拒绝，不等到上游。
3. 管理端下拉给出六个预置（`none`、`minimal`、`low`、`medium`、`high`、`xhigh`）、一个“上游默认（不发送）”和一个“自定义…”；预置不是白名单，自定义值合法。
4. 生成调用和“连接测试”按钮用同一个深度。
5. 旧的 `disable_reasoning` 不读、不写、不映射，也不做迁移。

## 备选方案与为什么不选

- **把旧键映射成新深度**（`true` → `none`，`false` → 缺失）：旧配置文件行为完全不变，代价是同一件事有两种写法，读取顺序要写进合同并且长期测着。用户选择只维护一条合同。
- **两个字段长期并存、旧键优先**：旧文件绝不改变行为，但两个字段同时存在时“谁说了算”要额外定义，管理端也没法在一个控件里表达两者。
- **彻底丢弃旧键**（选定）：只有一条合同。代价是旧配置里写着 `disable_reasoning: true` 的人，行为从“不思考”变成“由上游决定”。
- **按协议分支发 Anthropic 的思考预算**：需要新的协议分支、预算换算和测试。v1 保持“三种协议同一写法”，Anthropic 忽略这个字段与换字段之前一致。

## 后果

- 用户配置合同变窄了一格：思考相关的键只剩 `reasoning_effort`。带着旧键的配置文件仍然通过校验（未知键被保留），但下一次经管理端保存总结模型配置时，该键会随整体替换而消失。
- 旧配置的行为变化是这次决定的直接后果，不是缺陷：只有 `disable_reasoning` 是 `true` 且没有 `reasoning_effort` 的配置文件会改变行为。要回到“明确不思考”，把 `reasoning_effort` 写成 `none`。
- 深度值不校验是否属于预置，所以写错的代价是一次上游 400；“连接测试”用同一个深度，正是为了让这种错误在设置对话框里就能看见，而不是等到第一次生成任务简介。
- 请求体里 `reasoning_effort` 仍写在最后，与这个项目一直写它的位置一致；未配置时字段整个不出现，而不是出现一个空值。

## 证明方法

- `test-node/config/summary-model.test.ts`：缺失即不存在该键、六个预置与自定义 `max` 都被接受、空值与带空白的值被拒、旧键不读也不写回。
- `test-node/maintenance/summary-model-client.test.ts`：未配置时请求体不含该字段、配置了就三种协议都发原值且写在末尾、连接测试发的是同一个深度。
- `test-node/app/runtime.test.ts`：配置里的深度按原值落盘并原样读回，保存时旧键被丢掉。
- `test-node/ui/admin-ui-history.test.ts`：下拉的选项值正好是那八个状态，自定义框只在“自定义”下可用，空的自定义值在发出任何请求之前被拒。
