import { DEFAULT_PROXY_HOST } from "../config/index.js";

export interface CliOptions {
  readonly host: string;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let host = DEFAULT_PROXY_HOST;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") {
      host = requiredValue(argv, ++index, argument);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { host };
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Option ${option} requires a value.`);
  }
  return value;
}
