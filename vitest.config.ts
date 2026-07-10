import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "reports/vitest-junit.xml",
    },
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.ts", "packages/contracts/src/**/*.ts"],
      exclude: ["apps/server/src/cli.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
