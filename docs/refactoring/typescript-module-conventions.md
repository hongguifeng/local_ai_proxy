# TypeScript 模块与 Barrel 约定

## 目录边界

`src` 按领域分目录：`admin`、`app`、`cli`、`config`、`logging`、`maintenance`、`persistence`、`proxy`、`shared`、`ui`。

- 每个领域目录提供 `index.ts` 作为对外 barrel。
- `src/index.ts` 只聚合领域 barrel，不直接导出领域内部文件。
- 领域内部代码优先直接引用具体模块，避免 barrel 循环依赖。
- 其他领域只通过目标领域 `index.ts` 使用被批准的公共类型和服务。
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

禁止：

- `shared` 依赖业务领域。
- `persistence` 依赖 admin 或 UI。
- `proxy` 依赖 admin。
- 领域模块 import Electron。

## 测试目录

- Node 测试暂放 `test-node`，避免与 Python `tests` 混淆。
- 单元测试文件使用 `*.test.ts`。
- 测试可直接 import 纯内部模块；这不自动使其成为正式 npm 公共 API。
- Python 删除后，`test-node` 统一改名为 `tests`。
