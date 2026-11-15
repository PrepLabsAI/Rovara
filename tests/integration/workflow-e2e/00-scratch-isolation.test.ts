// Regression for the flaky "couldn't verify the base rule files" / "stage not WAIT_FOR_MERGE" failures of suite 2 (2.9a, 2.11) under load.
// The worker's verified base-rule read keeps a scratch directory per read and, before it makes one, removes every `agentx-base-rules-*` directory in its scratch root
// that is more than an hour old by `Date.now()`. A test that moves the fake clock past an hour (09-resilience, 08-merge-close, 10-page-auth) therefore judged every
// OTHER vitest worker's live scratch directory stale and removed it from under that worker's git read, which then stopped with the fixed "unverified" reason.
// The scratch root was the run's shared TMPDIR; it is now the workspace's own `.agentx-runtime/tmp` (the worker image's layout), so no run can touch another's.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, PLAN, atPlanReview, journeySuite } from "../../support/workflow-e2e-journeys.js";

describe("base-rule scratch isolation", () => {
  journeySuite();

  it("a clock jump past the stale-scratch age in one task never removes another run's scratch directory in the shared temporary directory", async () => {
    // Stands for a read another worker process has open right now: fresh by the real clock, in the run's shared temporary directory.
    const other = await mkdtemp(join(tmpdir(), "agentx-base-rules-"));
    try {
      const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
      e2e.clock.advance(2 * 3_600_000);
      await atPlanReview(e2e);
      await e2e.click("agentx_workflow_approve");
      await e2e.settle();
      expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
      expect(existsSync(other), "another run's live scratch directory was removed by a read running on a fake clock").toBe(true);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }, 120_000);
});
