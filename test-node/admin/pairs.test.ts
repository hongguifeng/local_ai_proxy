import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import {
  ConfigRepository,
  createDefaultProxyPair,
  materializeProxyConfigFile,
} from "../../src/config/index.js";
import {
  ProxyListenConflictError,
  ProxyManager,
  ProxyPairNotFoundError,
} from "../../src/proxy/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GET /api/pairs", () => {
  it("returns configured pairs with live runtime fields", async () => {
    const pair = {
      ...createDefaultProxyPair(""),
      enabled: true,
      running: true,
      actual_listen_port: 43123,
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: { listPairs: () => [pair] },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/pairs" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pairs: [pair] });
  });

  it("does not expose the route when no pair service is configured", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);
    expect((await server.inject({ method: "GET", url: "/api/pairs" })).statusCode).toBe(404);
  });

  it("replaces the complete pair list and returns committed runtime state", async () => {
    const template = createDefaultProxyPair("");
    const firstTarget = template.targets[0];
    if (firstTarget === undefined) throw new Error("Default proxy fixture needs a target.");
    const submitted = {
      ...template,
      id: "submitted",
      name: "Submitted",
      targets: [
        {
          ...firstTarget,
          model_prices: [
            {
              model_pattern: "gpt-*",
              input_per_million: "5",
              output_per_million: "30",
              cache_read_per_million: "0.5",
              cache_write_per_million: "6.25",
            },
          ],
        },
      ],
    };
    const committed = { ...submitted, running: false, actual_listen_port: null };
    const pairService = {
      replacements: [] as unknown[],
      listPairs: () => [],
      replacePairs(pairs: readonly (typeof submitted)[]) {
        this.replacements.push(pairs);
        return Promise.resolve([committed]);
      },
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService,
    });
    servers.push(server);

    const response = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: [submitted] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pairs: [committed] });
    expect(pairService.replacements).toEqual([[submitted]]);
  });

  it("[AI-25] round-trips legacy keys through the API and persisted JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-ai25-pairs-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "proxies.json");
    const legacyPair = {
      id: "legacy-pair",
      name: "Legacy pair",
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 0,
      upstream_url: "https://legacy.example/v1",
      model_mapping_mode: "disabled",
      default_model: "",
      default_upstream_model: "",
      preserve_route_model: false,
      allow_unnamed_model: false,
      unknown_model_policy: "reject",
      unknown_param_mode: "strip",
      unknown_param_paths: [],
      stream_keepalive_interval_seconds: 0,
      target_retry_limit: 2,
      target_retry_backoff_milliseconds: 250,
      failover_reuse_connection: true,
      target_connect_timeout_milliseconds: 1_000,
      target_first_byte_timeout_milliseconds: 10_000,
      target_idle_chunk_timeout_milliseconds: 30_000,
      target_headers: ["X-Legacy: yes"],
      strip_request_fields: "temperature",
      inject_request_fields: "",
      log_root: "legacy-logs",
      redact_logs: true,
      model_mappings: [{ listen: "legacy", upstream: "legacy-upstream" }],
    };
    await writeFile(configPath, JSON.stringify({ pairs: [legacyPair] }), "utf8");
    const repository = new ConfigRepository(configPath, path.join(directory, "logs"));
    const manager = new ProxyManager(await repository.load(), repository, {
      logRootBaseDirectory: directory,
    });
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: manager,
    });
    servers.push(server);

    const legacyUnknownKeys = [
      "upstream_url",
      "model_mapping_mode",
      "default_model",
      "default_upstream_model",
      "preserve_route_model",
      "allow_unnamed_model",
      "unknown_model_policy",
      "unknown_param_mode",
      "unknown_param_paths",
      "stream_keepalive_interval_seconds",
      "target_retry_limit",
      "target_retry_backoff_milliseconds",
      "failover_reuse_connection",
      "target_connect_timeout_milliseconds",
      "target_first_byte_timeout_milliseconds",
      "target_idle_chunk_timeout_milliseconds",
      "target_headers",
      "strip_request_fields",
      "inject_request_fields",
      "log_root",
      "redact_logs",
      "model_mappings",
    ];

    const beforeSave = await server.inject({ method: "GET", url: "/api/pairs" });
    expect(beforeSave.statusCode).toBe(200);
    const loadedPair = (JSON.parse(beforeSave.body) as { pairs: Record<string, unknown>[] })
      .pairs[0];
    if (loadedPair === undefined) throw new Error("Legacy pair was not returned.");
    expect(loadedPair).toMatchObject({
      upstream_url: legacyPair.upstream_url,
      model_mapping_mode: legacyPair.model_mapping_mode,
      target_retry_limit: legacyPair.target_retry_limit,
      log_root: legacyPair.log_root,
      redact_logs: legacyPair.redact_logs,
      model_mappings: legacyPair.model_mappings,
    });
    for (const key of legacyUnknownKeys) {
      expect(loadedPair[key]).toEqual(Reflect.get(legacyPair, key));
    }
    expect((loadedPair["targets"] as Record<string, unknown>[])[0]?.["log_root"]).toBe(
      path.join(directory, "logs"),
    );

    const submitted = {
      ...loadedPair,
      running: true,
      actual_listen_port: 4567,
      expanded: true,
      targets: (loadedPair["targets"] as Record<string, unknown>[]).map((target) => ({
        ...target,
        expanded: true,
      })),
    };
    const saved = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: [submitted] },
    });
    expect(saved.statusCode).toBe(200);
    const savedPair = (JSON.parse(saved.body) as { pairs: Record<string, unknown>[] }).pairs[0];
    if (savedPair === undefined) throw new Error("Saved pair was not returned.");
    expect(savedPair).toMatchObject({
      upstream_url: legacyPair.upstream_url,
      model_mapping_mode: legacyPair.model_mapping_mode,
      target_retry_limit: legacyPair.target_retry_limit,
      log_root: legacyPair.log_root,
      redact_logs: legacyPair.redact_logs,
      model_mappings: legacyPair.model_mappings,
    });
    for (const key of legacyUnknownKeys) {
      expect(savedPair[key]).toEqual(Reflect.get(legacyPair, key));
    }
    expect(savedPair["expanded"]).toBeUndefined();
    expect((savedPair["targets"] as Record<string, unknown>[])[0]?.["expanded"]).toBeUndefined();

    const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
      pairs: Record<string, unknown>[];
    };
    expect(persisted.pairs[0]).toMatchObject({
      upstream_url: legacyPair.upstream_url,
      model_mapping_mode: legacyPair.model_mapping_mode,
      target_retry_limit: legacyPair.target_retry_limit,
      log_root: legacyPair.log_root,
      redact_logs: legacyPair.redact_logs,
      model_mappings: legacyPair.model_mappings,
    });
    for (const key of legacyUnknownKeys) {
      expect(persisted.pairs[0]?.[key]).toEqual(Reflect.get(legacyPair, key));
    }
    expect(persisted.pairs[0]?.["running"]).toBeUndefined();
    expect(persisted.pairs[0]?.["actual_listen_port"]).toBeUndefined();
    expect(persisted.pairs[0]?.["expanded"]).toBeUndefined();
    expect(
      (persisted.pairs[0]?.["targets"] as Record<string, unknown>[])[0]?.["expanded"],
    ).toBeUndefined();

    const reloaded = materializeProxyConfigFile(await repository.load());
    expect(reloaded.pairs[0]).toMatchObject({
      upstream_url: legacyPair.upstream_url,
      log_root: legacyPair.log_root,
      targets: [{ log_root: path.join(directory, "logs") }],
    });
  });
  it("rejects invalid model prices before replacing the running configuration", async () => {
    const invalid = createDefaultProxyPair("");
    const manager = new ProxyManager({ pairs: [invalid] }, { save: () => Promise.resolve() });
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: manager,
    });
    servers.push(server);

    const response = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: {
        pairs: [
          {
            ...invalid,
            targets: [
              {
                ...invalid.targets[0],
                model_prices: [
                  {
                    model_pattern: "gpt-*",
                    input_per_million: "1e3",
                    output_per_million: "1",
                    cache_read_per_million: "1",
                    cache_write_per_million: "1",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_config" } });
    expect(manager.listPairs()).toMatchObject([{ id: invalid.id }]);
  });

  it("enables or disables one pair by ID", async () => {
    const pair = {
      ...createDefaultProxyPair(""),
      enabled: true,
      running: true,
      actual_listen_port: 43210,
    };
    const changes: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [pair],
        setPairEnabled(pairId, enabled) {
          changes.push({ pairId, enabled });
          return Promise.resolve(pair);
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/pairs/${pair.id}/enabled`,
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pair });
    expect(changes).toEqual([{ pairId: pair.id, enabled: true }]);
  });

  it("returns 400 for invalid request DTOs", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [],
        replacePairs: () => Promise.resolve([]),
        setPairEnabled: () => Promise.reject(new Error("must not run")),
      },
    });
    servers.push(server);

    const replaceResponse = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: "invalid" },
    });
    expect(replaceResponse.statusCode).toBe(400);
    expect(replaceResponse.json()).toMatchObject({ error: { code: "FST_ERR_VALIDATION" } });
    const enableResponse = await server.inject({
      method: "POST",
      url: "/api/pairs/missing/enabled",
      payload: {},
    });
    expect(enableResponse.statusCode).toBe(400);
  });

  it("returns 404 for an unknown pair and 409 for a listen conflict", async () => {
    const first = { ...createDefaultProxyPair(""), id: "first", enabled: true };
    const conflict = { ...createDefaultProxyPair(""), id: "conflict", enabled: true };
    let conflictMode = false;
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [],
        replacePairs: () =>
          conflictMode
            ? Promise.reject(new ProxyListenConflictError(conflict, first))
            : Promise.resolve([]),
        setPairEnabled: (pairId) => Promise.reject(new ProxyPairNotFoundError(pairId)),
      },
    });
    servers.push(server);

    const missing = await server.inject({
      method: "POST",
      url: "/api/pairs/unknown/enabled",
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "pair_not_found", message: "Proxy pair not found: unknown" },
    });

    conflictMode = true;
    const occupied = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: [first, conflict] },
    });
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json()).toMatchObject({ error: { code: "listen_conflict" } });
  });
});

describe("load balancer configuration through the pairs API", () => {
  const template = createDefaultProxyPair("");
  const firstTarget = template.targets[0];
  if (firstTarget === undefined) {
    throw new Error("Default proxy fixture needs a target.");
  }
  const secondTarget = {
    ...firstTarget,
    id: "target-two",
    name: "GPU 2",
    target_url: "http://127.0.0.1:9394/v1",
  };
  const firstTargetId = firstTarget.id;
  const group = {
    id: "lb-1",
    name: "Dual card",
    model_pattern: "Qwen3.8-Flash-Next",
    members: [
      { target_id: firstTargetId, model_id: "" },
      { target_id: secondTarget.id, model_id: "" },
    ],
  };

  function lbPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...template,
      id: "lb-pair",
      targets: [firstTarget, secondTarget],
      default_target_id: firstTargetId,
      ...overrides,
    };
  }

  function managerWith(): ProxyManager {
    return new ProxyManager({ pairs: [template] }, { save: () => Promise.resolve() });
  }

  async function putPairs(
    manager: ProxyManager,
    pairs: readonly unknown[],
  ): Promise<{ statusCode: number; body: unknown }> {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: manager,
    });
    servers.push(server);
    const response = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs },
    });
    const body: unknown = response.json();
    return { statusCode: response.statusCode, body };
  }

  it("LB01-07 persists a load balancer group with its v1 defaults", async () => {
    const manager = managerWith();
    const result = await putPairs(manager, [lbPair({ load_balancers: [group] })]);

    expect(result.statusCode).toBe(200);
    const stored = (result.body as { pairs: Record<string, unknown>[] }).pairs[0];
    expect(stored?.["load_balancers"]).toEqual([
      {
        id: "lb-1",
        name: "Dual card",
        enabled: true,
        model_pattern: "Qwen3.8-Flash-Next",
        members: [
          { target_id: firstTarget.id, model_id: "" },
          { target_id: secondTarget.id, model_id: "" },
        ],
        strategy: "least_load",
        metrics_enabled: true,
        failover_enabled: true,
      },
    ]);
    expect(manager.listPairs()[0]?.load_balancers).toEqual(stored?.["load_balancers"]);
  });

  it("LB01-01 adds an empty group list to a payload written without the field", async () => {
    const manager = managerWith();
    const result = await putPairs(manager, [{ ...template, id: "lb-pair" }]);

    expect(result.statusCode).toBe(200);
    expect(manager.listPairs()[0]?.id).toBe("lb-pair");
    expect(manager.listPairs()[0]?.load_balancers).toEqual([]);
    expect(
      (result.body as { pairs: Record<string, unknown>[] }).pairs[0]?.["load_balancers"],
    ).toEqual([]);
  });

  it("LB01-02 rejects a node target outside the pair with its exact path", async () => {
    const manager = managerWith();
    const result = await putPairs(manager, [
      lbPair({
        load_balancers: [
          {
            ...group,
            members: [
              { target_id: firstTarget.id, model_id: "" },
              { target_id: "ghost", model_id: "" },
            ],
          },
        ],
      }),
    ]);

    expect(result.statusCode).toBe(400);
    const error = (
      result.body as { error: { code: string; issues: { path: string; message: string }[] } }
    ).error;
    expect(error.code).toBe("invalid_config");
    expect(error.issues[0]?.path).toBe("pairs.0.load_balancers.0.members.1.target_id");
    expect(error.issues[0]?.message).toContain("not found in pair lb-pair: ghost");
    expect(manager.listPairs().map((pair) => pair.id)).toEqual([template.id]);
  });

  it("LB01-04 rejects a member with another log root", async () => {
    const manager = managerWith();
    const result = await putPairs(manager, [
      lbPair({
        targets: [firstTarget, { ...secondTarget, log_root: "other-logs" }],
        load_balancers: [group],
      }),
    ]);

    expect(result.statusCode).toBe(400);
    const error = (
      result.body as { error: { code: string; issues: { path: string; message: string }[] } }
    ).error;
    expect(error.code).toBe("invalid_config");
    expect(error.issues[0]?.path).toBe("pairs.0.load_balancers.0.members.1.target_id");
    expect(error.issues[0]?.message).toContain("must share one log root");
  });

  it("LB19-03 rejects an old id-only group in a save request instead of guessing members", async () => {
    const manager = managerWith();
    const result = await putPairs(manager, [
      lbPair({
        load_balancers: [
          {
            id: "lb-1",
            name: "Old shape",
            model_pattern: "qwen*",
            node_target_ids: [firstTarget.id],
          },
        ],
      }),
    ]);

    expect(result.statusCode).toBe(400);
    const error = (
      result.body as { error: { code: string; issues: { path: string; message: string }[] } }
    ).error;
    expect(error.code).toBe("invalid_config");
    expect(error.issues.some((issue) => issue.path.endsWith("members"))).toBe(true);
    expect(manager.listPairs().map((pair) => pair.id)).toEqual([template.id]);
  });

  it("LB01-05 rejects members that price the same model differently", async () => {
    const manager = managerWith();
    const priced = {
      model_pattern: "Qwen*",
      input_per_million: "1",
      output_per_million: "2",
      cache_read_per_million: "3",
      cache_write_per_million: "4",
    };
    const result = await putPairs(manager, [
      lbPair({
        targets: [{ ...firstTarget, model_prices: [priced] }, secondTarget],
        load_balancers: [group],
      }),
    ]);

    expect(result.statusCode).toBe(400);
    const error = (
      result.body as { error: { code: string; issues: { path: string; message: string }[] } }
    ).error;
    expect(error.code).toBe("invalid_config");
    expect(error.issues[0]?.message).toContain("must share identical model prices");
  });
});
