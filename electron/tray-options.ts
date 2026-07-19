import { loadCliOptions, type CliOptions } from "../src/cli/index.js";

export interface TrayOptions {
  readonly cli: CliOptions;
  readonly openOnStart: boolean;
}

export async function parseTrayOptions(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  baseDirectory = process.cwd(),
): Promise<TrayOptions> {
  const cliArguments: string[] = [];
  let openOnStart = env["LLM_PROXY_OPEN_ON_START"] === "1";
  for (const argument of argv) {
    if (argument === "--open-on-start") {
      openOnStart = true;
    } else {
      cliArguments.push(argument);
    }
  }
  return { cli: await loadCliOptions(cliArguments, env, baseDirectory), openOnStart };
}
