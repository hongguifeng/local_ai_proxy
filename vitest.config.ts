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
    passWithNoTests: true,
    reporters: ["default"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
