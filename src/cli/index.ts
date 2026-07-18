import { DEFAULT_CONFIG_PATH, DEFAULT_LOG_ROOT, DEFAULT_PROXY_HOST } from "../config/index.js";

export interface CliOptions {
  readonly configFile: string;
  readonly host: string;
  readonly logRoot: string;
  readonly noBrowser: boolean;
  readonly port: number;
}

export const DEFAULT_ADMIN_PORT = 8088;

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let configFile = DEFAULT_CONFIG_PATH;
  let host = DEFAULT_PROXY_HOST;
  let logRoot = DEFAULT_LOG_ROOT;
  let noBrowser = false;
  let port = DEFAULT_ADMIN_PORT;
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
  return { configFile, host, logRoot, noBrowser, port };
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
