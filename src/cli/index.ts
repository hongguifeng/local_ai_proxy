import path from "node:path";

import {
  DEFAULT_ADMIN_HOST,
  DEFAULT_ADMIN_PORT,
  DEFAULT_APPLICATION_CONFIG_PATH,
  DEFAULT_CONFIG_PATH,
  DEFAULT_LOG_ROOT,
  loadApplicationConfig,
  type ApplicationConfig,
} from "../config/index.js";

export { launchBrowser, openBrowserLater, type BrowserLauncher } from "./browser.js";
export { installShutdownSignals, type SignalProcess } from "./signals.js";
export { formatStartupError, runCli, type CliOutput, type RunCliDependencies } from "./runner.js";

export interface CliOptions {
  readonly applicationConfigFile: string;
  readonly configFile: string;
  readonly host: string;
  readonly logRoot: string;
  readonly noBrowser: boolean;
  readonly port: number;
}

export { DEFAULT_ADMIN_PORT };

/**
 * 把三种配置来源合并成最终 CLI 选项。
 * 优先级是：命令行参数 > 环境变量 > llm-proxy.json > 代码默认值。
 */
export function parseCliArgs(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  applicationConfig: ApplicationConfig = {
    admin: { host: DEFAULT_ADMIN_HOST, port: DEFAULT_ADMIN_PORT },
  },
): CliOptions {
  let applicationConfigFile =
    env["LLM_PROXY_APPLICATION_CONFIG_FILE"] ?? DEFAULT_APPLICATION_CONFIG_PATH;
  let configFile = env["LLM_PROXY_CONFIG_FILE"] ?? DEFAULT_CONFIG_PATH;
  let host = env["LLM_PROXY_UI_HOST"] ?? applicationConfig.admin.host;
  let logRoot = env["LLM_PROXY_LOG_ROOT"] ?? DEFAULT_LOG_ROOT;
  let noBrowser = env["LLM_PROXY_NO_BROWSER"] === "1";
  const environmentPort = env["LLM_PROXY_UI_PORT"];
  let port =
    environmentPort === undefined
      ? applicationConfig.admin.port
      : tcpPort(environmentPort, "LLM_PROXY_UI_PORT");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") {
      host = requiredValue(argv, ++index, argument);
      continue;
    }
    if (argument === "--port") {
      port = tcpPort(requiredValue(argv, ++index, argument), argument);
      continue;
    }
    if (argument === "--config-file") {
      configFile = requiredValue(argv, ++index, argument);
      continue;
    }
    if (argument === "--application-config") {
      applicationConfigFile = requiredValue(argv, ++index, argument);
      continue;
    }
    if (argument === "--log-root") {
      logRoot = requiredValue(argv, ++index, argument);
      continue;
    }
    if (argument === "--no-browser") {
      noBrowser = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { applicationConfigFile, configFile, host, logRoot, noBrowser, port };
}

export async function loadCliOptions(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  baseDirectory = process.cwd(),
): Promise<CliOptions> {
  // 尽早转成绝对路径，后续模块就不会因 process.cwd() 改变而读写到意外位置。
  const applicationConfigFile = path.resolve(
    baseDirectory,
    applicationConfigPathFromArgs(argv, env),
  );
  const applicationConfig = await loadApplicationConfig(applicationConfigFile);
  const options = parseCliArgs(argv, env, applicationConfig);
  return {
    ...options,
    applicationConfigFile,
    configFile: path.resolve(baseDirectory, options.configFile),
    logRoot: path.resolve(baseDirectory, options.logRoot),
  };
}

function applicationConfigPathFromArgs(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): string {
  let value = env["LLM_PROXY_APPLICATION_CONFIG_FILE"] ?? DEFAULT_APPLICATION_CONFIG_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--application-config") {
      value = requiredValue(argv, ++index, "--application-config");
    }
  }
  return value;
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Option ${option} requires a value.`);
  }
  return value;
}

function tcpPort(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Option ${option} must be an integer TCP port.`);
  }
  const port = Number(value);
  if (port < 1 || port > 65_535) {
    throw new Error(`Option ${option} must be between 1 and 65535.`);
  }
  return port;
}
