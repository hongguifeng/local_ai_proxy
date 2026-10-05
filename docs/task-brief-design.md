# 任务简介（Task brief）设计

## 1. 目标

历史列表把一次 Agent 工作流归成一个任务，但“这个任务到底在做什么”只能靠逐条翻请求。任务简介在**任务明细**面板顶部给出一个卡片，用一小段话概括该任务主要在做什么：手动触发、结果缓存、不自动产生模型费用。

与单请求“智能总结”的区别：总结输出是结构化 JSON（阶段区间 + 证据编号），面向一次请求的对话流程；简介只有一段自由文本，面向整个任务。

## 2. 方案

沿用智能总结的“显式生成 + 缓存结果 + 复用总结模型配置”模式：

1. 复用全局 `summary_model` 配置，不新增设置项。
2. 输入取该任务**最新一次已完成**的请求体（多轮对话 + 工具调用，最能代表任务当前状态），按同一套压缩规则裁剪（消息正文 4000 字符、工具参数/结果 2000 字符、深度 ≥3 省略、丢弃图片/音频/文件字段），并额外附上一个 `client` 对象：只包含能识别“是谁在说话”的几个请求头（`user-agent`、`x-app`、`x-agent-task-id`、各 session/turn 头、`anthropic-version`），让 agent 名称来自证据而不是模型对系统提示词的猜测。
3. 调用总结模型，要求“一到两段简短中文话概括任务在做什么，不要逐条复述，总计不超过 150 字”，并从输入里读出基础环境信息（客户端/agent、工作目录、git 分支、系统与 shell、其他确实重要的环境），严格输出 `{"brief": "…", "facts": {…}}`。
4. 结果写入库表 `task_briefs`（正文 + 环境信息 JSON），面板打开时读缓存，永不为打开面板调用模型。

## 3. 数据模型

`schema-v12.ts` 新增表：

```sql
CREATE TABLE task_briefs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  brief_text TEXT,
  source_record_id TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT
);
```

删除任务时级联删除简介。`source_record_id` 记录生成时所用的请求，便于日后判断简介是否已过时。

`schema-v13.ts` 给该表补上一列：

```sql
ALTER TABLE task_briefs ADD COLUMN context_json TEXT;
```

`context_json` 存模型提取出的环境信息（规范化键名的小写 JSON 对象，如 `{"agent": "pi 0.39", "cwd": "d:/code/local_ai_proxy", "git_branch": "main"}`）；没有提取到任何信息时为 `NULL`，重新生成时也会被新结果覆盖而不是沿用旧的。

## 4. API

- `GET /api/log-groups/:id/brief`：返回缓存的 `{task_id, text, context, model, generated_at, source_record_id}`，未生成时返回 `null`；`context` 只在确实提取到环境信息时出现。
- `POST /api/log-groups/:id/brief`：生成并覆盖缓存。错误映射：任务不存在 `404 log_group_not_found`；同一任务并发生成 `409 task_brief_in_progress`；模型失败 `502 task_brief_failed`（错误消息不带上游密钥或请求体）。

服务层在 `LogQueryService.generateTaskBrief(groupId, config)`，`runtime.ts` 负责注入 `config.summary_model`，未配置时以 `Summary model is not configured.` 失败（与单请求总结同一措辞，前端据此引导用户去设置）。

## 5. 输入选择与结果清洗

`TrafficRepository.latestTaskRecordId(taskId)` 取 `event = 'request_finished'` 中 `sequence` 最大的一条；若该任务全部请求都还在飞行中，退化为最新一条（正在跑的任务也能出简介）。选择“最新已完成”而非“第一条”的原因：Agent 会话的最新一次请求带着完整历史，单条即可代表整个任务；而 pending 行的 body 还在增长，描述它等于描述一个半成品。

模型回答经 `parseTaskBriefContent()` 解析：先按严格 JSON 读（失败则剥 ```json 围栏后再试），取出 `brief` 作为正文并过 `briefParagraph()` 清洗（折叠换行与制表符、剥残留包裹与引号、截断到 4000 字符），`facts` 经 `sanitizeBriefFacts()` 规范化：只留字符串值、键名转小写并把空格与连字符转成下划线、单个值截到 200 字符、最多 6 条。完全不守 JSON 约定的模型（直出散文）仍能得到可用简介，只是没有环境信息。

提示词版本记在 `prompt_version` 列，提示词改动时同步上调（当前 `v2`）。

## 6. UI

`renderTaskPricingPanel` 在面板标题行之后、事实卡片网格之前插入 `.task-brief` 卡片：

- 标题行右侧按钮：未生成时“生成简介 / Generate brief”，已有简介时“重新生成 / Regenerate”，生成中置灰显示“生成中… / Generating…”。
- 正文上方先是一排环境信息胶囊 `.task-brief-facts`（每个 `.task-brief-fact` = 灰色小标签 + 等宽值，`flex-wrap` + `overflow-wrap: anywhere`，长路径不会把卡片撑得比面板其他内容更宽）。已知键名用本地化标签（`agent`→客户端 / Client、`cwd`→工作目录 / Working dir、`git_branch`→分支 / Branch、`os`→系统 / OS 等），模型自己发明的键按原名显示；一个都没提取到时该行整体不渲染。
- 正文 `.task-brief-text`（显式 `white-space: normal`，不受统计卡片 `nowrap` 影响，`line-height: 1.7`）；下方灰色小字显示“模型名 · 生成时间”。
- 未生成时显示提示文案；失败时显示“简介生成失败: <原因>”。
- 简介状态计入 `taskPricingRenderSignature`，否则自动刷新会沿用旧 DOM 而看不到简介。
- 宽度：卡片与下方内容同宽——它被列入面板那一组 `max-width: 760px` 的阅读宽度选择器（`.pricing-panel > .task-summary, .task-brief, .table-scroll, …`）。不列入就会比事实卡片网格、明细表、趋势图长出 52 px（1180 px 窗口下 812 px vs 760 px），成为唯一“更长”的卡片。
- 面板关闭时清空 `state.taskBrief`；重新打开时读缓存（GET），只有点按钮才 POST。

## 7. 验证

- `test-node/maintenance/log-query-service.test.ts`：最新已完成请求作为输入（pending 请求不会被选中）、能识别的请求头会随输入送达而无关请求头不送、环境信息解析（键名规范化、非字符串值丢弃、超长值截断）、```json 围栏回答、不守 JSON 约定的散文回答、缓存读回、跨日志目录时简介写入拥有该任务的目录、未知任务报 `Log group not found.`。
- `test-node/persistence/repository.test.ts`：`context_json` 写入与读回，重新生成时以 `null` 清空旧环境信息。
- `test-node/app/runtime.test.ts`：装配后的应用存在这两个路由（GET 返回 `null`，未配置总结模型时 POST 返回 502 `task_brief_failed`）。
- `test-node/ui/admin-ui.test.ts`：打开面板不调用模型、点按钮后正文与环境信息胶囊出现、“重新生成”按钮与模型署名出现、卡片位于事实网格之上、关闭后重开读回缓存且不重复 POST。
- 任务明细两张基线截图（`doc/ui_task_detail_*.png`）重新捕获：加入简介卡片时高度 1597 → 1705 px，加入环境信息一行后 1705 → 1779 px。
