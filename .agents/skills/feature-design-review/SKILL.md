---
name: feature-design-review
description: >-
  Ground feature exploration, design changes and proposal documents in current project
  code: trace readers and writers, separate identity and state authorities, specify async
  lifecycles and consistent API/UI contracts, validate fixtures before measuring, and
  distinguish evidence from assumptions. Use when exploring a new feature, writing or
  revising a design/specification, or reviewing and merging competing proposals.
---

# 基于证据的功能设计与方案评审

## When this applies

- 探索新功能、比较替代方案，或把用户设想收敛为可实施的设计。
- 修改已有方案、API、状态语义、配置归属或持久化策略。
- 编写、评审或合并设计文档；尤其是多模型独立研究后的方案收敛。
- 与 `design-doc-readability` 配合：本技能负责事实与合同，可读性技能负责结构与表达。

## Invariants

### 先核对现状，再选择方案

- 先读 `docs/current/architecture.md`，记录研究基线、用户问题、成功标准和修改范围。
  历史文档只作线索；关键结论应指向当前文件、符号、读写路径及相关测试。
- 对“只有”“全部”“不会”“必然”等断言，搜索完整引用和全部写入口，再写结论。
  名称、注释、类型、历史 ADR 或一条正例都不足以单独证明运行行为。
- 区分当前事实、拟议合同、推断、待验证假设、历史记录和本次实测。未知就标未知，
  并说明它会阻塞什么、用什么证据消除；不得把建议写成已有功能。
- 现行内部合同可以按用户目标调整。明确将替代什么及影响范围，不把“当前只读”
  或“以前非目标”误当作新需求不可实现的理由；也不默认保留旧内部 API。

### 为数据与动作找到权威

- 每个设计对象写明身份、作用域、生命周期、所有者、读写入口和实际影响范围。
  配置、内存运行态、日志历史和上游聚合指标各有权威边界，不互相冒充。
- 不假设业务 ID、运行态 ID、记录 ID、URL 和物理资源是一一对应。操作共享对象时，
  列表与 API 必须披露受影响范围；关联不明时不得承诺只改一个业务对象。
- 核对计数、查找和投影的副作用。字段叫“次数”不证明它每个真实请求只增加一次；
  标为“查询”的方法也可能续期、学习索引或改变计数。
- 零值、缺失、过期和不完整是不同状态。样本新鲜不证明字段完整；多别名指向同一
  物理资源时先定义去重与聚合口径，不能盲目相加。

### 把异步生命周期写完整

- 单事件循环里的同步修改可原子完成，但请求、回调、日志、失败重试和配置保存会跨越
  `await`。列出检查、修改、派发、完成、回填、释放和清理之间能发生什么。
- 对有状态写操作，按风险明确冲突、重试和幂等合同。若 ID 会在重启或对象重建后复用，
  旧请求须能被区分；若资源配置可原地变化，执行时须复核相关身份或版本。
  不要求所有简单功能一律引入运行代号、版本表或操作队列。
- 区分已接受、已修改运行态、实际执行、业务成功和日志已观测；只保留功能需要的状态。
  日志失败不能自动等同业务失败，未执行也不能计为已付执行成本。
- 按实际涉及的对象检查并发、失败切换、reload/回滚、删除/禁用、重启、过期/容量淘汰和
  迟到回调。给出取消、失效或继续执行的规则；界面提示不能补足协议与资源兼容能力。

### 让正文、接口、界面和实验互相证明

- 用同一动作表核对前置条件、提交参数、状态转换、响应、错误码、UI 按钮和测试。
  不允许正文说拒绝、示例却成功；不允许同一操作既声明冲突又承诺后写覆盖。
- 为每个新增能力列出实际接线位置。管理 API 不止一条路由，还涉及服务装配、schema、
  浏览器合同和真实应用测试；具体检查交给匹配的项目技能，避免复制过期路由数。
- 先验证夹具是否创建了想测的状态，再测性能。对象数、独立身份、命中路径、schema、
  索引和缓存条件不符时，先修夹具，不能据耗时判断设计优劣。
- 合成脚本证明其覆盖的逻辑或成本；真实引擎收益需要对应工作负载的对照实验。
  不能用一个方便观测的计数器代替用户成功标准，也不能由成本信号推断未知剩余工作量。
- 关键实测保留可复跑脚本、命令、工作目录、输入/版本、前置断言和结果；缺失依赖或
  原始材料时标明复验边界。阈值写来源或校准计划，不用“对齐现有常量”冒充依据。

### 控制范围并维护文档身份

- 给出最小交付、明确非目标、替代方案和阶段出口；扩展有独立收益才纳入。
  简单变更可简写适用检查，不能为了模板创造数据库、定时器、持久化或兼容层。
- 修改旧方案时列出保留、替代、暂缓项，追踪受影响需求、示例、测试与文档入口。
  已采纳结论只有一个权威入口；未完成的提案不能自行宣告已批准或已实现。
- 比较模型时保留原稿与独立评审，使用相同题目、基线和评判口径，披露环境差异。
  只有用户授权才委派；“分别独立研究”与“按题分工”必须按用户原意执行。
  一次耗时、token 或单题结果不能外推总体能力排名。

## Standard commands

先沿代码问题选文件与符号，运行只读搜索；路径均相对仓库根目录：

```bash
git status --short
git rev-parse HEAD
rg --files src test-node scripts
rg -n 'rebind|allowRebind|targetId' src/proxy test-node/proxy
```

最后一条只是“找全写入口”的现有示例；其它功能换成自己的符号。不要把执行全部搜索当作
完成研究。写作前按需读 [reference.md](./reference.md) 中的数据表、竞态表和实验反例。

```bash
# 只检查实际修改的设计文档；以下是已有文件的命令示例。
npx prettier --ignore-path .gitignore --check docs/current/architecture.md
npm test -- test-node/docs
# 改动运行时模块边界时才检查模块图。
npm run check:modules
# 修改技能或 AGENTS 路由索引时运行。
npm run check:skills
```

Windows 测试从大写盘符运行。方案研究只执行必要验证，并遵守 AGENTS 的交付与实例隔离规则；
测试计划标清哪些已执行、哪些须实现后执行。新增/小幅修改文档的格式处理遵循
`design-doc-readability` 和 AGENTS，避免全篇重排已有历史表格。

## Reading the result

- 完成研究应能回答：改什么、由谁持有状态、何时生效、什么情况下拒绝或失效，以及证据
  能证明到哪里。缺少关键事实或合同矛盾时，文档仍是待收敛提案。
- 评审按“结论 → 证据 → 影响 → 最小修订 → 验证”报告。指出具体错误路径，区分已证缺陷
  与待测风险；长文、引用多、微基准快都不能替代正确性。
- 当前测试通过不证明拟议功能已实现，打包成功不证明性能收益，单次更快不证明因果。
  收益与安全性是不同验收项，应分别给结论。
- 交付前使用 reference 的自检表，把正文、API 示例、UI 和验证计划逐条对照。
  用户已授权的研究和文档工作应完成交付；本技能不新增统一审批步骤。

## Deeper material

- [reference.md](./reference.md) — 设计步骤、可复用模板、实验前置条件与常见错误反例。
- [design-doc-readability](../design-doc-readability/SKILL.md) — 文档结构、度量与单一权威入口。
- [current-architecture.md](../../../docs/current/architecture.md) — 现行架构、配置归属与依赖方向。
- [admin-api-probing](../admin-api-probing/SKILL.md) — 管理 API 接线、schema 与真实应用合同。
- [proxy-runtime](../proxy-runtime/SKILL.md) — 请求世代、reload、在途对象与日志边界。
- [real-upstream-acceptance](../real-upstream-acceptance/SKILL.md) — 隔离实例与真实上游验收。
