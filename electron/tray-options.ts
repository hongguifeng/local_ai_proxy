import { parseCliArgs, type CliOptions } from "../src/cli/index.js";

export interface TrayOptions {
  readonly cli: CliOptions;
  readonly openOnStart: boolean;
}

export function parseTrayOptions(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): TrayOptions {
  const cliArguments: string[] = [];
  let openOnStart = env["LLM_PROXY_OPEN_ON_START"] === "1";
  for (const argument of argv) {
    if (argument === "--open-on-start") {
      openOnStart = true;
    } else {
      cliArguments.push(argument);
    }
  }
  return { cli: parseCliArgs(cliArguments, env), openOnStart };
}
