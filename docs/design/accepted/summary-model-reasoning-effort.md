# 总结模型思考深度设计（v1）

> 状态：已接受设计
> 权威性：功能语义依据；当前代码不一致时先更新设计或写明偏差。
> 更新条件：字段语义、预置档位或 UI 合同变化时更新。

- 文档状态：设计已接受并已实现；当前行为以 `docs/current/product.md`、代码和测试为准。
- 实施记录：[总结模型思考深度实施计划](../../plans/archive/summary-model-reasoning-effort.md)（RE-01～RE-06 于 2026-10-28 收口）。
- 决策记录：[ADR-014](../../decisions/adr/014-summary-model-reasoning-effort.md)。

## 1. 决策摘要

把 `summary_model.disable_reasoning` 这个开关换成一个可自定义的思考深度字段 `reasoning_effort`：留空就不把这个字段发给上游（由上游决定），填了就原样发过去，预置六个档位，管理端用“下拉 + 自定义输入框”给这个值。

## 2. 需求

| 编号 | 要求                                                                                                                                                                                  | 由谁证明                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| R1   | 配置里唯一的思考字段是 `summary_model.reasoning_effort`；`disable_reasoning` 不再被任何代码读取，也不再被写回。                                                                       | `test-node/config/summary-model.test.ts`、全库搜索   |
| R2   | 该字段缺失或为空字符串时，请求体里不出现 `reasoning_effort`，即由上游自己决定思考深度。                                                                                               | `test-node/maintenance/summary-model-client.test.ts` |
| R3   | 该字段非空时，请求体里发的是配置里的原值，不做大小写归一、不做映射、不做校验白名单。                                                                                                  | 同上                                                 |
| R4   | 值必须是去掉首尾空白后非空、且不含空白的单个词；`medium high` 这种带空格的值按 `invalid_config` 拒绝。                                                                                | `test-node/config/summary-model.test.ts`、管理端保存 |
| R5   | 生成调用和连接测试用同一个值；连接测试不再固定发最省的档位。                                                                                                                          | `test-node/maintenance/summary-model-client.test.ts` |
| R6   | 管理端用下拉给预置值：留空（上游默认）、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`，再加“自定义”；自定义那一行默认不在界面上，选中“自定义”才出现，切回预置时该行消失并清空已写的内容；行出现时发的就是用户写的原文。 | `test-node/ui/admin-ui-history.test.ts`              |
| R7   | 三种协议（Chat、Responses、Anthropic Messages）都按同一写法发这个字段；Anthropic 会忽略它，这与换字段之前的行为一致。                                                                 | `test-node/maintenance/summary-model-client.test.ts` |

## 3. v1 明确不做

- 不为 Anthropic 改发 `thinking` / `budget_tokens`：这个字段发过去会被忽略，v1 保持“同一写法发给三种协议”。
- 不做按请求覆盖、不做按模型映射、不做档位成本或延迟预估：只有配置里的一个值。
- 不把 `disable_reasoning` 映射成新字段：旧键不读、不写、不迁移，旧配置文件的默认行为随之变成“不限制思考深度”。
- 不校验值必须是六个预置之一：自定义值合法，坏值由上游返回错误，管理端只挡住带空白和空值。

## 4. 字段语义

```ts
// src/config/config-schema.ts
reasoning_effort: z.string()
  .trim()
  .regex(/^[^\s]+$/)
  .optional();
```

- 缺失：不发送（上游默认）。这是旧配置里没有这个键时的行为，也是 UI 里“上游默认”那一项的存储形式。
- 存在：发送 `reasoning_effort: <值>`，写在请求体的最后，与换字段之前“推理开关写在最后”的位置一致。
- `""`（空字符串）不是合法存储值：schema 要求非空，UI 在选“自定义”而文本框为空时拒绝保存并说明原因。

## 5. 预置与自定义

| 预置      | 上游会接受的范围                                  | 说明                            |
| --------- | ------------------------------------------------- | ------------------------------- |
| `none`    | OpenAI Chat/Responses                             | 明确关闭推理，等于旧开关的 true |
| `minimal` | OpenAI Chat/Responses                             | 最省的推理，Qwen 这类服务会拒   |
| `low`     | OpenAI 与本项目实测的 Qwen（LM Studio）都接受     |                                 |
| `medium`  | OpenAI 与 Qwen 都接受                             |                                 |
| `high`    | OpenAI 接受；Qwen 在这里只接受 `xhigh/medium/low` |                                 |
| `xhigh`   | Qwen 接受；本项目子代理用的就是这一档             | OpenAI 不一定接受               |

上表是本地实测过的接受范围，不是上游合同：预置之外仍可用自定义值（例如厂商私有的 `max`），写错的代价是一次上游 400，而不是一次本地异常。

## 6. UI 合同

- 一个 `#summaryReasoning` 下拉：`""`（上游默认）、六个预置、`custom`（只作为 UI 状态，不入库）。
- 一个 `#summaryReasoningCustom` 文本框，只在 `custom` 时可用。
- 打开对话框时按已存值定位：值命中预置就选中该预置，值命中不了预置就落到“自定义”并把原值填进文本框，值缺失就选中“上游默认”。
- 保存时发出去的 `reasoning_effort` 就是下拉选中的预置值或文本框里的原文；选“上游默认”时这个键整个不出现在 PUT 体里。

## 7. 验收清单

- [x] R1：全库 `rg disable_reasoning` 在 `src/`、`electron/`、`test-node/` 和包内 `app.asar` 里都是 0 处。
- [x] R2/R3/R5/R7：`summary-model-client.test.ts` 钉住“未配置时请求体不含 `reasoning_effort`”、“配置了深度时三种协议都发原值（含 `max`）”、“连接测试发的是同一个值”。
- [x] R4：`config/summary-model.test.ts` 钉住带空白的值被拒、空字符串被拒、六个预置与自定义 `max` 被接受。
- [x] R6：`admin-ui-history.test.ts` 打开对话框，断言下拉的选项值正好等于 `["", 六个预置, "custom"]`、自定义行默认不可见、切到自定义后该行与输入框可见、切回预置后该行消失且值被清空；存储的 `max` 重新打开时该行可见并回填；空的自定义值在发出任何请求前被拒。
- [x] 管理端保存/读取：`test-node/admin/*` 与 `test-node/app/runtime.test.ts` 里的总结模型配置写入/持久化逐项通过，`reasoning_effort: "high"` 按原值落盘并读回。
- [x] 当前文档与 ADR 已写明：旧键不读、缺失即不发、非空即原样发、UI 的自定义口径。
- [x] 便携交付链跑完：`package:electron:portable` → `smoke:delivery` → `rebuild:node` → `abi:node`，并在 `app.asar` 里证明新代码在里面（2026-10-28，exe 18:52）。

## 8. 开放问题

| 问题                          | 推荐                  | 替代方案                                | 对 v1 的影响                     |
| ----------------------------- | --------------------- | --------------------------------------- | -------------------------------- |
| 是否给 Anthropic 改发思考预算 | v1 不发，保持统一写法 | 按协议分支发 `thinking`/`budget_tokens` | 需要新的协议分支与测试，暂缓。   |
| 是否校验值必须落在预置内      | 不校验，允许自定义    | 白名单校验，坏值在保存时就拒绝          | 自定义值用不了就失去意义，暂缓。 |
| 是否需要保留旧键做映射        | 不保留（本次已定）    | 读旧键并映射成 `none`/缺失              | 旧文件行为会变，已按决定接受。   |
