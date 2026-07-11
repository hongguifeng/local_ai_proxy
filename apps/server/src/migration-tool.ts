import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import Database from "better-sqlite3";

import { parsePersistedConfig } from "./config/schema.js";
import { openStorageDatabase } from "./storage/migration.js";

export interface MigrationResult {
  status: "migrated" | "already_migrated";
  configPath: string | null;
  databases: number;
  backupPath: string;
}
interface MigrationMarker {
  sourceHashes: Record<string, string>;
  configPath?: string | null;
  databases: number;
  backupPath: string;
}

export async function migrateData(sourceDirectory: string, targetDirectory: string): Promise<MigrationResult> {
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  if (source === target) throw new Error("Source and target directories must differ");
  const files = await migrationFiles(source);
  if (files.length === 0) throw new Error("No migratable data found in source directory");
  const hashes = await fileHashes(source, files);
  const markerPath = join(target, ".migration-complete.json");
  try {
    const marker = parseMarker(parseJson(await readFile(markerPath, "utf8")));
    if (JSON.stringify(marker.sourceHashes) === JSON.stringify(hashes))
      return {
        status: "already_migrated",
        configPath: marker.configPath ?? null,
        databases: marker.databases,
        backupPath: marker.backupPath,
      };
    throw new Error("Target was migrated from different source data");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error("Migration target must be empty");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const staging = `${target}.migration-${randomUUID()}`;
  const backup = join(staging, "backup");
  await mkdir(backup, { recursive: true });
  try {
    for (const file of files) {
      const destination = join(backup, relative(source, file));
      await mkdir(dirname(destination), { recursive: true });
      await cp(file, destination);
    }
    const configSource = files.find((file) => file.endsWith("proxies.json"));
    let configPath: string | null = null;
    if (configSource) {
      const converted = convertPythonConfig(parseJson(await readFile(configSource, "utf8")));
      configPath = "proxies.json";
      await writeFile(join(staging, configPath), `${JSON.stringify(converted, null, 2)}\n`);
    }
    const databases = files.filter((file) => file.endsWith("traffic.db"));
    for (const databaseSource of databases) {
      const before = inspectDatabase(databaseSource);
      const destination = join(staging, relative(source, databaseSource));
      await mkdir(dirname(destination), { recursive: true });
      await cp(databaseSource, destination);
      const database = openStorageDatabase(destination);
      database.close();
      const after = inspectDatabase(destination);
      if (
        before.tasks !== after.tasks ||
        before.records !== after.records ||
        !after.integrity ||
        after.foreignKeyViolations !== 0
      )
        throw new Error("Migrated database validation failed");
    }
    const marker = {
      version: 1,
      source,
      sourceHashes: hashes,
      configPath,
      databases: databases.length,
      backupPath: "backup",
    };
    await writeFile(join(staging, ".migration-complete.json"), `${JSON.stringify(marker, null, 2)}\n`);
    const afterHashes = await fileHashes(source, files);
    if (JSON.stringify(afterHashes) !== JSON.stringify(hashes)) throw new Error("Source data changed during migration");
    await mkdir(dirname(target), { recursive: true });
    await rename(staging, target);
    return { status: "migrated", configPath, databases: databases.length, backupPath: join(target, "backup") };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function convertPythonConfig(input: unknown) {
  if (!input || typeof input !== "object" || !("pairs" in input) || !Array.isArray(input.pairs))
    throw new Error("Unsupported Python config schema");
  return parsePersistedConfig({
    version: 1,
    proxies: input.pairs.map((raw) => {
      const pair = raw as Record<string, unknown>;
      const targets = Array.isArray(pair.targets) ? pair.targets : [];
      return {
        id: pair.id,
        name: pair.name,
        enabled: pair.enabled,
        listenHost: pair.listen_host,
        listenPort: pair.listen_port,
        accessLog: pair.access_log,
        defaultTargetId: pair.default_target_id,
        targets: targets.map((rawTarget) => {
          const target = rawTarget as Record<string, unknown>;
          return {
            id: target.id,
            name: target.name,
            enabled: target.enabled,
            url: target.target_url,
            targetApiKey: target.target_api_key,
            headers: target.target_headers,
            stripRequestFields:
              typeof target.strip_request_fields === "string"
                ? target.strip_request_fields.split(",").filter(Boolean)
                : target.strip_request_fields,
            injectRequestFields:
              typeof target.inject_request_fields === "string" && target.inject_request_fields
                ? parseJson(target.inject_request_fields)
                : {},
            timeouts: {
              connectMs: 10_000,
              responseHeadersMs: 60_000,
              idleMs: Math.max(1_000, Number(target.timeout ?? 600) * 1_000),
            },
            logRoot: target.log_root ?? null,
            redactLogs: target.redact_logs,
            modelMappings: target.model_mappings ?? [],
          };
        }),
      };
    }),
  });
}
function inspectDatabase(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return {
      tasks: count(database, "tasks"),
      records: count(database, "records"),
      integrity: database.pragma("integrity_check", { simple: true }) === "ok",
      foreignKeyViolations: (database.pragma("foreign_key_check") as unknown[]).length,
    };
  } finally {
    database.close();
  }
}
function count(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
async function migrationFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === "proxies.json" || entry.name === "traffic.db") result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}
async function hash(path: string): Promise<string> {
  const info = await stat(path);
  const digest = createHash("sha256").update(String(info.size));
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) digest.update(chunk);
  return digest.digest("hex");
}
async function fileHashes(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const file of files) values[relative(root, file)] = await hash(file);
  return values;
}
function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
function parseMarker(value: unknown): MigrationMarker {
  if (
    !value ||
    typeof value !== "object" ||
    !("sourceHashes" in value) ||
    !("databases" in value) ||
    !("backupPath" in value)
  )
    throw new Error("Invalid migration marker");
  const marker = value as Record<string, unknown>;
  if (
    !marker.sourceHashes ||
    typeof marker.sourceHashes !== "object" ||
    Array.isArray(marker.sourceHashes) ||
    !Object.values(marker.sourceHashes).every((hashValue) => typeof hashValue === "string") ||
    typeof marker.databases !== "number" ||
    typeof marker.backupPath !== "string"
  )
    throw new Error("Invalid migration marker");
  return {
    sourceHashes: marker.sourceHashes as Record<string, string>,
    databases: marker.databases,
    backupPath: marker.backupPath,
    ...(typeof marker.configPath === "string" || marker.configPath === null ? { configPath: marker.configPath } : {}),
  };
}
function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
