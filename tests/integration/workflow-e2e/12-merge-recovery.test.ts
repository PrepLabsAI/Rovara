import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { mergeRecoveryItem } from "../../../packages/broker/src/aws/workflow-merge-recovery.js";
import { githubWorkflowPullRequestKey } from "../../../packages/broker/src/developer/task-records.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { PLAN, editsOrFix, journeySuite, openDraftPr, said, MERGED } from "../../support/workflow-e2e-journeys.js";

const recovery = (e2e: WorkflowE2E, taskId = e2e.taskId()) => e2e.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${taskId}`);
const task = (e2e: WorkflowE2E, taskId = e2e.taskId()) => e2e.db.get(`DEVTASK#${taskId}`, "META")!;
const workspace = (e2e: WorkflowE2E) => e2e.db.find((item) => item.entityType === "WORKSPACE")[0]!;

function addRequiredPullRequest(e2e: WorkflowE2E, number = 2): void {
  const first = e2e.github.pullRequests[0]!;
  const current = task(e2e);
  const workflow = current.workflow as { pullRequests: Array<{ repositoryId: string; candidateDigest: string; number: number; url: string }> };
  const firstLink = workflow.pullRequests[0]!;
  const url = `https://github.com/example/demo/pull/${number}`;
  e2e.github.pullRequests.push({ ...first, number, url, state: "open", comments: [], threads: [] });
  const link = { ...firstLink, number, url };
  e2e.db.set({ ...current, workflow: { ...workflow, pullRequests: [...workflow.pullRequests, link] } });
  e2e.db.set({ ...githubWorkflowPullRequestKey("example/demo", number), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo",
    repositoryId: link.repositoryId, number, url, taskId: current.taskId, workspaceId: current.workspaceId, candidateDigest: link.candidateDigest, createdAt: new Date().toISOString() });
}

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

  it("12.R3 maps a real provider 429 to global cooldown before another due task can make an HTTP request", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, github: { wire: true }, mergeObservation: {
      httpFault: (attempt) => attempt === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "600" } })
        : new Response("temporary", { status: 500 }),
    } });
    const pullRequest = await openDraftPr(e2e);
    e2e.github.merge(pullRequest.number);
    const original = task(e2e);
    const originalTaskId = String(original.taskId);
    const originalWorkspaceId = String(original.workspaceId);
    const secondId = randomUUID();
    const secondNumber = 2;
    const secondUrl = `https://github.com/example/demo/pull/${secondNumber}`;
    const firstLink = (original.workflow as { pullRequests: Array<Record<string, unknown>> }).pullRequests[0]!;
    e2e.github.pullRequests.push({ ...pullRequest, number: secondNumber, url: secondUrl, state: "open", comments: [], threads: [] });
    e2e.db.set({ ...original, pk: `DEVTASK#${secondId}`, taskId: secondId, workspaceId: `${originalWorkspaceId}-second`,
      workflow: { ...(original.workflow as Record<string, unknown>), taskId: secondId, pullRequests: [{ ...firstLink, number: secondNumber, url: secondUrl }] } });
    e2e.db.set({ ...githubWorkflowPullRequestKey("example/demo", secondNumber), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo",
      repositoryId: firstLink.repositoryId, number: secondNumber, url: secondUrl, taskId: secondId, workspaceId: `${originalWorkspaceId}-second`,
      candidateDigest: firstLink.candidateDigest, createdAt: new Date().toISOString() });
    await e2e.db.send(new TransactWriteCommand({ TransactItems: [mergeRecoveryItem("state", secondId, new Date(e2e.clock.now() + 1).toISOString())] }));
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(e2e.mergeObservationRequests).toHaveLength(1);
    const cooldown = e2e.db.get("WORKFLOW_MERGE_SWEEP", "META")?.nextSweepAt as number;
    expect(cooldown).toBeGreaterThanOrEqual(e2e.clock.now() + 5 * 60_000);
    expect(recovery(e2e, originalTaskId)?.retiredAt).toBeUndefined();
    expect(recovery(e2e, secondId)?.retiredAt).toBeUndefined();
    e2e.clock.advance(cooldown - e2e.clock.now() - 1);
    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 0 });
    expect(e2e.mergeObservationRequests).toHaveLength(1);
    e2e.clock.advance(2);
    expect((await e2e.runMergeRecovery()).body.attempted).toBeGreaterThan(0);
    expect(e2e.mergeObservationRequests.length).toBeGreaterThan(1);
    e2e.db.delete(`DEVTASK#${secondId}`, "META");
    e2e.db.delete("WORKFLOW_MERGE_RECOVERY", `TASK#${secondId}`);
    const secondKey = githubWorkflowPullRequestKey("example/demo", secondNumber);
    e2e.db.delete(secondKey.pk, secondKey.sk);
    e2e.github.pullRequests.splice(e2e.github.pullRequests.findIndex((entry) => entry.number === secondNumber), 1);
  }, 120_000);

  it("12.R3 lets an owner close win the workflow save CAS after the authoritative merge read", async () => {
    const scenario: { current?: WorkflowE2E } = {};
    let raced = false;
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, mergeObservation: { afterRead: async () => {
      if (raced) return;
      raced = true;
      const active = scenario.current!;
      await active.click("agentx_workflow_close");
      await active.submitView({});
      await active.settle();
    } } });
    scenario.current = e2e;
    const pullRequest = await openDraftPr(e2e);
    e2e.github.merge(pullRequest.number);
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).statusCode).toBe(200);
    await e2e.settle();
    expect(raced).toBe(true);
    expect(task(e2e).closedAt).toBeDefined();
    expect(e2e.workflow().stage).not.toBe("MERGED");
    expect(workspace(e2e).status).toBe("CLOSED");
    expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(1);
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeUndefined();
    expect(recovery(e2e)?.retiredAt).toBeDefined();
  }, 120_000);

  it("12.R3 releases against the original charge and audit identity after creator revocation and channel withdrawal", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const pullRequest = await openDraftPr(e2e);
    const original = task(e2e);
    const developerId = String(original.developerId);
    const charge = original.charge as { member: { pk: string; sk: string }; organization: { pk: string; sk: string } };
    const developer = e2e.db.get(`DEVELOPER#${developerId}`, "META")!;
    e2e.db.set({ ...developer, revoked: true });
    for (const binding of e2e.db.find((item) => String(item.pk).startsWith("SLACK_BINDING#"))) e2e.db.delete(String(binding.pk), String(binding.sk));
    e2e.github.merge(pullRequest.number);
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).statusCode).toBe(200);
    expect(e2e.deleteEc2Session).not.toHaveBeenCalled();
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.db.get(charge.member.pk, charge.member.sk)).toMatchObject({ count: 0 });
    expect(e2e.db.get(charge.organization.pk, charge.organization.sk)).toMatchObject({ count: 0 });
    expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(1);
    const audits = e2e.db.find((item) => item.taskId === original.taskId && item.action === "close" && item.phase === "completed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ developer: { developerId: original.developerId, provider: original.provider, slackUserId: original.slackUserId },
      workspaceId: original.workspaceId, responseText: "The task is complete (its pull request merged), and its workspace is released." });
  }, 120_000);

  it("12.R3 keeps the release marker after an ambiguous read and two cleanup failures, then releases exactly once", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const pullRequest = await openDraftPr(e2e);
    e2e.github.merge(pullRequest.number);
    e2e.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: unknown } | undefined)?.pk === "FINISHED_RELEASE",
      error: { name: "InternalServerError" } });
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toMatchObject({ taskId: e2e.taskId() });
    expect(e2e.deleteEc2Session).not.toHaveBeenCalled();
    e2e.clock.advance(5 * 60_000);
    expect((await e2e.runMergeRecovery()).body).toMatchObject({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(e2e.deleteEc2Session).not.toHaveBeenCalled();

    e2e.deleteEc2Session.mockRejectedValueOnce(agentXError("WORKSPACE_BUSY", "busy"));
    e2e.deleteEc2Session.mockRejectedValueOnce(new Error("transient deletion failure"));
    await e2e.runRecovery();
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeDefined();
    e2e.clock.advance(5 * 60_000);
    await e2e.runRecovery();
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeDefined();
    e2e.clock.advance(10 * 60_000);
    await e2e.runRecovery();
    await e2e.settle();
    expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(3);
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeUndefined();
    expect(task(e2e).releasedAt).toBeDefined();
    const completedAudits = () => e2e.db.find((item) => item.taskId === e2e.taskId() && item.action === "close" && item.phase === "completed");
    expect(completedAudits()).toHaveLength(1);

    const lateDeliveryId = "63333333-2222-4333-8444-555555555555";
    const lateMerge = { kind: "pull_request", action: "closed", number: pullRequest.number, merged: true } as const;
    expect((await e2e.webhook(lateMerge, { deliveryId: lateDeliveryId })).status).toBe(200);
    expect((await e2e.webhook(lateMerge, { deliveryId: lateDeliveryId })).body).toMatchObject({ delivery: "DUPLICATE" });
    await e2e.settle();
    expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(3);
    expect(completedAudits()).toHaveLength(1);
  }, 120_000);

  it("12.R3 requires both authoritative required PRs before the broker queues cleanup", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const first = await openDraftPr(e2e);
    addRequiredPullRequest(e2e);
    e2e.github.merge(first.number);
    e2e.clock.advance(5 * 60_000);

    expect((await e2e.runMergeRecovery()).statusCode).toBe(200);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", pullRequests: [expect.objectContaining({ state: "MERGED" }), expect.objectContaining({ state: "OPEN" })] });
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeUndefined();
    e2e.github.merge(2);
    e2e.clock.advance(5 * 60_000);
    expect((await e2e.runMergeRecovery()).statusCode).toBe(200);
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(e2e.db.get("FINISHED_RELEASE", `TASK#${e2e.taskId()}`)).toBeDefined();
    await e2e.runRecovery();
    await e2e.settle();
    expect(task(e2e).releasedAt).toBeDefined();
    const secondKey = githubWorkflowPullRequestKey("example/demo", 2);
    e2e.db.delete(secondKey.pk, secondKey.sk);
    e2e.github.pullRequests.splice(e2e.github.pullRequests.findIndex((entry) => entry.number === 2), 1);
    const completed = task(e2e);
    const workflow = completed.workflow as { pullRequests: Array<{ number: number }> };
    e2e.db.set({ ...completed, workflow: { ...workflow, pullRequests: workflow.pullRequests.filter((entry) => entry.number !== 2) } });
  }, 120_000);
});
