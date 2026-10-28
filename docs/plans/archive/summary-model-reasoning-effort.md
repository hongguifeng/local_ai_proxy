# 总结模型思考深度实施计划

> 状态：历史计划
> 权威性：历史执行记录，不作为当前待办。
> 更新条件：只补充归档说明或修正链接。

当前状态：RE-01～RE-06 全部完成（2026-10-28 收口）。设计权威见[总结模型思考深度设计](../../design/accepted/summary-model-reasoning-effort.md)，决策记录见 [ADR-014](../../decisions/adr/014-summary-model-reasoning-effort.md)，当前行为见[产品当前行为](../../current/product.md)。

本文按依赖顺序执行。每项任务都要完成实现、测试、文档同步和本项验收后才能标记完成；验收口径不靠实现者自报，由主会话独立复核。

## 1. 任务表

| 编号  | 任务                                                       | 依赖         | 验收证据                                                                 |
| ----- | ---------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| RE-01 | `summary_model` 换成 `reasoning_effort`（schema 与客户端） | 无           | `test-node/config/summary-model.test.ts`、`summary-model-client.test.ts` |
| RE-02 | 管理端 DTO、路由与持久化随之调整                           | RE-01        | `test-node/admin/*`、`test-node/app/runtime.test.ts`                     |
| RE-03 | 管理端 UI：下拉 + 自定义输入、中英文案、清掉死 CSS         | RE-02        | `test-node/ui/admin-ui-history.test.ts`、CSS 级联中立 oracle             |
| RE-04 | 更新测试夹具里所有 `disable_reasoning`                     | RE-01        | 全量 Vitest 通过                                                         |
| RE-05 | 当前文档与 ADR 收口                                        | RE-01～RE-03 | `npx prettier`、`npx vitest run test-node/docs`、`git diff --check`      |
| RE-06 | 便携交付链与 `app.asar` 内容证明                           | 以上         | `smoke:delivery` 输出、asar 内字符串检查、`abi:node`                     |

## 2. 执行约定

开始前读根目录 `AGENTS.md`、[现行架构](../../current/architecture.md)，以及 `admin-api-probing`、`static-checks-and-split`、`css-cascade-audit`、`packaging-smoke`、`documentation-maintenance` 里与当次任务相关的部分。用户正在运行的便携版实例只读，任何验证都用隔离数据目录、独立端口和独立日志根。

## 3. 验收检查顺序

1. 先跑相关文件的定向 Vitest（`--coverage.enabled=false`），把新写的断言跑热。
2. `npm run typecheck`、`npm run lint`、`npm run format:check`、`git diff --check`。
3. 碰了 UI 就跑 CSS 级联中立 oracle，并重拍可能被移动的基线，与提交件比哈希和像素差。
4. `npx vitest run test-node/docs` 与新文档的 `npx prettier --check`。
5. 最后 `npm run check` 全量收口。
6. 交付链 `package:electron:portable` → `smoke:delivery` → `rebuild:node` → `abi:node`，
   并解 `app.asar` 证明包里确实是这份代码。

## 4. 风险与停止条件

- 如果"不迁移旧键"在实际数据上造成损失（例如用户的旧配置保存后行为异常），停止并回到用户确认，
  不在实现里偷偷补映射。
- 如果上游实测某个深度不被接受，停止并记录实测响应，不把它写成保证可用的文档。
- 如果连接测试用的深度与生成请求用的深度不一致，停止：这个功能的全部价值就在于"测的就是会发的"。
- 如果发现任何代码仍在读 `disable_reasoning`，停止：R1 是这次选择的核心，不能半迁移。

## 5. 完成后要做的文档动作

- 当前行为：把"`reasoning_effort` 缺失即不发，非空即原样发"写进
  `docs/current/product.md`；旧键不再被读也写进去。✅ 已写入（第 2 节配置模型）。
- 设计：实现落地后从 `docs/design/active/` 收口到 `docs/design/accepted/`。✅
- 决策：`docs/decisions/adr/014-summary-model-reasoning-effort.md`。✅
- `npm run check:skills`：本计划未新增或删除 skill，文档路径变化已由 `test-node/docs` 覆盖。✅

## 6. 完成记录

2026-10-28 收口。RE-01 → RE-06 全部完成，未删减任何测试。

| 验收要求 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1       | 全库 `rg disable_reasoning` 在 `src/`、`electron/`、`test-node/` 零命中；包内 `app.asar` 解出后零命中；`test-node/config/summary-model.test.ts` "does not read the old reasoning switch and does not carry it into a save"。                                                                                                                                                                                        |
| R2 / R3  | `summary-model-client.test.ts`："leaves the depth out of the body when the configuration does not name one"（三种协议）与"sends a configured depth verbatim, including values the console does not offer"（预置与 `max`，字段写在末尾）；`test-node/app/runtime.test.ts` 用 `reasoning_effort: "high"` 固定落盘与读回。                                                                                             |
| R4       | `test-node/config/summary-model.test.ts`："trims a depth, then refuses an empty one and one with a space inside"。                                                                                                                                                                                                                                                                                                  |
| R5 / R6  | `test-node/ui/admin-ui-history.test.ts`："gives the summary model a reasoning depth picker whose custom box answers only when it is being picked"（八个选项值、自定义框只在 `custom` 下可用、回到预置即清空并禁用、空的自定义值在发出任何请求之前被拒、新增标签全部已翻译）；`summary-model-client.test.ts`："sends the configured depth on a connection test for every API type"。                                 |
| 门禁     | `npm run check`：151 个文件通过 / 1 跳过，1630 个测试通过 / 2 跳过；`test-node/docs` 12 个文件 37 个测试；`git diff --check` 干净；新文档 `prettier --check` 通过。                                                                                                                                                                                                                                                 |
| CSS 删除 | `CSS_CANDIDATE=<HEAD 版 app.css>` 跑 `test-node/ui/admin-ui-css-cascade.test.ts` "candidate stylesheet must not change any computed-style count" 通过：删掉两条 `.summary-enabled` 死规则不改变任何计算样式计数。                                                                                                                                                                                                   |
| 基线     | 重拍 `ui_logs_cn/en`、`ui_proxy_cn/en`：三张字节一致；`ui_logs_en` 只有 PNG 编码元数据差异，像素差 0 / 1,694,016，已 `git checkout --` 恢复提交件；登记行未改。                                                                                                                                                                                                                                                     |
| 交付     | `package:electron:portable` → `smoke:delivery`（payload `health 538 ms, proxy 200, GET /api/logs 200 total 1, exit code 0`；wrapper `health 2323 ms, proxy 200, GET /api/logs 200 total 1, exit code 0`）→ `rebuild:node` → `abi:node`（NODE_MODULE_VERSION 137，真实查询 `{"a":1}`）。新 exe `release/LLM-Proxy-0.4.10-x64-portable.exe` 111,999,879 字节 / 18:52，上一份是 112,001,724 字节 / 16:52。             |
| 包内容   | 解 `release/win-unpacked/resources/app.asar`：`disable_reasoning`、`disableReasoning`、`.summary-enabled` 零命中；`dist-node/src/config/config-schema.js`、`dist-node/src/maintenance/summary-model-client.js`、`dist-node/src/admin/admin-schemas.js` 均含 `reasoning_effort`；`dist-node/src/admin/static/index.html` 含 `summaryReasoning`；`dist-node/src/admin/static-bundle/admin-app.js` 含新控件逻辑 9 处。 |

残余风险：Anthropic Messages 仍会忽略这个字段，与换字段之前一致；用户写的深度是否被上游接受，
由上游决定，本项目只保证原样送达，"连接测试"是看见这件事的入口。

执行中被测试纠正过两次，都记在这里：

- `expect(locator).toHaveValues([...])` 在这套 playwright-core 上对单个 `<select>` 报
  "Not a select element with a multiple attribute"，与 `ui-test-quirks` 记的严格模式问题同源，
  改成一次性读 `option.value` 数组。
- 对话框里的 `<form>` 会先跑原生必填校验：URL 或模型名为空时 `submit` 事件根本不触发，
  所以"空的自定义值被拒"这条测试必须先填上必填项才能走到提交处理器。

归档补充（同日）：用户看了界面后要求自定义档位默认不要出现在界面上，于是把"默认禁用"改成
"整行默认隐藏，选中自定义才出现"（`#summaryReasoningCustomRow` + `.target-check-form
label[hidden]`），并加了一条测试钉住"存储的自定义深度重新打开时该行可见并回填"。合同以
`docs/design/accepted/summary-model-reasoning-effort.md` R6 和 `docs/current/product.md` 为准；
本计划里 R6 那行的"只在 `custom` 下可用"是收口当时的写法，已被这次补充取代。

这次补充的验收：`npm run check` EXIT=0（151 文件 / 1631 测试）；重拍 `ui_logs_cn/en`、
`ui_proxy_cn/en` 后只有 `ui_logs_en` 的字节变了，像素差 0 / 1,694,016，已恢复提交件；
交付链重跑到 `release/LLM-Proxy-0.4.10-x64-portable.exe` 112,000,263 字节 / 19:22，
`smoke:delivery` payload 与 wrapper 都是 `exit code 0`，`abi:node` 回到 NODE_MODULE_VERSION 137。
CSS 级联 oracle 拿 HEAD 版 app.css 当候选时报了 30 行，按 `tag#id.class` 路径逐个点名后确定
只有三个元素变了：那一行（`grid -> none`）、它的 `span`（`block -> inline`）和它的 `input`
（`block -> inline-block`）——全部在重设计的这一行上，其余页面状态无一变动。
