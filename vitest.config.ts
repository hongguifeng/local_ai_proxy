import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      clean: true,
      exclude: ["electron/**", "test-node/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
    include: ["test-node/**/*.test.ts"],
    outputFile: {
      junit: "test-results/vitest-junit.xml",
    },
    // An empty run must be an error: a filter or a path that matches nothing is
    // how a stale verification recipe pretends to have passed.
    passWithNoTests: false,
    reporters: ["default", "junit"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
