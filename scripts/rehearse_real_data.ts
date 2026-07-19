import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { ConfigRepository } from "../src/config/index.js";
import { TrafficRepository } from "../src/persistence/index.js";
import { validateMigrationDatabase, type MigrationValidation } from "./validate_migration.js";

export interface RealDataRehearsalResult {
  readonly sourceDatabaseBytes: number;
  readonly backupDurationMs: number;
  readonly configPairCount: number;
  readonly migrated: MigrationValidation;
  readonly rollbackHashMatch: boolean;
  readonly rollbackReopen: MigrationValidation;
}

export async function rehearseRealData(
  sourceLogRoot: string,
  rehearsalRoot: string,
): Promise<RealDataRehearsalResult> {
  await mkdir(rehearsalRoot);
  const sourceDatabase = path.join(sourceLogRoot, "traffic.db");
  const sourceConfig = path.join(sourceLogRoot, "proxies.json");
  const snapshotDatabase = path.join(rehearsalRoot, "traffic.before-node.db");
  const workingDatabase = path.join(rehearsalRoot, "traffic.db");
  const snapshotConfig = path.join(rehearsalRoot, "proxies.before-node.json");
  const workingConfig = path.join(rehearsalRoot, "proxies.json");

  await copyFile(sourceConfig, snapshotConfig);
  await copyFile(snapshotConfig, workingConfig);
  const configRepository = new ConfigRepository(workingConfig, rehearsalRoot);
  const config = await configRepository.load();
  await configRepository.save(config);
  await copyFile(snapshotConfig, workingConfig);
  const restoredConfig = await configRepository.load();

  const sourceSize = (await stat(sourceDatabase)).size;
  const source = new Database(sourceDatabase, { fileMustExist: true, readonly: true });
  const backupStarted = performance.now();
  try {
    await source.backup(snapshotDatabase);
  } finally {
    source.close();
  }
  const backupDurationMs = performance.now() - backupStarted;
  await copyFile(snapshotDatabase, workingDatabase);

  const repository = new TrafficRepository(rehearsalRoot);
  try {
    repository.listTasks("", 1, 0);
  } finally {
    repository.close();
  }
  const migrated = validateMigrationDatabase(rehearsalRoot);

  await removeWorkingWal(rehearsalRoot);
  await copyFile(snapshotDatabase, workingDatabase);
  const rollbackHashMatch = (await sha256(snapshotDatabase)) === (await sha256(workingDatabase));

  const rollbackRepository = new TrafficRepository(rehearsalRoot);
  rollbackRepository.close();
  const rollbackReopen = validateMigrationDatabase(rehearsalRoot);

  return {
    sourceDatabaseBytes: sourceSize,
    backupDurationMs,
    configPairCount: restoredConfig.pairs.length,
    migrated,
    rollbackHashMatch,
    rollbackReopen,
  };
}

async function removeWorkingWal(logRoot: string): Promise<void> {
  await Promise.all(
    ["traffic.db-wal", "traffic.db-shm"].map((name) =>
      rm(path.join(logRoot, name), { force: true }),
    ),
  );
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("Expected a binary file chunk.");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceLogRoot = process.argv[2];
  const rehearsalRoot = process.argv[3];
  if (sourceLogRoot === undefined || rehearsalRoot === undefined) {
    throw new Error("Usage: rehearse_real_data <source-log-root> <empty-rehearsal-root>");
  }
  const result = await rehearseRealData(sourceLogRoot, rehearsalRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
