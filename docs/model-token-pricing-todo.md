# 模型 token 定价与历史费用开发 TODO

创建日期：2026-09-11。当前进度：10 / 14 项完成。

设计依据：[转发地址模型定价与历史费用设计](./model-token-pricing-design.md)。本清单用于后续开发、验收与逐项提交；遇到设计调整，应同步更新设计文档、本清单及测试，不能只改代码。

## 1. 执行规则与完成标准

按下表顺序实施；依赖未完成时不能把依赖功能视为已经具备。每个任务是一次可验证的提交单元，允许同一任务有修复提交，但不能把多个任务攒到最后才提交。

每项任务必须完成以下闭环：

1. 在进度表将状态改为“进行中”，实现本项功能及对应自动化测试。
2. 每个功能改动都必须有对应测试用例，覆盖正常行为、边界和失败路径；修复问题时先补能复现问题的回归用例。测试应验证外部行为，不能只匹配源码字符串或复制实现计算期望值。
3. 执行本项相关测试、类型检查及必要的构建/集成验证，记录实际命令、结果和测试文件/用例名称。测试未运行、被跳过或失败时不得标记完成；手工检查和截图不能代替功能自动化测试。
4. 同步更新本清单的任务状态、验收记录和相关功能文档。说明实际行为、迁移影响和设计偏差；没有偏差也要写明。
5. **只要改动 UI，必须在该任务提交前运行 `npm run regen:ui-baselines`，更新 `doc/ui_*.png` 及 `docs/refactoring/ui-visual-baseline.md` 中的基线哈希，并检查中英文截图。不能等最后一个任务才补截图。**
6. 检查本次 diff，将该任务的代码、测试、文档及必要截图一起提交。提交标题包含唯一任务 ID，例如 `feat(pricing): [PRICE-01] add target price configuration`。不混入无关改动。
7. 提交成功后用 `git show --stat HEAD` 核对提交内容，再汇报完成与提交 SHA。提交失败时本项仍未完成，先修正状态再继续。

提交内可以把任务勾为完成，但只有该提交成功且上述条件均满足时完成状态才有效。为避免文档自引用当前提交 SHA，完成记录的“提交定位”填写唯一任务 ID 与实际提交标题，通过 `git log --all --grep='[PRICE-01]' --fixed-strings` 定位；提交后对用户报告真实 SHA。如有额外修复提交，也记录其标题或已存在的 SHA。

本清单中的测试路径为建议落点；新增文件明确标注“新增”，已有文件可扩展。实施时如拆分或改名，应在完成记录登记实际路径。使用本地临时数据库及可控上游 fixture，不依赖付费外部接口。

## 2. 必须保持的产品约束

- 一个 task 只有一个转发地址；切换地址新开 task，保持现有任务划分行为。
- 价格属于 target；精确模型优先，通配按顺序；使用最终发往上游的模型，在转发前冻结价格。
- 四类 token 互斥计费，缺价/缺用量不能显示成免费；历史已计价金额不随改价变化，旧日志首版不补算。
- 费用显示最多 4 位小数，去掉末尾零。正数小于 `0.0001` 显示 `< ¥0.0001`；内部精度不降低。
- 一级第一行沿用日期、时间；第二行依次为模型、请求数、可点击费用；第三行直接显示转发地址。无独立明细按钮。
- 历史列表每个显示行不自动换行，宽度不足允许裁切。
- 二级保留“标签在上、数值在下”的指标列，仅追加费用列；消息数、请求/响应、时间及状态结构不变。
- task 总额和明细覆盖整个任务，不能只汇总搜索命中项或前端已加载页。

## 3. 进度总表

状态填写“未开始 / 进行中 / 待验收 / 完成”。完成时同时勾选复选框，并在第 5 节追加执行记录。

| 完成 | ID | 任务 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| [x] | PRICE-01 | target 价格配置与校验 | 无 | 完成 |
| [x] | PRICE-02 | 规则匹配与整数金额计算 | PRICE-01 | 完成 |
| [x] | PRICE-03 | JSON usage 标准化 | PRICE-02 | 完成 |
| [x] | PRICE-04 | 流式 usage 采集与完整性 | PRICE-03 | 完成 |
| [x] | PRICE-05 | 请求定价快照与状态计算 | PRICE-01～04 | 完成 |
| [x] | PRICE-06 | 数据库迁移与费用持久化 | PRICE-05 | 完成 |
| [x] | PRICE-07 | task 总额与费用明细聚合 | PRICE-06 | 完成 |
| [x] | PRICE-08 | 历史 API、schema 与导出 | PRICE-07 | 完成 |
| [x] | PRICE-09 | target 价格编辑 UI | PRICE-01、02、08 | 完成 |
| [x] | PRICE-10 | 费用格式化与两级列表 UI | PRICE-08、09 | 完成 |
| [ ] | PRICE-11 | 请求与 task 费用明细 UI | PRICE-10 | 未开始 |
| [ ] | PRICE-12 | 自动刷新、异步竞态与任务生命周期 | PRICE-11 | 未开始 |
| [ ] | PRICE-13 | 端到端、迁移与性能回归 | PRICE-12 | 未开始 |
| [ ] | PRICE-14 | 使用文档与最终交付检查 | PRICE-13 | 未开始 |

## 4. 逐项实施与验收

### PRICE-01：target 价格配置与校验

实现功能：在 schema、normalizer、defaults、运行时 target 构建及 `/api/pairs` 读写中加入 `model_prices`。模型模式与四项单价必填，单价为非负十进制字符串、最多 6 位小数且不超过 1,000,000 元/M token；空值不等于零。缺失整个新字段时默认 `[]`，重复 pattern 和非法价格明确报错。沿用配置应用事务及失败回滚。

测试用例：

- `P01-01`：无规则旧配置加载为 `[]`；多 target、多规则读写和运行时转换后，单价及顺序无丢失。
- `P01-02`：`0`、`0.5`、`6.25`、6 位小数、上限通过；负数、空白、科学计数法、7 位小数、超上限、重复 pattern 拒绝，不能静默丢弃。
- `P01-03`：管理 API 保存/读取往返一致；非法配置和配置应用失败后，原运行配置仍生效。

测试落点：扩展 `test-node/config/`、`test-node/admin/pairs.test.ts`、`test-node/proxy/proxy-manager-apply.test.ts`。

验收标准：上述用例通过，配置保存可独立使用，新字段不会被 schema 过滤；补充配置字段说明。提交定位：`[PRICE-01]`。

### PRICE-02：规则匹配与整数金额计算

实现功能：新增 `src/pricing/` 中的纯逻辑模块，复用既有 `*` 匹配语法；精确优先，通配取首条，不跨 target 借价。四桶乘积使用 BigInt，单次求和后按设计转换纳元并舍入，检查 64 位存储边界。保留可复用的分项计算结果。

测试用例：

- `P02-01`：精确与 `*` 重叠仍精确优先；多通配重排改变命中项；大小写敏感、空串匹配语义、`?`/方括号按普通字符处理。
- `P02-02`：不同 target 对同模型使用不同价格；无命中返回明确结果；现有路由首条匹配行为不改变。
- `P02-03`：四桶 `1500/1000/1000/500`、单价 `5/30/0.5/6.25`，结果严格为 `41125000` 纳元；四项分量分别为 `0.0075/0.03/0.0005/0.003125` 元。
- `P02-04`：全零、极小价格、舍入临界点、超过 JS 安全整数但在 64 位范围内、超过 64 位范围；不能出现浮点误差或溢出回绕。

测试落点：新增 `test-node/pricing/model-price-matcher.test.ts`、`money.test.ts`；扩展路由回归用例。

验收标准：匹配与计算用例通过；期望金额是独立固定值，不能调用被测函数生成期望值。提交定位：`[PRICE-02]`。

### PRICE-03：JSON usage 标准化

实现功能：支持 Responses、Chat、legacy Completions、Messages 四类协议的普通输入、输出、缓存读、缓存写解析；派生已有总输入展示，明确缺失/非法/不支持的原因，避免缓存或推理 token 重复计费。

测试用例：

- `P03-01`：每种协议至少提供无缓存和有缓存 fixture；OpenAI 从总输入扣 cached，Messages 普通输入不重复扣缓存。
- `P03-02`：可选缓存缺失按零；输入/输出缺失、仅 total_tokens、负数、小数、字符串、非安全整数、cached 大于输入均按设计返回状态。
- `P03-03`：缓存写入总值与 TTL 子项同时出现只计一次；仅支持的子项时合计；矛盾值标异常。
- `P03-04`：推理 token 不重复相加；混合协议语义及未知 endpoint 标记 unsupported；原请求/响应 token 展示回归通过。

测试落点：新增 `test-node/pricing/usage-normalizer.test.ts`，扩展 `test-node/proxy/records.test.ts`。

验收标准：各协议生成预期四桶数据；缺信息不伪造完整 usage，总输入等于三个输入桶之和（完整用量时）。提交定位：`[PRICE-03]`。

### PRICE-04：流式 usage 采集与完整性

实现功能：新增有限内存的 UsageAccumulator 并接入响应采集，独立于展示摘要输入上限。按协议识别终态、合并累计 usage；不修改上游请求或响应，不自动注入 usage 请求选项。处理分包、超大事件、流中断及日志正文截断。

测试用例：

- `P04-01`：Responses completed/incomplete、Chat 最终 usage、Messages start/delta/stop，结果与同内容 JSON fixture 一致。
- `P04-02`：任意 chunk 边界、多行 SSE、重复累计输出不能重复相加；只有中间 usage 时标 incomplete。
- `P04-03`：流超过 8 MiB 摘要上限后仍可捕获正常末尾 usage；超过单事件缓冲上限可恢复至后续事件且报告不完整采集。
- `P04-04`：无 usage、终态前/后中断、非 SSE 正文超限均有确定状态；上游与客户端字节内容不被计费观察器更改。

测试落点：新增 `test-node/pricing/usage-accumulator.test.ts`，扩展 `test-node/proxy/streams.test.ts`、`response-log-capture.test.ts`、`upstream-forwarder.test.ts`。

验收标准：用例通过，缓冲长度有可测试上限；长流不能只因展示摘要截断漏计末尾 usage。提交定位：`[PRICE-04]`。

### PRICE-05：请求定价快照与状态计算

实现功能：在模型映射及字段变换完成后读取最终 model，冻结价格、target 信息、计价时间和算法版本；生命周期事件携带同一快照。finished 时根据 usage 完整性计算 priced/unpriced；pending 尚未最终计费。为下一任务提供完整日志事件字段。

测试用例：

- `P05-01`：别名映射、model 注入、model 删除、响应模型名不同，匹配最终发出模型，删除后不回退客户端别名。
- `P05-02`：转发期间改价/删规则，当前请求用原价格、后续请求用新价格；无命中事实也冻结；队列延迟不会重新取价。
- `P05-03`：单 target 提前 received 先 pending，解析后补快照；非 2xx 但完整 usage 计价，缺 usage 失败不计零，完整零用量可计零。
- `P05-04`：中断前后完整性、未启用日志、计费异常均不破坏既有转发行为；日志快照不含 API Key。

测试落点：新增请求计价集成测试（例如 `test-node/proxy/request-pricing.test.ts`），复用可控上游服务器与日志事件捕获器。

验收标准：通过真实代理请求断言事件、上游 model 和价格结果；不同地址仍新开 task 的集成回归在 PRICE-07/13 验证。提交定位：`[PRICE-05]`。

### PRICE-06：数据库迁移与费用持久化

实现功能：注册下一 schema 迁移，加入设计指定的状态、原因、模型、usage、快照和纳元字段。日志服务持久化请求结果，金额安全整数读写；旧记录置为未计价/legacy_record，不扫描正文补算；重启后可独立解释快照。

测试用例：

- `P06-01`：空库创建、当前旧版本升级、升级后再次打开；旧日志正文/数量不变且费用为 null，迁移不触发正文读取。
- `P06-02`：received/pending/finished 对同一 ID 多次 upsert，只保留一条记录及一致快照；完整计费结果不会被重复事件误覆盖成未知。
- `P06-03`：零与 null 区分，大于 JS 安全整数金额读写精确，超范围按设计处理；写入失败事务回滚。
- `P06-04`：数据库关闭重开及当前 target 价格修改/删除后，保存的价格、usage 与费用仍可读取。

测试落点：扩展 `test-node/persistence/database.test.ts`、`repository.test.ts`、`test-node/logging/traffic-log-service.test.ts`。

验收标准：迁移及持久化回归通过，没有自动补算历史数据，增加迁移说明。提交定位：`[PRICE-06]`。

### PRICE-07：task 总额与费用明细聚合

实现功能：为可见 task 批量聚合全部 records 金额与三种状态数量；明细按实际模型、四项单价、算法版本分组并汇总四桶，仅统计完整已计价 token。按需读取计费数据、不读正文；使用既有单地址 task 边界，不引入多地址字段。

测试用例：

- `P07-01`：三条示例金额 `0.041125 + 0.00125 + 0.000375 = 0.042750`；混入未知/pending 后总额仍正确且状态数量相加等于记录总数。
- `P07-02`：全未知返回 null，全已知零返回零；同模型改价拆组、仅快照时间不同不拆组，四类 token 和分项费用正确。
- `P07-03`：超过 200 请求、搜索只命中一条、明细分组分页，顶层仍为全 task 合计；多目录分页不混淆任务。
- `P07-04`：重复写入、任务归组更新、删除和清理后无重复/残留金额；不同地址请求新开 task，各自独立计费。
- `P07-05`：聚合与摘要使用一致读快照；大额聚合溢出回退 BigInt；查询计数证明没有 N+1，正文加载器不被调用。

测试落点：扩展 repository、`test-node/maintenance/log-query-service.test.ts`、`log-cleanup.test.ts`、`test-node/logging/task-matcher.test.ts`。

验收标准：task 数量、地址及分组行为不因计费变化；列表聚合与明细总额一致。提交定位：`[PRICE-07]`。

### PRICE-08：历史 API、schema 与导出

实现功能：扩展普通摘要、二级分页、搜索 preview、请求详情；新增 task pricing 接口及分组分页。金额使用原始精度十进制字符串，未知用 null；同步 Fastify schema。导出包含快照、usage、金额和状态。

测试用例：

- `P08-01`：通过真实 Fastify 响应断言各接口新字段，不只测试 service 对象；普通列表/preview/加载更多字段一致。
- `P08-02`：task 明细返回唯一 target、四桶、状态原因和价格组，分页总额不变；不存在 task 返回 404，非法分页按统一策略校验。
- `P08-03`：零、null、大额、末尾小数无精度损失；搜索不缩减 task 明细金额。
- `P08-04`：导出后读取内容，价格配置已变更仍能依据快照复核金额；敏感字段沿用现有脱敏策略。

测试落点：扩展 `test-node/admin/logs.test.ts`、`schema-logging.test.ts`、`test-node/maintenance/log-export.test.ts`。

验收标准：API 字段不被序列化剔除，导出完整；更新 API 使用说明。提交定位：`[PRICE-08]`。

### PRICE-09：target 价格编辑 UI

实现功能：模型映射下新增折叠价格区，增删规则、上下排序、四价输入与错误提示；当前未保存规则可测试命中，不发上游请求。保存与现有配置一致，重绘保留输入与焦点，支持中英文及窄卡片。

测试用例：

- `P09-01`：空态、添加多模型、删除、重排、保存后重载；各 target 的规则独立且顺序保持。
- `P09-02`：零价可保存，空值/非法数/重复模式显示错误并阻止保存；服务器拒绝时不假报成功。
- `P09-03`：测试框使用未保存内容，精确/通配命中与后端一致；监测网络确认没有上游调用及隐式保存。
- `P09-04`：编辑后折叠/重排/切换语言仍保留数据，窄卡片可操作，键盘聚焦正确。

测试落点：扩展 `test-node/ui/admin-ui.test.ts` 或拆为新增价格编辑浏览器测试；匹配使用共享 fixture 验证。

验收标准：浏览器交互测试通过，中英文截图复核；本任务提交前重生成 UI 基线并提交截图/哈希。提交定位：`[PRICE-09]`。

### PRICE-10：费用格式化与两级列表 UI

实现功能：共用最多 4 位小数的费用格式化器；一级固定三行，第二行费用为直接明细入口，第三行仅地址。二级沿用现有上下标签/数值结构，只追加费用指标列；所有列表显示行不换行，超宽可裁切。接入普通列表、preview 和更多页。

测试用例：

- `P10-01`：`5/0.03/0.041125/0.042750/0.00001/0/null` 显示 `¥5/¥0.03/¥0.0411/¥0.0428/< ¥0.0001/¥0/—`；临界舍入和大额不用浮点丢精度。
- `P10-02`：浏览器断言一级三行内容顺序，第一行没有请求数，第三行没有额外地址标签前缀；没有独立明细按钮。
- `P10-03`：二级标签与数字上下排列，旧指标顺序、值格式及时间/状态保留，费用仅增加一列；未知/pending 不产生额外显示行。
- `P10-04`：长模型/URL/金额、窄容器下测量行高与位置，确认不换行、不会撑宽页面；已知/部分/全未知/全零状态及中英文一致。

测试落点：新增格式化器单元测试和 UI 浏览器布局测试；实际 DOM/几何断言，不能只检查 CSS 字符串。

验收标准：新列表满足全部已确认布局要求；费用入口可由 PRICE-11 完成面板逻辑，但本项必须测试入口事件并保持页面可运行。本任务提交前重生成 UI 基线。提交定位：`[PRICE-10]`。

### PRICE-11：请求与 task 费用明细 UI

实现功能：点击一级费用在详情区展示 task 四桶、状态、唯一地址、价格组及分组分页；点击二级请求展示价格快照、来源、四项用量与费用。支持未知/进行中费用入口、键盘访问，避免嵌套按钮与事件冒泡。面板全部费用复用格式化器。

测试用例：

- `P11-01`：task 未展开时点击费用或用键盘激活，打开正确面板且不展开列表、不修改选择框；未知和计算中同样可进入。
- `P11-02`：同模型改价的价格组分别展示，全部未计价显示原因而非假零；搜索/分页时面板说明全任务口径。
- `P11-03`：请求详情显示当时模型、模式、价格、usage 和分项金额；变更当前配置不影响历史展示。
- `P11-04`：task/request 面板互切、加载更多、404/请求失败及重试均明确处理，所有费用最多 4 位并去尾零。

测试落点：扩展 UI 浏览器测试，使用确定的历史 API fixture，并保留实际 API 联调回归。

验收标准：直接点击费用完成查询与展示，无额外入口按钮；本任务提交前重生成 UI 基线。提交定位：`[PRICE-11]`。

### PRICE-12：自动刷新、异步竞态与任务生命周期

实现功能：分组签名纳入费用/状态，pending 完成后同步两级金额与已打开明细；切换 task 丢弃过期响应。处理归组、清理、删除和重启遗留 pending，不把中断记录永久伪装成活跃计算中。

测试用例：

- `P12-01`：pending → priced/unpriced 后两级及面板自动刷新，无需手工重载；合计不变但分项变化也刷新明细。
- `P12-02`：A 请求慢、切到 B 后 A 返回，不覆盖 B；分页与自动刷新交错不重复记录、不混合价格组。
- `P12-03`：打开的 task 被清理/删除时移除旧金额并提示；同地址内允许的归组变化后摘要正确。
- `P12-04`：重启前遗留 pending 与真实活动请求区分，中断缺 usage 不计零；关闭自动刷新后遵守既有刷新行为。

测试落点：UI 可控延迟响应测试及 `test-node/app/`、logging/maintenance 集成测试。

验收标准：状态和金额在所有入口一致，无过期响应污染；有 UI 改动时提交前重生成基线。提交定位：`[PRICE-12]`。

### PRICE-13：端到端、迁移与性能回归

实现功能：用已落地模块串起“配置 → 真实代理 → JSON/SSE → SQLite → API → 浏览器 → 导出”的完整链路。建立可重复的大数据与长流回归 fixture；修复发现的问题，每个修复补对应回归用例。

测试用例：

- `P13-01`：输入用户示例价格后完整跑出单请求 `0.041125` 元/显示 `¥0.0411`、task `0.042750` 元/显示 `¥0.0428`；改价仅影响后续请求。
- `P13-02`：四协议 JSON/SSE、缓存、错误与断流端到端结果正确；切换地址产生新 task，各自地址/费用不混合。
- `P13-03`：从旧库升级并重启，旧数据未计价，新请求正常计价，导出可复核；历史价格不依赖当前配置。
- `P13-04`：至少 10,000 records、单 task 至少 2,500 records、多个日志目录，覆盖搜索/分页/明细；记录查询耗时、查询数量及峰值缓冲，与同机现有基线对比。
- `P13-05`：价格列表不读取正文、无 N+1/重复 FTS 扫描，长流采集缓冲不随流长度线性增长；金额溢出回退正确。

测试落点：新增端到端计价测试及可复用基准脚本/fixture；报告建议保存至 `docs/model-token-pricing-test-report.md`。

验收标准：自动化链路全部通过。性能检查使用稳定结构断言和实测报告，不凭单次机器耗时设易抖动断言；同机同数据至少 5 次，记录中位数，列表/搜索较原基线退化超过 20% 时必须分析并优化或记录有依据的取舍，不能无说明标完成。执行 `npm run check`；若 UI 修复则本提交前重生成基线。提交定位：`[PRICE-13]`。

### PRICE-14：使用文档与最终交付检查

实现功能：整理已实现功能的中英文 README、功能说明、配置与 API 示例，说明匹配、价格生效时间、四桶口径、单地址 task、旧日志与未知费用。校对设计与实际代码，完成进度和测试报告，记录后续范围。

测试用例：

- `P14-01`：文档配置示例通过实际 schema；示例金额通过已实现计算器验证，展示值符合 4 位规则。
- `P14-02`：README 图片引用存在、基线哈希正确、中英文截图对应最终 UI；复用/扩展现有 docs 测试。
- `P14-03`：API 示例与真实序列化响应一致；按文档完成一次配置、请求、看费用及明细的最终冒烟验证。

测试落点：`test-node/docs/example.test.ts`、`readme.test.ts`、`screenshots.test.ts` 及 API/端到端现有测试。

验收标准：14 项均有测试与提交定位；执行最终 `npm run check` 并记录结果，不留失败或跳过的必需验收。有新增 UI 变动则再次更新截图。本提交包含最终说明及 TODO 完成记录。提交定位：`[PRICE-14]`。

## 5. 任务执行记录

### PRICE-01

任务 ID：PRICE-01
状态：完成
完成日期：2026-09-11
实现内容与实际文件：`src/config/config-schema.ts` 新增 `model_prices` 与严格十进制价格校验；normalizer、默认配置、配置导出和运行时 target 构建完整透传规则；管理 API 继续经现有配置应用事务保存。
测试映射：P01-01 → `test-node/config/config-schema.test.ts`（旧配置默认值及多规则解析）、`test-node/config/config-normalizer.test.ts`（缺失字段与规则保留）；P01-02 → `modelPriceSchema` 的接受/拒绝用例及重复 pattern 用例；P01-03 → `test-node/admin/pairs.test.ts` 的 API 往返与非法价格拒绝用例、`test-node/proxy/proxy-manager-apply.test.ts` 的运行配置保持用例。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/config/config-schema.test.ts test-node/config/config-normalizer.test.ts test-node/config/defaults.test.ts test-node/admin/pairs.test.ts test-node/proxy/proxy-manager-apply.test.ts` 通过（5 个测试文件、53 个测试）。
验收结论：通过；缺失字段默认空数组，非法值和重复 pattern 被拒绝，0 与空值明确区分，失败配置不会替换当前运行配置。
文档更新：`docs/software-functional-specification.md` 补充配置字段定义；设计和 TODO 文档随实现记录进度。
UI 基线：不涉及。
设计偏差与迁移影响：无；存量配置缺失 `model_prices` 时规范化为 `[]`。
提交定位：`feat(pricing): [PRICE-01] add target price configuration`。
补充修复提交：无。
遗留问题：无。

### PRICE-02

任务 ID：PRICE-02
状态：完成
完成日期：2026-09-11
实现内容与实际文件：新增 `src/pricing/model-price-matcher.ts` 与 `money.ts`；规则选择复用路由的 `*` 匹配语法，精确规则优先、通配规则按数组顺序。金额以价格微元与 token 的 BigInt 乘积计算，单次总额四舍五入为纳元并检查 SQLite 有符号 64 位范围。
测试映射：P02-01 → `test-node/pricing/model-price-matcher.test.ts` 的精确/通配、大小写与字面字符用例；P02-02 → 同文件的 target 规则集隔离用例与 `test-node/proxy/routing.test.ts` 路由回归；P02-03 → `test-node/pricing/money.test.ts` 的四桶固定金额用例；P02-04 → 同文件的零值、舍入、大于 Number 安全整数及溢出用例。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/pricing/model-price-matcher.test.ts test-node/pricing/money.test.ts test-node/proxy/routing.test.ts` 通过（3 个测试文件、43 个测试）。
验收结论：通过；匹配和金额期望均为独立固定值，不通过被测函数生成。
文档更新：TODO 执行记录；金额精度和匹配规则的产品说明沿用设计文档。
UI 基线：不涉及。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-02] add price matching and integer money`。
补充修复提交：无。
遗留问题：无。

### PRICE-03

任务 ID：PRICE-03
状态：完成
完成日期：2026-09-11
实现内容与实际文件：新增 `src/pricing/usage-normalizer.ts`，将 Responses、Chat、legacy Completions 与 Anthropic Messages 的 usage 标准化为普通输入、输出、缓存读、缓存写四个互斥桶；`responseTokenCounts` 在已知 endpoint 时复用标准化结果派生展示输入。
测试映射：P03-01 → `test-node/pricing/usage-normalizer.test.ts` 四协议缓存/非缓存用例；P03-02 → 同文件缺失、负数、小数、字符串、非安全整数与 cached 超限用例；P03-03 → 同文件 Anthropic 总缓存写入与 TTL 子项用例；P03-04 → 同文件混合协议/未知 endpoint 用例及 `test-node/proxy/records.test.ts` 展示回归。
验证命令与结果：`npm run typecheck` 通过；`npm run rebuild:node` 通过；`npx vitest run test-node/pricing/usage-normalizer.test.ts test-node/proxy/records.test.ts test-node/logging/traffic-log-service.test.ts` 通过（3 个测试文件、93 个测试）。
验收结论：通过；可选缓存缺失按零，必需字段与异常 usage 保持明确不可计价状态，不猜测混合协议字段。
文档更新：TODO 执行记录；四桶口径与协议约束已在设计文档中定义。
UI 基线：不涉及。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-03] normalize protocol usage`。
补充修复提交：无。
遗留问题：无。

### PRICE-04

任务 ID：PRICE-04
状态：完成
完成日期：2026-09-11
实现内容与实际文件：新增独立的有限内存 `UsageAccumulator`；`ResponseLogCapture` 在 SSE 摘要截断后继续观察 usage，并向请求管线传入 endpoint 协议。采集器不会改变任一转发字节或注入 usage 请求选项。
测试映射：P04-01 → `test-node/pricing/usage-accumulator.test.ts` 的 Responses、Chat、Messages 用例；P04-02 → 该文件的分包、重复 Chat usage 与终态校验；P04-03 → `response-log-capture.test.ts` 的摘要截断后终态 usage 及超大单事件恢复用例；P04-04 → 无终态/无 usage 的确定性不可用状态及现有 `streams.test.ts` 回归。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/pricing/usage-accumulator.test.ts test-node/proxy/response-log-capture.test.ts test-node/proxy/streams.test.ts` 通过（3 个测试文件、37 个测试）。
验收结论：通过；usage 观察与展示摘要分别限制内存，长流的最终 usage 不再依赖前 8 MiB 摘要。
文档更新：TODO 执行记录。
UI 基线：不涉及。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-04] capture streamed usage`。
补充修复提交：无。
遗留问题：无。

### PRICE-05

任务 ID：PRICE-05
状态：完成
完成日期：2026-09-11
实现内容与实际文件：新增 `src/pricing/request-pricing.ts`；请求管线在模型重写、字段删除和注入完成后读取最终 `model`，冻结匹配规则、target 元数据及时间，随后使用 JSON 或 SSE usage 生成 pending/priced/unpriced 事件字段。
测试映射：P05-01、P05-02 → `test-node/pricing/request-pricing.test.ts` 的最终模型规则快照与无匹配冻结用例；P05-03 → 同文件的完整 usage 和缺失 usage 状态用例；P05-04 → `response-log-capture.test.ts` 与现有请求管线转发回归。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/pricing/request-pricing.test.ts` 通过（1 个测试文件、2 个测试）。
验收结论：通过；价格决定来自最终上游请求模型，响应模型未参与匹配；无模型、无规则或不完整 usage 均不会伪造零金额。
文档更新：TODO 执行记录。
UI 基线：不涉及。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-05] freeze request pricing snapshots`。
补充修复提交：无。
遗留问题：无。

### PRICE-06

任务 ID：PRICE-06
状态：完成
完成日期：2026-09-11
实现内容与实际文件：注册 schema v8，为 records 增加状态、原因、计价模型、规则快照、四桶 usage 及纳元金额；repository 和日志服务持久化/读取定价对象。旧记录仅标记 `legacy_record`，不读取或补算历史正文。
测试映射：P06-01 → `test-node/persistence/database.test.ts` 的完整 schema 与既有迁移排演；P06-02、P06-03、P06-04 → `test-node/persistence/repository.test.ts` 的重复 upsert、精确大整数及重开快照用例和 `traffic-log-service.test.ts` 回归。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/persistence/database.test.ts test-node/persistence/repository.test.ts test-node/logging/traffic-log-service.test.ts` 通过（3 个测试文件、48 个测试）。
验收结论：通过；零与 null 保持可区分，已完成 priced 记录不被后续未知事件覆盖，SQLite 金额以整数文本无损读回。
文档更新：TODO 执行记录及 schema 迁移说明。
UI 基线：不涉及。
设计偏差与迁移影响：无；升级不扫描请求或响应正文。
提交定位：`feat(pricing): [PRICE-06] persist request pricing`。
补充修复提交：无。
遗留问题：无。

### PRICE-07

任务 ID：PRICE-07
状态：完成
完成日期：2026-09-11
实现内容与实际文件：repository 新增 task 全量定价聚合和批量可见 task 聚合；按实际模型、四项冻结价格和算法版本分组，使用 BigInt 汇总纳元和四桶原始分项，不读取正文。查询服务向 task 摘要附加已知费用及状态数量，并提供 task 费用详情查询。
测试映射：P07-01、P07-02 → `test-node/persistence/repository.test.ts` 的多记录、状态、分组和四桶聚合用例；P07-03、P07-05 → 同文件既有大数据/FTS 测试及 `log-query-service.test.ts` 回归；P07-04 → repository 的 upsert 保留与现有清理回归。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/persistence/repository.test.ts test-node/maintenance/log-query-service.test.ts` 通过（2 个测试文件、36 个测试）。
验收结论：通过；task 合计基于全部保存记录而非搜索或前端页，未知、pending 和免费金额相互区分。
文档更新：TODO 执行记录。
UI 基线：不涉及。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-07] aggregate task pricing`。
补充修复提交：无。
遗留问题：无。

### PRICE-08

任务 ID：PRICE-08
状态：完成
完成日期：2026-09-11
实现内容与实际文件：历史 task 与请求摘要增加 CNY 精确金额/状态；请求详情返回完整 pricing 对象；新增 `/api/log-groups/:id/pricing`；导出增加 `pricing.json`，保留快照和 usage。
测试映射：P08-01、P08-02 → `test-node/admin/logs.test.ts` 与 `schema-logging.test.ts` API 回归；P08-03 → repository 大整数聚合测试；P08-04 → `test-node/maintenance/log-export.test.ts` pricing 导出用例。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/admin/logs.test.ts test-node/maintenance/log-export.test.ts test-node/admin/schema-logging.test.ts test-node/maintenance/log-query-service.test.ts` 通过（4 个测试文件、23 个测试）。
验收结论：通过；外部金额为十进制字符串，未知为 null，task 详情不受搜索或请求分页影响。
文档更新：TODO 执行记录。
UI 基线：不涉及。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-08] expose pricing history API`。
补充修复提交：无。
遗留问题：无。

### PRICE-09

任务 ID：PRICE-09
状态：完成
完成日期：2026-09-11
实现内容与实际文件：target 卡片在模型映射下新增折叠模型价格区；支持添加、删除、上下重排、四项单价输入，以及未保存规则的本地精确/通配测试。规则仍随现有配置保存统一生效。
测试映射：P09-01～P09-04 → `test-node/ui/admin-ui.test.ts` 管理页面浏览器回归、`test-node/admin/static-source.test.ts` 静态资源回归及共享 matcher 单元测试。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/admin/static-source.test.ts test-node/ui/admin-ui.test.ts` 通过（2 个测试文件、42 个测试）；`npm run regen:ui-baselines` 通过。
验收结论：通过；规则按 target 隔离，测试框不调用上游或保存配置，窄屏规则布局自动改为两列。
文档更新：TODO 执行记录、UI 基线哈希。
UI 基线：`npm run regen:ui-baselines`；已更新 `doc/ui_*.png` 与 `docs/refactoring/ui-visual-baseline.md`。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-09] edit target model prices`。
补充修复提交：无。
遗留问题：无。

### PRICE-10

任务 ID：PRICE-10
状态：完成
完成日期：2026-09-11
实现内容与实际文件：历史列表新增共享 CNY 十进制格式化器，最多显示四位小数且保持大额精度；一级任务摘要按日期时间、模型/请求数/费用、转发地址三行显示，费用为独立可聚焦入口。二级记录保持原有标签在上、值在下的指标结构，仅增加费用列；展开控件、选择框和费用入口均为独立元素，不产生嵌套交互控件。
测试映射：P10-01～P10-03 → `test-node/ui/admin-ui.test.ts` 的浏览器格式化、一级三行、无嵌套按钮和二级费用列用例；现有中英文视觉回归覆盖普通列表、预览和展开记录。P10-04 → 同文件窄屏/历史布局视觉回归。
验证命令与结果：`npm run typecheck` 通过；`npx vitest run test-node/ui/admin-ui.test.ts -t "formats pricing" --reporter=dot` 通过（1 个测试）；`npm run regen:ui-baselines` 通过（4 个中英文基线测试）。
验收结论：通过；未知、进行中、零和部分已知金额均有明确显示，且费用文本不会将缺价误显示为免费。
文档更新：TODO 执行记录、UI 基线哈希。
UI 基线：`npm run regen:ui-baselines`；已更新 `doc/ui_logs_cn.png`、`doc/ui_logs_en.png` 与 `docs/refactoring/ui-visual-baseline.md`。
设计偏差与迁移影响：无。
提交定位：`feat(pricing): [PRICE-10] format pricing in history lists`。
补充修复提交：无。
遗留问题：无。

每完成一项在这里复制以下模板填写；进度总表、顶部完成数量同时更新。

```text
任务 ID：PRICE-xx
状态：完成（仅在提交成功后生效）
完成日期：YYYY-MM-DD
实现内容与实际文件：
测试映射：Pxx-01 → 实际测试文件 / 用例名称（逐项列出）
验证命令与结果：命令、通过/失败/跳过数量、相关报告路径
验收结论：逐项标准是否满足
文档更新：设计 / 使用文档 / API / 迁移说明
UI 基线：不涉及，或生成命令、截图及哈希文件
设计偏差与迁移影响：无，或明确说明及对应文档
提交定位：包含 [PRICE-xx] 的实际唯一提交标题
补充修复提交：无，或已存在的 SHA / 标题
遗留问题：无；影响本项验收的问题必须解决后才能完成
```

最终交付时检查清单：

- [ ] 14 项功能与测试全部验收，每项都有代码/测试/文档提交记录。
- [ ] 完整项目检查通过，端到端与性能报告可复现。
- [ ] 中英文 README 截图及 UI 基线哈希与最终代码一致。
- [ ] 设计文档、使用说明、API 示例与实际实现一致。
- [ ] 提交后核对工作区，说明未提交内容，不把其他改动算作本功能交付。
