// The second setup file of the shared-module test files (vitest.config.ts, project "shared-modules"; tests/support/process-state.ts runs first). These files run one after another in one worker on one module graph, so state a module keeps outlives the file that changed it. When a file ends this
// puts the process-wide switches back as the file found them, empties the merge-action slots a file filled (the hosted job services, packages/broker/src/aws/core-job-services.ts,
// and some tests install the CI fix and branch sync deciders; a fresh module graph has none), and turns the driving-test assumption off again. The switches are noted
// once the file's imports have loaded: a shared helper that sets one when it is first loaded (tests/unit/lessons/lesson-helpers.ts turns the lessons switch on)
// runs only once per worker, so its setting must stay for the files after it.
import { afterAll, beforeAll } from "vitest";
import { uninstallBranchSyncDeciders } from "../../packages/broker/src/core/branch-sync/branch-sync.js";
import { uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { currentAutoApplyGate, currentLearnedLessonsGate, setAutoApplyGate, setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { currentLessonsUsedReader, setLessonsUsedReader } from "../../packages/broker/src/lessons/used-in-pr.js";
import { assumeDrivingTestsPassed } from "./fake-dynamodb.js";

let found: { lessonsGate: () => boolean; autoApplyGate: () => boolean; lessonsUsedReader: ReturnType<typeof currentLessonsUsedReader> } | undefined;

beforeAll(() => {
  found = { lessonsGate: currentLearnedLessonsGate(), autoApplyGate: currentAutoApplyGate(), lessonsUsedReader: currentLessonsUsedReader() };
});

afterAll(() => {
  if (found !== undefined) {
    setLearnedLessonsGate(found.lessonsGate);
    setAutoApplyGate(found.autoApplyGate);
    setLessonsUsedReader(found.lessonsUsedReader);
  }
  uninstallCiFixDecider();
  uninstallBranchSyncDeciders();
  // fake-dynamodb.ts: a file that reads every route digest as having passed its driving test turns it on for itself only.
  assumeDrivingTestsPassed(false);
});
