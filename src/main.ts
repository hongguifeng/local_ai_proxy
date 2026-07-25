import { formatStartupError, loadCliOptions, runCli } from "./cli/index.js";
import { enableRuntimeDiagnostics } from "./shared/index.js";

// 这是 CLI 版本的进程入口。package.json 中的 start 脚本最终会执行它编译后的文件。
// 项目使用 ESM，因此可以直接在模块顶层使用 await，不必再包一层 main()。
enableRuntimeDiagnostics();

try {
  const options = await loadCliOptions(process.argv.slice(2));
  await runCli(options);
} catch (error) {
  // 设置 exitCode 会让当前事件循环有机会完成必要的输出；它比立刻 process.exit(1)
  // 更适合常规错误退出。真正的资源释放由应用生命周期和信号处理器负责。
  process.stderr.write(`LLM proxy failed to start: ${formatStartupError(error)}\n`);
  process.exitCode = 1;
}
