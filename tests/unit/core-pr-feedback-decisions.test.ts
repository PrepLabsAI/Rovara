import { expect, it, vi } from "vitest";
import { when, WORKFLOW_KEEP_PULL_REQUESTS_NOTE, type MergeTrackingItem } from "@agentx/contracts";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { decidePrFeedback, retryPrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";

it("a revision changed during host reads refuses before attempting a workflow transaction", async () => {
  const { change } = await import("@agentx/contracts");
  const w = await reviewedFeedbackWorld();
  w.read.mockImplementationOnce(async () => {
    await w.h.store.update({ key: w.task, ops: [change.set(["workflow", "revision"], w.task.workflow!.revision + 1)] });
    return w.feedback;
  });
  const transact = vi.spyOn(w.h.store, "transact");
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(transact).not.toHaveBeenCalled();
});

it.each(["operation-status", "operation-fence", "workspace-holder", "workspace-fence", "task-company"])("running Keep cannot overwrite a raced %s", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const { workspaceOperations } = await import("../../packages/broker/src/core/task-flow/reads.js");
  const { change } = await import("@agentx/contracts");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  const workspace = { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" };
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (!raced && items.some(item => item.kind === "update" && item.key.pk === task.pk)) {
      raced = true;
      if (kind === "operation-status") await w.h.store.update({ key: operation, ops: [change.set("status", "SUCCEEDED")] });
      if (kind === "operation-fence") await w.h.store.update({ key: operation, ops: [change.set("fence", operation.fence + 2)] });
      if (kind === "workspace-holder") await w.h.store.update({ key: workspace, ops: [change.set("activeOperationId", "33333333-3333-4333-8333-333333333333")] });
      if (kind === "workspace-fence") await w.h.store.update({ key: workspace, ops: [change.set("fence", operation.fence + 2)] });
      if (kind === "task-company") await w.h.store.update({ key: task, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
    }
    return transact(items);
  });
  await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision })).rejects.toMatchObject({ code: kind === "operation-fence" ? "STALE_FENCE" : "IDEMPOTENCY_CONFLICT" });
  expect((await w.h.store.get(task))?.["workflow"]).not.toMatchObject({ feedbackReview: { status: "DISMISSED" } });
  if (kind === "operation-status") expect((await w.h.store.get(operation))?.["status"]).toBe("SUCCEEDED");
});

it.each(["decision", "queued-keep", "checked-keep"])("a raced request receipt cannot be overwritten by %s", async kind => {
  const { blockWorkflow, WORKFLOW_BLOCK_REASONS } = await import("@agentx/contracts");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await reviewedFeedbackWorld();
  let task = w.task;
  if (kind === "checked-keep") {
    await decidePrFeedback(w.h.deps, w.h.owner, task.taskId, w.request);
    task = (await readTask(w.h.deps, task.taskId))!;
    task.workflow = blockWorkflow(task.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
  }
  if (kind === "queued-keep") task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
  await w.h.store.put({ item: toDocument(task) });
  const requestId = kind === "decision" ? w.request.requestId : "88888888-8888-4888-8888-888888888888";
  const key = { pk: task.pk, sk: `REQUEST#${requestId}` };
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    const receipt = items.find(item => item.kind === "put" && item.item.pk === key.pk && item.item.sk === key.sk);
    if (!raced && receipt?.kind === "put") {
      raced = true;
      await w.h.store.put({ item: { ...receipt.item, payloadHash: "another-request" } });
    }
    return transact(items);
  });
  const action = kind === "decision" ? decidePrFeedback(w.h.deps, w.h.owner, task.taskId, w.request)
    : keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId, expectedRevision: task.workflow!.revision });
  await expect(action).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await w.h.store.get(key))?.["payloadHash"]).toBe("another-request");
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(task.workflow);
});

it.each(["company", "closed"])("a task %s change at the Keep claim cannot leave a receipt", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const { change } = await import("@agentx/contracts");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const requestId = "88888888-8888-4888-8888-888888888888";
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (!raced && items.some(item => item.kind === "put" && item.item.sk === `REQUEST#${requestId}`)) {
      raced = true;
      await w.h.store.update({ key: task, ops: [kind === "company" ? change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb") : change.set("closedAt", new Date(w.clock.ms).toISOString())] });
    }
    return transact(items);
  });
  await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId, expectedRevision: task.workflow!.revision })).rejects.toBeDefined();
  expect(await w.h.store.get({ pk: task.pk, sk: `REQUEST#${requestId}` })).toBeUndefined();
});

it.each(["decision", "retry"])("a company change at the %s transaction cannot mutate the task", async kind => {
  const { change } = await import("@agentx/contracts");
  const w = await reviewedFeedbackWorld(kind === "retry" ? "BLOCKED" : "COMPLETE");
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (!raced && items.some(item => item.kind === "update" && item.key.pk === w.task.pk)) {
      raced = true;
      await w.h.store.update({ key: w.task, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
    }
    return transact(items);
  });
  const action = kind === "retry" ? retryPrFeedback(w.h.deps, w.h.owner, w.task.taskId, { reviewDigest: w.request.reviewDigest })
    : decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  await expect(action).rejects.toBeDefined();
  expect((await w.h.store.get(w.task))?.["workflow"]).toEqual(w.task.workflow);
});

it("the owner approves only selected findings and queues one paid fix on the same task", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const next = (await readTask(w.h.deps, w.task.taskId))!;
  expect(next.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "feedback", feedbackReview: { status: "APPROVED" } });
  expect(next.charge).toEqual(w.task.charge);
  expect(next.workflow!.feedbackDecisions).toHaveLength(1);
  expect(await w.h.store.get(dispatchRowKey(w.h.deps.companyId, w.task.taskId, next.workflow!.revision))).toMatchObject({ kind: "IMPLEMENT" });
  const transact = vi.spyOn(w.h.store, "transact");
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  expect(transact).not.toHaveBeenCalled();
});

it("failed review Keep succeeds with a missing report blob and records DISMISS without paid work", async () => {
  const w = await reviewedFeedbackWorld("BLOCKED");
  w.objects.delete(w.task.workflow!.feedbackReview!.reviewRef!.objectKey);
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  const body = { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE };
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, body);
  const next = (await readTask(w.h.deps, w.task.taskId))!;
  expect(next.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: w.task.workflow!.revision + 1,
    feedbackReview: { status: "DISMISSED", reviewRef: w.task.workflow!.feedbackReview!.reviewRef }, feedbackDecisions: [{ decision: "DISMISS", requestId: body.requestId }] });
  expect(admit).not.toHaveBeenCalled();
});

it("an explicitly authorized co-owner is recorded as the real actor", async () => {
  const w = await reviewedFeedbackWorld();
  const actorId = "c".repeat(64);
  w.h.deps.access.ownerActing = async () => ({ actorId, authority: { actorId, ownerIds: [actorId] } });
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackDecisions![0]!.actorId).toBe(actorId);
});

it("a retired stamp cannot authorize a core feedback decision", async () => {
  const w = await reviewedFeedbackWorld();
  const { engineStampKey } = await import("../../packages/broker/src/core-host/engine-stamp.js");
  await w.h.store.delete({ key: engineStampKey(w.task.taskId) });
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(w.task.workflow);
});

it.each(["body", "actor"])("an existing decision request refuses a conflicting %s", async kind => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  if (kind === "body") w.request.ownerNote = "Different instructions";
  if (kind === "actor") {
    const actorId = "c".repeat(64);
    w.h.deps.access.ownerActing = async () => ({ actorId, authority: { actorId, ownerIds: [actorId] } });
  }
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it.each(["closed", "missing-workflow"])("a %s task refuses decisions before host reads or admission", async kind => {
  const { change } = await import("@agentx/contracts");
  const w = await reviewedFeedbackWorld();
  await w.h.store.update({ key: w.task, ops: [kind === "closed" ? change.set("closedAt", new Date(w.clock.ms).toISOString()) : change.remove("workflow")] });
  w.read.mockClear();
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  expect(w.read).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});

it("a lost pinned project gives an actionable refusal before paying for the selected fix", async () => {
  const w = await reviewedFeedbackWorld();
  const project = await w.h.deps.projects.revision(w.task.project, w.task.startingRevision);
  vi.spyOn(w.h.deps.projects, "revision").mockResolvedValueOnce(project).mockResolvedValue(undefined);
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  expect(admit).not.toHaveBeenCalled();
});

it("an actor mapping changed during reads cannot commit the earlier actor's decision", async () => {
  const w = await reviewedFeedbackWorld();
  let calls = 0;
  w.h.deps.access.ownerActing = async () => {
    const actorId = calls++ === 0 ? w.task.ownerKey : "c".repeat(64);
    return { actorId, authority: { actorId, ownerIds: [actorId] } };
  };
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(w.task.workflow);
});

it.each(["non-owner-admin", "script-token", "foreign-company", "stale-revision", "stale-report", "stale-proposal", "partial-bundles", "duplicate-findings", "changed-head", "changed-comment", "unknown-budget", "refused-admission", "revoked-at-commit"])("refuses %s with no workflow or paid writes", async kind => {
  const w = await reviewedFeedbackWorld();
  const before = w.task.workflow;
  let caller = w.h.owner;
  if (kind === "non-owner-admin") w.h.deps.access.ownerActing = async () => undefined;
  if (kind === "script-token") caller = { ...caller, scriptToken: { tokenId: "test", name: "script", permissions: [], projects: ["web"] } };
  if (kind === "foreign-company") caller = { ...caller, principal: { ...caller.principal, companyId: "org_bbbbbbbbbbbbbbbbbbbb" } };
  if (kind === "stale-revision") w.request.expectedRevision--;
  if (kind === "stale-report") w.request.reviewDigest = "0".repeat(64);
  if (kind === "stale-proposal") w.request.proposalDigest = "0".repeat(64);
  if (kind === "partial-bundles") w.request.bundleDigests = [];
  if (kind === "duplicate-findings") w.request.selectedFindingIds.push("finding-1");
  if (kind === "changed-head") w.feedback.changeRequest.headRevision = "f".repeat(40);
  if (kind === "changed-comment") w.feedback.comments[0]!.body = "This comment was edited after the owner read it.";
  if (kind === "unknown-budget") { w.h.deps.taskCapUsd = async () => 10; w.h.deps.taskSpendUsd = async () => undefined; }
  if (kind === "refused-admission") w.h.deps.admission.admit = async () => ({ allowed: false, code: "budget_exceeded", message: "No budget" });
  if (kind === "revoked-at-commit") w.h.deps.access.ownerActing = async () => ({ actorId: w.task.workflow!.ownerId,
    items: [{ kind: "check", key: { pk: "ACCESS", sk: "revoked" }, condition: when.present() }] });
  await expect(decidePrFeedback(w.h.deps, caller, w.task.taskId, w.request)).rejects.toBeDefined();
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(before);
});

it("retry of a failed report returns started once and its digest replay cannot enqueue twice", async () => {
  const w = await reviewedFeedbackWorld("BLOCKED");
  const body = { reviewDigest: w.request.reviewDigest };
  expect(await retryPrFeedback(w.h.deps, w.h.owner, w.task.taskId, body)).toMatchObject({ started: true });
  expect(await retryPrFeedback(w.h.deps, w.h.owner, w.task.taskId, body)).toMatchObject({ started: false });
});

it("concurrent retries return one started result and one non-starting result", async () => {
  const w = await reviewedFeedbackWorld("BLOCKED");
  const original = w.h.deps.admission.admit.bind(w.h.deps.admission);
  let count = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  w.h.deps.admission.admit = async input => {
    const admitted = await original(input);
    if (input.action === "task.round") { count++; if (count === 2) release(); await barrier; }
    return admitted;
  };
  const body = { reviewDigest: w.request.reviewDigest };
  const results = await Promise.all([retryPrFeedback(w.h.deps, w.h.owner, w.task.taskId, body), retryPrFeedback(w.h.deps, w.h.owner, w.task.taskId, body)]);
  expect(results.map(r => r.started).sort()).toEqual([false, true]);
});

it.each(["retry", "request-changes"])("unknown spend cannot enqueue a %s critic", async kind => {
  const w = await reviewedFeedbackWorld(kind === "retry" ? "BLOCKED" : "COMPLETE");
  w.h.deps.taskCapUsd = async () => 10;
  w.h.deps.taskSpendUsd = async () => undefined;
  const action = kind === "retry" ? retryPrFeedback(w.h.deps, w.h.owner, w.task.taskId, { reviewDigest: w.request.reviewDigest })
    : decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, { ...w.request, decision: "REQUEST_CHANGES", selectedFindingIds: [], ownerNote: "Check the failure path." });
  await expect(action).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(w.task.workflow);
});

it.each(["queued", "running"])("Keep ends a %s collector with retained evidence and no paid fix", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "running") {
    await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
    task = (await readTask(w.h.deps, w.task.taskId))!;
  }
  const request = { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision };
  await keepPrFeedback(w.h.deps, w.h.owner, task.taskId, request);
  const kept = (await readTask(w.h.deps, task.taskId))!;
  expect(kept.workflow).toMatchObject({ revision: task.workflow!.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING",
    feedbackReview: { status: "DISMISSED", bundleRefs: task.workflow!.feedbackReview!.bundleRefs }, feedbackDecisions: [{ decision: "DISMISS", requestId: request.requestId }] });
  await keepPrFeedback(w.h.deps, w.h.owner, task.taskId, request);
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.revision).toBe(kept.workflow!.revision);
  await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { ...request, expectedRevision: kept.workflow!.revision })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it.each(["stale-revision", "missing-workspace", "revoked-claim", "revoked-running-claim", "unconfirmed-stop", "changed-worker", "changed-actor", "closed"])("collecting Keep refuses %s without dismissing evidence", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const { change } = await import("@agentx/contracts");
  const { workspaceOperations } = await import("../../packages/broker/src/core/task-flow/reads.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "unconfirmed-stop" || kind === "changed-worker" || kind === "revoked-running-claim") {
    await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
    task = (await readTask(w.h.deps, task.taskId))!;
    const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
    if (kind === "changed-worker") await w.h.store.update({ key: operation, ops: [change.set("workflowMode", "IMPLEMENT")] });
    else if (kind === "unconfirmed-stop") {
      await w.h.store.update({ key: operation, ops: [change.set("machineId", "still-stopping")] });
      vi.spyOn(w.h.machines, "stop").mockResolvedValue();
      vi.spyOn(w.h.machines, "health").mockResolvedValue({ state: "stopping", activeOperations: 1, features: [], checkedAt: new Date(w.clock.ms).toISOString() });
    }
  }
  if (kind === "missing-workspace") await w.h.store.delete({ key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" } });
  if (kind === "revoked-claim" || kind === "revoked-running-claim") w.h.deps.access.ownerActing = async () => ({ actorId: task.ownerKey, items: [{ kind: "check", key: { pk: "ACCESS", sk: "revoked" }, condition: when.present() }] });
  if (kind === "changed-actor") {
    let calls = 0;
    w.h.deps.access.ownerActing = async () => {
      const actorId = calls++ === 0 ? task.ownerKey : "c".repeat(64);
      return { actorId, authority: { actorId, ownerIds: [actorId] } };
    };
  }
  if (kind === "closed") await w.h.store.update({ key: task, ops: [change.set("closedAt", new Date(w.clock.ms).toISOString())] });
  const stop = vi.spyOn(w.h.machines, "stop");
  w.put.mockClear();
  const request = { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision - (kind === "stale-revision" ? 1 : 0) };
  const code = kind === "missing-workspace" ? "WORKSPACE_NOT_READY" : kind === "unconfirmed-stop" || kind === "changed-worker" ? "WORKSPACE_BUSY" : "IDEMPOTENCY_CONFLICT";
  await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, request)).rejects.toMatchObject({ code });
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(task.workflow);
  if (kind === "revoked-running-claim") expect(stop).not.toHaveBeenCalled();
  if (kind === "closed") expect(w.put).not.toHaveBeenCalled();
});

it.each(["queued", "running"])("a failed %s Keep commit leaves no unsafe operation hold", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const { workspaceOperations } = await import("../../packages/broker/src/core/task-flow/reads.js");
  const { readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "running") await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const transact = w.h.store.transact.bind(w.h.store);
  let refuse = true;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (refuse && items.some(item => item.kind === "update" && item.key.pk === task.pk)) { refuse = false; return { applied: false, reason: "condition_failed", failed: [] }; }
    return transact(items);
  });
  await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  if (kind === "running") expect((await workspaceOperations(w.h.deps, task.workspaceId))[0]!.status).toBe("INTERRUPTED");
  else expect(await workspaceOperations(w.h.deps, task.workspaceId)).toHaveLength(0);
  expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBeNull();
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: kind === "running" ? "PENDING" : "COLLECTING" } });
});

it.each(["changed-comment", "active-worker", "unchecked", "closed"])("no-change Keep refuses %s before dismissal", async kind => {
  const { blockWorkflow, WORKFLOW_BLOCK_REASONS, change } = await import("@agentx/contracts");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  const blocked = blockWorkflow(approved.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
  if (kind === "unchecked") delete blocked.verification;
  await w.h.store.update({ key: approved, ops: [change.set("workflow", toDocument(blocked))] });
  if (kind === "changed-comment") w.feedback.comments[0]!.body = "New information after approval";
  if (kind === "active-worker") await w.h.store.update({ key: { pk: `WORKSPACE#${w.task.workspaceId}`, sk: "META" }, ops: [change.set("activeOperationId", "33333333-3333-4333-8333-333333333333")] });
  if (kind === "closed") await w.h.store.update({ key: w.task, ops: [change.set("closedAt", new Date(w.clock.ms).toISOString())] });
  w.read.mockClear();
  const result = keepPrFeedback(w.h.deps, w.h.owner, w.task.taskId, { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: blocked.revision });
  if (kind === "unchecked") await expect(result).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  else await expect(result).rejects.toBeDefined();
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(blocked);
  if (kind === "closed") expect(w.read).not.toHaveBeenCalled();
});

it("CI folding ignores an already approved card", async () => {
  const { feedbackDecider } = await import("../../packages/broker/src/core/pr-feedback/merge-action.js");
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await expect(feedbackDecider({ item: { failingChecks: ["unit"] } as MergeTrackingItem, workflow: task.workflow!, autonomy: "run", now: w.clock.ms })).resolves.toBeUndefined();
});

it.each(["worker-selection-bound", "worker-prompt-bound", "unsafe-check", "owner-question", "long-note", "unsafe-path", "missing-bundle", "unknown-cap"])("%s refuses approval before workflow, dispatch or money writes", async kind => {
  const { rewriteFeedbackReport } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld();
  if (kind === "worker-selection-bound") {
    await rewriteFeedbackReport(w, report => { report.findings = Array.from({ length: 101 }, (_, i) => ({ ...report.findings[0]!, id: `finding-${i}` })); });
    w.request.selectedFindingIds = w.report.findings.map(f => f.id);
  }
  if (kind === "worker-prompt-bound") await rewriteFeedbackReport(w, report => {
    report.findings[0]!.evidence = Array.from({ length: 50 }, () => ({ source: "candidate", reference: "x".repeat(2000) }));
  });
  if (kind === "unsafe-check") {
    w.task.workflow!.checkPolicy = { required: [{ id: "required-1", label: "Unit tests", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] };
    await rewriteFeedbackReport(w, report => { report.findings[0]!.fixProposal!.obsoleteChecks = ["required-1"]; });
  }
  if (kind === "owner-question") await rewriteFeedbackReport(w, report => { report.findings[0]!.proposedDisposition = "OWNER_DECISION"; });
  if (kind === "long-note") w.request.ownerNote = "x".repeat(501);
  if (kind === "unsafe-path") await rewriteFeedbackReport(w, report => { report.findings[0]!.fixProposal!.fileChanges[0]!.path = "../outside.ts"; });
  if (kind === "missing-bundle") w.objects.delete(w.task.workflow!.feedbackReview!.bundleRefs[0]!.objectKey);
  if (kind === "unknown-cap") w.h.deps.taskCapUsd = async () => undefined;
  const before = (await readTask(w.h.deps, w.task.taskId))!;
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toBeDefined();
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(before.workflow);
  expect(admit).not.toHaveBeenCalled();
});

it("Request changes retains the owner's note and queues exactly one replacement critic", async () => {
  const w = await reviewedFeedbackWorld();
  w.h.clock.advance(1);
  const body = { ...w.request, decision: "REQUEST_CHANGES", selectedFindingIds: [], ownerNote: "Check the cancellation path too." };
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, body);
  const next = (await readTask(w.h.deps, w.task.taskId))!;
  expect(next.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "COLLECTING" }, feedbackNotes: [{ text: body.ownerNote }] });
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: w.task.taskId, workflowRevision: next.workflow!.revision, kind: "REVIEW" })).toBe("STARTED");
  const { feedbackRequirements } = await import("../../packages/broker/src/core/pr-feedback/inputs.js");
  expect(await feedbackRequirements(w.h.deps, (await readTask(w.h.deps, w.task.taskId))!)).toContain(body.ownerNote);
});

it("CI changes revise the pending owner card without autonomous selection, even at autonomy run", async () => {
  const { feedbackDecider } = await import("../../packages/broker/src/core/pr-feedback/merge-action.js");
  const w = await reviewedFeedbackWorld();
  const item = { failingChecks: ["unit"] } as MergeTrackingItem;
  expect(await feedbackDecider({ item: { ...item, failingChecks: [] }, workflow: w.task.workflow!, autonomy: "run", now: w.clock.ms })).toBeUndefined();
  const action = await feedbackDecider({ item, workflow: w.task.workflow!, autonomy: "run", now: w.clock.ms });
  expect(action?.workflow).toMatchObject({ revision: w.task.workflow!.revision + 1, feedbackReview: { status: "PENDING" }, feedbackCiFailures: { checks: ["unit"] } });
  expect(action?.dispatch).toBeUndefined();
  expect(action?.workflow.feedbackDecisions).toBeUndefined();
  expect(await feedbackDecider({ item, workflow: action!.workflow, autonomy: "run", now: w.clock.ms })).toBeUndefined();
  const cleared = await feedbackDecider({ item: { ...item, failingChecks: [] }, workflow: action!.workflow, autonomy: "run", now: w.clock.ms });
  expect(cleared?.workflow.feedbackCiFailures).toBeUndefined();
});

it("CI folding leaves a failed advisory card untouched", async () => {
  const { feedbackDecider } = await import("../../packages/broker/src/core/pr-feedback/merge-action.js");
  const w = await reviewedFeedbackWorld("BLOCKED");
  await expect(feedbackDecider({ item: { failingChecks: ["unit"] } as MergeTrackingItem, workflow: w.task.workflow!, autonomy: "run", now: w.clock.ms })).resolves.toBeUndefined();
});


it.each(["retry", "queued-keep", "checked-keep", "fix-start"])("%s carries live access into the final commit, including revocation after the owner read", async kind => {
  const { blockWorkflow, WORKFLOW_BLOCK_REASONS } = await import("@agentx/contracts");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const { startImplementation } = await import("../../packages/broker/src/core/build-step/start.js");
  const { workspaceOperations } = await import("../../packages/broker/src/core/task-flow/reads.js");
  for (const revoked of [false, true]) {
    const w = await reviewedFeedbackWorld(kind === "retry" ? "BLOCKED" : "COMPLETE");
    let task = w.task;
    if (kind === "fix-start" || kind === "checked-keep") {
      await decidePrFeedback(w.h.deps, w.h.owner, task.taskId, w.request);
      task = (await readTask(w.h.deps, task.taskId))!;
    }
    if (kind === "checked-keep") task.workflow = blockWorkflow(task.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
    if (kind === "queued-keep") task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
    await w.h.store.put({ item: toDocument(task) });
    const access = { pk: "ACCESS", sk: "feedback-fix1" };
    await w.h.store.put({ item: { ...access, allowed: true } });
    let ownerReads = 0;
    w.h.deps.access.ownerActing = async () => {
      ownerReads++;
      return { actorId: task.ownerKey, items: [{ kind: "check", key: access, condition: when.eq("allowed", true) }] };
    };
    const transact = w.h.store.transact.bind(w.h.store);
    let finalAttempt = false;
    vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
      if (items.some(item => item.kind === "update" && item.key.pk === task.pk && item.key.sk === task.sk)) {
        finalAttempt = true;
        if (revoked) await w.h.store.put({ item: { ...access, allowed: false } });
      }
      return transact(items);
    });
    const before = task.workflow;
    const operations = await workspaceOperations(w.h.deps, task.workspaceId);
    const action = kind === "retry" ? retryPrFeedback(w.h.deps, w.h.owner, task.taskId, { reviewDigest: w.request.reviewDigest })
      : kind === "fix-start" ? startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision })
      : keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision });
    if (revoked) {
      await action.catch(() => undefined);
      expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(before);
      expect(await workspaceOperations(w.h.deps, task.workspaceId)).toEqual(operations);
      expect(await w.h.store.get(dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision + 1))).toBeUndefined();
    } else {
      await action;
      expect((await readTask(w.h.deps, task.taskId))!.workflow).not.toEqual(before);
    }
    expect(ownerReads).toBeGreaterThan(0);
    expect(finalAttempt).toBe(true);
  }
});

it.each(["checked-keep", "dismiss"])("outside push still permits %s without paid work", async kind => {
  const { blockWorkflow, WORKFLOW_BLOCK_REASONS } = await import("@agentx/contracts");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await reviewedFeedbackWorld();
  let task = w.task;
  if (kind === "checked-keep") {
    await decidePrFeedback(w.h.deps, w.h.owner, task.taskId, w.request);
    task = (await readTask(w.h.deps, task.taskId))!;
    task.workflow = blockWorkflow(task.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
    await w.h.store.put({ item: toDocument(task) });
  }
  w.feedback.changeRequest.headRevision = "e".repeat(40);
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  if (kind === "dismiss") await decidePrFeedback(w.h.deps, w.h.owner, task.taskId, { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE });
  else await keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision });
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "DISMISSED" } });
  expect(admit).not.toHaveBeenCalled();
});
