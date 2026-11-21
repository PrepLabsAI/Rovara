import { defineConfig } from "vitest/config";
import { sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

// Vitest 5.0.3 does not forward CLI --exclude to test.projects. Keep the Linux
// profile as one project so CI's separately scheduled Docker files stay excluded.
export default defineConfig({
  test: {
    ...sharedVitestSettings,
    include: ["tests/linux/**/*.test.ts"],
    isolate: true,
  },
});
