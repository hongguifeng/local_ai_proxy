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
    // The UI suites launch a browser and close a stub server from their hooks, and a
    // shared two-core runner with four workers spends more than the 10 s default on that
    // while nothing is wrong. A unit test that hangs still fails, just later.
    hookTimeout: 30_000,
    // A hosted runner gives this suite four cores' worth of work and 16 GB, and four forks
    // holding a browser, a TypeScript program and a bundle build each ran the machine out of
    // memory: one fork died at the V8 heap limit while every assertion that reported was
    // green. Two workers is what those cores can actually run at once.
    ...(process.env.CI === undefined ? {} : { maxWorkers: 2 }),
  },
});
