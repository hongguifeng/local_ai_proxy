# TypeScript 模块边界

> 状态：当前
> 权威性：产品模块的运行时依赖方向和公共导出约定。
> 更新条件：新增领域、改变运行时 import、调整 barrel 或模块检查规则时更新。

## 目录职责

产品代码按领域分在 `src/app`、`src/cli`、`src/config`、`src/proxy`、`src/logging`、`src/persistence`、`src/maintenance`、`src/pricing`、`src/admin` 和 `src/shared`；Electron 宿主单独位于 `electron/`。浏览器源码只位于 `src/admin/static/`。

每个领域可以有 `index.ts` 作为公开入口，但领域内部优先直接导入具体叶模块。barrel 若带入 manager、registry 或启动代码，会把不应依赖运行时的领域拉进来；协议分析、任务身份、payload 和 stream 解析属于 `src/proxy/protocol/` 叶模块，允许被 transport、logging 和 persistence 同向使用。

## 依赖规则

- `shared` 不依赖业务领域。
- `src` 不依赖 `electron`。
- transport 运行时只由 `app`、`admin`、`cli` 和装配根持有。
- logging、maintenance、pricing 和 persistence 不通过 `src/proxy/index.ts` 取得 transport。
- repository 不反向依赖 service；测试可以直接导入内部模块，但产品模块图不因此放宽。
- 只导入类型的边不参与运行时环判断，运行时 re-export 仍然算边。

## 检查器

`npm run check:modules` 读取 TypeScript AST，解析 `.js` 说明符到源码文件和目录入口，报告运行时环与越界链。它覆盖 `src/**` 和 `electron/**`，不覆盖测试夹具。

新增跨领域 import 时先回答三个问题：

1. 被导入的是状态所有者、纯协议语义，还是仅为方便暴露的实现细节？
2. 这条边是否会把监听器、registry、管理端或存储反向带入调用方？
3. 能否把共享逻辑下沉到 `shared` 或对应的叶模块，而不是扩展 barrel？

## 浏览器模块

浏览器代码由 `src/admin/static/entry.js` 和 `src/admin/static/modules/*.js` 组成一个 bundle。UI 模块直接导入需要的 helper；不得恢复编号脚本、运行时拼接脚本、旧的隐式全局或未冻结的测试全局。UI 类型由 `src/admin/ui-contracts.d.ts` 和 `tsconfig.ui.json` 检查，`npm run typecheck` 会同时检查产品、测试、脚本和完整浏览器图。

## 验收清单

- `npm run check:modules` 报告 0 个运行时环和 0 个越界导入。
- `npm run typecheck` 和 `npm run lint` 通过。
- 构建后的 `app.asar` 只包含当前 bundle 和模块，不包含已删除的旧 bundle 输出。
- 若模块边界改变，同步更新 [当前架构](../architecture.md)；若改变外部或持久化语义，另更新当前产品文档或 ADR。
