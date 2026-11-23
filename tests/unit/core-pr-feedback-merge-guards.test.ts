import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { change, when } from "@agentx/contracts";
import { acceptStep, blockTaskWorkflow, commitWorkflow, readWorkspace, runDispatchRow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { startChecksRerun, startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { createBuildSteps } from "../../packages/broker/src/core/build-step/index.js";
import { decidePrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";
import { createHarness } from "../support/task-flow-harness.js";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { blockedReview, report, seed, taskOf, TASK_ID } from "../support/task-actions-world.js";
import { closeRecoveryHarness } from "../support/close-recovery-harness.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities, type CallbackAction } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER } from "../../packages/broker/src/services/callbacks.js";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { startManualPublication } from "../../packages/broker/src/core/task-flow/manual-publication.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";

it.each(["companyId", "closedAt", "closeOperationId"])("a step cannot commit after %s changes during acceptance", async field => {
  const h = createHarness();
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Atomic acceptance" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  await h.store.update({ key: workspaceKey(h.deps.companyId, task.workspaceId), ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const before = await workspaceOperations(h.deps, task.workspaceId);
  const transact = h.store.transact.bind(h.store);
  let raced = false;
  h.store.transact = async items => {
    if (!raced) {
      raced = true;
      await h.store.update({ key: taskKey(task.taskId), ops: [change.set(field, field === "companyId" ? "org_bbbbbbbbbbbbbbbbbbbb" : field === "closedAt" ? new Date(h.clock.now).toISOString() : randomUUID())] });
    }
    return transact(items);
  };
  const relay = vi.spyOn(h.deps.outbox, "relay");
  const accepted = await acceptStep(h.deps, { task, workspace, requestId: randomUUID(), prompt: "Do not race Close" });
  expect(raced).toBe(true);
  expect(accepted).toEqual({ result: "STALE" });
  expect(await workspaceOperations(h.deps, task.workspaceId)).toEqual(before);
  expect(relay).not.toHaveBeenCalled();
  expect((await readWorkspace(h.deps, task.workspaceId))?.activeOperationId).toBeNull();
});

it("a manual feedback start preserves its request identity, owner note and selected paid approval", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  const requestId = randomUUID(), instructions = "Keep the existing retry limit.";
  expect(await startImplementation(w.h.deps, { taskId: approved.taskId, workflowRevision: approved.workflow!.revision }, { requestId, instructions })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, approved.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  expect(operation.requestId).toBe(requestId);
  expect(operation.workflowFeedbackApproval?.selectedFindingIds).toEqual(["finding-1"]);
  expect(operation.dispatch.payload["workflowFeedbackApproval"]).toEqual(operation.workflowFeedbackApproval);
  expect(operation.dispatch.payload["prompt"]).toContain("Add a bounded retry.");
  expect(operation.dispatch.payload["prompt"]).toContain(`Owner note: ${instructions}`);
  expect(operation.dispatch.requires).toContain("task.workflowFeedbackApproval");
  expect(operation.dispatch.extraActions).toContain("feedback-approval");
});

it.each(["BLOCKED", "WAITING"] as const)("manual feedback starts only from READY or BLOCKED, not %s otherwise", async state => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  task.workflow = { ...task.workflow!, state, blockReason: "Retry requested" };
  await w.h.store.put({ item: toDocument(task) });
  expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow.revision }, { requestId: randomUUID(), instructions: "Bound retries" })).toBe(state === "BLOCKED" ? "STARTED" : "STALE");
  if (state === "BLOCKED") expect((await readTask(w.h.deps, task.taskId))!.workflow).not.toHaveProperty("blockReason");
});

it("ordinary coding does not require feedback worker features or callback authority", async () => {
  const w = await seed({ workflow: blockedReview({ stage: "IMPLEMENT", state: "READY" }) });
  const task = await taskOf(w.h);
  expect(await startImplementation(w.h.deps, { taskId: TASK_ID, workflowRevision: task.workflow!.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  expect(operation.dispatch.requires).not.toContain("task.workflowFeedbackApproval");
  expect(operation.dispatch.extraActions).not.toContain("feedback-approval");
  expect(operation.dispatch.payload["prompt"]).toContain("Add the retry flag");
});

it("feedback owner authority remains in the implementation acceptance transaction", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!, key = { pk: "AUTHORITY", sk: "META" };
  await w.h.store.put({ item: { ...key, revision: 1 } });
  w.h.deps.access.ownerActing = async () => ({ actorId: task.ownerKey, items: [{ kind: "check", key, condition: when.eq("revision", 1) }] });
  const transact = w.h.store.transact.bind(w.h.store);
  w.h.store.transact = async items => {
    await w.h.store.update({ key, ops: [change.set("revision", 2)] });
    return transact(items);
  };
  const before = await workspaceOperations(w.h.deps, task.workspaceId);
  expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision })).toBe("STALE");
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toEqual(before);
});

it("the next review receives the selected feedback context", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  task.workflow = { ...task.workflow!, stage: "REVIEW", state: "WAITING" };
  await w.h.store.put({ item: toDocument(task) });
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow.revision, kind: "REVIEW" })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId)).find(op => op.workflowMode === "REVIEW")!;
  expect(JSON.stringify(operation.dispatch.payload["workflowReviewFeedback"])).toContain("Add a bounded retry.");
});

it.each(["close", "block", "plan"] as const)("an accepted close forbids a subsequent %s workflow write", async action => {
  const w = await seed({ workflow: blockedReview({ stage: "PLAN", state: "READY" }) });
  const task = await taskOf(w.h);
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set("closeOperationId", randomUUID())] });
  const before = await readTask(w.h.deps, TASK_ID);
  const transact = vi.spyOn(w.h.store, "transact"), artifacts = vi.spyOn(w.h.deps.artifacts!, "get");
  if (action === "close") expect(await commitWorkflow(w.h.deps, task, { ...task.workflow!, revision: task.workflow!.revision + 1, state: "BLOCKED" })).toBe(false);
  else if (action === "block") { await blockTaskWorkflow(w.h.deps, TASK_ID, task.workflow!.revision, "Do not overwrite close"); expect(transact).not.toHaveBeenCalled(); }
  else { expect(await runDispatchRow(w.h.deps, { taskId: TASK_ID, workflowRevision: task.workflow!.revision, kind: "PLAN" })).toBe("STALE"); expect(artifacts).not.toHaveBeenCalled(); }
  expect(await readTask(w.h.deps, TASK_ID)).toEqual(before);
});

it.each([true, false])("manual checks require a retryable position (eligible=%s)", async eligible => {
  const w = await seed({ workflow: blockedReview({ stage: eligible ? "PULL_REQUEST" : "REVIEW", state: eligible ? "READY" : "BLOCKED", pullRequests: [] }, [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])]) });
  const task = await taskOf(w.h);
  const requestId = randomUUID();
  const result = await startChecksRerun(w.h.deps, { taskId: TASK_ID, workflowRevision: task.workflow!.revision }, { requestId, actorId: task.ownerKey, manual: { requestId, instructions: "Check current code" } });
  expect(result).toBe(eligible ? "STARTED" : "STALE");
});

it.each(["foreign", "missing", "complete", "blocked"] as const)("the merge feedback hook fails closed for %s reports", async kind => {
  const w = await reviewedFeedbackWorld(kind === "blocked" ? "BLOCKED" : "COMPLETE");
  if (kind === "foreign") await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
  if (kind === "missing") await w.h.store.delete({ key: taskKey(w.task.taskId) });
  const task = { ...await w.world.task(), workflow: w.task.workflow!, orgId: w.h.deps.companyId };
  expect(await w.tracking.deps.feedbackRoundCheck!(task)).toBe(kind === "complete");
});

it("a closing run cannot exchange a repository credential", async () => {
  const w = await closeRecoveryHarness();
  w.h.deps.resumeAcceptedClose = async () => {};
  await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
  const exchange = vi.fn(async () => ({ username: "worker", password: "fixture" }));
  const handler = createCallbackHandler({ flow: w.h.deps, blobs: {} as never, grants: { exchange } });
  const response = await handler({ method: "POST", path: `/v1/internal/workspaces/${w.run.workspaceId}/operations/${w.run.id}/repository-credentials`, headers: { "x-agentx-repository-grant": "fixture" }, body: JSON.stringify({ credentialRef: "fixture", repositoryUrl: "https://github.com/acme/app", access: "clone" }) });
  expect(response.statusCode).toBe(403);
  expect(exchange).not.toHaveBeenCalled();
});

it.each(["ci", "conflict"] as const)("an automatic %s fix keeps its own evidence in the coding prompt", async source => {
  const w = await seed({ workflow: blockedReview({ stage: "IMPLEMENT", state: "READY", fixSource: source, fixProblems: ["RED_JOB_OR_FILE"] }, []) });
  const task = await taskOf(w.h);
  expect(await startImplementation(w.h.deps, { taskId: TASK_ID, workflowRevision: task.workflow!.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  expect(operation.dispatch.payload["prompt"]).toContain("RED_JOB_OR_FILE");
  expect(operation.dispatch.payload["prompt"]).not.toContain("Add the retry flag");
});

it.each(["revision", "flow", "notes"] as const)("step acceptance fences a concurrent %s change", async field => {
  const w = await seed(), task = await taskOf(w.h), current = task.workflow!;
  const workspace = (await readWorkspace(w.h.deps, task.workspaceId))!;
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  w.h.store.transact = async items => {
    if (!raced) {
      raced = true;
      await w.h.store.update({ key: taskKey(TASK_ID), ops: [field === "revision" ? change.set(["workflow", "revision"], current.revision + 1) : field === "flow" ? change.set(["workflow", "flow"], { rulesVersion: 2 }) : change.set("threadNoteCount", 1)] });
    }
    return transact(items);
  };
  expect(await acceptStep(w.h.deps, { task, workspace, requestId: randomUUID(), prompt: "Current evidence only", workflowMode: "IMPLEMENT", workflow: { current, next: { ...current, revision: current.revision + 1, state: "RUNNING", ...(field === "flow" ? { flow: { rulesVersion: 1 } } : {}) } }, ...(field === "notes" ? { notes: { suffix: "", fedThrough: "2026-11-10T10:00:01.000Z" } } : {}) })).toEqual({ result: "STALE" });
  expect(raced).toBe(true);
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toEqual([]);
});

it.each(["SUCCEEDED", "CANCEL_REQUESTED", "RUNNING"] as const)("a redelivered %s operation is acknowledged without dispatch", async status => {
  const h = createHarness(); await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "No duplicate work" });
  const operation = (await workspaceOperations(h.deps, started.task.workspaceId)).find(op => op.kind === "prepare")!;
  await h.store.put({ item: toDocument({ ...operation, status }) });
  await h.flow.relayOnce();
  expect(await runDispatchOnce(h.deps)).toMatchObject({ dropped: 1, delivered: 0, failed: 0 });
});

it("the retained run's old delivery is dropped while Close owns it", async () => {
  const w = await closeRecoveryHarness(); w.h.deps.resumeAcceptedClose = async () => {};
  await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
  const queue = await w.h.queues.queue("task-dispatch");
  await queue.enqueue({ body: { v: 1, companyId: w.h.deps.companyId, workspaceId: w.run.workspaceId, operationId: w.run.id } });
  expect(await runDispatchOnce(w.h.deps)).toMatchObject({ dropped: 2, delivered: 0, failed: 0 });
  expect((await readOperation(w.h.deps, w.run.workspaceId, w.run.id))?.status).toBe("RUNNING");
});

it("an artifact callback on a closing run cannot impersonate its usage channel", async () => {
  const w = await closeRecoveryHarness(); w.h.deps.resumeAcceptedClose = async () => {};
  await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
  const bookUsage = vi.fn(async () => {});
  const handler = createCallbackHandler({ flow: w.h.deps, blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } }, bookUsage });
  const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: w.run.workspaceId, operationId: w.run.id, fence: w.run.fence, actions: ["artifacts"], expiresInSeconds: 600 });
  expect((await handler({ method: "POST", path: `/v1/internal/workspaces/${w.run.workspaceId}/operations/${w.run.id}/artifacts`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ events: w.usage }) })).statusCode).toBe(409);
  expect(bookUsage).not.toHaveBeenCalled();
});

it("the admitted CodeBuild callback reaches its publication validator", async () => {
  const w = await seed({ workflow: null });
  const op = await startManualPublication(w.h.deps, w.caller, TASK_ID, { requestId: randomUUID(), title: "Retry", draft: true });
  const handler = createCallbackHandler({ flow: w.h.deps, blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } } });
  const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: op.workspaceId, operationId: op.id, fence: op.fence, actions: op.dispatch.extraActions as CallbackAction[], expiresInSeconds: 600 });
  const response = await handler({ method: "POST", path: `/v1/internal/workspaces/${op.workspaceId}/operations/${op.id}/codebuild`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ unexpected: true }) });
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body)).toMatchObject({ error: { message: "CodeBuild callback contains unknown fields" } });
});

it("the larger feedback-report byte allowance does not apply to unrelated artifacts", async () => {
  const h = createHarness(); await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Bound artifacts" });
  const operation = (await workspaceOperations(h.deps, started.task.workspaceId)).find(op => op.kind === "prepare")!;
  await h.store.put({ item: toDocument({ ...operation, workflowMode: "FEEDBACK_REVIEW" }) });
  const handler = createCallbackHandler({ flow: h.deps, blobs: { put: async () => {}, get: async () => undefined } as never, grants: { exchange: async () => { throw new Error("unused"); } } });
  const token = new CallbackCapabilities(Buffer.from(h.deps.callbackSigningKey)).issue({ workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, actions: ["artifacts"], expiresInSeconds: 600 });
  expect((await handler({ method: "POST", path: `/v1/internal/workspaces/${operation.workspaceId}/operations/${operation.id}/artifacts`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ name: "unrelated.json", mediaType: "application/json", content: "x".repeat(200_001) }) })).statusCode).toBe(400);
});
