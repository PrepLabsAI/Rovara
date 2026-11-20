import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const nativeP0Files = [
  "tests/e2e/project-setup-terminal-authority-fix1.test.ts",
  "tests/e2e/p0-native-journey.test.ts",
  "tests/e2e/p0-native-journey-5b.test.ts",
  "tests/e2e/runtime-installation-qualification.native.test.ts",
  "tests/e2e/m1-web-journey.test.ts",
  "tests/e2e/m1-3-journeys.test.ts",
  "tests/e2e/m1-4-journeys.test.ts",
];

// Tests too slow for every full run. `npm test` leaves them out, except in a pull request's "the ones this change can reach" run (ROVARA_NIGHTLY_TESTS=1 in
// ci.yml), which runs one only when the change reaches it. CI's nightly job and every release run them all (`npm run test:nightly`).
// eval-question-simulation: about 8 minutes of one-thread Monte Carlo that checks the eval check's false-alarm rate and power (packages/contracts/src/eval-check.ts).
// worker-env-detect-growth (#1236): about 7.5 minutes timing every environment detector on hostile files of growing size, so no pattern backtracks
// catastrophically (packages/worker/src/env-detect/). The 256 KiB sweep in worker-env-detect-hardening still runs in every full run.
// local-up-flow: a whole task through `rovara up` on SQLite against a fake worker (243 tests, about 4 minutes).
// workflow-e2e/*: the hosted task lifecycle, suite by suite, against fakes (about 17 minutes in all). Every file in the folder, new ones included.
const WORKFLOW_E2E_DIR = "tests/integration/workflow-e2e";
const workflowE2eFiles = readdirSync(fileURLToPath(new URL(`../../${WORKFLOW_E2E_DIR}`, import.meta.url)))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `${WORKFLOW_E2E_DIR}/${name}`);

export const nightlyOnlyFiles = [
  "tests/unit/eval-question-simulation.test.ts",
  "tests/unit/worker-env-detect-growth.test.ts",
  "tests/unit/local-up-flow.test.ts",
  ...workflowE2eFiles,
];

// #1242: integration journeys that belong after a deployed beta environment in the release pipeline, not on code merge. Until that stage exists they
// run only in CI's nightly job: unlike nightlyOnlyFiles, no pull request or push run includes them, not even when the change reaches them.
// slack-workflow-e2e: 32 Slack-to-draft-pull-request journeys in one process (about 115 s).
export const postDeployFiles = [
  "tests/integration/slack-workflow-e2e.test.ts",
];

export const sharedVitestSettings = {
  coverage: { enabled: false },
  globalSetup: ["tests/support/test-temp-dir.ts"] as string[],
  passWithNoTests: false,
  testTimeout: 60_000,
} as const;
