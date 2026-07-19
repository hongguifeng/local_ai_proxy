import { formatStartupError, loadCliOptions, runCli } from "./cli/index.js";
import { enableRuntimeDiagnostics } from "./shared/index.js";

enableRuntimeDiagnostics();

try {
  const options = await loadCliOptions(process.argv.slice(2));
  await runCli(options);
} catch (error) {
  process.stderr.write(`LLM proxy failed to start: ${formatStartupError(error)}\n`);
  process.exitCode = 1;
}
