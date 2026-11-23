// Exercise hosted job composition: omitting either installer must leave its dispatch absent.
import { afterEach, expect, it, vi } from "vitest";
import { BRANCH_SYNCS_PER_DAY_MAX, CI_FIX_ROUNDS_MAX, agentSessionKey, change, mergeTrackingKey } from "@agentx/contracts";
import { createHostedBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { uninstallBranchSyncDeciders } from "../../packages/broker/src/core/branch-sync/branch-sync.js";
import { readLatestCiEvidence, uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { pullRequestRecordKey } from "../../packages/broker/src/core/build-step/records.js";
import { soleOwnerPeople } from "../../packages/broker/src/core/merge/people.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { dispatchPartition, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { TASK_ID } from "../support/merge-world.js";
import { ORG, SESSION, OWNER_ID, host } from "../support/service-host.js";

import { workflowMessage, workflowMessageKey } from "../../packages/broker/src/developer/workflow-messages.js";
import { inboxPartition } from "../../packages/broker/src/core/notify/inbox-rows.js";
import { createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { readTaskMoney } from "../../packages/broker/src/core/cost/task-money.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";

afterEach(() => { uninstallCiFixDecider(); uninstallBranchSyncDeciders(); vi.restoreAllMocks(); });

async function world(kind: "ci" | "conflict" | "behind" = "ci") {
  const w = await host();
  const pr = w.world.prs[0]!;
  const workspace = workspaceKey(ORG, "ws-1");
  await w.h.store.put({ item: { ...workspace, entityType: "WORKSPACE", id: "ws-1", companyId: ORG, ownerKey: "owner-1" } });
  await w.h.store.put({ item: {
    ...pullRequestRecordKey(workspace, pr.repositoryId, pr.number), entityType: "PULL_REQUEST", workspaceId: "ws-1",
    repository: pr.repositoryId, expectedHeadCommit: pr.head,
  } });
  if (kind === "ci") pr.model.setChecks(pr.head, [{ name: "unit", state: "completed", conclusion: "failure", required: true, url: "", runId: "11" }]);
  else {
    const codeHost = (await w.world.host.repository("web", 1, pr.repositoryId, ORG))!.codeHost;
    const status = codeHost.changeRequestStatus.bind(codeHost);
    vi.spyOn(codeHost, "changeRequestStatus").mockImplementation(async (...args) => ({ ...await status(...args), mergeableState: kind === "behind" ? "behind" : "conflicted" }));
  }
  w.registry.register("metering", "test", { record: async () => ({ cost: null, source: "unknown" as const }), price: async () => null });
  const options = { companyId: ORG, flow: w.h.flow, registry: w.registry, repository: w.world.host.repository, people: soleOwnerPeople,
    ciMode: async () => "their_ci_fix" as const, now: () => new Date(w.clock.ms) };
  const jobs = createHostedBrokerCoreServices(options);
  // A second runtime build in the same warm process must not register a slot twice.
  createHostedBrokerCoreServices(options);
  const pass = async (budgetMs = 1000) => {
    await w.h.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    return jobs["merge-tracking"].pass({ budgetMs });
  };
  const rows = async () => (await w.h.store.query({ pk: dispatchPartition(ORG) })).items;
  const refresh = () => jobs["session-sweep"].pass({ budgetMs: 1000 });
  const summary = () => w.h.store.get(agentSessionKey(ORG, SESSION, "META"));
  const events = async () => (await w.h.store.query({ pk: agentSessionKey(ORG, SESSION, "META").pk, sk: { op: "beginsWith", prefix: "EVENT#" } })).items;
  return { ...w, pr, pass, rows, refresh, summary, events };
}

it("hosted failing CI queues exactly one counted implementation with its evidence", async () => {
  const w = await world();
  expect(await w.pass()).toMatchObject({ attempted: 1, failed: 0 });
  const workflow = (await w.world.task()).workflow;
  expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "ci", fixRounds: { ci: 1, conflict: 0, feedbackAuto: 0 } });
  expect(await w.rows()).toEqual([expect.objectContaining({ companyId: ORG, taskId: TASK_ID, workflowRevision: workflow.revision, kind: "IMPLEMENT" })]);
  expect(await readLatestCiEvidence(w.h.store, TASK_ID, ORG)).toContain("unit");
  await w.pass();
  expect(await w.rows()).toHaveLength(1);
  expect((await w.world.task()).workflow.fixRounds?.ci).toBe(1);
});

it.each(["conflict", "behind"] as const)("hosted %s queues one sync and spends one daily sync", async (kind) => {
  const w = await world(kind);
  expect(await w.pass()).toMatchObject({ attempted: 1, failed: 0 });
  const workflow = (await w.world.task()).workflow;
  expect(workflow.branchSync).toMatchObject({ reason: kind === "behind" ? "behind" : "conflict" });
  expect(await w.rows()).toEqual([expect.objectContaining({ companyId: ORG, taskId: TASK_ID, workflowRevision: workflow.revision, kind: "SYNC" })]);
  expect(await w.h.store.get(mergeTrackingKey(TASK_ID, w.pr.repositoryId, w.pr.number))).toMatchObject({ syncs: { day: "2026-11-09", count: 1 } });
  await w.pass();
  expect(await w.rows()).toHaveLength(1);
});

it.each(["ci", "conflict"] as const)("hosted %s stops at its existing paid fix-round cap without dispatch", async (kind) => {
  const w = await world(kind);
  const fixRounds = { ci: CI_FIX_ROUNDS_MAX, conflict: 2, feedbackAuto: 0 };
  await w.world.setWorkflow({ fixRounds });
  await w.pass();
  expect((await w.world.task()).workflow).toMatchObject({ state: "BLOCKED", fixRounds });
  expect(await w.rows()).toHaveLength(0);
});

it("hosted branch sync leaves the branch alone when today's sync allowance is spent", async () => {
  const w = await world("behind");
  await w.world.seedTracking({ syncs: { day: "2026-11-09", count: BRANCH_SYNCS_PER_DAY_MAX } });
  await w.pass();
  expect((await w.world.task()).workflow.branchSync).toBeUndefined();
  expect(await w.rows()).toHaveLength(0);
});

it("hosted CI fixing leaves another company's task and its workflow untouched", async () => {
  const w = await world();
  const before = (await w.world.task()).workflow;
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
  expect(await w.pass()).toMatchObject({ attempted: 0, failed: 0 });
  expect((await w.world.task()).workflow).toEqual(before);
  expect(await w.rows()).toHaveLength(0);
});

it("hosted CI fixing does not act on a head changed outside Rovara", async () => {
  const w = await world();
  const branch = w.pr.model.getChangeRequest(String(w.pr.number)).sourceBranch;
  const head = w.pr.model.commit(branch, { "src/a.ts": "export const a = 2;\n" });
  w.pr.model.setChecks(head, [{ name: "unit", state: "completed", conclusion: "failure", required: true, url: "", runId: "12" }]);
  await w.pass();
  expect((await w.world.task()).workflow.stage).toBe("WAIT_FOR_MERGE");
  expect(await w.rows()).toHaveLength(0);
});

it("hosted merge actions do no work after the pass budget is exhausted", async () => {
  const w = await world();
  expect(await w.pass(0)).toMatchObject({ complete: false, reason: "budget" });
  expect((await w.world.task()).workflow.stage).toBe("WAIT_FOR_MERGE");
  expect(await w.rows()).toHaveLength(0);
});

// Missing visibility must fail at the hosted composition, not just at the pure decider.
it("serves the CI round and failing check in the hosted summary, timeline and workflow message", async () => {
  const w = await world();
  await w.pass();
  await w.refresh();
  expect(await w.summary()).toMatchObject({ summary: { step: "Fixing failing checks, round 1 of 3: unit" } });
  expect((await w.events()).some(event => typeof event["text"] === "string" && event["text"].includes("Fixing failing checks, round 1 of 3: unit"))).toBe(true);
  const workflow = (await w.world.task()).workflow;
  const ready = workflowMessage({ taskId: TASK_ID, workflow });
  expect(ready?.text).toContain("Fixing failing checks, round 1 of 3: unit");
  expect(workflowMessageKey({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" })).toBe(workflowMessageKey(workflow));
  expect(ready?.blocks.filter(block => block["type"] === "actions")).toEqual([]);
  expect(workflowMessage({ taskId: TASK_ID, workflow: { ...workflow, state: "RUNNING" } })?.text).toContain("round 1 of 3: unit");
});

it.each(["conflict", "behind"] as const)("serves hosted %s branch-sync state and one timeline start", async (kind) => {
  const w = await world(kind);
  await w.pass();
  await w.refresh();
  expect(await w.summary()).toMatchObject({ summary: { step: "Updating the branch with main", display: { state: "building" } } });
  const starts = async () => (await w.events()).filter(event => event["text"] === "Updating the branch with main.");
  expect(await starts()).toHaveLength(1);
  await w.pass();
  expect(await starts()).toHaveLength(1);
});

it.each(["ci", "conflict"] as const)("hosted %s stop emits a person message and uses the existing inbox writer once", async (kind) => {
  const w = await world(kind);
  await w.refresh(); // Prime a summary, as the hosted projector does before CI finishes.
  await w.world.setWorkflow({ fixRounds: { ci: 3, conflict: 2, feedbackAuto: 0 } });
  await w.pass();
  const workflow = (await w.world.task()).workflow;
  expect(workflowMessage({ taskId: TASK_ID, workflow })?.text).toContain(workflow.blockReason);
  await w.refresh();
  const inbox = async () => (await w.h.store.query({ pk: inboxPartition(ORG, OWNER_ID) })).items;
  expect(await inbox()).toEqual([expect.objectContaining({ sessionId: SESSION, kind: "needs_you" })]);
  await w.refresh();
  expect(await inbox()).toHaveLength(1);
});

it.each([true, false])("hosted CI fix comments respect draft=%s and repeated passes", async (draft) => {
  const w = await world();
  w.pr.model.getChangeRequest(String(w.pr.number)).draft = draft;
  await w.pass();
  const comments = () => w.pr.model.getChangeRequest(String(w.pr.number)).comments.filter(comment => comment.author === "rovara-owner");
  expect(comments()).toHaveLength(draft ? 0 : 1);
  if (!draft) expect(comments()[0]?.body).toContain("round 1 of 3");
  await w.pass();
  expect(comments()).toHaveLength(draft ? 0 : 1);
});

it("hosted CI stop posts the existing needs-person PR comment once", async () => {
  const w = await world();
  await w.world.setWorkflow({ fixRounds: { ci: 3, conflict: 0, feedbackAuto: 0 } });
  await w.pass();
  await w.pass();
  const comments = w.pr.model.getChangeRequest(String(w.pr.number)).comments;
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).toContain("has stopped. It needs a person");
});

it("a hosted paid fix receipt adds to task cost and session cost without double booking", async () => {
  const w = await world();
  const ledger = createCostLedger({ store: w.h.store, metering: w.registry.require("metering"), now: () => new Date(w.clock.ms) });
  await ledger.applyChargeReceipt(chargeReceipt({ companyId: ORG, taskId: TASK_ID, operationId: "first-build", callId: "first-build", status: "final", reason: "rated_usage", usageComplete: true, usage: { state: "available", value: { input: 10, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } }, price: { state: "available", value: { authority: "gateway", version: "test-v1", hash: "test-price", fetchedAt: "2026-11-09T10:00:00.000Z" } } }));
  await w.pass();
  const receipt = chargeReceipt({ companyId: ORG, taskId: TASK_ID, operationId: "ci-fix-build", callId: "ci-fix-build", status: "final", reason: "rated_usage", usageComplete: true, usage: { state: "available", value: { input: 10, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } }, price: { state: "available", value: { authority: "gateway", version: "test-v1", hash: "test-price", fetchedAt: "2026-11-09T10:00:00.000Z" } } });
  await ledger.applyChargeReceipt(receipt);
  await ledger.applyChargeReceipt(receipt);
  const task = (await readTask(w.h.deps, TASK_ID))!;
  expect(await readTaskMoney({ store: w.h.store, companyId: ORG, task, hosted: true })).toMatchObject({ spentMicros: { value: 160 }, finalMicros: { value: 160 }, coverage: { finalCalls: 2 } });
  await w.refresh();
  expect(await w.summary()).toMatchObject({ summary: { costUsd: 0.00016 } });
});
