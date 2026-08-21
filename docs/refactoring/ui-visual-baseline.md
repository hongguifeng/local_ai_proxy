# UI 视觉基线登记

## 目的

本文件登记 Python 版本现有的四张 UI 截图，作为 Node.js 重构阶段的布局、颜色、信息层级和交互状态基线。

原截图没有保存浏览器名称、浏览器版本、设备缩放或原始 viewport 元数据，因此无法把像素级差异直接认定为回归。第一轮 Playwright 基线建立时，应在固定浏览器和 viewport 下重新生成一套可自动比较的截图；在此之前，以现有图片尺寸和可见结构进行人工对照。

## 基线文件

| 页面 | 语言 | 文件 | 图片尺寸 | SHA-256 |
| --- | --- | --- | --- | --- |
| Proxy | 中文 | `doc/ui_proxy_cn.png` | 1278 x 1215 | `aa44512263e5ffac844c00fb4c872f54b2cc450457ca650b3fac1bbea766b2d6` |
| Proxy | 英文 | `doc/ui_proxy_en.png` | 1278 x 1208 | `93b74ae36c31a4ae4e3b2d0a92d0241ff093ce7c9b1ca039e661e79cbc5f5e83` |
| History | 中文 | `doc/ui_logs_cn.png` | 1384 x 1212 | `651ac50056dc8318d023a6fa2bcde4da9c127f35e59974a6c5988b070fe05f83` |
| History | 英文 | `doc/ui_logs_en.png` | 1384 x 1224 | `13dc6dd1e6d94a535a45588a033a60c144eec19714c9aefc40975cdcd7735903` |

哈希复现命令：

```bash
sha256sum doc/ui_proxy_cn.png doc/ui_proxy_en.png doc/ui_logs_cn.png doc/ui_logs_en.png
```

## Proxy 页面状态

截图中可见的关键基线：

- 顶部白色 Header，左侧产品名，右侧 Tab 和语言选择器。
- 页面浅灰背景，代理为白色圆角卡片。
- 代理名称、运行圆点、监听地址、端口和开关位于同一行。
- Target 使用浅蓝灰卡片，并在代理卡片内按可用宽度自动换行排列。
- Target 默认展示名称、默认目标、URL、API Key、模型映射、启用状态和“更多配置”。
- API Key 输入框包含显隐与复制按钮。
- 代理卡片底部右侧包含添加 Target 和删除代理操作。
- 运行代理使用绿色状态圆点和绿色开关；停止代理使用灰色状态。
- 中文和英文界面保持同一布局，不因文字长度改变主要列结构。

## History 页面状态

截图中可见的关键基线：

- 左侧为固定宽度 task/request 列表，右侧为上下分隔的 Request/Response。
- 左侧顶部包含搜索、刷新、导出、清理选中、自动刷新。
- fixture 包含多个 task：首个 task 展开，其余以单行折叠卡片显示（不同 model 和 request 数）。
- 每个 task 是浅灰列表区内一张独立的白色圆角卡片，卡片之间用留白分隔。
- task header 是卡片顶部的蓝灰色块，带加粗左侧色条，包含复选框、折叠箭头、时间范围和 model/request/target 摘要；header 与请求项列表之间有一条分隔线。
- 展开的 task 下按 sequence 倒序显示 5 条请求项，白底、相对 header 缩进，仅用浅色细线分隔，视觉层级从属于 task header。
- 请求项状态圆点覆盖三种状态：绿色 200 成功、红色 4xx 错误（响应 tokens 为 0）、琥珀色 pending（tokens 未返回）。
- 右侧 JSON 使用等宽字体、语法颜色和 `details/summary` 折叠树。
- Request/Response 标题栏右侧包含 meta、wrap、expand、format、copy 按钮。
- Request 和 Response 之间有可拖动水平分隔条；列表和详情之间有可拖动垂直分隔条。
- Request 中的格式化长字符串字段以展开的多行纯文本块显示（含换行、分段标记和 raw payload 尾部），并带复制按钮。

## 自动化视觉回归约定

基线重生成：`npm run regen:ui-baselines`（通过视觉回归测试重新捕获四张截图，并自动同步上表 SHA-256）。

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
