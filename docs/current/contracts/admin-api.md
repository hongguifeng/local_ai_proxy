# 管理 API 合同

> 状态：当前
> 权威性：管理 API 的声明、服务接线和浏览器消费者之间的边界。
> 更新条件：新增、删除或改变路由、请求字段、响应字段或错误语义时更新。

## 唯一声明

`src/admin/admin-schemas.ts` 是 wire shape 的唯一声明来源。它同时生成：

- `src/admin/admin-contracts.ts` 使用的 TypeScript 输出类型。
- Fastify 使用的 JSON schema。
- `test-node/admin/api-contract.test.ts` 验证的公开响应和路由合同。

服务实现必须返回 schema 对应的 DTO。不要先改 TypeScript 接口，再在路由中手写另一份 JSON 形状；不要为同一字段维护一份 API schema 和一份 UI 类型。

## 一条路由的完整接线

新增或修改管理 API 时按以下顺序核对：

1. 在对应的 `src/admin/routes/*.ts` 注册路由和 HTTP 方法。
2. 在 `src/app/admin-services.ts` 提供并装配路由需要的服务。
3. 在 `src/admin/admin-schemas.ts` 声明请求、响应和错误字段。
4. 在 `src/admin/admin-contracts.ts` 导出 UI 或服务需要的类型。
5. 在浏览器 `src/admin/static/modules/` 中使用真实字段名和错误合同。
6. 在真实应用合同测试中覆盖成功、空值、400、404 和 500 路径。

`assertAdminServicesComplete()` 在管理端绑定端口前检查服务集合。服务缺失是启动错误，不应靠“路由返回 404”来掩盖。

## 开放字段和序列化

每个 response schema 都要明确字段是否开放。历史请求、响应、meta 和摘要等协议承载内容允许保留未建模键；控制面 DTO 只开放有意保留的扩展字段。Fastify 的序列化会丢弃 schema 未声明的字段，所以开放字典必须用开放 schema，并用真实 HTTP 往返证明未知键保留。

错误响应至少保持 `error.code` 和 `error.message`；有字段问题时携带 `issues`。输入校验失败由 Fastify 返回 400，业务对象不存在使用明确的 404 错误，服务或存储失败使用对应的 500 分类。不要只断言状态码而忽略错误体。

## 浏览器消费者

浏览器 API helper 对非 2xx 响应抛出带结构化错误的 `ApiError`。调用方必须区分加载、空结果、业务错误和网络错误；新增字段先更新 schema 和 UI 类型，再更新消费者。

UI 测试通过真实管理端或受控服务发起 HTTP 请求，不直接调用旧的全局渲染函数。完整浏览器模块合同见 [当前产品行为](../product.md) 和 `static-checks-and-split` skill。

## 验收清单

- 路由、服务、schema、DTO 和浏览器消费者都已接线。
- 公开字段顺序和开放性与测试合同一致。
- 空配置、缺少记录、非法请求、服务失败和未知键都有明确行为。
- `npm run typecheck`、`npm run lint`、相关 `test-node/admin` 和 UI 测试通过。
- API 语义改变时同步更新 [当前产品行为](../product.md) 或新增 ADR；不要只更新本文。
