import { formatStartupError, parseCliArgs, runCli } from "./cli/index.js";
import { enableRuntimeDiagnostics } from "./shared/index.js";

enableRuntimeDiagnostics();

const options = parseCliArgs(process.argv.slice(2));
try {
  await runCli(options);
} catch (error) {
  process.stderr.write(`LLM proxy failed to start: ${formatStartupError(error)}\n`);
  process.exitCode = 1;
}
