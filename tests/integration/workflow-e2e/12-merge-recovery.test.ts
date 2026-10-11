import { describe, expect, it } from "vitest";
import { createWorkflowE2E } from "../../support/workflow-e2e.js";
import { PLAN, editsOrFix, journeySuite, openDraftPr, said, MERGED } from "../../support/workflow-e2e-journeys.js";

describe("Suite 12: merge recovery without a webhook", () => {
  journeySuite();

  it.each([
    ["configured", undefined, true],
    ["missing", null, false],
  ] as const)("12.R3 completes and releases an owner-approved merge when the webhook secret is %s", async (_label, webhookSecret, wire) => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, ...(wire ? { github: { wire: true } } : {}), ...(webhookSecret === undefined ? {} : { webhookSecret }) });
    const pullRequest = await openDraftPr(e2e);

    e2e.github.merge(pullRequest.number);
    e2e.clock.advance(5 * 60_000);
    const response = await e2e.runMergeRecovery();
    expect(response.statusCode).toBe(200);
    await e2e.settle();

    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    expect(said(e2e).at(-1)).toBe(MERGED);
    expect(e2e.mergeObservationRequests).toEqual(wire ? ["github", "github", "github", "github", "github"] : ["pull-request", "commit-tree", "pull-request"]);
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toMatchObject({ taskId: e2e.taskId() });
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.releasedAt).toBeDefined();
    expect(e2e.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${e2e.taskId()}`)?.retiredAt).toBeDefined();
    e2e.clock.advance(5 * 60_000);
    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(e2e.mergeObservationRequests).toHaveLength(wire ? 5 : 3);
  }, 120_000);

  it("12.R3 refuses a merged PR at a foreign head even when its tree bytes match the checked candidate", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const pullRequest = await openDraftPr(e2e);
    e2e.github.foreignPush(pullRequest.number, { tree: pullRequest.tree });
    e2e.github.merge(pullRequest.number);
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).statusCode).toBe(200);
    await e2e.settle();

    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE" });
    expect(e2e.workflow().stage).not.toBe("MERGED");
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeUndefined();
    expect(e2e.db.commandNames()).not.toContain("ScanCommand");
    expect(e2e.mergeObservationRequests).toEqual(["pull-request", "commit-tree", "pull-request"]);
  }, 120_000);

  it("12.R3 retries an ambiguous release-marker write and never performs compute cleanup in the merge poll", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const pullRequest = await openDraftPr(e2e);
    e2e.github.merge(pullRequest.number);
    e2e.db.injectFault({
      command: "UpdateCommand",
      match: (input) => (input.Key as { pk?: unknown } | undefined)?.pk === "FINISHED_RELEASE",
      error: { name: "InternalServerError" },
    });
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeUndefined();
    expect(e2e.db.find((item) => item.entityType === "WORKSPACE")[0]?.status).toBe("READY");

    e2e.clock.advance(5 * 60_000);
    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toMatchObject({ taskId: e2e.taskId() });
    expect(e2e.mergeObservationRequests).toHaveLength(3);
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.releasedAt).toBeDefined();
  }, 120_000);
});
