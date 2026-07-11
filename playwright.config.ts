import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  outputDir: "./test-results/playwright",
  retries: 2,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node apps/web/e2e/fixture-server.mjs",
    url: "http://127.0.0.1:4174/api/v1/health",
    reuseExistingServer: false,
  },
});
