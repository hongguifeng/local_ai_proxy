import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import { startTrackedChild, stopTrackedChild, waitForTrackedExit } from "./smoke_harness.js";

/**
 * Proves which SQLite native ABI is installed by running a real query. `require("better-sqlite3")`
 * never touches the native binding, so it prints success whether the binary carries the Node ABI
 * or the Electron ABI; only opening a ":memory:" database and reading a row tells them apart.
 *
 * Node verification entry point: run this file with plain Node (`npm run abi:node`).
 * Electron verification entry point: run it with `--electron`, which spawns the local Electron
 * binary with ELECTRON_RUN_AS_NODE deleted and repeats the same query inside it.
 */

export type ProbeRuntime = "electron" | "node";

export interface AbiProbeResult {
  readonly detail: string;
  readonly ok: boolean;
}

export function currentRuntime(): ProbeRuntime {
  return process.versions.electron ? "electron" : "node";
}

export function probeSqliteAbi(runtime: ProbeRuntime = currentRuntime()): AbiProbeResult {
  try {
    const database = new Database(":memory:");
    try {
      const row = database.prepare("select 1 as a").get() as { a: number } | undefined;
      if (row?.a !== 1) {
        return {
          detail: `better-sqlite3 loaded but "select 1" returned ${JSON.stringify(row)} in ${runtime}.`,
          ok: false,
        };
      }
      return {
        detail:
          `OK: better-sqlite3 answered a real query in ${runtime} ` +
          `(NODE_MODULE_VERSION ${process.versions.modules}, query result {"a":1}).`,
        ok: true,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return { detail: describeNativeModuleFailure(error, runtime), ok: false };
  }
}

/** One sentence an operator can act on: the two ABI numbers, the runtime, and the exact
 *  rebuild command that would change the installed binary. */
export function describeNativeModuleFailure(error: unknown, runtime: ProbeRuntime): string {
  const message = error instanceof Error ? error.message : String(error);
  const versions = [...message.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((match) => match[1]);
  const advice =
    runtime === "electron"
      ? "run npm run rebuild:electron before packaging or running a packaged executable"
      : "run npm run rebuild:node before Node tests, the Node smoke, or this probe";
  if (versions.length >= 2 && versions[0] !== undefined && versions[1] !== undefined) {
    return (
      `better_sqlite3.node carries the ABI built for NODE_MODULE_VERSION ${versions[0]} while ${runtime} ` +
      `needs ${versions[1]}, so it cannot be loaded here: ${advice}.`
    );
  }
  const code = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
  return (
    `better_sqlite3 could not load its native module${code} in ${runtime}: ${message.trim()} ` +
    `If this runtime is Electron, ${advice}; re-run npm ci first if the file itself is missing.`
  );
}

export function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const resolved: unknown = require("electron");
  if (typeof resolved !== "string") {
    throw new Error("The electron package did not resolve to an executable path.");
  }
  return resolved;
}

export async function runProbeInElectron(deadlineMs = 60_000): Promise<number> {
  // Electron takes the entry as a plain path. A "file://" URL lands in the child's
  // process.argv[1] and then fails this module's own entry gate, so the child starts and
  // never runs the probe.
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new Error("Cannot re-run the ABI probe inside Electron without an entry path.");
  }
  const tracked = startTrackedChild(electronBinary(), [entry], { stdio: "inherit" });
  const exitCode = await waitForTrackedExit(tracked, deadlineMs);
  if (exitCode === null) {
    await stopTrackedChild(tracked);
    throw new Error(
      `The Electron ABI probe did not exit within ${deadlineMs} ms; the tracked child (pid ${String(tracked.pid)}) was killed.`,
    );
  }
  return exitCode;
}

async function main(): Promise<void> {
  if (process.argv.includes("--electron")) {
    const exitCode = await runProbeInElectron();
    process.stdout.write(
      `electron ABI probe finished with exit code ${String(exitCode)} (${exitCode === 0 ? "the packaged runtime can open SQLite" : "the Electron runtime could not open SQLite"}).\n`,
    );
    process.exit(exitCode);
  }
  const result = probeSqliteAbi();
  process.stdout.write(`${result.detail}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
