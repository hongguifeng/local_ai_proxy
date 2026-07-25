# 用 LLM Proxy 学习 Node.js 与 TypeScript

这份教程面向刚开始学习 Node.js 的开发者。目标不是一次读懂所有代码，而是借助一个真实项目，逐步理解 Node.js 程序如何启动、接收 HTTP 请求、调用上游服务、处理流、保存数据、测试以及安全退出。

建议先掌握 JavaScript 的变量、函数、对象、数组和 `Promise` 基础。遇到不熟悉的 TypeScript 语法时，不必停下来系统学习全部类型知识，先根据本教程理解它在当前代码中的作用。

## 1. 先建立项目全景

这个项目同时运行两类 HTTP 服务：

- 管理服务：默认监听 `127.0.0.1:18080`，由 Fastify 提供 Web 页面和管理 API。
- 代理服务：根据页面中的配置监听一个或多个端口，把客户端请求转发给 LLM 上游。

一次普通启动的主要调用链如下：

```text
package.json 的 npm start
  -> dist-node/src/main.js
  -> src/main.ts
  -> loadCliOptions() 读取参数和配置
  -> runCli()
  -> createNodeApplication()
  -> Application.start()
  -> ProxyManager.startEnabled() 启动代理端口
  -> AdminControlPlane.start() 启动管理端口
```

一次代理请求的主要调用链如下：

```text
客户端 HTTP 请求
  -> ProxyListener
  -> ProxyRequestPipeline.handle()
  -> collectBody() 收集请求体
  -> selectTargetByModel() 选择上游
  -> rewriteRequestModel()/transformRequestJsonFields() 改写请求
  -> openUpstreamResponse() 请求上游
  -> forwardResponseBody() 流式返回响应
  -> TrafficLogService
  -> TrafficRepository
  -> SQLite traffic.db
```

先记住这两条链路即可。其他文件大多是在为其中某个步骤提供类型、校验、数据转换或测试。

## 2. 准备开发环境

项目要求 Node.js 24。先检查版本：

```bash
node --version
npm --version
```

安装依赖并运行完整检查：

```bash
npm ci
npm run check
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 使用 `tsx watch` 直接运行 TypeScript，文件变化后自动重启 |
| `npm run build` | 用 TypeScript 编译到 `dist-node`，并复制静态资源 |
| `npm start` | 运行已经编译的 CLI 应用 |
| `npm test` | 运行全部 Vitest 测试 |
| `npm run test:watch` | 监听文件变化并重复运行相关测试 |
| `npm run typecheck` | 只做 TypeScript 类型检查，不生成文件 |
| `npm run lint` | 检查容易出错或不统一的代码写法 |
| `npm run format` | 用 Prettier 格式化文件 |

学习阶段推荐开两个终端：一个运行 `npm run dev -- --no-browser`，另一个运行测试或发送请求。

## 3. 从 package.json 理解 Node.js 项目

首先阅读 `package.json`，重点关注四部分。

### 3.1 scripts

`scripts` 是项目命令的统一入口。例如：

```json
{
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.json && node dist-node/scripts/copy_static_assets.js",
    "test": "vitest run"
  }
}
```

运行 `npm run dev` 时，npm 实际执行的是右侧命令。团队成员和 CI 因此能使用同一套操作。

### 3.2 dependencies 与 devDependencies

- `dependencies` 是程序运行时需要的包，例如 Fastify、Zod 和 SQLite 驱动。
- `devDependencies` 主要服务于开发和构建，例如 TypeScript、ESLint、Prettier、Vitest 和 Electron 打包工具。

本项目的重要第三方库：

- `fastify`：管理 API 的 HTTP 框架。
- `zod`：在运行时校验配置数据。
- `better-sqlite3`：同步 SQLite 驱动。
- `typescript`：静态类型检查和编译。
- `vitest`：测试框架。

### 3.3 type: module

`"type": "module"` 表示项目使用 ECMAScript Modules（ESM），所以代码使用 `import`/`export`。

你会看到 TypeScript 文件这样导入：

```ts
import { runCli } from "./cli/index.js";
```

虽然源文件是 `.ts`，相对导入仍写 `.js`。原因是 `tsconfig.json` 使用 `NodeNext`：编译后的 Node.js 真正加载 `.js` 文件，TypeScript 会在开发时把它解析回对应的 `.ts` 源文件。这是 Node ESM 项目中常见、也很容易让新手困惑的一点。

### 3.4 engines

`engines.node` 记录支持的 Node.js 版本。使用过旧或过新的版本都可能导致依赖安装或运行行为不同，因此排查问题时应先确认版本。

## 4. 第一条阅读路线：程序如何启动

按下面顺序阅读：

1. `src/main.ts`
2. `src/cli/index.ts`
3. `src/cli/runner.ts`
4. `src/app/application.ts`
5. `src/app/runtime.ts`

### 4.1 顶层 await 与错误边界

`src/main.ts` 是最外层入口。它读取 `process.argv`，再直接 `await` 异步函数。ESM 支持顶层 `await`，因此不需要传统的立即执行异步函数。

最外层 `try/catch` 是启动错误边界。深层模块负责提供有意义的错误，入口负责把错误写到标准错误并设置退出码。

可以在入口临时加入调试输出，观察 Node 进程收到的参数：

```ts
console.log(process.argv);
```

然后运行：

```bash
npm run dev -- --host 127.0.0.1 --port 18081 --no-browser
```

注意 npm 自身参数与应用参数之间的 `--`。

### 4.2 配置来源与优先级

`src/cli/index.ts` 把默认值、应用配置文件、环境变量和命令行参数合并。通常越靠近本次启动的配置优先级越高：

```text
命令行参数 > 环境变量 > llm-proxy.json > 代码默认值
```

阅读时留意两个概念：

- `parseCliArgs()` 是同步的纯计算，适合单元测试。
- `loadCliOptions()` 负责读文件和解析绝对路径，是 I/O 层。

把纯逻辑与 I/O 分开，会让测试更简单。

### 4.3 Application 状态机

`src/app/application.ts` 只有很少代码，却展示了重要设计：用明确状态约束生命周期。

```text
created -> starting -> running -> stopping -> stopped
```

它防止重复启动、停止过程再次启动等非法操作。启动失败时回到 `stopped`；停止失败时也通过 `finally` 结束在 `stopped`，避免应用卡在中间状态。

对应测试在 `test-node/app/application.test.ts`。建议一边读实现，一边读测试中的输入、操作和断言。

### 4.4 组合根和依赖注入

`src/app/runtime.ts` 创建配置仓库、代理管理器、日志查询服务和管理服务器。这个集中组装对象的地方通常称为“组合根”。

项目中很多构造函数接收接口或可选依赖，例如时钟、ID 生成器、文件系统操作。这是一种轻量依赖注入：生产环境使用真实依赖，测试传入可控的替身，不需要额外的依赖注入框架。

## 5. 第二条阅读路线：HTTP 请求如何被转发

按下面顺序阅读：

1. `src/proxy/proxy-listener.ts`
2. `src/proxy/proxy-request-pipeline.ts`
3. `src/proxy/body-collector.ts`
4. `src/proxy/routing.ts`
5. `src/proxy/request-transform.ts`
6. `src/proxy/headers.ts`
7. `src/proxy/upstream-forwarder.ts`

### 5.1 Node 原生 HTTP 服务器

`ProxyListener` 使用 `node:http` 的 `createServer()`。每次请求都会得到：

- `IncomingMessage`：可读取的请求流。
- `ServerResponse`：可写入的响应流。

`createServer` 的回调本身不会等待异步函数，所以代码使用 `Promise.resolve(...).catch(...)` 接住异步异常。遗漏这一步可能产生未处理的 Promise 拒绝。

### 5.2 请求体也是流

`IncomingMessage` 实现了异步迭代器，因此 `collectBody()` 可以这样消费数据：

```ts
for await (const chunk of request) {
  // 每次收到一块数据
}
```

项目设置了两个限制：

- 内存阈值：小 body 存在内存中，超过阈值后转存临时文件。
- 最大请求大小：超过限制立即抛出 `RequestBodyTooLargeError`，最终返回 HTTP 413。

这是资源控制的真实案例。只实现功能而不限制内存，在并发大请求下可能让进程崩溃。

### 5.3 路由和请求改写

请求体收集完成后，流水线读取顶层 JSON `model`，按配置顺序查找第一个匹配的目标。`*` 是通配符；未命中则使用默认目标。

随后按固定顺序处理：

1. 改写模型名。
2. 删除配置指定的顶层 JSON 字段。
3. 注入配置指定的顶层 JSON 字段。
4. 重建 `Content-Length` 等转发 headers。

顺序属于业务契约。改变顺序可能让同一配置产生不同请求。

### 5.4 回调 API 包装成 Promise

`openUpstreamResponse()` 使用 Node 原生 `http.request()`/`https.request()`。这些 API 主要依赖回调和事件，函数将“收到上游响应头”包装成 Promise，使调用方可以使用 `await`。

请特别区分三类错误或终止来源：

- 连接错误：触发 `error` 事件。
- 上游超时：销毁 request 并抛出 `UpstreamTimeoutError`。
- 客户端断开或应用关闭：通过 `AbortSignal` 取消上游请求。

### 5.5 流式响应和背压

LLM API 常使用 SSE 返回流式结果。`forwardResponseBody()` 一边读取上游分块，一边写给客户端，并同时把分块交给日志摘要器。

`response.write(chunk)` 返回 `false` 时，表示下游写入缓冲区暂时已满。代码等待 `drain` 再继续，这叫背压。没有背压时，如果上游很快而客户端很慢，未发送的数据会不断堆积在内存中。

## 6. 第三条阅读路线：配置如何安全保存

按下面顺序阅读：

1. `src/config/config-schema.ts`
2. `src/config/config-normalizer.ts`
3. `src/config/config-validation.ts`
4. `src/config/config-repository.ts`
5. `src/proxy/proxy-manager.ts`

### 6.1 为什么 TypeScript 类型还不够

TypeScript 类型会在编译后消失。磁盘 JSON、HTTP body 和环境变量都可能包含任意内容，所以外部输入应先以 `unknown` 接收，再进行运行时检查。

本项目用 Zod 定义 schema，并用 `z.infer` 生成对应 TypeScript 类型：

```ts
const userSchema = z.object({ name: z.string() });
type User = z.infer<typeof userSchema>;
```

这样运行时校验规则和编译期类型来自同一份定义。

### 6.2 规范化与校验的区别

- 规范化：把可接受但不统一的数据转换成标准形态，例如补默认值、去掉首尾空格。
- 校验：拒绝不能安全使用的数据，例如非法 URL、重复 ID 或越界端口。

本项目先规范化，再严格校验。校验通过之后，业务层不必反复判断字段是否缺失。

### 6.3 原子写文件

直接覆盖配置文件存在风险：进程在写到一半时崩溃，文件就会变成残缺 JSON。

`ConfigRepository` 使用下面的保存方式：

```text
创建同目录临时文件
  -> 写入完整内容
  -> fsync
  -> 关闭文件句柄
  -> rename 为正式文件
```

`rename` 在同一文件系统内通常是原子操作，读者看到的要么是旧文件，要么是新文件。异常路径还会关闭句柄并清理临时文件。

### 6.4 配置应用的补偿式事务

仅安全写文件还不够，配置变化会引起端口启停。`ProxyManager` 大致执行：

```text
计算新旧配置差异
  -> 停止受影响的旧实例
  -> 启动新实例
  -> 保存新配置
```

任何一步失败时，它会停止已经启动的新实例，并重新启动被停止的旧实例。这不是数据库事务，而是通过反向操作实现的补偿式事务。

多个管理请求还可能并发修改配置。`#applyQueue` 使用 Promise 链把应用操作串行化，避免它们交叉执行。

## 7. 第四条阅读路线：SQLite 与日志

按下面顺序阅读：

1. `src/persistence/database.ts`
2. `src/persistence/schema-v1.ts` 和 `schema-v2.ts`
3. `src/persistence/repository.ts`
4. `src/logging/write-queue.ts`
5. `src/logging/traffic-log-service.ts`
6. `src/logging/task-matcher.ts`

### 7.1 数据库初始化和迁移

连接数据库时会：

1. 创建日志目录。
2. 打开 `traffic.db`。
3. 设置 WAL、外键、超时等 pragma。
4. 检查 FTS5 全文搜索能力。
5. 在事务中运行未执行的 schema migration。

迁移版本写在 `schema_meta` 表中。所有待执行迁移和版本号更新处于同一个事务，某一步失败时不会留下“表只改了一半但版本已升级”的状态。

### 7.2 Repository 模式

`TrafficRepository` 把 SQL 封装为业务可理解的方法，例如保存任务、保存请求记录、分页搜索和清理数据。上层服务不需要知道表结构细节。

`better-sqlite3` 使用同步 API。优点是事务和错误处理直接；代价是 SQL 执行期间会阻塞事件循环。因此应保持查询有索引、有分页，并避免在请求热路径执行超长事务。

### 7.3 为什么还需要写队列

多个代理目标可能共享同一个日志目录。`writeQueueForLogRoot()` 按绝对路径为每个日志根创建一个串行 Promise 队列，让同一数据库的写操作按顺序执行。

关闭日志服务时必须先 `drain()` 等待队列排空，再关闭数据库连接。资源生命周期不仅包括“如何创建”，也包括“何时能安全销毁”。

### 7.4 一个日志为什么要用事务

一次请求结束可能同时更新：

- 任务表。
- 请求/响应详情表。
- response ID 关联。
- 上下文关联。
- 被合并任务的清理。

这些写入放在一个数据库事务中，管理页面不会看到只有部分数据成功的中间状态。

## 8. 第五条阅读路线：管理 API 与 Fastify

阅读 `src/admin/admin-server.ts`，可以学习一个框架如何组织服务器：

- `addHook`：请求前后和错误时执行公共逻辑，这里用于结构化访问日志。
- `setErrorHandler`：把内部错误转换为稳定的 HTTP 错误响应。
- `setNotFoundHandler`：统一处理未知路由。
- `server.get/post/put`：注册路由。
- `schema`：校验请求并约束响应结构。

建议从 `/api/health` 开始，它不依赖复杂服务。然后阅读代理配置 API，最后阅读日志查询、导出和清理 API。

可以用 curl 观察响应：

```bash
curl -i http://127.0.0.1:18080/api/health
curl -i http://127.0.0.1:18080/api/pairs
```

路由处理函数应主要完成 HTTP 层工作：读取参数、调用服务、设置状态码。复杂业务逻辑应留在 `ProxyManager` 或日志服务中，这样无需启动 HTTP 服务器也能测试业务规则。

## 9. 测试：学习代码行为的最快方式

测试目录 `test-node` 基本按照 `src` 的模块划分。推荐采用“实现文件 + 对应测试文件”成对阅读的方法。

几个适合新手的起点：

- `test-node/app/application.test.ts`：状态机和异步错误。
- `test-node/cli/cli.test.ts`：参数解析和配置优先级。
- `test-node/proxy/routing.test.ts`：纯函数和表格化用例。
- `test-node/proxy/body-collector.test.ts`：异步迭代、临时文件与异常清理。
- `test-node/config/config-repository.test.ts`：文件 I/O 替身和原子保存。
- `test-node/admin/health.test.ts`：HTTP API 注入测试。

只运行一个文件：

```bash
npx vitest run test-node/proxy/routing.test.ts
```

按测试名称过滤：

```bash
npx vitest run -t "wildcard"
```

调试测试时，先把用例缩小到一个文件或一个名称，比反复运行全部测试更快。

测试代码中常见的三种技术：

1. 依赖注入：传入假的时钟、ID 生成器、文件系统或应用对象。
2. 临时目录：每个用例使用独立磁盘位置，避免污染真实数据。
3. HTTP 注入：Fastify 可在不真正监听 TCP 端口的情况下调用路由。

## 10. TypeScript 语法阅读提示

### 10.1 interface 和 type

它们描述对象形状，只参与类型检查，不会出现在运行时。项目经常为模块依赖定义较小接口，便于替换和测试。

### 10.2 readonly

`readonly` 防止属性在 TypeScript 代码中被意外重新赋值。它不是深冻结，也不能阻止其他 JavaScript 代码在运行时修改对象。

### 10.3 unknown

`unknown` 表示“值存在，但还不知道类型”。使用前必须通过 `typeof`、`instanceof`、Zod 或自定义类型守卫缩小范围，比 `any` 安全。

### 10.4 私有字段 #name

`#state`、`#repository` 是 JavaScript 原生私有字段，类外部在运行时也不能访问。它和只在 TypeScript 层限制访问的 `private` 不完全相同。

### 10.5 可选链和空值合并

```ts
lifecycle.start?.();       // 存在时才调用
configured ?? fallback;   // 只有 null/undefined 才使用 fallback
```

注意 `??` 不会把空字符串、`0` 或 `false` 当成缺失值，这对配置代码尤其重要。

### 10.6 类型导入

```ts
import type { IncomingMessage } from "node:http";
```

`import type` 只供类型检查，编译后会被移除，可避免不必要的运行时依赖和 ESM 循环引用问题。

## 11. 调试方法

### 11.1 使用 Node Inspector

项目的开发命令通过 `tsx` 运行 TypeScript。可以直接启动调试：

```bash
node --inspect-brk ./node_modules/tsx/dist/cli.mjs src/main.ts --no-browser
```

然后在 Chrome 打开 `chrome://inspect`，或使用编辑器附加到默认的 `9229` 端口。

推荐断点位置：

- `src/app/runtime.ts` 的应用启动回调。
- `src/proxy/proxy-request-pipeline.ts` 的 `handle()`。
- `src/proxy/routing.ts` 的 `selectTargetByModel()`。
- `src/logging/traffic-log-service.ts` 的 `#save()`。

### 11.2 观察进程和网络行为

启动后先请求健康检查，再从 UI 创建代理。也可以准备一个很小的本地上游服务，观察代理收到和发出的内容。

查看端口是否监听：

```bash
curl -i http://127.0.0.1:18080/api/health
```

若启动报 `EADDRINUSE`，表示地址或端口已被其他进程占用。这个错误会在配置应用层转换为更适合管理 API 的 `409 listen_conflict`。

### 11.3 不要只依赖 console.log

`console.log` 适合临时观察，但长期日志应包含结构化上下文。项目的 `StructuredLogger` 会记录服务名、状态码、耗时和错误类型，便于筛选和自动处理。

## 12. 推荐的四周学习路线

### 第一周：运行、入口和测试

- 运行 `npm ci`、`npm run dev` 和 `npm test`。
- 阅读 `package.json`、`tsconfig.json` 和 `src/main.ts`。
- 阅读 CLI 与 Application 测试。
- 修改一个 CLI 错误消息并补对应测试，然后恢复或保留合理改动。

### 第二周：HTTP、Promise 和流

- 阅读代理监听器和请求流水线。
- 理解 `IncomingMessage`、`ServerResponse` 和 `for await...of`。
- 为路由纯函数增加边界测试。
- 在本地模拟慢客户端，观察背压相关代码。

### 第三周：配置、错误和持久化

- 阅读 Zod schema、规范化和仓库。
- 手工构造非法配置，观察错误信息。
- 阅读 SQLite migration 和 repository。
- 写一个只在临时目录运行的小脚本，插入并查询一条记录。

### 第四周：架构和小功能

- 阅读 Fastify 管理 API。
- 追踪 UI 的一次保存操作如何到达 `ProxyManager`。
- 选择下面一个练习完整实现：类型、实现、测试、文档一起完成。
- 最后运行 `npm run check`。

## 13. 循序渐进的练习题

这些练习按风险和难度排序。建议在独立 Git 分支上完成。

### 练习 1：增加纯函数测试

为 `modelPatternMatches()` 增加以下边界用例：

- 空字符串。
- 连续多个 `*`。
- 中文或 emoji 模型名。
- 星号在开头、中间和结尾。

目标：熟悉 Vitest 的 `describe`、`it` 和 `expect`。

### 练习 2：增加 CLI 参数

增加一个只影响启动输出的布尔参数，例如 `--quiet`。需要修改类型、解析、runner 和测试。

目标：理解一个小需求如何穿过类型边界和模块边界。

### 练习 3：给健康检查增加进程运行时间

在健康响应中加入 `uptime_seconds`，值来自 `process.uptime()`。测试中应注入函数或封装时钟，避免依赖真实时间。

目标：理解 API schema、DTO、依赖注入和测试稳定性。

### 练习 4：给请求体限制增加配置

将最大请求体大小从代码默认值扩展为可配置项，并经过 Zod 校验传入 `ProxyRequestPipeline`。

目标：理解配置从磁盘到运行时对象的完整数据流。

### 练习 5：增加一个数据库迁移

新增一列或索引，创建新的 migration，并测试旧数据库升级和重复连接。

目标：理解 schema 版本、事务、幂等性和真实数据升级风险。

## 14. 阅读大型文件的方法

项目中 `admin-server.ts`、`repository.ts`、`streams.ts` 和 `task-matcher.ts` 较长。不要从第一行硬读到最后一行，可以使用下面的方法：

1. 先读 export 的类型、类和函数，了解公开能力。
2. 找到调用它的地方，明确输入和输出。
3. 只追踪一个具体场景，例如“一个 Responses SSE 如何形成日志摘要”。
4. 找对应测试确认边界行为。
5. 最后再阅读内部 helper。

可以用 ripgrep 查找调用点：

```bash
rg "selectTargetByModel" src test-node
rg "new TrafficRepository" src test-node
rg "request_finished" src test-node
```

## 15. 完成一次改动的标准流程

以后在这个项目中练习功能时，可以固定采用下面的循环：

1. 用 `rg` 找入口、调用者和已有测试。
2. 先写下输入、输出、失败方式和资源清理要求。
3. 修改最小范围代码。
4. 增加或更新测试。
5. 运行目标测试。
6. 运行 `npm run typecheck` 和 `npm run lint`。
7. 最后运行 `npm run check`。
8. 用 `git diff` 检查是否混入无关改动。

真实 Node.js 开发不只是“让正常路径跑通”。这个项目最值得学习的部分，是它如何处理外部输入、并发修改、客户端中断、上游超时、磁盘写入失败、数据库一致性和进程退出。沿着这些失败路径阅读，你会比只学习框架 API 更快建立工程思维。
