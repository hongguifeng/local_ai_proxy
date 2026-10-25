# TypeScript 模块与 Barrel 约定

## 目录边界

`src` 按领域分目录：`admin`、`app`、`cli`、`config`、`logging`、`maintenance`、`persistence`、`proxy`、`shared`、`ui`。

- 每个领域目录提供 `index.ts` 作为对外 barrel。
- `src/index.ts` 只聚合领域 barrel，不直接导出领域内部文件。
- 领域内部代码优先直接引用具体模块，避免 barrel 循环依赖。
- 其他领域通过目标领域 `index.ts` 使用服务、manager 和公共类型；职责单一的叶模块（协议分析、
  任务身份、纯记录处理）由引用方直接导入具体模块，因为 barrel 会连带装入 manager/registry 运行时。
  `src/proxy/protocol/` 是 proxy 内的叶模块区，transport 和存储都直接引用其中的文件。
- `main.ts` 和 Electron host 是 composition root，不被领域模块反向依赖。

## ESM 导入

- TypeScript 源码使用 ESM。
- 相对 import 在源码中写编译后扩展名 `.js`，配合 `moduleResolution: NodeNext`。
- 类型专用导入使用 `import type`。
- 不使用 CommonJS `require`，第三方 CommonJS 包通过 ESM interop 或独立 adapter 封装。

## 依赖方向

建议方向：

```text
main/electron -> app/admin/cli
app/admin -> config/proxy/logging/maintenance
proxy/logging/maintenance -> persistence/shared
config/persistence -> shared
shared -> no project domain dependency
```

在此之上按实际职责划分 transport、存储和控制面：

- transport 运行时（listener、manager、registry、pipeline）只由控制面和装配根持有。
  `src/proxy/index.ts` barrel 连带这些文件，因此 `logging`、`maintenance`、`persistence`、
  `pricing`、`config`、`shared` 只导入 proxy 的叶模块，绝不导入这个 barrel。
- 请求与响应语义（端点分类、指纹、任务身份、负载与 SSE 解析）不属于 transport，住在
  `src/proxy/protocol/`，transport 和存储同向引用它，谁都不反向依赖对方的运行时。
- 计价、URL 解析和用量换算这类支撑模块留在 `src/pricing` 与 proxy 的地址工具里；支撑领域
  可以引用它们，但不能经由它们间接触到 transport 运行时。

禁止：

- `shared` 依赖业务领域。
- `persistence` 依赖 admin 或 UI。
- `proxy` 依赖 admin。
- 领域模块 import Electron。
- 存储、读取和支撑领域通过 `src/proxy/index.ts` 引入 transport 运行时。

`npm run check:modules` 把这些方向写成可执行规则：用 TypeScript AST 建立运行时 import 与
re-export 图，解析 `.js` 说明符到 `.ts` 源和目录 barrel，排除纯类型导入，报出环和越界导入的
具体依赖链。检查范围是 `src/**` 和 `electron/**`；测试文件允许直接导入领域内部模块，所以
`test-node/` 不在检查范围内。

## 测试目录

- Node 测试暂放 `test-node`，避免与 Python `tests` 混淆。
- 单元测试文件使用 `*.test.ts`。
- 测试可直接 import 纯内部模块；这不自动使其成为正式 npm 公共 API。
- Python 删除后，`test-node` 统一改名为 `tests`。
