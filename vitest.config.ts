import { configDefaults, defineConfig } from "vitest/config";
import { DurationSequencer } from "./tests/support/duration-sequencer.js";
import { moduleMockingFiles, nativeP0Files, nightlyOnlyFiles, postDeployFiles, sharedModuleGroups, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

const exclude = [...configDefaults.exclude, ...nativeP0Files, ...postDeployFiles, ...(process.env.ROVARA_NIGHTLY_TESTS === "1" ? [] : nightlyOnlyFiles)];

export default defineConfig({
  test: {
    ...sharedVitestSettings,
    exclude,
    // `--shard=N/M` (CI's test shards) takes a share balanced by each file's recorded run time, not an even number of files (tests/.timings/vitest-durations.json).
    sequence: { sequencer: DurationSequencer },
    // Loading the same modules again for every test file is about half of the suite's time (@agentx/contracts alone is 468 modules). The files that mock modules
    // must keep a fresh module graph each ("fresh-modules"); every other file shares one per worker once the files leave no state behind
    // (tests/support/process-state.ts and module-state.ts put it back after each file). The shared files run in five groups by the package they load
    // (sharedModuleGroups): a worker keeps every module it has loaded, and one group for all of them grew a worker past CI's heap (1.7 GB on shard 8, against
    // about 0.8 GB per group). Vitest stops a group's workers when the group ends.
    projects: [
      { extends: true, test: { name: "fresh-modules", include: moduleMockingFiles, isolate: true } },
      ...Object.entries(sharedModuleGroups).map(([name, files]) => ({
        extends: true as const,
        test: { name, include: files, exclude, isolate: false, setupFiles: ["tests/support/process-state.ts", "tests/support/module-state.ts"] },
      })),
    ],
  },
});
