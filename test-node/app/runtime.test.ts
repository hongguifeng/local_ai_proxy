import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeApplication } from "../../src/app/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("createNodeApplication", () => {
  it("starts the admin UI and enabled proxies, then releases both ports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    const configuredProxyPort = await availablePort();
    await writeFile(
      configFile,
      JSON.stringify({
        pairs: [
          {
            id: "enabled",
            name: "Enabled",
            enabled: true,
            listen_host: "127.0.0.1",
            listen_port: configuredProxyPort,
            access_log: false,
            default_target_id: "target",
            targets: [
              {
                id: "target",
                name: "Target",
                enabled: true,
                target_url: "http://127.0.0.1:9",
                target_api_key: "",
                target_headers: [],
                strip_request_fields: "",
                inject_request_fields: "",
                log_root: "logs",
                redact_logs: false,
                model_mappings: [],
              },
            ],
          },
        ],
      }),
    );
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });

    await runtime.application.start();
    await expect(access(path.join(root, "logs", "traffic.db"))).resolves.toBeUndefined();
    const adminPort = runtime.address()?.port;
    expect(adminPort).toBeTypeOf("number");
    const response = await fetch(`http://127.0.0.1:${adminPort}/api/pairs`);
    const body = (await response.json()) as { pairs: { actual_listen_port: number }[] };
    const proxyPort = body.pairs[0]?.actual_listen_port;
    expect(proxyPort).toBeTypeOf("number");

    // LB-16 removed the model check, so this route no longer exists at all.
    const removedVerify = await fetch(
      `http://127.0.0.1:${adminPort}/api/load-balancer/verify-models`,
      { method: "POST" },
    );
    expect(removedVerify.status).toBe(404);
    const removedBody = (await removedVerify.json()) as { error?: { code?: string } };
    expect(removedBody.error?.code).toBe("not_found");

    await runtime.application.stop();
    await expect(fetch(`http://127.0.0.1:${adminPort}/api/health`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${proxyPort}/v1/models`)).rejects.toThrow();
  });

  it("exposes the log listing, export, and cleanup admin routes on the assembled application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    await writeFile(configFile, JSON.stringify({ pairs: [] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    try {
      const adminPort = runtime.address()?.port;
      expect(adminPort).toBeTypeOf("number");

      // Guard against the assembled app silently dropping these routes (404
      // "Route not found."): the admin server only registers cleanup/export
      // when the wired log service actually provides those methods.
      const list = await fetch(`http://127.0.0.1:${adminPort}/api/logs`);
      expect(list.status).toBe(200);

      // The pending sweep depends on this route: without it the admin UI falls
      // back to one detail request per in-flight record.
      const records = await fetch(
        `http://127.0.0.1:${adminPort}/api/logs/records?ids=missing-record`,
      );
      expect(records.status).toBe(200);
      expect(await records.json()).toEqual({ records: [] });

      const pricing = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing`,
      );
      expect(pricing.status).toBe(404);
      const pricingBody = (await pricing.json()) as { error?: { code?: string } };
      expect(pricingBody.error?.code).toBe("log_group_not_found");

      const tokenSeries = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing/tokens`,
      );
      expect(tokenSeries.status).toBe(404);
      const tokenSeriesBody = (await tokenSeries.json()) as { error?: { code?: string } };
      expect(tokenSeriesBody.error?.code).toBe("log_group_not_found");

      const costSeries = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing/costs`,
      );
      expect(costSeries.status).toBe(404);
      const costSeriesBody = (await costSeries.json()) as { error?: { code?: string } };
      expect(costSeriesBody.error?.code).toBe("log_group_not_found");

      const outputTokenSeries = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing/output-tokens`,
      );
      expect(outputTokenSeries.status).toBe(404);
      const outputTokenSeriesBody = (await outputTokenSeries.json()) as {
        error?: { code?: string };
      };
      expect(outputTokenSeriesBody.error?.code).toBe("log_group_not_found");

      // The task-brief card depends on these two routes: GET returns the cached
      // brief (null when it was never generated) and POST generates one. With no
      // summary model configured the POST fails with a readable 502.
      const brief = await fetch(`http://127.0.0.1:${adminPort}/api/log-groups/missing-group/brief`);
      expect(brief.status).toBe(200);
      expect(await brief.json()).toBeNull();

      const briefGenerate = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/brief`,
        { method: "POST" },
      );
      expect(briefGenerate.status).toBe(502);
      const briefBody = (await briefGenerate.json()) as {
        error?: { code?: string; message?: string };
      };
      expect(briefBody.error?.code).toBe("task_brief_failed");
      expect(briefBody.error?.message).toBe("Summary model is not configured.");

      const exportResponse = await fetch(`http://127.0.0.1:${adminPort}/api/logs/export`);
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get("content-type")).toBe("application/zip");
      const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());
      expect([zipBytes[0], zipBytes[1]]).toEqual([0x50, 0x4b]);

      // Guard against the assembled app silently dropping the model price
      // import route (404 "Route not found."): it is registered only when the
      // model catalog service is wired in runtime.ts.
      const importBad = await fetch(`http://127.0.0.1:${adminPort}/api/model-prices/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(importBad.status).toBe(400);
      const importBadBody = (await importBad.json()) as { error?: { code?: string } };
      expect(importBadBody.error?.code).toBe("FST_ERR_VALIDATION");

      // Guard against the assembled app silently dropping the target metrics
      // route (404 "Route not found."): it is registered only when the
      // metrics service is wired in runtime.ts.
      const metricsBad = await fetch(`http://127.0.0.1:${adminPort}/api/target-metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(metricsBad.status).toBe(400);
      const metricsBadBody = (await metricsBad.json()) as { error?: { code?: string } };
      expect(metricsBadBody.error?.code).toBe("FST_ERR_VALIDATION");

      const metricsInvalidUrl = await fetch(`http://127.0.0.1:${adminPort}/api/target-metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUrl: "http://" }),
      });
      expect(metricsInvalidUrl.status).toBe(400);
      const metricsInvalidBody = (await metricsInvalidUrl.json()) as {
        error?: { code?: string };
      };
      expect(metricsInvalidBody.error?.code).toBe("invalid_target_url");

      const metricsUnreachable = await fetch(`http://127.0.0.1:${adminPort}/api/target-metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUrl: "http://127.0.0.1:9" }),
      });
      expect(metricsUnreachable.status).toBe(200);
      const metricsBody = (await metricsUnreachable.json()) as {
        ok: boolean;
        error?: string;
        durationMs: number;
      };
      expect(metricsBody.ok).toBe(false);
      expect(metricsBody.error).toBeTruthy();
      expect(metricsBody.durationMs).toBeGreaterThanOrEqual(0);

      // Guard against the assembled app silently dropping the target model list
      // route (404 "Route not found."): it is registered only when the models
      // service is wired in runtime.ts.
      const modelsBad = await fetch(`http://127.0.0.1:${adminPort}/api/target-models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(modelsBad.status).toBe(400);
      const modelsBadBody = (await modelsBad.json()) as { error?: { code?: string } };
      expect(modelsBadBody.error?.code).toBe("FST_ERR_VALIDATION");

      const modelsInvalidUrl = await fetch(`http://127.0.0.1:${adminPort}/api/target-models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUrl: "http://" }),
      });
      expect(modelsInvalidUrl.status).toBe(400);
      const modelsInvalidBody = (await modelsInvalidUrl.json()) as {
        error?: { code: string };
      };
      expect(modelsInvalidBody.error?.code).toBe("invalid_target_url");

      const modelsUnreachable = await fetch(`http://127.0.0.1:${adminPort}/api/target-models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUrl: "http://127.0.0.1:9" }),
      });
      expect(modelsUnreachable.status).toBe(200);
      const modelsBody = (await modelsUnreachable.json()) as {
        ok: boolean;
        models: string[];
        error?: string;
        durationMs: number;
      };
      expect(modelsBody.ok).toBe(false);
      expect(modelsBody.models).toEqual([]);
      expect(modelsBody.error).toBeTruthy();
      expect(modelsBody.durationMs).toBeGreaterThanOrEqual(0);

      // The load balancing routes must exist on the assembled application, and the
      // status route must answer from memory even when nothing is configured.
      const lbStatus = await fetch(`http://127.0.0.1:${adminPort}/api/load-balancer/status`);
      expect(lbStatus.status).toBe(200);
      const lbBody = (await lbStatus.json()) as { now: number; pairs: unknown[] };
      expect(lbBody.now).toBeTypeOf("number");
      expect(lbBody.pairs).toEqual([]);

      // LB-16 removed the model check: the route answers with the generic not_found code,
      // which is how Fastify reports a route that was never registered.
      const removedVerify = await fetch(
        `http://127.0.0.1:${adminPort}/api/load-balancer/verify-models`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groupId: "missing-group", pairId: "missing-pair" }),
        },
      );
      expect(removedVerify.status).toBe(404);
      const removedBody = (await removedVerify.json()) as { error?: { code?: string } };
      expect(removedBody.error?.code).toBe("not_found");

      const cleanupPayloads = [
        { group_ids: ["missing-group"] },
        { keep_latest: 1 },
        { older_than_days: 30 },
      ];
      for (const payload of cleanupPayloads) {
        const response = await fetch(`http://127.0.0.1:${adminPort}/api/logs/cleanup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { deleted_count: number };
        expect(body.deleted_count).toBe(0);
      }
    } finally {
      await runtime.application.stop();
    }
  });

  it("fails cleanly when the admin port is already occupied", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile: path.join(root, "missing.json"),
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: address.port,
    });

    await expect(runtime.application.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(runtime.application.state).toBe("stopped");
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("[AI-01] keeps a saved pair edit when the summary model is applied afterwards", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    const pair = disabledPairFixture("Original");
    await writeFile(configFile, JSON.stringify({ pairs: [pair] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    try {
      const adminPort = runtime.address()?.port;
      expect(adminPort).toBeTypeOf("number");
      const base = `http://127.0.0.1:${adminPort}`;

      // The pair edit and the summary save are separate admin writes. Neither may
      // revert the other, so the second write must be composed against the
      // configuration the first one committed.
      const renamed = await fetch(`${base}/api/pairs`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairs: [{ ...pair, name: "edited-name" }] }),
      });
      expect(renamed.status).toBe(200);
      const renamedBody = (await renamed.json()) as { pairs: { name: string }[] };
      expect(renamedBody.pairs[0]?.name).toBe("edited-name");

      const summarySaved = await fetch(`${base}/api/settings/summary-model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(summaryModelFixture()),
      });
      expect(summarySaved.status).toBe(200);

      const pairsAfterSummary = await fetch(`${base}/api/pairs`);
      const pairsBody = (await pairsAfterSummary.json()) as { pairs: { name: string }[] };
      expect(pairsBody.pairs[0]?.name).toBe("edited-name");

      const persisted = JSON.parse(await readFile(configFile, "utf8")) as {
        pairs: { name: string }[];
        summary_model?: Record<string, unknown>;
      };
      expect(persisted.pairs[0]?.name).toBe("edited-name");
      expect(persisted.summary_model).toMatchObject(summaryModelFixture());

      const readBack = await fetch(`${base}/api/settings/summary-model`);
      expect(await readBack.json()).toMatchObject(summaryModelFixture());
    } finally {
      await runtime.application.stop();
    }
  });

  it("[AI-02] follows log root changes and answers empty statistics when nothing is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    await writeFile(configFile, JSON.stringify({ pairs: [] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    try {
      const adminPort = runtime.address()?.port;
      expect(adminPort).toBeTypeOf("number");
      const base = `http://127.0.0.1:${adminPort}`;
      const statisticsWindow = "from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z";

      // With no log root the statistics routes are still registered and answer the
      // same empty shape as an empty database.
      const emptyOverview = await fetch(
        `${base}/api/usage-statistics/overview?${statisticsWindow}`,
      );
      expect(emptyOverview.status).toBe(200);
      expect(await emptyOverview.json()).toMatchObject({
        totals: { requests: 0 },
        byTarget: [],
        byModel: [],
      });
      const emptyOptions = await fetch(`${base}/api/usage-statistics/options?${statisticsWindow}`);
      expect(emptyOptions.status).toBe(200);
      expect(await emptyOptions.json()).toEqual({ targets: [], models: [] });
      const emptyExport = await fetch(`${base}/api/usage-statistics/export?${statisticsWindow}`);
      expect(emptyExport.status).toBe(200);
      expect(await emptyExport.text()).toContain("bucket,requests,tasks");
      const emptyLogs = await fetch(`${base}/api/logs?limit=5`);
      expect(((await emptyLogs.json()) as { groups: unknown[] }).groups).toEqual([]);

      const firstRoot = path.join(root, "stats-a");
      const secondRoot = path.join(root, "stats-b");
      await mkdir(firstRoot, { recursive: true });
      await mkdir(secondRoot, { recursive: true });
      seedPricedRecord(firstRoot, "app-stats-a", "target-a", "1000");
      seedPricedRecord(secondRoot, "app-stats-b", "target-b", "2000");

      // One committed pair change moves the history list and the statistics together.
      const moved = await fetch(`${base}/api/pairs`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairs: [disabledPairFixture("first root", firstRoot)] }),
      });
      expect(moved.status).toBe(200);
      const movedOverview = await fetch(
        `${base}/api/usage-statistics/overview?${statisticsWindow}`,
      );
      expect(movedOverview.status).toBe(200);
      expect(await movedOverview.json()).toMatchObject({
        totals: { requests: 1, cost: "0.000001000" },
      });
      const movedGroups = (await (await fetch(`${base}/api/logs?limit=5`)).json()) as {
        groups: { id: string }[];
      };
      expect(movedGroups.groups.map((group) => group.id)).toEqual(["app-stats-a"]);

      const secondMove = await fetch(`${base}/api/pairs`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairs: [disabledPairFixture("second root", secondRoot)] }),
      });
      expect(secondMove.status).toBe(200);
      const secondOverview = await fetch(
        `${base}/api/usage-statistics/overview?${statisticsWindow}`,
      );
      expect(await secondOverview.json()).toMatchObject({
        totals: { requests: 1, cost: "0.000002000" },
      });
      const secondGroups = (await (await fetch(`${base}/api/logs?limit=5`)).json()) as {
        groups: { id: string }[];
      };
      expect(secondGroups.groups.map((group) => group.id)).toEqual(["app-stats-b"]);

      // The root that was dropped is neither read nor recreated afterwards.
      await rm(path.join(firstRoot, "traffic.db"), { force: true });
      const cleared = await fetch(`${base}/api/pairs`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairs: [] }),
      });
      expect(cleared.status).toBe(200);
      const clearedOverview = await fetch(
        `${base}/api/usage-statistics/overview?${statisticsWindow}`,
      );
      expect(await clearedOverview.json()).toMatchObject({ totals: { requests: 0 } });
      await expect(access(path.join(firstRoot, "traffic.db"))).rejects.toThrow();
    } finally {
      await runtime.application.stop();
    }
  });

  it("persists summary model settings when applying the configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    await writeFile(configFile, JSON.stringify({ pairs: [] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    const adminPort = runtime.address()?.port;
    const summary = {
      disable_reasoning: true,
      api_type: "openai_chat",
      target_url: "http://127.0.0.1:1235",
      api_key: "secret",
      model: "summarizer",
      target_headers: [],
      timeout_ms: 180000,
    };
    await fetch(`http://127.0.0.1:${adminPort}/api/settings/summary-model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
    });
    const persisted = JSON.parse(await readFile(configFile, "utf8")) as {
      summary_model?: Record<string, unknown>;
    };
    expect(persisted.summary_model).toMatchObject(summary);
    await runtime.application.stop();
  });

  // [AI-09] Every write route the route table declares is answered by the assembled
  // application. The discriminator this test is written against is the 404 code: `not_found`
  // comes from the not-found handler and means the route was never registered, while
  // `pair_not_found`, `log_group_not_found` and `record_not_found` mean the route is registered
  // and the object the request named does not exist. Pinning the status and code of all twelve
  // requests is what tells those two apart; a route that was dropped by a missing service would
  // show up here as `404 not_found`.
  it("[AI-09] answers every write route on its own assembled application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    await writeFile(configFile, JSON.stringify({ pairs: [disabledPairFixture("managed")] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    try {
      const adminPort = runtime.address()?.port;
      expect(adminPort).toBeTypeOf("number");
      const base = `http://127.0.0.1:${adminPort}`;
      // Port 9 is the discard port: nothing listens there, so the connection test reports a
      // failed request instead of reaching an upstream that costs money.
      const unreachableSummary = { ...summaryModelFixture(), target_url: "http://127.0.0.1:9" };

      const writes: readonly {
        readonly method: string;
        readonly route: string;
        readonly body: unknown;
        readonly status: number;
        readonly code: string | null;
      }[] = [
        {
          method: "POST",
          route: "/api/log-groups/missing-group/brief",
          body: {},
          status: 502,
          code: "task_brief_failed",
        },
        {
          method: "POST",
          route: "/api/logs/missing-record/summary",
          body: {},
          status: 502,
          code: "summary_failed",
        },
        {
          method: "POST",
          route: "/api/logs/cleanup",
          body: { group_ids: ["missing-group"] },
          status: 200,
          code: null,
        },
        {
          method: "POST",
          route: "/api/model-prices/import",
          body: {},
          status: 400,
          code: "FST_ERR_VALIDATION",
        },
        {
          method: "POST",
          route: "/api/target-check",
          body: {},
          status: 400,
          code: "FST_ERR_VALIDATION",
        },
        {
          method: "POST",
          route: "/api/target-metrics",
          body: {},
          status: 400,
          code: "FST_ERR_VALIDATION",
        },
        {
          method: "POST",
          route: "/api/target-models",
          body: {},
          status: 400,
          code: "FST_ERR_VALIDATION",
        },
        {
          method: "POST",
          route: "/api/pairs/managed-pair/enabled",
          body: { enabled: true },
          status: 200,
          code: null,
        },
        {
          method: "POST",
          route: "/api/pairs/missing-pair/enabled",
          body: { enabled: true },
          status: 404,
          code: "pair_not_found",
        },
        {
          method: "POST",
          route: "/api/settings/summary-model/test",
          body: unreachableSummary,
          status: 200,
          code: null,
        },
        {
          method: "PUT",
          route: "/api/pairs",
          body: { pairs: [disabledPairFixture("renamed")] },
          status: 200,
          code: null,
        },
        {
          method: "PUT",
          route: "/api/settings/summary-model",
          body: unreachableSummary,
          status: 200,
          code: null,
        },
      ];

      const mismatched: string[] = [];
      for (const write of writes) {
        const response = await fetch(base + write.route, {
          method: write.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(write.body),
        });
        const parsed = (await response.json()) as { error?: { code?: string } };
        const code = response.status === 200 ? null : (parsed.error?.code ?? null);
        if (response.status !== write.status || code !== write.code) {
          mismatched.push(
            `${write.method} ${write.route}: ${response.status} ${code ?? "-"} instead of ${write.status} ${write.code ?? "-"}`,
          );
        }
      }
      expect(mismatched).toEqual([]);

      // The two writes that change state have to be visible afterwards, which is what makes them
      // write operations instead of routes that only answer.
      const pairsAfter = (await (await fetch(`${base}/api/pairs`)).json()) as {
        pairs: { name: string; enabled: boolean }[];
      };
      expect(pairsAfter.pairs.map((pair) => [pair.name, pair.enabled])).toEqual([
        ["renamed", false],
      ]);

      const persisted = JSON.parse(await readFile(configFile, "utf8")) as {
        pairs: { name: string }[];
        summary_model?: Record<string, unknown>;
      };
      expect(persisted.pairs[0]?.name).toBe("renamed");
      expect(persisted.summary_model).toMatchObject(unreachableSummary);
    } finally {
      await runtime.application.stop();
    }
  });
});

function disabledPairFixture(name: string, logRoot = "logs"): Record<string, unknown> {
  return {
    id: "managed-pair",
    name,
    enabled: false,
    listen_host: "127.0.0.1",
    listen_port: 0,
    access_log: false,
    default_target_id: "managed-target",
    load_balancers: [],
    targets: [
      {
        id: "managed-target",
        name: "Managed target",
        enabled: true,
        target_url: "http://127.0.0.1:9",
        target_api_key: "",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        log_root: logRoot,
        redact_logs: false,
        model_mappings: [],
      },
    ],
  };
}

function summaryModelFixture(): Record<string, unknown> {
  return {
    disable_reasoning: true,
    api_type: "openai_chat",
    target_url: "http://127.0.0.1:1236",
    api_key: "summary-secret",
    model: "summarizer",
    target_headers: [],
    timeout_ms: 180000,
  };
}

function seedPricedRecord(root: string, taskId: string, target: string, costNanoCny: string): void {
  const repository = new TrafficRepository(root);
  const timestamp = "2026-07-18T10:00:00.000+08:00";
  repository.upsertTask({
    id: taskId,
    kind: "responses",
    model: "model",
    target: "fixture-target",
    started_at: timestamp,
    last_seen_at: timestamp,
    last_response_at: timestamp,
    request_count: 2,
    pending_request_only: false,
  });
  repository.upsertRecord({
    id: `record-${taskId}`,
    task_id: taskId,
    sequence: 1,
    method: "POST",
    path: "/v1/responses",
    target_url: target,
    pricing: {
      pricing_status: "priced",
      billing_model: "model",
      usage: {
        inputUncachedTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      cost_nano_cny: costNanoCny,
    },
  });
  repository.close();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
