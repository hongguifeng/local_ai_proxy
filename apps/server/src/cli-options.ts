import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

export const VERSION = loadVersion();

export const ExitCode = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type CliOptions = Readonly<{
  host: string;
  port: number;
  configFile: string;
  logRoot: string;
  noBrowser: boolean;
  allowRemoteAdmin: boolean;
  adminToken: string | undefined;
}>;

export type CliAction =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "version" }>
  | Readonly<{ kind: "migrate"; source: string; target: string }>
  | Readonly<{ kind: "run"; options: CliOptions }>;

export class CliUsageError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliUsageError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function loadVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL("./build-metadata.json", import.meta.url), "utf8")) as unknown;
    if (value && typeof value === "object" && "version" in value && typeof value.version === "string")
      return value.version;
  } catch {
    // Source and test execution use the development fallback.
  }
  return "0.3.0-dev";
}

function parseRawArgs(args: readonly string[], environment: Readonly<Record<string, string | undefined>>) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
        host: { type: "string", default: environment.LLM_PROXY_UI_HOST ?? "127.0.0.1" },
        port: { type: "string", default: environment.LLM_PROXY_UI_PORT ?? "8088" },
        "config-file": { type: "string", default: environment.LLM_PROXY_CONFIG_FILE ?? "logs/proxies.json" },
        "log-root": { type: "string", default: environment.LLM_PROXY_LOG_ROOT ?? "logs" },
        "no-browser": { type: "boolean", default: environment.LLM_PROXY_NO_BROWSER === "1" },
        "allow-remote-admin": { type: "boolean", default: false },
        "admin-token": { type: "string", default: environment.LLM_PROXY_ADMIN_TOKEN },
      },
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : "Invalid command-line arguments", {
      cause: error,
    });
  }
}

export function parseCliArgs(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CliAction {
  if (args[0] === "migrate") {
    let migration;
    try {
      migration = parseArgs({
        args: [...args.slice(1)],
        strict: true,
        allowPositionals: false,
        options: { source: { type: "string" }, target: { type: "string" } },
      });
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : "Invalid migration arguments");
    }
    if (!migration.values.source || !migration.values.target)
      throw new CliUsageError("migrate requires --source and --target");
    return { kind: "migrate", source: migration.values.source, target: migration.values.target };
  }
  const parsed = parseRawArgs(args, environment);

  if (parsed.values.help) {
    return { kind: "help" };
  }
  if (parsed.values.version) {
    return { kind: "version" };
  }

  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliUsageError("--port must be an integer between 1 and 65535");
  }
  const host = parsed.values.host.trim();
  if (!host) {
    throw new CliUsageError("--host must not be empty");
  }
  const allowRemoteAdmin = parsed.values["allow-remote-admin"];
  const rawAdminToken = parsed.values["admin-token"]?.trim();
  const adminToken = rawAdminToken === "" ? undefined : rawAdminToken;
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && !allowRemoteAdmin) {
    throw new CliUsageError("Non-loopback admin hosts require --allow-remote-admin");
  }
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && !adminToken) {
    throw new CliUsageError("Non-loopback admin hosts require --admin-token or LLM_PROXY_ADMIN_TOKEN");
  }

  return {
    kind: "run",
    options: {
      host,
      port,
      configFile: parsed.values["config-file"],
      logRoot: parsed.values["log-root"],
      noBrowser: parsed.values["no-browser"],
      allowRemoteAdmin,
      adminToken,
    },
  };
}

export function renderHelp(): string {
  return `LLM Proxy ${VERSION}

Usage: llm-proxy [options]
       llm-proxy migrate --source <python-data-dir> --target <node-data-dir>

Options:
  -h, --help                 Show this help text
  -v, --version              Show the version
      --host <host>          Admin bind host (default: 127.0.0.1)
      --port <port>          Admin port (default: 8088)
      --config-file <path>   Configuration file (default: logs/proxies.json)
      --log-root <path>      Default traffic log root (default: logs)
      --no-browser           Do not open the admin UI in a browser
      --allow-remote-admin   Explicitly allow a non-loopback admin host
      --admin-token <token>  Authentication token required for remote admin
`;
}
