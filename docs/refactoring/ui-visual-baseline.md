# UI 视觉基线登记

## 目的

本文件登记六张 UI 基线截图：Proxy 与 History 页面各按中/英界面拆分，使用量统计页面各一张，作为 Node.js 重构阶段的布局、颜色、信息层级和交互状态基线。

原截图没有保存浏览器名称、浏览器版本、设备缩放或原始 viewport 元数据，因此无法把像素级差异直接认定为回归。第一轮 Playwright 基线建立时，应在固定浏览器和 viewport 下重新生成一套可自动比较的截图；在此之前，以现有图片尺寸和可见结构进行人工对照。

## 基线文件

| 页面 | 语言 | 文件 | 图片尺寸 | SHA-256 |
| --- | --- | --- | --- | --- |
| Proxy | 中文 | `doc/ui_proxy_cn.png` | 1278 x 1215 | `c2ff326b0a5cc3167f2febb61455977b65b10bd0b3e030c63f1716b46fb4d85a` |
| Proxy | 英文 | `doc/ui_proxy_en.png` | 1278 x 1208 | `1649bacdfcd18c88fd9069e5b1473e55454482236b9a6e23d9f692a90ebd8742` |
| History | 中文 | `doc/ui_logs_cn.png` | 1384 x 1212 | `db0b74de468b91867fe2cacfb334833c576cc3dffaa35d0baa5dd7f787400185` |
| History | 英文 | `doc/ui_logs_en.png` | 1384 x 1224 | `7496eac2c35ed025143e923521e669553ffc10c79d3193c5988db2837152e231` |
| Usage statistics | 中文 | `doc/ui_stats_cn.png` | 1278 x 1613 | `dac23fdfc8d59fa2a02461a07eb52cbcad51eb7b3c662d289aecc2b6081a8450` |
| Usage statistics | 英文 | `doc/ui_stats_en.png` | 1278 x 1613 | `2b6f11098ad9a541d724e53216c67af4ae4e5b68b253a63d87a92e97395a253b` |

哈希复现命令：

```bash
sha256sum doc/ui_proxy_cn.png doc/ui_proxy_en.png doc/ui_logs_cn.png doc/ui_logs_en.png doc/ui_stats_cn.png doc/ui_stats_en.png
```

比较规则（`screenshotDifference`，test-node/ui/admin-ui.test.ts）：宽度必须一致；高度相差 ≤ 4 px（多余行必须为近白背景，容忍不同环境下分数像素舍入造成的文档高度漂移）；重叠区域像素差异比例小于 0.25。

## Proxy 页面状态

截图中可见的关键基线：

- 顶部白色 Header，左侧产品名，右侧 Tab 和语言选择器。
- 页面浅灰背景，代理为白色圆角卡片。
- 代理名称、运行圆点、监听地址、端口和开关位于同一行。
- Target 卡片按状态区分背景色：默认目标浅绿色、已启用浅蓝色、未启用浅灰色，并在代理卡片内按可用宽度自动换行排列。
- fixture 中第一个代理包含默认与已启用卡片，第二个代理包含一张未启用卡片，用于覆盖三种状态。
- Target 默认展示名称、默认目标、URL、API Key、模型映射、启用状态和“更多配置”。
- API Key 输入框包含显隐与复制按钮。
- 代理卡片底部右侧包含添加 Target 和删除代理操作。
- 运行代理使用绿色状态圆点和绿色开关；停止代理使用灰色状态。
- 中文和英文界面保持同一布局，不因文字长度改变主要列结构。

## History 页面状态

截图中可见的关键基线：

- 左侧为固定宽度 task/request 列表，右侧为上下分隔的 Request/Response。
- 左侧顶部包含搜索、自动刷新（文字位于复选框下方）、全选、清理选中、导出、刷新。
- fixture 包含多个 task：首个 task 展开，其余以单行折叠卡片显示（不同 model 和 request 数）。
- 每个 task 是浅灰列表区内一张独立的白色圆角卡片，卡片之间用留白分隔。
- task header 是卡片顶部的蓝灰色块，带加粗左侧色条；左侧控制列中复选框、ⓘ 任务明细图标按钮与折叠箭头自上而下排列，右侧为时间范围和 model/request/target 摘要。header 与请求项列表之间有一条分隔线。
- 展开的 task 下按 sequence 倒序显示 5 条请求项，白底、相对 header 缩进，仅用浅色细线分隔，视觉层级从属于 task header。
- 请求项状态圆点覆盖两种非成功状态：红色 4xx 错误（保留状态码文字）、琥珀色 pending（保留"等待中"文字）；200 成功不再显示任何状态标记。
- 指标颜色两级统一：费用为青绿色（#176b52），数量类指标（一级请求数、二级响应 tokens）为蓝色（#315a82），模型名与请求 tokens 为琥珀色（#7a4308 / #8a4b08），消息数为中性深灰。
- 速度指标两级同格式：一级显示任务平均 decode 速度，二级在“响应”与“费用”之间显示单条请求的 decode 速度，数值均为琥珀色（#8a5a13）且格式为“x.xt/s”（≥100 取整），无可用 decode 窗口时不显示。
- 右侧 JSON 使用等宽字体、语法颜色和 `details/summary` 折叠树。
- Request/Response 标题栏右侧包含 meta、wrap、expand、format、copy 按钮。
- Request 和 Response 之间有可拖动水平分隔条；列表和详情之间有可拖动垂直分隔条。
- Request 中的格式化长字符串字段以展开的多行纯文本块显示（含换行、分段标记和 raw payload 尾部），并带复制按钮。

## Usage statistics 页面状态

统计页面由固定 fixture 驱动（固定日期范围、跟随当前时间关闭），关键基线：

- 筛选区：统计区间起止（datetime-local 输入）、跟随当前时间复选框、快捷区间按钮（7/14/30 天、今天）、转发地址/模型/粒度/指标筛选和“应用/重置”按钮。
- 概览卡片为两行：请求数、任务数、Token 总量、费用，以及费用趋势、按转发地址、按模型三张趋势/占比卡片。
- Token 总量卡片内部分区展示输入、输出、缓存读取、缓存写入的明细。
- 费用趋势使用 SVG 折线图；按转发地址、按模型使用环形图，图心显示总量，图例列出各项名称、数值与占比。
- 未计价请求在概览卡片上以警告条提示，并提供“查看明细”操作。
- 中文与英文界面保持同一布局，数值单位分别使用万/亿与 K/M/B 压缩显示。

## 自动化视觉回归约定

基线重生成：`npm run regen:ui-baselines`（通过视觉回归测试重新捕获六张截图，并自动同步上表 SHA-256）。

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
