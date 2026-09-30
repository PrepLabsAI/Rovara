import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    globalSetup: ["tests/support/test-temp-dir.ts"],
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: false,
    // CDK synth tests outgrow 10 s under a loaded full gate.
    testTimeout: 60_000,
  },
});
