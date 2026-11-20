import { defineConfig } from "vitest/config";
import { nightlyOnlyFiles, postDeployFiles, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

export default defineConfig({
  test: {
    ...sharedVitestSettings,
    include: [...nightlyOnlyFiles, ...postDeployFiles],
  },
});
