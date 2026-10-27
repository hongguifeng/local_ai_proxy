---
name: documentation-maintenance
description: >-
  Maintain AGENTS.md, project skills, and categorized documentation from verified development
  experience. Use when a task reveals a reusable pitfall, changes a current contract, adds or
  retires a workflow, changes a document or skill path, or reaches completion and needs a
  maintenance review.
---

# 持续维护项目文档与 AI 指导

## When this applies

- 一个任务遇到可复现的坑、反直觉约束、容易重复犯的错误或新的验证方法。
- 代码、配置、API、UI、打包流程、ABI 顺序、测试入口或文档目录发生改变。
- 新增、修改、拆分、删除或移动 `AGENTS.md`、`.agents/skills/` 或 `docs/` 下的文件。
- 一个任务即将结束，需要判断是否应把经验沉淀为长期指导。
- 评审发现当前规则、skill、设计、报告和代码之间存在重复、冲突或过期引用。

## Invariants

### 先分类证据，再选择归属

把发现分成五类，并把它放到唯一的权威位置：

| 发现                                 | 首选位置                             | 进入条件                                                                   |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------- |
| 当前运行行为、用户可见合同、数据兼容 | `docs/current/`                      | 已由代码、测试或实测确认，并且后续实现必须遵守                             |
| 可重复的排障、验证或实现方法         | 对应 `.agents/skills/<name>/`        | 任务类型可以被触发条件识别，步骤和结果可复用                               |
| 已作出的取舍及其原因                 | `docs/decisions/adr/`                | 存在替代方案、长期影响或未来需要追溯的决定                                 |
| 一次运行、一次发布或一次实验的结果   | `docs/reports/` 或当前计划的完成记录 | 结果带有时间、版本、输入和明确边界                                         |
| 所有任务都必须遵守的高代价边界       | `AGENTS.md`                          | 与具体功能无关，跨任务、长期有效且遗漏代价高，且遗漏会造成高风险或大量返工 |

一次性失败、没有复现的猜测和只适用于一个任务的临时选择，留在任务记录或报告中，不要直接写进 `AGENTS.md`。

### 经验必须带证据和失效边界

新增规则至少写清楚：

1. 触发条件：后来什么任务会遇到它。
2. 观察到的失败或风险：具体命令、文件、符号、错误或行为。
3. 规则本身：未来 AI 应采取什么动作。
4. 证明方法：用什么测试、搜索、实测或工具判断它仍然成立。
5. 适用范围和失效条件：何时不应套用这条规则。

删除规则也需要证据：代码、配置或命令已经消失，自动检查已使旧错误不可能发生，或者原事实已经明确过期。发现与当前任务直接相关的死链接或过期路径时，不能只把它列为残余风险后继续交付；应修复它，或说明为什么修复会扩大合同范围并让任务停在待处理状态。

### 保持唯一权威和单向引用

- `AGENTS.md` 只负责入口、长期边界和 skill 路由；详细配方放在 skill，当前合同放在 `docs/current/`。
- 一个合同只维护一个权威入口。其他文档链接到它，并说明自己保留的是历史、测量或执行记录。
- 不把完成记录复制成当前合同，也不把历史材料改写成当前行为。
- 修改路径后全局搜索旧路径，更新引用者和测试；不要留下“看起来像当前入口”的死链接。
- 如果新改动涉及某个文档家族，搜索代码注释、skill、测试和 README 中对该家族旧路径的引用。与本次家族直接相关的死路径必须修复；完全无关的历史引用才可以记录为后续工作。
- `AGENTS.md` 和每个 skill 都必须能被 `npm run check:skills` 的路径、命令和章节检查验证。

### 用最小规则控制长期增长

- 优先更新已有规则或 skill，只有不存在合适归属时才新增文件。
- `AGENTS.md` 新增一条规则前，证明它跨任务适用、遗漏代价高，并能用短句表达。
- skill 新增一条陷阱前，说明触发条件、标准命令、结果解释和更深材料；不要只写一个警告句。
- 当前文档只描述当前实现；设计、计划、报告和历史材料必须保持各自生命周期。
- 经验涉及产品行为时，同时检查代码、测试、当前文档和相关 ADR；不要只修改文字让检查变绿。

## Standard commands

从仓库根目录执行，Windows 测试使用大写盘符路径：

```bash
git status --short
rg -n "旧路径|旧命令|旧符号" AGENTS.md .agents/skills docs test-node
rg --files docs .agents/skills
npm run check:skills
npx prettier --ignore-path .gitignore --check AGENTS.md .agents/skills/<name>/SKILL.md docs/<changed-file>.md
npx vitest run test-node/docs
```

如果维护内容反映了源码、测试或构建行为，还要运行对应的专项测试；完整行为变化继续执行 `npm run check`。检查结果中要区分本次改动引入的失败和基线已有的失败。

## Reading the result

维护完成的提交应能回答：

- 未来 AI 会在什么任务中读到这条规则？
- 它能从规则找到唯一权威文档、代码入口和证明命令吗？
- 规则是否由具体证据支持，并写明了适用边界？
- `AGENTS.md` 是否仍然只包含跨任务规则？
- skill 的触发条件、五个固定章节、命令、链接和文档状态是否一致？
- 当前文档是否仍与代码和测试一致，历史材料是否没有被误当成当前合同？

用 `git diff` 检查内容和归属，用 `git diff --check` 检查空白，用 `npm run check:skills` 检查 skill 结构、路径和命令；不要因为格式和路由测试通过就假定经验本身正确。

## Deeper material

- [reference.md](./reference.md) — 经验分级、维护记录模板和审查清单。
- [文档导航](../../../docs/README.md) — 文档分类、权威性、生命周期和语言规则。
- [当前架构](../../../docs/current/architecture.md) — 当前实现和验证入口。
- [AGENTS.md](../../../AGENTS.md) — 始终生效的项目入口规则。
- [skills.test.ts](../../../test-node/docs/skills.test.ts) — skill roster、章节、链接和命令检查。
- [document-structure.test.ts](../../../test-node/docs/document-structure.test.ts) — 文档分类、状态和本地链接检查。
