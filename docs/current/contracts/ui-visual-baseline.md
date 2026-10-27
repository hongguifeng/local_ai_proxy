# UI 视觉基线登记

> 状态：当前
> 权威性：当前代码和用户行为的文档入口。
> 更新条件：对应代码合同、用户行为或验证入口变化时更新。

## 目的

本文件登记十张 UI 基线截图：Proxy、History、使用量统计、任务明细（History 页内的“任务明细”面板）与负载均衡组卡片（Proxy 页内的负载均衡区）各按中/英界面拆分，作为 Node.js 重构阶段的布局、颜色、信息层级和交互状态基线。

原截图没有保存浏览器名称、浏览器版本、设备缩放或原始 viewport 元数据，因此无法把像素级差异直接认定为回归。第一轮 Playwright 基线建立时，应在固定浏览器和 viewport 下重新生成一套可自动比较的截图；在此之前，以现有图片尺寸和可见结构进行人工对照。

## 基线文件

| 页面 | 语言 | 文件 | 图片尺寸 | SHA-256 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Proxy | 中文 | `doc/ui_proxy_cn.png` | 1278 x 1215 | `8c56ef181f2fd753471ee115239e919ef03c3019a9793ac69f91347dc497870d` | 当前任务卡片与顶部时间范围为 2026-07-18 12:00:00 的静态 fixture(不是测试当前时间);侧栏日志组为 4 个任务 fixture(1 个 3 调用任务 + 1 个长任务)。转发地址卡片头部左侧是名称输入框，右上角依次是自绘默认单选与启用开关（开关无文字），卡片左下角同一行依次是测试/指标/删除按钮与「更多配置」；卡片按状态保留淡填充（默认浅绿 `#d7e9e0`、已启用浅蓝 `#d5e0ed`、未启用浅灰 `#f5f6f8`）；默认选中时启用开关保持勾选并置为禁用态（整枚滑块降到 45% 透明度）。 |
| Proxy | 英文 | `doc/ui_proxy_en.png` | 1278 x 1208 | `6aa2418e7b9c67e1add1f412fc92715de6a5c26f6d81f85fd2aba6df72fb3d78` | 当前任务卡片与顶部时间范围为 2026-07-18 12:00:00 的静态 fixture(不是测试当前时间);侧栏日志组为 4 个任务 fixture(1 个 3 调用任务 + 1 个长任务)。Target card 头部左侧是名称输入框，右上角依次是自绘 Default 单选与 Enabled 开关（开关无文字），卡片左下角同一行依次是 Test/Metrics/Delete 按钮与 More settings；卡片按状态保留淡填充（Default 浅绿 `#d7e9e0`、Enabled 浅蓝 `#d5e0ed`、未启用浅灰 `#f5f6f8`）；Default 选中时 Enabled 开关保持勾选并禁用。 |
| Load balancing | 中文 | `doc/ui_lb_cn.png` | 1278 x 1973 | `a7195d64f8588e2c0fc2d648061351092d0511610bcb172cd2004f9a7b90c7b1` | Proxy 页整页截图（viewport 高度自适应到整页，不是只截可视区），只保留第一个代理卡片以免整页过长。转发地址三张卡片全部启用（默认那张浅绿填充 `#d7e9e0` 加绿色描边、另外两张浅蓝填充 `#d5e0ed` 加蓝色描边，右上角是默认单选与启用开关），下面以虚线分隔出负载均衡区：两张组卡片与转发地址卡片同宽、左对齐，右侧留白。左边那张参与节点下面是两行映射（`lmstudio`、`Target`，映射模型都留空），右边那张是另一个组 Cloud relay（轮转策略），成员 `openrouter` 与 `lmstudio`。组卡片里的四个控件（组名、pattern、选择策略、选择节点）长相一致：白底、1 px `#b8c5d3` 细边框、6 px 圆角、32 px 高、13 px 字，两个下拉和选择节点按钮右侧的箭头是同一张 SVG、靠右 10 px。成员行左边的节点名框与右边的映射模型框同样 32 px 高、13 px 字、同一描边色，只是名字框圆角与边框粗细沿用标签样式。两张卡片都是正常状态：成员全部启用，所以画面里没有「禁用」标记，也没有琥珀色警告行；成员浮层两张都保持关闭。左边那张的「节点状态 · 2」details 展开，其第一个节点 lmstudio 的「路由绑定」列表也展开；右边那张的节点状态保持折叠，所以同一画面里折叠与展开都在。展开的节点行是六项事实（进行中、排队、KV、绑定、冷却、指标来源）加右侧「启用」徽标，数字来自一次真实的状态读取（截图前先等到那一次读取），不是卡片在读取到达前写的占位值。绑定列表共 5 行、是完整一页（「本节点绑定: 5 / 5 · 已显示行的关联 task: 6」，没有「继续读取」按钮）：基线夹具只留代表行，每行各占一种状态——三个 task 共享一个 binding、候选且历史被截断、超长模型名、历史查询失败、没有配置日志根；整页 25 行只会把截图拉到几千像素而不增添任何可读内容，留下的行与 UI 用例读到的是同一批 item、`totalBindings`/`hasMore`/`nextOffset` 也都按缩短后的集合一致，不是真实服务答不出来的形状。每行是列表里一张浅底（`#f7f9fb`）、1 px `#dde5ef` 描边、6 px 圆角的独立小块，块与块之间 8 px 留白——相邻绑定靠留白和各自描边分开，不靠竖线或缩进。小块首行只印这一行读起来的主线加两个数：最左是关联到的 task id（没关联时是绑定编号加模型名，超长时被省略号截断，完整值在悬停文本里），紧跟一枚活动徽标（进行中/空闲/未知），其后只有请求次数与输入 token；这条绑定还连着别的 task 时另加一枚 `+N` 徽标，`N` 是本行不展示的条数，徽标的悬停文本把那些 task 的 id 与各自的请求数逐个列出来。这四项以外画面里没有任何标记：候选、候选不唯一、历史读失败、历史被截断、日志可能还没写进去、节点不同、历史落点未知、只有进行中请求、task 等级一律只写在悬停文本里，连「这个绑定的历史读不了」这类坏消息也只在悬停里读得到。其余全部信息——编号、模型、端点类型与路径、目标与 `targetId`、路由版本、编号代次、最近请求与其观测时间、最后响应与其观测时间、进行中计数、完整成本句（归一化用量种类、输入/缓存读取/请求字节、观测时间）、关联 task 数与置信度、历史覆盖一句与其 cause、原因标签、本行未展示的 task 名单——写成块首行的 `data-lb-hover-*` 属性并拼成首行的 `title` 悬停文本；被选作标题那个 task 自己的等级、时间、落点、端点与模型拼在标题的悬停文本里。迁移一行是同一行里的选择目标节点下拉与迁移此绑定按钮：两者等高（28 px）、顶边与垂直中心对齐，未选中目标时按钮保持禁用；下拉第一项是占位的选择目标节点，只有服务端判定可接收的成员才是可选项，指标未知的合格目标在名字后面追加目标指标未知，被拒绝的成员带着服务端那句原因出现在同一列表里但带 disabled；历史读取失败的「重新读取」按钮排在同一行末尾，确认句与提示句各占自己的下一行。列表底部跟着迁移操作一行，内容是 #7 这条记录的等待当前请求边界状态与其取消这次登记按钮，因为操作状态来自列表读取而不是重复提交。超长模型名在行内被省略号截断，tooltip 仍是完整名字。禁用成员、各类警告与未选节点的空态都由功能用例覆盖，不进基线。 |
| Load balancing | 英文 | `doc/ui_lb_en.png` | 1278 x 2056 | `515b3c65943986adb7060cb89862d187dcc01543edbd29d10055a9f2122ad076` | 与中文基线同一 fixture 的英文界面（转发地址卡片同布局：头部右上角 Default 单选 + Enabled 开关，左下角 Test/Metrics/Delete + More settings，按状态保留淡填充与描边色）：Dual GPU 的 Member nodes 是 `lmstudio` 与 `Target`，Cloud relay 是 Round robin、成员 `openrouter` 与 `lmstudio`；Least load 与 Round robin 两个 select 和 Choose nodes 按钮同一长相（白底、细边框、6 px 圆角、32 px 高、箭头同尺寸同位置）。两张卡片都是正常状态，没有 off 标记也没有警告行，Member nodes 下面是 Choose nodes 触发器和每个成员一行映射（节点名框 + Mapped model 输入框，两框等高），Choose nodes 浮层两张都保持关闭。左边那张的 Node state · 2 展开，第一个节点 lmstudio 的 Route bindings 列表也展开；右边那张保持折叠。展开的节点行六项事实（In flight、Waiting、KV、Bindings、Cooldown、Metrics source）加 on 徽标，数字来自一次真实的状态读取；Metrics source 与 Routing revision、Cost 两格在英文标签更长的情况下被 ellipsis 截断，完整内容仍在 title tooltip 里。展开的列表是完整一页（Bindings on this node: 5 / 5 · Linked tasks in the rows shown: 6，没有 Load more 按钮），5 行各覆盖一种状态：three tasks on one binding（high confidence + several candidates + ambiguous）、candidate 且 history truncated 与 log write may still be pending、超长模型名、history query failed 带 SqliteError 原句、no log root configured。Each binding is its own light block inside the list — `#f7f9fb` fill, 1 px `#dde5ef` border, 6 px radius — with 8 px of blank space between blocks, so neighbours are separated by whitespace and their own borders rather than by indentation or a vertical line. The block's first line prints only the thing the row is read for and two figures: the linked task id at the left (the binding number plus model name when nothing is linked, ellipsised when too long with the full value in the hover text), an activity chip right after it (in flight / idle / unknown), then the request count and the input-token count, and a `+N` chip when the binding holds more tasks than the line shows - `N` counts the tasks this row does not print, and the chip's hover text lists those tasks with their own request counts. Nothing beyond those four items is printed at all: the candidate, several-candidates, history-query-failed, history-truncated, log-write-may-be-pending, different-node, history-target-unknown, pending-request-only and task-level marks are all carried in the hover text, and even a history read that broke is readable only there. Everything else - the number, model, endpoint kind and path, target and `targetId`, routing revision, incarnation, last request with its observed time, last response with its observed time, in-flight count, the full cost sentence (usage kind, input, cache-read and request bytes, observed time), linked-task count with confidence, the history-coverage sentence with its cause, the reason labels and the list of tasks the row does not print - is written into the block's own line as `data-lb-hover-*` attributes and joined into its `title` hover text, while the task the title names carries its own level, times, target node, endpoint and model inside the title's hover text. The move affordance is one line: the Choose a destination node select and the Move this binding button are the same height (28 px) and share a top edge and vertical centre, and the button stays disabled until a destination is chosen; the select's first option is the placeholder Choose a destination node, only members the server accepts are selectable, an eligible destination with missing, stale or partial figures is followed by destination metrics unknown, and a refused member appears in the same list carrying the server's refusal reason and disabled. A failed history read adds its Reload button at the end of that same line, and the confirmation and hint sentences each take their own next line. Below the list comes the Migration operations line, holding #7's waiting-for-the-current-request-boundary state and its Cancel this registration button, because that state comes from the list read rather than a repeated submit. 长模型名在行内被 ellipsis 截断，tooltip 是完整名字。fixture 不含名为“新代理”的第二个代理，列表与节点行的每一句也都走了翻译键，所以整张画面里没有任何中文。 |
=
| History | 中文 | `doc/ui_logs_cn.png` | 1384 x 1212 | `3b4e33cd300ced3d803285d0b74f474f9edae0fbfc21d389ea17d52d4cf00b7f` | 当前任务卡片与顶部时间范围为 2026-07-18 12:00:00 的静态 fixture(不是测试当前时间);侧栏日志组为 4 个任务 fixture(1 个 3 调用任务 + 1 个长任务)。一级任务列表的控制列第二行（与复选框同一中轴、对齐模型/指标行）在 `cost.pending_request_count` 大于 0 时画一枚 8 px 绿色圆点（`var(--accent)`，只有 tooltip 不参与文本）；fixture 里只有第一个任务为 1，其余三个任务为 0，所以画面里只有一枚圆点，圆点之外无任何像素变化（60 个像素，占 0.0036%）。 |
| History | 英文 | `doc/ui_logs_en.png` | 1384 x 1224 | `dfa47f2b5ebee9fd5dce1b0d33ac4bbfb0cd754adb8533a495203d1c14225fb2` | 与中文基线同一 fixture 的英文界面：一级任务列表控制列第二行同一位置只有第一个任务显示 8 px 绿色圆点（`cost.pending_request_count` 为 1，圆点只有 title，不新增可见文本），其余三个任务没有进行中的请求；英文画面无中文，圆点之外无任何像素变化（60 个像素，占 0.0035%）。 |
| Usage statistics | 中文 | `doc/ui_stats_cn.png` | 1278 x 1553 | `ba399c298ae842fa80c73e532d4d4c47e5c5f93109ee5e61334eb0c163bc0b8d` | “总体使用量”标题下“按当前时间范围汇总”后以琥珀色（原提示条颜色）括号内联未计价请求数量（不再使用独立提示条） |
| Usage statistics | 英文 | `doc/ui_stats_en.png` | 1278 x 1553 | `9e9288111abe4d10686f5d35af06bc40dc8f32c94d7ba74bcdb9fcc0a6928321` | “Total usage”标题下“Summary for the selected period”后以琥珀色（原提示条颜色）括号内联未计价请求数量（不再使用独立提示条） |
| Task detail | 中文 | `doc/ui_task_detail_cn.png` | 1180 x 1833 | `784ea7c1c4080d94e12c2b956071b8a450a14018c18a22da0faff60cf10eeb0a` | 面板最上方新增“任务简介”卡片（白底、圆角、描边）：标题行右侧是按钮（未生成时“生成简介”，已有简介时“重新生成”，生成中置灰显示“生成中…”），正文是一段自动换行的简介文字，卡片里先是一排环境信息标签（模型从最新一次请求里读出的基础信息：客户端、工作目录、分支、系统等，只有读到才会出现），随后是简介正文段落，其下灰色小字为“模型名 · 生成时间”；基线中该卡片填入 fixture 简介与环境信息。卡片与下方的事实卡片网格同宽（一起列入面板的 max-width: 760px 阅读宽度组，不会比其他内容更长）。任务详情面板顶部:转发地址为独立整行;4 列卡片网格第一行是模型卡片(首格)与横跨 3 列的时间条(3 个子卡:时间范围 + 任务总耗时 + 请求总耗时)。时间范围子卡是三列(标签 | 日期 | 时间)网格,两个时间行各有自己的左侧标签(“起始时间”/“结束时间”,而非共享的“时间范围”标题):上行为起始([起始日期徽标] 开始时间,前缀标签“起始时间”),下行为结束([结束日期徽标] 结束时间,前缀标签“结束时间”),两行之间用 row-gap 9px 拉开(时间行 line-height 1,中心距约 30px,与原箭头分隔布局一致;两个日期徽标始终都显示,同天与跨天一致,两日期对齐在同一日期列,两个时间对齐在同一时间列);窄窗口下 app.js 的 fitTaskSummaryValues 先逐像素缩小模型名(下限 12px)再折行;第二行是请求数量、总 Token(人类可读:≥ 1 亿显示 x.x 亿、≥ 1 万显示 x.x 万、否则千分位原值,与明细表合计行同一数据源)、平均 decode 速度、费用（20px 大数值，左缘对齐）；三条趋势图（费用 / 逐请求 token 总量 / token 输出，费用图在最前）各自最高点旁直标该点具体值（费用与点悬浮提示同格式，四舍五入到 4 位小数；峰值靠右缘时标签改到点左侧，避免溢出 viewBox）；费用图与 token 输出图各有一条表示逐请求平均值的琥珀色水平虚线（独立于折线颜色，避免与数据混在一起），线右端标出数值（平均值为 0 或仅一个点时不画），虚线与数值画在折线点之上不被点遮挡，逐请求 token 总量图无此线；明细表上方新增“任务费用”节标题（绿色圆点，与费用趋势同一语义色，只在表格出现时一起出现），表头行底色由 #edf2f7 加深为 #dbe4ee，合计行不再填底色（与表体同一白底，只靠上边框和加粗字重区分），四个分区的范围说明改到各自标题下方、内容上方（任务费用表一句，三条趋势图各一句），两张画面从 1779 长到 1833 |
| Task detail | 英文 | `doc/ui_task_detail_en.png` | 1180 x 1833 | `c2f69cbb730f2d2070ed63350d922871cdece0276eaf97dd0d82f71e082b4efa` | 面板最上方新增“Task brief”卡片（白底、圆角、描边）：标题行右侧是按钮（未生成时“Generate brief”，已有简介时“Regenerate”，生成中置灰显示“Generating…”），正文是一段自动换行的简介文字，卡片里先是一排环境信息标签（模型从最新一次请求里读出的基础信息：Client、Working dir、Branch、OS 等，只有读到才会出现），随后是简介正文段落，其下灰色小字为“model · generated time”；基线中该卡片填入 fixture 简介与环境信息。卡片与下方的事实卡片网格同宽（一起列入面板的 max-width: 760px 阅读宽度组，不会比其他内容更长）。任务详情面板顶部:Target 为独立整行;4 列卡片网格第一行是 Model 卡片(首格)与横跨 3 列的时间条(Time range + Task time + Request time)。Time range 子卡是三列(label | date | time)网格,两个时间行各有自己的左侧标签(“Start time”/“End time”,而非共享的“Time range”标题):上行为起始([start date badge] start time,前缀标签“Start time”),下行为结束([end date badge] end time,前缀标签“End time”),两行之间用 row-gap 9px 拉开(时间行 line-height 1,中心距约 30px,与原箭头分隔布局一致;两个日期徽标始终都显示,同天与跨天一致,两日期对齐在同一日期列,两时间对齐在同一时间列);窄窗口下模型名由 fitTaskSummaryValues 缩小(下限 12px);第二行是 Requests、Total tokens(人类可读:≥ 1B / ≥ 1M 缩写,否则千分位原值,与明细表合计行同一数据源)、Avg decode speed、Cost（20px 大数值，左缘对齐）；三条趋势图（费用 / 逐请求 token 总量 / token 输出，费用图在最前）各自最高点旁直标该点具体值（费用与点悬浮提示同格式，四舍五入到 4 位小数；峰值靠右缘时标签改到点左侧，避免溢出 viewBox）；Cost 图与 Token 输出图各有一条表示逐请求平均值的琥珀色水平虚线（独立于折线颜色，避免与数据混在一起），线右端标出数值（平均值为 0 或仅一个点时不画），虚线与数值画在折线点之上不被点遮挡，Token 总量图无此线；明细表上方新增 “Task cost” 节标题（绿色圆点，与费用趋势同一语义色，只在表格出现时一起出现），表头行底色由 #edf2f7 加深为 #dbe4ee，合计行不再填底色（与表体同一白底，只靠上边框和加粗字重区分），四个分区的范围说明改到各自标题下方、内容上方（任务费用表一句，三条趋势图各一句），两张画面从 1779 长到 1833 |

哈希复现命令：

```bash
sha256sum doc/ui_proxy_cn.png doc/ui_proxy_en.png doc/ui_lb_cn.png doc/ui_lb_en.png doc/ui_logs_cn.png doc/ui_logs_en.png doc/ui_stats_cn.png doc/ui_stats_en.png doc/ui_task_detail_cn.png doc/ui_task_detail_en.png
```

比较规则（`screenshotDifference`，test-node/ui/admin-ui-page.ts）：宽度必须一致；高度不做断言，只要求一方多出的行是空白背景——自适应视口的高度随系统字体换行变化（同一张 Load balancing 页在 Linux runner 上中文矮 32 px、英文高 32 px，在 windows runner 上英文矮 54 px），断言相等会把字体差异当成内容回归；重叠区域像素差异比例小于 0.25（Proxy 与 Load balancing 两组基线用更严的 0.12）。内容丢失会让多出的行出现深色像素，内容位移会体现在像素比例上。多出的行能不能算空白，取决于页面底下留了多少空白带：绑定列表成了整页最后一段内容之后，52 px 留白只剩 31 px 空白尾，容不住上面那些高度漂移，最后一行有字的内容就落到比较区外，空白行检查会在字根本没动的情况下报错。所以 Load balancing 的自适应视口留白现在是 150 px（`LB_CAPTURE_PAD`），committed 两张基线下面的空白尾实测 129 px，比目前测到的最大漂移 54 px 高一倍多；空白行检查本身不放宽，多出的一行有字仍然失败。

## Proxy 页面状态

截图中可见的关键基线：

- 顶部白色 Header，左侧产品名，右侧 Tab 和语言选择器。
- 页面浅灰背景，代理为白色圆角卡片。
- 代理名称、运行圆点、监听地址、端口和开关位于同一行。
- Target 卡片按状态保留淡填充与描边色（原三种深填充各与白色对半混合，画面更安静）：默认目标 `#d7e9e0` + 描边 `#357451`、已启用 `#d5e0ed` + `#3c74a6`、未启用 `#f5f6f8` + `#c5c8cc`；卡片在代理卡片内按可用宽度自动换行排列。
- fixture 中第一个代理包含默认与已启用卡片，第二个代理包含一张未启用卡片，用于覆盖三种状态。
- fixture 上游名称与地址使用通用示例名（`openrouter` / `lmstudio` / `Target` + `https://api.example.com/v1`，监听模型前缀 `or-` / `A-`），不绑定具体第三方中转服务商；路由单测同样用 `or-gpt-5.5` 前缀。
- Target 默认展示名称、URL、API Key、模型映射；卡片右上角是自绘默认单选（未选为灰色圆环，选中为主题色圆环加中心圆点）与启用开关（与负载均衡组卡片同一款滑块，右侧没有文字，`title` 与 `aria-label` 为「启用 / Enabled」），默认选中时开关保持勾选并禁用。
- 卡片头部行左侧是名称输入框（占据剩余宽度），右上角是默认单选与启用开关；测试/指标/删除三枚按钮在卡片底部行的左端，「更多配置」仍在同一行右端。
- 每张 Target 卡片头部左侧是 ⠿ 拖拽手柄（同一代理只有一个 Target 时置灰禁用），拖动手柄可调整卡片顺序，顺序即模型映射的匹配优先级。
- API Key 输入框包含显隐与复制按钮。
- 代理卡片头部一行从左到右是名称输入框、监听地址、端口、「删除 / Delete」按钮、最右端的启用开关；名称框是固定 240 px 宽，不随列拉伸。
- 「转发地址 / Targets」标题行左侧是加粗标题，右侧是「添加转发地址 / Add target」按钮，位置与「添加负载均衡组」一致；卡片底部不再有操作行。
- 转发地址区下方以虚线分隔出「负载均衡组 / Load balancing groups」区：标题行左侧是加粗标题，右侧是「添加负载均衡组 / Add load balancing group」按钮，组卡片（若有）与转发地址卡片同宽（`repeat(auto-fit, minmax(300px, 360px))` + `justify-content: start`）左对齐换行，不会被拉伸到整行，也不会被同行的邻居拉到等高。`ui_proxy_cn.png` / `ui_proxy_en.png` 的 fixture `load_balancers` 为空数组，所以两张代理卡片里都只有标题与按钮，没有组卡片和节点状态；带组卡片的状态由 `ui_lb_cn.png` / `ui_lb_en.png` 覆盖。
- 运行代理使用绿色状态圆点和绿色开关；停止代理使用灰色状态。
- 中文和英文界面保持同一布局，不因文字长度改变主要列结构。

## 负载均衡组卡片状态

`ui_lb_cn.png` / `ui_lb_en.png` 由带组的 Proxy fixture（`visualLbPairs()`）驱动：整页截图，只保留第一个代理卡片以免画面过长；基线里的两张组卡片是 Dual GPU（最少负载，成员 `lmstudio` 与 `Target`）与 Cloud relay（轮转，成员 `openrouter` 与 `lmstudio`），成员全部启用，即用户要求的「正常情况」画面。关键基线：

- 组卡片与转发地址卡片同宽（300–360 px）并左对齐；同一区里多张组卡片并排，不会拉伸到整行，也不会被同行邻居拉到等高。
- 组卡片头部一行是组名输入框、「删除 / Delete」按钮、绿色启用开关（开关在最右端）；其下依次是请求模型 pattern、选择策略下拉、两个开关复选框。
- 「参与节点 / Member nodes」标题下先是一行「选择节点 / Choose nodes」触发器，其下每个已勾选成员占一行：左边节点名是一枚白底描边框，右边是这一行自己的映射模型输入框。禁用成员的名单元格右侧带琥珀色「禁用 / off」标记，标记始终单行不换行（基线里成员全部启用，画面里没有这枚标记）。
- 「选择节点 / Choose nodes」触发器（右侧一枚 SVG 箭头）展开后在本 pair 全部转发节点上浮出复选框列表，浮层覆盖卡片下方内容而不改变卡片高度，点浮层外或按 Esc 关闭；基线里浮层保持关闭。
- 一张都没勾选时映射区显示「未选择节点 / No nodes selected」；基线里两组都有成员，所以这句只由功能用例覆盖，不在画面中。
- 基线里两张卡片到「节点状态 · 2 / Node state · 2」为止；LB-16 删掉了匹配预览输入和校验按钮，两张基线因此比最初矮 92 px，LB-17 把卡片里四个控件统一成同一长相后又各自高了 7 px；LB-19 给每个成员加了映射模型输入框，两张基线各自长到 1278×1207 / 1278×1252；随后 LB-19.1 删掉了成员上方那行标签（映射区已经说明同一件事），两张又各自矮回 27 px，当时中文 1278×1150、英文 1278×1194（LB-20 换头部两控件的位置时高度没动；LB-21 把「添加转发地址」挪上「转发地址」标题行、把「删除」挪进代理头部后，卡片底部那一行操作没了，整页因此比上一版矮 30 / 31 px）。TRI-06 加上节点行下的绑定列表后两张基线仍字节不变，因为那时基线里节点状态 details 全部折叠、画面里根没有新控件。本轮把基线改成真的覆盖这个列表：左边那张「节点状态 · 2」details 展开，其第一个节点的「路由绑定 / Route bindings」列表也展开，右边那张保持折叠，所以折叠与展开在同一画面里都有。展开区是节点行的六项事实加启用徽标（数字来自一次真实的状态读取，截图前先等到那一次读取，否则画面里会是卡片在读取到达前写的占位值），然后是 5 行代表 binding 与一句完整一页的汇总（`5 / 5`，没有「继续读取」按钮）：三 task 共享一个 binding、候选且历史被截断、超长模型名（行内省略号，tooltip 仍是全名）、历史查询失败带服务端原句、没有配置日志根。列表由 `lbBindingVisualRows` 这个只给基线用的旋钮缩短，留下的行仍是 UI 用例读到的同一批 item，`totalBindings`、`hasMore`、`nextOffset` 与节点计数都按同一批行算，所以画面里没有真实服务答不出来的形状；整页 25 行只会把截图拉到几千像素而不增添可读内容。两张现在中文 1278×1973、英文 1278×2056，比上一版（1278×2154 / 1278×2260）各自矮 181 / 204 px：行上的
标记全部收回悬停、连到多个 task 的绑定不再为其余 task 各起一行以后，块的高度又降了一截；自适应视口仍在
整页下面留 150 px 空白带，让 runner 与本机之间的高度漂移落在空白里，而不是落在最后一行有字的内容上。组里含禁用成员时卡片下部会出现琥珀色警告行；基线里两组都是正常状态，画面里没有警告行。
- 英文基线里 `Metrics source`、`Routing revision` 与 `Cost` 三格因为英文标签更长而被 ellipsis 截断，完整内容在 `title` tooltip 里；同一格中文标签短，画面里是完整值。这是标签长度差异，不是新的截断规则。
- 中英文界面同一列结构，英文界面文案无中文。

## History 页面状态

截图中可见的关键基线：

- 左侧为固定宽度 task/request 列表，右侧为上下分隔的 Request/Response。
- 左侧顶部包含搜索、自动刷新（文字位于复选框下方）、全选、清理选中、导出、刷新。
- fixture 包含多个 task：首个 task 展开，其余以单行折叠卡片显示（不同 model 和 request 数）。
- 每个 task 是浅灰列表区内一张独立的白色圆角卡片，卡片之间用留白分隔。
- task header 是卡片顶部的蓝灰色块，带加粗左侧色条；左侧控制列中复选框与三角形展开/折叠按钮自上而下排列（原 ⓘ 任务明细图标按钮已移除，明细入口即 header 本身），右侧为时间范围和 model/request/target 摘要。header 与请求项列表之间有一条分隔线。
- task header 摘要分三行：第一行为日期徽标（蓝灰圆角标签，不参与指标配色）与等宽字体时间范围，中间箭头为中性灰；第二行为 model 名（琥珀色文本）以及请求数、decode 速度、费用三个浅色底值标签（chip）；模型名过长时优先省略（悬停显示完整名称），保证三个指标标签完整可见；第三行为转发地址，带前置圆点标记并单行省略。
- 展开的 task 下按 sequence 倒序显示 5 条请求项，白底、相对 header 缩进，仅用浅色细线分隔，视觉层级从属于 task header。
- 请求项状态圆点覆盖两种非成功状态：红色 4xx 错误（保留状态码文字）、琥珀色 pending（保留"等待中"文字）；200 成功不再显示任何状态标记。
- 指标颜色两级统一：费用为青绿色（#176b52），数量类指标（一级请求数、二级响应 tokens）为蓝色（#315a82），模型名与请求 tokens 为琥珀色（#7a4308 / #8a4b08），消息数为中性深灰；日期徽标、时间范围与转发地址使用中性蓝灰。
- 速度指标两级同格式：一级显示任务平均 decode 速度，二级在“响应”与“费用”之间显示单条请求的 decode 速度，数值均为琥珀色（#8a5a13）且格式为“x.xt/s”（≥100 取整），无可用 decode 窗口时不显示。
- 右侧 JSON 使用等宽字体、语法颜色和 `details/summary` 折叠树。
- Request/Response 标题栏右侧包含 meta、wrap、expand、format、copy 按钮。
- Request 和 Response 之间有可拖动水平分隔条；列表和详情之间有可拖动垂直分隔条。
- Request 中的格式化长字符串字段以展开的多行纯文本块显示（含换行、分段标记和 raw payload 尾部），并带复制按钮。
- `ui_logs_cn.png` 有两个只差 1 个像素的候选字节：`3b4e33cd300c…`（137773 字节）与 `f015ca22db5c…`
  （137776 字节）。差异像素的位置是 (310,168)，落在 `section.log-group` 卡片那圈 1 px `rgb(213,221,231)`
  描边、8 px 圆角的右上角（卡片右缘在 x=318）上，两个值分别是 `#d5dde7` 与 `#d1dae5`，每通道差
  4/255；图片尺寸在两者之间不变（1384 x 1212），多出的行也没有内容。
  TRI-09 整合在主树复测时把这条归因推翻了。复测条件是完全相同的工具链：Playwright 1.62.0、
  Chromium revision 1234、同一份 bundle `admin-app.js`（`aa93f38d…`）、同一份 `src/admin/static/app.css`。
  HEAD 的 UI 栈连拍 9 次，6 次拍出 `3b4e33cd…`、3 次拍出 `f015ca22…`；把 `eee78a0`（TRI-09 之前）的
  `src/admin/static` 加四个 UI 测试栈文件单独取回、重建 bundle 后再拍 3 次，2 次 `3b4e33cd…`、
  1 次 `f015ca22…`。两个源状态都能拍出两个 hash，所以这一枚圆角像素既与源码无关，也不是每次都一样
  的结果。早先登记的两处说法——「这台 runner 现在稳定拍出」和「环境差异」——都被这组实测否定，留在
  这里只作为当时的记录，不再作为依据。同理，把 `6652d21` 的源码单独取回再拍一次那个检查也分不出
  源码与抖动，因为它比较的两个版本都在 TRI-09 之后；真正能分开的是跨 `eee78a0` 这一组对照。
  本轮按多数的结果把 `3b4e33cd…` 登记成这张图的参考字节，并明确记下：以后重拍同一页可能拍出另一个
  值，这不是回归，也不该靠改视觉阈值去掩盖别的问题。静态参考 hash 与 `screenshotDifference` 的差异
  像素比例是两层不同的东西——这一枚像素翻值会让 hash 变，比例却不会报警——所以 hash 行要按图的实际
  字节维护，比例断言不能替代它。其余九张基线本轮在主树重拍出来的字节与 HEAD 完全相同；负载均衡两张
  也没有因为移动控件的文案改动而变化，因为基线画面里没有提交过的行，也就没有那句未知结果的提示，
  新加的 detached/retry 态不在默认基线里。

## Usage statistics 页面状态

统计页面由固定 fixture 驱动（固定日期范围、跟随当前时间关闭），关键基线：

- 筛选区：统计区间起止（datetime-local 输入）、跟随当前时间复选框、快捷区间按钮（7/14/30 天、今天）、转发地址/模型/粒度/指标筛选和“应用/重置”按钮。
- 概览卡片为两行：请求数、任务数、Token 总量、费用，以及费用趋势、按转发地址、按模型三张趋势/占比卡片。
- Token 总量卡片内部分区展示输入、输出、缓存读取、缓存写入的明细。
- 费用趋势使用 SVG 折线图；按转发地址、按模型使用环形图，图心显示总量，图例列出各项名称、数值与占比。
- 未计价请求在概览卡片上以警告条提示，并提供“查看明细”操作。
- 中文与英文界面保持同一布局，数值单位分别使用万/亿与 K/M/B 压缩显示。

## Task detail 面板状态

“任务明细”是 History 页内的浮层面板（`#pricingPanel`，覆盖 Request/Response 详情区，左侧任务列表保持可见），由任务卡片头部点击打开，由固定 fixture 驱动，关键基线：

- 面板顶部为标题行（“任务明细”/“Task details”）与右侧“关闭”按钮，下方以细线分隔。
- 标题行下依次是“任务简介”卡片（内容见上表基线行）、转发地址整行，以及 4 列事实卡片网格：第一行是模型卡片与横跨 3 列的时间条（时间范围 / 任务总耗时 / 请求总耗时），第二行是请求数量、总 Token、平均 decode 速度与费用。费用卡片只显示任务已知金额合计；已计价、未计价与等待中的请求数量不进面板，只有列表卡片和列表圆点用到它们。
- 中部为任务费用表，自带节标题“任务费用”/“Task cost”（绿色圆点，与下方费用趋势同一语义色）：标题和它的范围说明只在有计价请求、表格出现时一起出现；未计价任务在这一行显示原因，后面跟着同一句范围说明，既没有表格也没有标题。表按“普通输入 / 输出 / 缓存读取 / 缓存写入”列出已计价 token 数、token 占比、金额与费用占比（带占比条）；token 占比条为青色（#0e7490）、费用占比条为绿色，两列配色与折线图一致，末行为合计。表头行底色 #dbe4ee 是全表唯一填色的带，合计行不填底色，与表体同一白底，只靠上边框和加粗字重与表体分开。
- “整个任务费用，包含未匹配请求。”这句范围说明写在“任务费用”标题下方、表格上方,随后是三张 SVG 折线图(x 均为请求序号,一个点一个请求,点带悬停 title),每图的说明写在各自标题下方、图上方:单请求费用趋势(y=每请求自身费用,无费用的请求不显示)、单请求 Token 数趋势(y=每请求 token 总量,无 token 数的请求不显示)、单请求 Token 输出趋势(y=每个请求自身的输出 token,尚无输出 token 数的请求不显示)。三图按指标语义着色:Token 总量为青色(#0e7490,与"总 Token"卡片同色)、Token 输出为蓝色(#315a82,与请求数量蓝色同系)、费用保持绿色（绿色专属于费用语义）；各节标题左侧有与折线同色的小圆点，帮助快速区分三个分区（明细表的“任务费用”标题同样用绿色圆点，与费用趋势一起构成费用分区）。单请求费用趋势与单请求 Token 输出趋势图内另有一条表示逐请求平均值的水平虚线（琥珀色，独立于各图折线颜色，避免与数据混在一起），数值标在线右端（平均值为 0 或仅一个点时不画）；虚线与数值画在折线点之上，点密集时不被遮挡；逐请求 Token 总量图不含此线。
- 三张折线图的纵轴刻度取 1/2/5 的“整齐”步长，轴上限选为在 3–8 段网格内最接近最大值的刻度，使最高点贴近顶部网格线，避免图表上方出现大片空白。
- 面板底部列出按计费模型分组的“价格分组”折叠卡片（模型 · 请求数 · 费用，模型名为琥珀色、费用为绿色，与任务列表同一语义色），标题带琥珀色圆点；默认折叠，展开后为对应明细表；手动展开/折叠状态按任务记忆，面板刷新后保持。
- 面板虽然浮在详情区上，左侧的任务列表仍然在画面里，所以“请求仍在进行”的圆点也在两张任务明细
  基线里出现：只有第一个任务画一枚 8 px 绿色圆点，与 `ui_logs_cn.png` / `ui_logs_en.png` 里那枚
  同一口径、同一位置。这两张图的哈希在 TRI-06 整合的全量重拍中从 `837f7b3c981b…` / `77150c15d3f1…`
  变成 `e983f5eeb3f3…` / `589ad539010d…`，与旧图逐像素比对只差 60 个像素，全部落在
  (32,211)-(40,219) 这个范围内，即圆点本身；原因是 `4323f3f` 落这个标记时只重拍了两张 History
  基线，这两张跟着列表一起变的图没一起重拍，于是带着旧画面，本轮重拍把它补正，不是 TRI-06 引入的
  画面变化。两张尺寸仍为 1180 x 1779；本轮给任务费用表加标题、加深表头底色、去掉合计行底色并把四段范围说明改到标题下方后，两张各自长到 1180 x 1833。
- 面板内容宽度上限约 760px；中英文界面保持同一布局，金额单位分别使用 ¥ 与 $。

## 自动化视觉回归约定

基线重生成：`npm run regen:ui-baselines`（通过视觉回归测试重新捕获十张截图，并自动同步上表 SHA-256）。

Playwright 视觉测试建立后固定：

- 浏览器：CI 中固定版本的 Chromium。
- 设备缩放：1。
- 字体：CI 镜像中固定系统字体，必要时随测试资源提供字体。
- 桌面 viewport：至少覆盖 1278/1384 宽度的现有布局。
- 窄屏 viewport：宽度 760 以下单独建立基线。
- 动画：截图前禁用 transition/animation。
- 时间、端口、ID、API Key 等动态数据：使用固定 fixture。
- 截图前等待字体加载、网络空闲和自动刷新暂停。

允许的初期差异：

- 浏览器/字体渲染造成的少量字形像素差异。
- 固定 fixture 与历史截图真实数据不同导致的正文差异。

不允许的差异：

- 卡片、工具栏、分栏或按钮缺失。
- Proxy/History 主要布局方向变化。
- 运行/停止状态颜色语义变化。
- 中英文切换导致字段丢失或控件不可见。
- JSON 树、meta、wrap、format、copy 或 splitter 功能缺失。
