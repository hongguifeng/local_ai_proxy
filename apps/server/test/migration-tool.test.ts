import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateData } from "../src/migration-tool.js";
import { loadMigrations, readSchemaVersion } from "../src/storage/migration.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("one-time Python data migration", () => {
  it("backs up, converts, validates and detects a repeated migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-proxy-migrate-"));
    roots.push(root);
    const source = join(root, "python-data");
    const target = join(root, "node-data");
    await mkdir(join(source, "logs"), { recursive: true });
    const config = {
      pairs: [
        {
          id: "proxy-1",
          name: "Proxy",
          enabled: false,
          listen_host: "127.0.0.1",
          listen_port: 1234,
          access_log: false,
          default_target_id: "target-1",
          targets: [
            {
              id: "target-1",
              name: "Target",
              enabled: true,
              target_url: "https://example.com",
              target_api_key: "sample-secret",
              target_headers: [],
              strip_request_fields: "metadata",
              inject_request_fields: "{}",
              timeout: 600,
              log_root: "logs",
              redact_logs: true,
              model_mappings: [],
            },
          ],
        },
      ],
    };
    await writeFile(join(source, "proxies.json"), JSON.stringify(config));
    const databasePath = join(source, "logs", "traffic.db");
    const database = new Database(databasePath);
    database.exec(loadMigrations()[0]?.sql ?? "");
    database.prepare("INSERT INTO schema_meta(key,value) VALUES('schema_version','1')").run();
    database.close();
    const sourceBefore = await readFile(databasePath);
    const result = await migrateData(source, target);
    expect(result).toMatchObject({ status: "migrated", databases: 1, configPath: "proxies.json" });
    expect(await readFile(join(target, "backup", "proxies.json"), "utf8")).toBe(JSON.stringify(config));
    const converted = JSON.parse(await readFile(join(target, "proxies.json"), "utf8")) as {
      proxies: { targets: { targetApiKey: string }[] }[];
    };
    expect(converted.proxies[0]?.targets[0]?.targetApiKey).toBe("sample-secret");
    const migrated = new Database(join(target, "logs", "traffic.db"));
    expect(readSchemaVersion(migrated)).toBe(2);
    migrated.close();
    expect(await readFile(databasePath)).toEqual(sourceBefore);
    await expect(migrateData(source, target)).resolves.toMatchObject({ status: "already_migrated", databases: 1 });
  });
  it("does not alter source data when validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-proxy-migrate-fail-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "proxies.json"), '{"unsupported":true}');
    const before = await readFile(join(source, "proxies.json"));
    await expect(migrateData(source, target)).rejects.toThrow();
    expect(await readFile(join(source, "proxies.json"))).toEqual(before);
  });
});
