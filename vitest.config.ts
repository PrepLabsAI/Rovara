import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
