import { afterEach, describe, expect, it } from "vitest";

import {
  applicationHealth,
  createAdminServer,
  type ModelCatalogAdminService,
} from "../../src/admin/index.js";
import type { ModelPriceImportRequest, ModelPriceImportResult } from "../../src/pricing/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

function serviceWith(
  outcome: (request: ModelPriceImportRequest) => Promise<ModelPriceImportResult>,
): ModelCatalogAdminService {
  return { importModelPrices: (request) => outcome(request) };
}

const RESULT: ModelPriceImportResult = {
  models: ["gpt-5", "unknown-model"],
  rules: [
    {
      model_pattern: "gpt-5",
      input_per_million: "2.13",
      output_per_million: "8.875",
      cache_read_per_million: "0.213",
      cache_write_per_million: "0",
    },
  ],
  unmatched: ["unknown-model"],
  catalog: { source: "models.dev", fetchedAt: 1_700_000_000 },
};

describe("POST /api/model-prices/import", () => {
  it("does not expose the route when no model catalog service is configured", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a malformed request body", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      modelCatalogService: serviceWith(() => Promise.resolve(RESULT)),
    });
    servers.push(server);

    const missingUrl = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { priceRate: "1" },
    });
    expect(missingUrl.statusCode).toBe(400);

    const invalidScheme = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "ftp://example.test" },
    });
    expect(invalidScheme.statusCode).toBe(400);

    const invalidRate = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "http://127.0.0.1:9", priceRate: "1.2345678" },
    });
    expect(invalidRate.statusCode).toBe(400);
  });

  it("forwards the request, defaulting absent fields, and returns the rules", async () => {
    const seen: ModelPriceImportRequest[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      modelCatalogService: serviceWith((request) => {
        seen.push(request);
        return Promise.resolve(RESULT);
      }),
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RESULT);
    expect(seen).toEqual([{ targetUrl: "http://127.0.0.1:9" }]);

    const withExtras = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "http://127.0.0.1:9", targetApiKey: "sk-test", priceRate: "7.1" },
    });
    expect(withExtras.statusCode).toBe(200);
    expect(seen[1]).toEqual({
      targetUrl: "http://127.0.0.1:9",
      targetApiKey: "sk-test",
      priceRate: "7.1",
    });
  });

  it("maps invalid inputs from the service to 400", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      modelCatalogService: serviceWith(() => Promise.reject(new RangeError("rate is invalid"))),
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error?: { code?: string; message?: string } }>();
    expect(body.error?.code).toBe("invalid_model_price_import");
  });

  it("maps upstream and catalog failures to 502", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      modelCatalogService: serviceWith(() =>
        Promise.reject(new Error("The upstream answered 401 for /v1/models.")),
      ),
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/model-prices/import",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(502);
    const body = response.json<{ error?: { code?: string; message?: string } }>();
    expect(body.error?.code).toBe("model_catalog_fetch_failed");
    expect(body.error?.message).toContain("401");
  });
});
