import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type PackagedSmokeReport,
  type SmokePorts,
  runPackagedSmoke,
  reportSmokeLine,
  requestedPorts,
} from "./smoke_harness.js";

/**
 * Smoke test for the unpacked payload: release/win-unpacked/LLM Proxy.exe, the directory the
 * portable wrapper unpacks. Running it proves the application, its SQLite native module and
 * the admin endpoints inside the shipped tree without going through the NSIS stub, so a
 * wrapper problem and a payload problem stay separable.
 *
 * Run this before scripts/artifact_smoke.ts: the payload cannot collide with the portable
 * stub's Temp directory, so a clean payload result plus a failed wrapper run means the
 * wrapper's shared unpack directory, not the payload, is what broke.
 */

export const PAYLOAD_HEALTH_DEADLINE_MS = 30_000;

export async function findUnpackedPayload(releaseDirectory: string): Promise<string> {
  const executable = path.join(releaseDirectory, "win-unpacked", "LLM Proxy.exe");
  const info = await stat(executable).catch(() => undefined);
  if (info === undefined) {
    throw new Error(
      `Unpacked payload executable not found at ${executable}: build the payload first, for example npm run package:electron:dir.`,
    );
  }
  return executable;
}

export async function smokeUnpackedPayload(
  releaseDirectory = path.resolve("release"),
  ports: SmokePorts | undefined = requestedPorts(),
): Promise<PackagedSmokeReport> {
  if (process.platform !== "win32") {
    throw new Error("Windows payload smoke test must run on Windows.");
  }
  const executable = await findUnpackedPayload(releaseDirectory);
  const report = await runPackagedSmoke({
    executable,
    healthDeadlineMs: PAYLOAD_HEALTH_DEADLINE_MS,
    kind: "payload",
    ports,
  });
  reportSmokeLine("unpacked payload", executable, report);
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeUnpackedPayload();
}
