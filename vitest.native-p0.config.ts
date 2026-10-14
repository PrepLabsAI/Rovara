import { defineConfig } from "vitest/config";
import { nativeP0Files, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

export default defineConfig({
  test: {
    ...sharedVitestSettings,
    include: [...nativeP0Files],
  },
});
