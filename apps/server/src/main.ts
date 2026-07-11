import {
  CliUsageError,
  ExitCode,
  parseCliArgs,
  renderHelp,
  VERSION,
  type CliOptions,
  type ExitCodeValue,
} from "./cli-options.js";
import { installShutdownHooks, type ApplicationRuntime, type SignalSource } from "./lifecycle.js";
import { createProductionRuntime } from "./production-runtime.js";

export type MainDependencies = Readonly<{
  createRuntime: (options: CliOptions) => ApplicationRuntime;
  environment: Readonly<Record<string, string | undefined>>;
  signalSource: SignalSource;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openBrowser: (url: string) => Promise<void>;
}>;

export function createDefaultDependencies(): MainDependencies {
  return {
    createRuntime: createProductionRuntime,
    environment: process.env,
    signalSource: process,
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
    openBrowser: async (url) => {
      const browser = await import("./browser.js");
      await browser.openBrowser(url);
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
    if (!action.options.noBrowser) {
      try {
        await dependencies.openBrowser(`http://${browserHost(action.options.host)}:${action.options.port.toString()}/`);
      } catch {
        dependencies.stderr(
          JSON.stringify({ event: "warning", code: "BROWSER_OPEN_FAILED", message: "Could not open browser" }),
        );
      }
    }
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

function browserHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
