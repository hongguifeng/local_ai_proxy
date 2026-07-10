import {
  CliUsageError,
  ExitCode,
  parseCliArgs,
  renderHelp,
  VERSION,
  type CliOptions,
  type ExitCodeValue,
} from "./cli-options.js";
import {
  createScaffoldRuntime,
  installShutdownHooks,
  type ApplicationRuntime,
  type SignalSource,
} from "./lifecycle.js";

export type MainDependencies = Readonly<{
  createRuntime: (options: CliOptions) => ApplicationRuntime;
  environment: Readonly<Record<string, string | undefined>>;
  signalSource: SignalSource;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}>;

export function createDefaultDependencies(): MainDependencies {
  return {
    createRuntime: createScaffoldRuntime,
    environment: process.env,
    signalSource: process,
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
  };
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: MainDependencies = createDefaultDependencies(),
): Promise<ExitCodeValue> {
  let action;
  try {
    action = parseCliArgs(args, dependencies.environment);
  } catch (error) {
    const message = error instanceof CliUsageError ? error.message : "Invalid command-line arguments";
    dependencies.stderr(JSON.stringify({ event: "error", code: "USAGE_ERROR", message }));
    return ExitCode.usageError;
  }

  if (action.kind === "help") {
    dependencies.stdout(renderHelp());
    return ExitCode.success;
  }
  if (action.kind === "version") {
    dependencies.stdout(VERSION);
    return ExitCode.success;
  }

  const controller = new AbortController();
  const removeHooks = installShutdownHooks(controller, dependencies.signalSource);
  const runtime = dependencies.createRuntime(action.options);
  let started = false;
  try {
    await runtime.start(controller.signal);
    started = true;
    dependencies.stdout(
      JSON.stringify({
        event: "ready",
        host: action.options.host,
        port: action.options.port,
        configFile: action.options.configFile,
        logRoot: action.options.logRoot,
      }),
    );
    await runtime.wait(controller.signal);
    return ExitCode.success;
  } catch {
    dependencies.stderr(
      JSON.stringify({ event: "error", code: started ? "RUNTIME_ERROR" : "STARTUP_ERROR", message: "Service failed" }),
    );
    return ExitCode.runtimeError;
  } finally {
    removeHooks();
    try {
      await runtime.stop();
    } catch {
      dependencies.stderr(JSON.stringify({ event: "error", code: "SHUTDOWN_ERROR", message: "Shutdown failed" }));
    }
  }
}
