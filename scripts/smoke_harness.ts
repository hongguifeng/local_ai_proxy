import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createTcpProbe } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createDefaultProxyPair } from "../src/config/defaults.js";

/**
 * Shared plumbing for the two packaged-application smokes. It owns every resource a smoke
 * launch creates: the throwaway config pair, the fresh userData directory, the absolute log
 * root, the upstream fixture, the child process, and the cleanup that removes all of them.
 *
 * The startup condition below is not optional. A packaged Electron executable spawned with
 * ELECTRON_RUN_AS_NODE still set runs as plain Node, so Node parses "--port" as its own
 * option and the process dies with exit 9 ("bad option") before the app can bind a port.
 * That death looks like a packaging failure in the health report but is a launch problem,
 * so every spawn here deletes the variable from the child environment first.
 */

export const ELECTRON_RUN_AS_NODE_VARIABLE = "ELECTRON_RUN_AS_NODE";

export function smokeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => name !== ELECTRON_RUN_AS_NODE_VARIABLE),
  );
}

export interface SmokePorts {
  readonly admin: number;
  readonly proxy: number;
  readonly upstream: number;
}

export interface SmokeWorkspace {
  readonly adminUrl: string;
  readonly applicationConfigFile: string;
  readonly configFile: string;
  readonly dataDirectory: string;
  readonly directory: string;
  readonly exitSignalFile: string;
  readonly logRoot: string;
  readonly ports: SmokePorts;
  readonly startupErrorFile: string;
}

export interface PackagedSmokeOptions {
  readonly executable: string;
  readonly healthDeadlineMs?: number;
  readonly kind: SmokeKind;
  readonly ports: SmokePorts | undefined;
}

export type SmokeKind = "portable" | "payload";

const DEFAULT_HEALTH_DEADLINE_MS = 60_000;
const SHUTDOWN_DEADLINE_MS = 30_000;
const DATABASE_DEADLINE_MS = 20_000;

/** Ports the operator pinned for this run, so a verification can be repeated on the same
 *  numbers and still be checked for availability before use. */
export function requestedPorts(
  environment: NodeJS.ProcessEnv = process.env,
): SmokePorts | undefined {
  const admin = smokePort(environment, "LLM_PROXY_SMOKE_ADMIN_PORT");
  const proxy = smokePort(environment, "LLM_PROXY_SMOKE_PROXY_PORT");
  const upstream = smokePort(environment, "LLM_PROXY_SMOKE_UPSTREAM_PORT");
  if (admin === undefined || proxy === undefined || upstream === undefined) return undefined;
  return { admin, proxy, upstream };
}

function smokePort(environment: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = environment[name];
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535, received "${value}".`);
  }
  return port;
}

/** Reserves the three ports a smoke launch needs, preferring the caller's numbers when the
 *  caller supplied them and an ephemeral port when that number is already taken. */
export async function reservePorts(preferred: SmokePorts | undefined): Promise<SmokePorts> {
  return {
    admin: await reservePort(preferred?.admin),
    proxy: await reservePort(preferred?.proxy),
    upstream: await reservePort(preferred?.upstream),
  };
}

async function reservePort(preferred: number | undefined): Promise<number> {
  if (preferred !== undefined && (await isPortAvailable(preferred))) return preferred;
  const server = createTcpProbe();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function isPortAvailable(port: number): Promise<boolean> {
  const server = createTcpProbe();
  const available = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!available) return false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

/** Builds a throwaway workspace so a smoke launch can never read or write the configuration,
 *  log root, or userData directory of the instance the user runs day to day. Every path is
 *  absolute: a relative log root would be resolved against the application config directory,
 *  and a relative "--config-file" against the child's cwd. */
export async function createSmokeWorkspace(
  kind: SmokeKind,
  ports: SmokePorts,
): Promise<SmokeWorkspace> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `llm-proxy-${kind}-smoke-`));
  const logRoot = path.join(directory, "logs");
  const dataDirectory = path.join(directory, "user-data");
  await mkdir(logRoot, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });

  const applicationConfigFile = path.join(directory, "llm-proxy.json");
  await writeFile(
    applicationConfigFile,
    `${JSON.stringify({ admin: { host: "127.0.0.1", port: ports.admin } }, null, 2)}\n`,
    "utf8",
  );

  // The default pair is disabled, and a disabled pair never opens a database, so the health
  // check alone would prove nothing about the SQLite binding inside the payload.
  const pair = createDefaultProxyPair(logRoot);
  pair.enabled = true;
  pair.listen_port = ports.proxy;
  const target = pair.targets[0];
  if (target === undefined) throw new Error("The default proxy pair must carry a target.");
  target.target_url = `http://127.0.0.1:${ports.upstream}`;
  target.log_root = logRoot;
  const configFile = path.join(directory, "proxies.json");
  await writeFile(configFile, `${JSON.stringify({ pairs: [pair] }, null, 2)}\n`, "utf8");

  return {
    adminUrl: `http://127.0.0.1:${ports.admin}`,
    applicationConfigFile,
    configFile,
    dataDirectory,
    directory,
    exitSignalFile: path.join(directory, "exit.signal"),
    logRoot,
    ports,
    startupErrorFile: path.join(directory, "startup-error.txt"),
  };
}

export interface UpstreamFixture {
  readonly port: number;
  close: () => Promise<void>;
}

/** One local upstream so a smoke run can produce a real logged record without any network. */
export async function startUpstreamFixture(port: number): Promise<UpstreamFixture> {
  const server = createServer((request, response) => {
    request.resume();
    response.on("error", () => {
      // The smoke client may hang up while the run is being torn down.
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "resp-smoke",
        object: "chat.completion",
        model: "smoke-upstream",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "sqlite abi smoke reply" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function proxyRoundTrip(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "smoke-model",
      messages: [{ role: "user", content: "prove the packaged sqlite binding works" }],
      stream: false,
    }),
  });
  await response.text();
  return response.status;
}

export interface LogPageReport {
  readonly status: number;
  readonly total: number;
}

export async function fetchLogPage(adminUrl: string): Promise<LogPageReport> {
  const response = await fetch(`${adminUrl}/api/logs?limit=5`);
  const body: unknown = await response.json().catch(() => undefined);
  const total =
    typeof body === "object" && body !== null && "total" in body ? Number(body.total) : Number.NaN;
  return { status: response.status, total };
}

export interface TrafficDatabaseReport {
  readonly bytes: number;
  readonly path: string;
}

export async function requireTrafficDatabase(
  logRoot: string,
  deadlineMs = DATABASE_DEADLINE_MS,
): Promise<TrafficDatabaseReport> {
  const databaseFile = path.join(logRoot, "traffic.db");
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const info = await stat(databaseFile).catch(() => undefined);
    if (info !== undefined) {
      return { bytes: info.size, path: databaseFile };
    }
    await sleep(100);
  }
  throw new Error(
    `No traffic.db was created in this run's log root ${logRoot}: the packaged application never opened its database.`,
  );
}

export async function waitForHealth(
  url: string,
  startupErrorFile: string,
  deadlineMs: number,
): Promise<{ ms: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  while (Date.now() < deadline) {
    const startupError = await readFileOrNull(startupErrorFile);
    if (startupError !== undefined) {
      throw new Error(`Packaged application startup failed: ${startupError.trim()}`);
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        await response.text();
        return { ms: Date.now() - startedAt };
      }
    } catch {
      // The packaged process may still be unpacking or starting.
    }
    await sleep(250);
  }
  throw new Error(`Packaged application did not become healthy: ${url}`);
}

async function readFileOrNull(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function requestSmokeExit(exitSignalFile: string): Promise<void> {
  await writeFile(exitSignalFile, "exit\n", "utf8");
}

export interface TrackedChild {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  exitCode: () => number | null;
}

/** Spawns the packaged executable and records the exit code as soon as the process reports
 *  one, so the smoke can distinguish "it exited" from "it never answered". The child
 *  environment is built here, in one place, because every packaged launch needs the same
 *  startup condition: ELECTRON_RUN_AS_NODE must not be inherited. */
export function startTrackedChild(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "env">,
  environmentAdditions: Readonly<Record<string, string>> = {},
): TrackedChild {
  const child = spawn(command, args, {
    ...options,
    env: { ...smokeChildEnvironment(), ...environmentAdditions },
  });
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code;
  });
  return { child, exitCode: () => exitCode, pid: child.pid };
}

export async function waitForTrackedExit(
  tracked: TrackedChild,
  deadlineMs = SHUTDOWN_DEADLINE_MS,
): Promise<number | null> {
  const deadline = Date.now() + deadlineMs;
  while (tracked.exitCode() === null && Date.now() < deadline) {
    await sleep(100);
  }
  return tracked.exitCode();
}

/** Kills only the process this script started, and only while it is still running. */
export async function stopTrackedChild(tracked: TrackedChild): Promise<void> {
  if (tracked.exitCode() !== null || tracked.child.killed) return;
  tracked.child.kill();
  await waitForTrackedExit(tracked, SHUTDOWN_DEADLINE_MS);
}

export interface ForeignInstanceReport {
  readonly pids: number[];
  readonly available: boolean;
}

/** Reads the process table to find LLM Proxy instances this script did not start. Used only
 *  to explain a health timeout as a launch collision; foreign processes are reported, never
 *  killed. */
export async function findForeignProxyInstances(
  trackedPids: number[],
): Promise<ForeignInstanceReport> {
  const listed = await runListCommand();
  if (listed === undefined) return { available: false, pids: [] };
  const pids: number[] = [];
  for (const line of listed.split("\n")) {
    const fields = line.split('","').map((field) => field.replace(/^"|"$/g, "").trim());
    if (fields[0]?.toLowerCase() !== "llm proxy.exe") continue;
    const pid = Number(fields[1]);
    if (Number.isInteger(pid) && !trackedPids.includes(pid)) pids.push(pid);
  }
  return { available: true, pids };
}

async function runListCommand(): Promise<string | undefined> {
  const child = spawn("tasklist", ["/fo", "csv", "/nh"], {
    env: smokeChildEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  return exitCode === 0 ? output : undefined;
}

/** Turns a health timeout into a sentence about what actually happened. A portable wrapper
 *  unpacks into a Temp directory and deletes it on exit, so a second run of the same build,
 *  or another live instance holding the same userData lock, can keep a new process from ever
 *  binding its admin port. That is a launch collision and must not be reported as a payload
 *  regression, so the message points at the unpacked-payload smoke instead. */
export async function explainHealthFailure(
  earlyExit: number | null,
  trackedPids: number[],
  workspace: SmokeWorkspace,
  foreignLookup: (pids: number[]) => Promise<ForeignInstanceReport> = findForeignProxyInstances,
): Promise<string> {
  const startupError = (await readFileOrNull(workspace.startupErrorFile))?.trim();
  if (startupError) return `The application reported this startup failure: ${startupError}`;
  if (earlyExit !== null) {
    return (
      `The application exited with code ${earlyExit} before serving /api/health, which is a launch ` +
      `problem, not a packaging failure. A clean exit usually means the userData directory ${workspace.dataDirectory} ` +
      `already holds the Electron single-instance lock for another live instance.`
    );
  }
  const foreign = await foreignLookup(trackedPids);
  if (foreign.pids.length > 0) {
    return (
      `Another LLM Proxy instance is already running (pid ${foreign.pids.join(", ")}). A portable wrapper unpacks ` +
      `into a Temp directory and deletes it on exit, and the single-instance lock is namespaced by userData, so this ` +
      `launch could be blocked by that instance: it is a portable unpack-path collision, not a payload regression. ` +
      `Check the payload itself with npm run smoke:payload.`
    );
  }
  const reason = foreign.available
    ? "no other LLM Proxy process was found in the process table"
    : "the process table could not be read, so another instance cannot be ruled out";
  return (
    `The application stayed alive but never answered /api/health; ${reason}. Treat this as a launch ` +
    `problem first: the portable wrapper unpacks into a Temp directory that a concurrent run may hold. ` +
    `Check the payload itself with npm run smoke:payload.`
  );
}

export function reportSmokeLine(
  label: string,
  executable: string,
  report: PackagedSmokeReport,
): void {
  process.stdout.write(
    `${label}: ${path.basename(executable)} health ${report.healthMs} ms, proxy ${report.proxyStatus}, ` +
      `GET /api/logs?limit=5 ${report.logStatus} total ${report.total}, ` +
      `traffic.db ${report.database.bytes} bytes at ${report.database.path}, ` +
      `exit code ${String(report.exitCode)}.\n`,
  );
}

export interface PackagedSmokeReport {
  readonly database: TrafficDatabaseReport;
  readonly exitCode: number | null;
  readonly healthMs: number;
  readonly logStatus: number;
  readonly proxyStatus: number;
  readonly total: number;
}

/** Runs one packaged executable end to end: health, a real proxy round trip, the log
 *  endpoint, the database file, a clean exit, and removal of every temporary resource. */
export async function runPackagedSmoke(
  options: PackagedSmokeOptions,
): Promise<PackagedSmokeReport> {
  const ports = await reservePorts(options.ports);
  const workspace = await createSmokeWorkspace(options.kind, ports);
  const upstream = await startUpstreamFixture(ports.upstream);
  const tracked = startTrackedChild(
    options.executable,
    [
      "--no-browser",
      "--port",
      String(ports.admin),
      "--application-config",
      workspace.applicationConfigFile,
      "--config-file",
      workspace.configFile,
      "--log-root",
      workspace.logRoot,
    ],
    {
      cwd: workspace.directory,
      stdio: "ignore",
    },
    {
      LLM_PROXY_DATA_DIR: workspace.dataDirectory,
      LLM_PROXY_SMOKE_EXIT_FILE: workspace.exitSignalFile,
      LLM_PROXY_STARTUP_ERROR_FILE: workspace.startupErrorFile,
    },
  );
  const trackedPids = [tracked.pid].filter((pid): pid is number => pid !== undefined);
  try {
    const health = await waitForHealth(
      workspace.adminUrl,
      workspace.startupErrorFile,
      options.healthDeadlineMs ?? DEFAULT_HEALTH_DEADLINE_MS,
    );
    const proxyStatus = await proxyRoundTrip(ports.proxy);
    if (proxyStatus !== 200) {
      throw new Error(
        `The packaged proxy answered ${proxyStatus} instead of 200 for POST /v1/chat/completions.`,
      );
    }
    const logs = await fetchLogPage(workspace.adminUrl);
    if (logs.status !== 200) {
      throw new Error(
        `GET /api/logs?limit=5 answered ${logs.status}; a 500 there means the SQLite native module in the payload ` +
          `cannot be loaded, which is an ABI problem in the package, not an application bug.`,
      );
    }
    if (logs.total < 1) {
      throw new Error(
        `GET /api/logs?limit=5 reported total ${logs.total} after a logged proxy round trip, so the payload never wrote the record.`,
      );
    }
    const database = await requireTrafficDatabase(workspace.logRoot);
    await requestSmokeExit(workspace.exitSignalFile);
    const exitCode = await waitForTrackedExit(tracked);
    if (exitCode !== 0) {
      throw new Error(
        `Packaged application exited with code ${String(exitCode)} after the exit signal.`,
      );
    }
    await assertAdminPortReleased(workspace.adminUrl);
    return {
      database,
      exitCode,
      healthMs: health.ms,
      logStatus: logs.status,
      proxyStatus,
      total: logs.total,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Packaged application did not become healthy")
    ) {
      throw new Error(
        `${error.message}\n${await explainHealthFailure(tracked.exitCode(), trackedPids, workspace)}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    await stopTrackedChild(tracked);
    await upstream.close();
    await rm(workspace.directory, { force: true, recursive: true });
  }
}

async function assertAdminPortReleased(url: string): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/api/health`);
    } catch {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Packaged application did not release its admin port: ${url}`);
}
