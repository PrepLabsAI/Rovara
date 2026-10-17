import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/acceptance/e2e-container-foundation.acceptance.ts"],
    globalSetup: [],
    passWithNoTests: false,
    testTimeout: 90_000,
    hookTimeout: 15_000,
  },
});
