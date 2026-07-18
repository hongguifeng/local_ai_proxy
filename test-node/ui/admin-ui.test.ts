import { afterAll, beforeAll, describe, it } from "vitest";
import { chromium, expect as expectPage, type Browser, type Page } from "@playwright/test";
import type { AddressInfo } from "node:net";

import {
  applicationHealth,
  createAdminServer,
  loadAdminStaticAssets,
} from "../../src/admin/index.js";
import type { PublicProxyPair } from "../../src/config/index.js";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof createAdminServer>;
let baseUrl: string;

const pairs: PublicProxyPair[] = [
  {
    id: "proxy-one",
    name: "Fixture Proxy",
    enabled: true,
    running: true,
    actual_listen_port: 4321,
    listen_host: "127.0.0.1",
    listen_port: 4321,
    access_log: false,
    default_target_id: "target-one",
    targets: [
      {
        id: "target-one",
        name: "Fixture Target",
        enabled: true,
        target_url: "https://example.test/v1",
        target_api_key: "secret-key",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        timeout: 600,
        log_root: "logs",
        redact_logs: false,
        model_mappings: [],
      },
    ],
  },
];

beforeAll(async () => {
  server = createAdminServer({
    getHealth: () => applicationHealth("running"),
    pairService: { listPairs: () => pairs },
    staticAssets: await loadAdminStaticAssets(),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await page.close();
  await browser.close();
  await server.close();
});

describe("admin UI proxy page", () => {
  it("loads and renders configured proxy pairs", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const card = page.locator('.proxy-card[data-index="0"]');
    await expectPage(card).toHaveCount(1);
    await expectPage(card.locator('[data-field="name"]')).toHaveValue("Fixture Proxy");
    await expectPage(card.locator('[data-field="listen_host"]')).toHaveValue("127.0.0.1");
    await expectPage(card.locator('[data-field="listen_port"]')).toHaveValue("4321");
    await expectPage(card.locator(".status")).toHaveClass(/running/);
    await expectPage(card.locator('[data-target-field="name"]')).toHaveValue("Fixture Target");
    await expectPage(card.locator('[data-target-field="target_url"]')).toHaveValue(
      "https://example.test/v1",
    );
  });
});
