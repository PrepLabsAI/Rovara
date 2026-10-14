import { configDefaults, defineConfig } from "vitest/config";
import { nativeP0Files, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

export default defineConfig({
  test: {
    ...sharedVitestSettings,
    exclude: [...configDefaults.exclude, ...nativeP0Files],
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
