import path from "node:path";

import { createNodeApplication, type Application, type NodeApplication } from "../app/index.js";
import type { CliOptions } from "./index.js";
import { openBrowserLater } from "./browser.js";
import { installShutdownSignals } from "./signals.js";

export interface CliOutput {
  write(text: string): unknown;
}

export interface RunCliDependencies {
  readonly createApplication?: (options: CliOptions) => NodeApplication;
  readonly cwd?: string;
  readonly openBrowser?: (url: string) => unknown;
  readonly output?: CliOutput;
  readonly registerSignals?: (application: Application) => unknown;
}

export async function runCli(
  options: CliOptions,
  dependencies: RunCliDependencies = {},
): Promise<Application> {
  const createApplication = dependencies.createApplication ?? createNodeApplication;
  const runtime = createApplication(options);
  await runtime.application.start();
  const address = runtime.address();
  const port = address?.port ?? options.port;
  const uiUrl = `http://${options.host}:${port}`;
  const output = dependencies.output ?? process.stdout;
  const cwd = dependencies.cwd ?? process.cwd();
  output.write(`LLM proxy UI listening on ${uiUrl}\n`);
  output.write(`Proxy config: ${path.resolve(cwd, options.configFile)}\n`);
  output.write(`Logs directory: ${path.resolve(cwd, options.logRoot)}\n`);
  (dependencies.registerSignals ?? installShutdownSignals)(runtime.application);
  if (!options.noBrowser) {
    (dependencies.openBrowser ?? openBrowserLater)(uiUrl);
  }
  return runtime.application;
}

export function formatStartupError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = Array.from(error.errors as Iterable<unknown>)
      .map(formatStartupError)
      .join("; ");
    return details === "" ? error.message : `${error.message} ${details}`;
  }
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : ` ${formatStartupError(error.cause)}`;
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}
