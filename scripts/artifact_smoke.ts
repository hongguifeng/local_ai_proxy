import { readdir } from "node:fs/promises";
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
 * Smoke test for the portable wrapper: the NSIS stub plus 7z payload that is what actually
 * ships. It unpacks ~111 MB into a Temp directory before the app can start, so its health
 * deadline is longer than the unpacked payload's, and a failure is classified as a launch
 * collision or a packaging problem instead of being reported as one without evidence.
 *
 * The unpacked payload has its own smoke in scripts/payload_smoke.ts; run that one first when
 * a wrapper run fails, because the wrapper shares its Temp directory with any other run of the
 * same build and can be blocked by it without the payload being at fault.
 */

export const PORTABLE_HEALTH_DEADLINE_MS = 90_000;

export async function findPortableArtifact(releaseDirectory: string): Promise<string> {
  const names = await readdir(releaseDirectory);
  const name = names.find((candidate) => /portable.*\.exe$/iu.test(candidate));
  if (name === undefined) throw new Error(`Portable artifact not found in ${releaseDirectory}.`);
  return path.join(releaseDirectory, name);
}

export async function smokePortableWrapper(
  releaseDirectory = path.resolve("release"),
  ports: SmokePorts | undefined = requestedPorts(),
): Promise<PackagedSmokeReport> {
  if (process.platform !== "win32") {
    throw new Error("Windows artifact smoke test must run on Windows.");
  }
  const executable = await findPortableArtifact(releaseDirectory);
  const report = await runPackagedSmoke({
    executable,
    healthDeadlineMs: PORTABLE_HEALTH_DEADLINE_MS,
    kind: "portable",
    ports,
  });
  reportSmokeLine("portable wrapper", executable, report);
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokePortableWrapper();
}
