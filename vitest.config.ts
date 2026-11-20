import { configDefaults, defineConfig } from "vitest/config";
import { DurationSequencer } from "./tests/support/duration-sequencer.js";
import { moduleMockingFiles, nativeP0Files, nightlyOnlyFiles, postDeployFiles, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

const include = ["tests/**/*.test.ts", "packages/**/*.test.ts"];
const exclude = [...configDefaults.exclude, ...nativeP0Files, ...postDeployFiles, ...(process.env.ROVARA_NIGHTLY_TESTS === "1" ? [] : nightlyOnlyFiles)];

export default defineConfig({
  test: {
    ...sharedVitestSettings,
    exclude,
    // `--shard=N/M` (CI's test shards) takes a share balanced by each file's recorded run time, not an even number of files (tests/.timings/vitest-durations.json).
    sequence: { sequencer: DurationSequencer },
    // Loading the same modules again for every test file is about half of the suite's time (@agentx/contracts alone is 468 modules). The files that mock modules
    // must keep a fresh module graph each ("fresh-modules"); every other file ("shared-modules") can share one per worker once the files leave no state behind
    // (tests/support/module-state.ts puts it back after each file). Both projects still give every file fresh modules: sharing is switched on separately.
    projects: [
      { extends: true, test: { name: "fresh-modules", include: moduleMockingFiles, isolate: true } },
      { extends: true, test: { name: "shared-modules", include, exclude: [...exclude, ...moduleMockingFiles], isolate: true } },
    ],
  },
});
