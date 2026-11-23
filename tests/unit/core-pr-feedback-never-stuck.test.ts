import { toDocument, type TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { expect, it } from "vitest";
import { change } from "@agentx/contracts";
import { feedbackWorld, reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { collectPrFeedback } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { recoverPrFeedback, PR_FEEDBACK_REVIEW_DEADLINE_MS } from "../../packages/broker/src/core/pr-feedback/recovery.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createBuildSteps } from "../../packages/broker/src/core/build-step/index.js";

it("deadline recovery tolerates losing task visibility after the critic has stopped", async () => {
  const { vi } = await import("vitest");
  const { readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  delete w.h.deps.buildSteps;
  const get = w.h.store.get.bind(w.h.store);
  vi.spyOn(w.h.store, "get").mockImplementation(async key => {
    if (key.pk === task.pk && (await get(operation))?.["status"] === "INTERRUPTED") return undefined;
    return get(key);
  });
  w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  await expect(recoverPrFeedback(w.h.deps, task)).resolves.toBeUndefined();
  expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBeNull();
});

it.each(["another-kind", "missing-workspace"])("an exhausted row with %s has a reachable failure exit", async kind => {
  const { runDueDispatches } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await w.h.store.update({ key: dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision), ops: [change.set("kind", kind === "another-kind" ? "IMPLEMENT" : "REVIEW"), change.set("attempts", 7)] });
  if (kind === "missing-workspace") await w.h.store.delete({ key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" } });
  w.h.deps.buildSteps = { runRow: async () => { throw new Error("wrong row"); }, onEnded: async () => undefined };
  await runDueDispatches(w.h.deps);
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toHaveLength(0);
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.feedbackReview!.status).toBe("COLLECTING");
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.state).toBe("BLOCKED");
});

it("a settled queued review remains a handled sweep if later task reads are unavailable", async () => {
  const { vi } = await import("vitest");
  const { runDueDispatches } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const key = dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision);
  await w.h.store.update({ key, ops: [change.set("attempts", 7)] });
  w.h.deps.buildSteps = { runRow: async () => { throw new Error("critic could not start"); }, onEnded: async () => undefined };
  const get = w.h.store.get.bind(w.h.store);
  const read = vi.spyOn(w.h.store, "get").mockImplementation(async key => {
    const row = await get(key);
    if (key.pk === task.pk && key.sk === "META" && (row as unknown as TaskRecord | undefined)?.workflow?.feedbackReview?.status === "PENDING") throw new Error("task reader unavailable after settlement");
    return row;
  });
  try {
    expect(await runDueDispatches(w.h.deps)).toEqual({ started: 0, waiting: 0, stale: 0, failed: 0, blocked: 1 });
  } finally { read.mockRestore(); }
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED", provider: "broker-lifecycle" } } });
  expect(await w.h.store.get(key)).toBeUndefined();
  expect((await workspaceOperations(w.h.deps, task.workspaceId))[0]?.status).toBe("FAILED");
});

it.each(["foreign-company", "closed", "wrong-stage"])("queued failure refuses %s before immutable writes", async kind => {
  const { failQueuedReview } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "foreign-company") task.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
  if (kind === "closed") task.closedAt = new Date(w.clock.ms).toISOString();
  if (kind === "wrong-stage") task.workflow!.stage = "IMPLEMENT";
  w.put.mockClear();
  await expect(failQueuedReview(w.h.deps, task, "Cannot start.")).resolves.toBe(false);
  expect(w.put).not.toHaveBeenCalled();
});

it("an unchanged queued recovery makes no transaction attempt", async () => {
  const { vi } = await import("vitest");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const transact = vi.spyOn(w.h.store, "transact");
  await recoverPrFeedback(w.h.deps, task);
  expect(transact).not.toHaveBeenCalled();
});

it("recovery cannot recreate a feedback dispatch for another workflow stage", async () => {
  const { vi } = await import("vitest");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await w.h.store.delete({ key: dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision) });
  task.workflow!.stage = "PLAN";
  await w.h.store.put({ item: toDocument(task) });
  const transact = vi.spyOn(w.h.store, "transact");
  await recoverPrFeedback(w.h.deps, task);
  expect(transact).not.toHaveBeenCalled();
});

it.each(["failure", "keep"])("a %s lifecycle operation cannot overwrite an existing operation id", async kind => {
  const { buildOperation } = await import("../../packages/broker/src/core/task-flow/accept.js");
  const { readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const { failQueuedReview } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const workspace = (await readWorkspace(w.h.deps, task.workspaceId))!;
  const id = "33333333-3333-4333-8333-333333333333";
  const built = buildOperation(w.h.deps, { workspace, kind: "task", workflowMode: "FEEDBACK_REVIEW", operationId: id,
    requestId: id, workflowRevision: task.workflow!.revision, dispatch: { kind: "task", projectRevision: task.startingRevision, payload: {} } });
  await w.h.store.put({ item: toDocument({ ...built.operation, status: "SUCCEEDED" }) });
  w.h.deps.newId = () => id;
  if (kind === "failure") expect(await failQueuedReview(w.h.deps, task, "Review failed.")).toBe(false);
  else await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await w.h.store.get(built.operation))?.["status"]).toBe("SUCCEEDED");
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(task.workflow);
});

it.each(["task-company", "task-revision", "task-closed", "workspace-fence", "workspace-holder", "operation-fence", "operation-status"])("cancellation atomically refuses a raced %s", async kind => {
  const { vi } = await import("vitest");
  const { quiesceCritic } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
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
    if (!raced && items.some(item => item.kind === "update" && item.key.sk === operation.sk)) {
      raced = true;
      if (kind === "task-company") await w.h.store.update({ key: task, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
      if (kind === "task-revision") await w.h.store.update({ key: task, ops: [change.set(["workflow", "revision"], task.workflow!.revision + 1)] });
      if (kind === "task-closed") await w.h.store.update({ key: task, ops: [change.set("closedAt", new Date(w.clock.ms).toISOString())] });
      if (kind === "workspace-fence") await w.h.store.update({ key: workspace, ops: [change.set("fence", operation.fence + 2)] });
      if (kind === "workspace-holder") await w.h.store.update({ key: workspace, ops: [change.set("activeOperationId", "33333333-3333-4333-8333-333333333333")] });
      if (kind === "operation-fence") await w.h.store.update({ key: operation, ops: [change.set("fence", operation.fence + 2)] });
      if (kind === "operation-status") await w.h.store.update({ key: operation, ops: [change.set("status", "SUCCEEDED")] });
    }
    return transact(items);
  });
  const stop = vi.spyOn(w.h.machines, "stop");
  await expect(quiesceCritic(w.h.deps, task, operation)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(stop).not.toHaveBeenCalled();
});

it.each(["closing", "new-fence", "new-holder"])("release cannot overwrite a raced %s workspace", async kind => {
  const { vi } = await import("vitest");
  const { releaseCriticHold } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  const key = { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" };
  await w.h.store.update({ key, ops: [change.set("fence", operation.fence + 1)] });
  const update = w.h.store.update.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "update").mockImplementation(async input => {
    if (!raced) {
      raced = true;
      const op = kind === "closing" ? change.set("status", "CLOSING") : kind === "new-fence" ? change.set("fence", operation.fence + 2) : change.set("activeOperationId", "33333333-3333-4333-8333-333333333333");
      await update({ key, ops: [op] });
    }
    return update(input);
  });
  await releaseCriticHold(w.h.deps, operation);
  const workspace = await w.h.store.get(key);
  expect(workspace?.["activeOperationId"]).toBe(kind === "new-holder" ? "33333333-3333-4333-8333-333333333333" : operation.id);
  if (kind === "closing") expect(workspace?.["status"]).toBe("CLOSING");
});

it("a missing artifact adapter still produces a discoverable failed owner card", async () => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  delete w.h.deps.feedbackArtifacts;
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" })).toBe("STALE");
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED" } } });
});

it.each(["queued", "running", "accepting"])("a company change during %s failure settlement leaves the foreign task untouched", async kind => {
  const { vi } = await import("vitest");
  const { failQueuedReview } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const { recordPrFeedbackReview } = await import("../../packages/broker/src/core/pr-feedback/review.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "running") {
    await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
    task = (await readTask(w.h.deps, task.taskId))!;
  }
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (!raced && items.some(item => item.kind === "update" && item.key.pk === task.pk)) {
      raced = true;
      await w.h.store.update({ key: task, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
    }
    return transact(items);
  });
  if (kind === "accepting") expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" })).toBe("STALE");
  else if (kind === "queued") expect(await failQueuedReview(w.h.deps, task, "The review could not start.")).toBe(false);
  else await recordPrFeedbackReview(w.h.deps, task, (await workspaceOperations(w.h.deps, task.workspaceId))[0]!, { status: "FAILED" });
  expect((await w.h.store.get(task))?.["workflow"]).toEqual(task.workflow);
});

it.each(["closed", "company", "revision"])("dispatch recovery refuses a raced task %s", async kind => {
  const { vi } = await import("vitest");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const key = dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision);
  await w.h.store.delete({ key });
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (!raced && items.some(item => item.kind === "put" && item.item.pk === key.pk && item.item.sk === key.sk)) {
      raced = true;
      const op = kind === "closed" ? change.set("closedAt", new Date(w.clock.ms).toISOString()) : kind === "company" ? change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb") : change.set(["workflow", "revision"], task.workflow!.revision + 1);
      await w.h.store.update({ key: task, ops: [op] });
    }
    return transact(items);
  });
  await recoverPrFeedback(w.h.deps, task);
  expect(await w.h.store.get(key)).toBeUndefined();
});

it("dispatch exhaustion produces the canonical failed review card through the real dispatcher", async () => {
  const { runDueDispatches } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const key = dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision);
  await w.h.store.update({ key, ops: [change.set("attempts", 7)] });
  w.h.deps.buildSteps = { runRow: async () => { throw new Error("review cannot start"); }, onEnded: async () => undefined };
  expect(await runDueDispatches(w.h.deps)).toMatchObject({ blocked: 1, started: 0 });
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING",
    feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED", provider: "broker-lifecycle" } } });
  expect(await w.h.store.get(key)).toBeUndefined();
  expect((await workspaceOperations(w.h.deps, task.workspaceId))[0]?.status).toBe("FAILED");
});

it.each(["deleted-dispatch", "deadline", "attempts"])("queued %s has a real recovery transition", async kind => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const key = dispatchRowKey(w.h.deps.companyId, task.taskId, task.workflow!.revision);
  if (kind === "deleted-dispatch") await w.h.store.delete({ key });
  if (kind === "deadline") w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  if (kind === "attempts") await w.h.store.update({ key, ops: [change.set("attempts", 8)] });
  await recoverPrFeedback(w.h.deps, task);
  const next = (await readTask(w.h.deps, task.taskId))!;
  if (kind === "deleted-dispatch") {
    expect(await w.h.store.get(key)).toMatchObject({ kind: "REVIEW", workflowRevision: task.workflow!.revision });
    expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" })).toBe("STARTED");
  } else {
    expect(next.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED", provider: "broker-lifecycle" } } });
    expect(await w.h.store.get(key)).toBeUndefined();
    expect((await workspaceOperations(w.h.deps, task.workspaceId))[0]?.status).toBe("FAILED");
  }
});

it.each(["build-hook", "no-build-hook"])("a silent accepted critic reaches a failed owner card at the overall deadline (%s)", async kind => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  if (kind === "no-build-hook") delete w.h.deps.buildSteps;
  w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  await recoverPrFeedback(w.h.deps, task);
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED" } } });
});

it("a validated worker report becomes a complete card; a failed report keeps its evidence", async () => {
  for (const status of ["COMPLETE", "BLOCKED"] as const) {
    const w = await reviewedFeedbackWorld(status);
    expect(w.task.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status } } });
    expect(w.task.workflow!.feedbackReview!.bundleRefs).toHaveLength(1);
  }
});

it("a no-change approved fix can Keep, and dismissed identical comments do not reopen it", async () => {
  const { blockWorkflow, WORKFLOW_BLOCK_REASONS } = await import("@agentx/contracts");
  const { decidePrFeedback } = await import("../../packages/broker/src/core/pr-feedback/decide.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  const blocked = blockWorkflow(approved.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
  await w.h.store.update({ key: approved, ops: [change.set("workflow", toDocument(blocked))] });
  await keepPrFeedback(w.h.deps, w.h.owner, w.task.taskId, { requestId: "88888888-8888-4888-8888-888888888889", expectedRevision: blocked.revision });
  const kept = (await readTask(w.h.deps, w.task.taskId))!;
  expect(kept.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "DISMISSED" } });
  expect(await collectPrFeedback(w.deps, kept, w.budget)).toBe("unchanged");
});

it("a healthy but silent critic is stopped and confirmed quiescent before its deadline failure settles", async () => {
  const { vi } = await import("vitest");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  await w.h.store.update({ key: operation, ops: [change.set("machineId", "silent-critic"), change.set("status", "RUNNING")] });
  const stop = vi.spyOn(w.h.machines, "stop").mockResolvedValue();
  const health = vi.spyOn(w.h.machines, "health").mockResolvedValue({ state: "stopping", activeOperations: 1, features: [], checkedAt: new Date(w.clock.ms).toISOString() });
  w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  await recoverPrFeedback(w.h.deps, task);
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.state).toBe("RUNNING");
  expect(stop.mock.calls).toEqual([["silent-critic"]]);
  health.mockResolvedValue({ state: "stopped", activeOperations: 0, features: [], checkedAt: new Date(w.clock.ms).toISOString() });
  await recoverPrFeedback(w.h.deps, task);
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING" } });
});

it.each(["unchecked", "failed-check", "uncleared-review"])("Keep refuses a no-change fix with %s candidate proof", async kind => {
  const { blockWorkflow, WORKFLOW_BLOCK_REASONS } = await import("@agentx/contracts");
  const { decidePrFeedback } = await import("../../packages/broker/src/core/pr-feedback/decide.js");
  const { keepPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/keep.js");
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const blocked = blockWorkflow(task.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
  if (kind === "unchecked") blocked.verification = undefined;
  if (kind === "failed-check") blocked.verification!.candidateDigest = "0".repeat(64);
  if (kind === "uncleared-review") blocked.reviews = [];
  await w.h.store.update({ key: task, ops: [change.set("workflow", toDocument(blocked))] });
  await expect(keepPrFeedback(w.h.deps, w.h.owner, task.taskId, { requestId: "88888888-8888-4888-8888-888888888889", expectedRevision: blocked.revision })).rejects.toBeDefined();
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(blocked);
});

it("recovers a terminal critic whose workspace release committed before workflow settlement was lost", async () => {
  const { recordOperationResult } = await import("../../packages/broker/src/core/task-flow/results.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  const steps = w.h.deps.buildSteps!;
  await steps.runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  w.h.deps.buildSteps = { ...steps, onEnded: async () => undefined };
  await recordOperationResult(w.h.deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: "FAILED" });
  w.h.deps.buildSteps = steps;
  task = (await readTask(w.h.deps, task.taskId))!;
  expect(task.workflow!.state).toBe("RUNNING");
  await recoverPrFeedback(w.h.deps, task);
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING" } });
});

it("a late result cannot release the cancellation fence and start a new paid round before quiescence", async () => {
  const { vi } = await import("vitest");
  const { recordOperationResult } = await import("../../packages/broker/src/core/task-flow/results.js");
  const { retryPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/decide.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  await w.h.store.update({ key: operation, ops: [change.set("machineId", "late-critic"), change.set("status", "RUNNING")] });
  task = (await readTask(w.h.deps, task.taskId))!;
  let stopping = true;
  vi.spyOn(w.h.machines, "stop").mockImplementation(async () => {
    await recordOperationResult(w.h.deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: "SUCCEEDED" });
    const failed = (await readTask(w.h.deps, task.taskId))!;
    const digest = failed.workflow!.feedbackReview!.reviewRef!.sha256;
    await retryPrFeedback(w.h.deps, w.h.owner, task.taskId, { reviewDigest: digest });
    const retry = (await readTask(w.h.deps, task.taskId))!;
    expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: retry.workflow!.revision, kind: "REVIEW" })).toBe("WAITING");
    expect(await workspaceOperations(w.h.deps, task.workspaceId)).toHaveLength(1);
    stopping = false;
  });
  vi.spyOn(w.h.machines, "health").mockImplementation(async () => ({ state: stopping ? "stopping" : "stopped", activeOperations: 0, features: [], checkedAt: new Date(w.clock.ms).toISOString() }));
  w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  await recoverPrFeedback(w.h.deps, task);
  const retry = (await readTask(w.h.deps, task.taskId))!;
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: retry.workflow!.revision, kind: "REVIEW" })).toBe("STARTED");
});

it.each(["foreign-company", "wrong-holder", "wrong-fence", "wrong-fence-claimed", "lost-claim"])("critic cancellation refuses %s before accepting quiescence", async kind => {
  const { vi } = await import("vitest");
  const { quiesceCritic } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  const workspace = { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" };
  if (kind === "foreign-company") operation.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
  if (kind === "wrong-holder") await w.h.store.update({ key: workspace, ops: [change.set("activeOperationId", "99999999-9999-4999-8999-999999999999")] });
  if (kind === "wrong-fence") await w.h.store.update({ key: workspace, ops: [change.set("fence", operation.fence + 2)] });
  if (kind === "wrong-fence-claimed") {
    operation.status = "CANCEL_REQUESTED";
    await w.h.store.update({ key: workspace, ops: [change.set("fence", operation.fence + 2)] });
  }
  if (kind === "lost-claim") vi.spyOn(w.h.store, "transact").mockResolvedValue({ applied: false, reason: "condition_failed", failed: [] });
  const stop = vi.spyOn(w.h.machines, "stop");
  await expect(quiesceCritic(w.h.deps, task, operation)).rejects.toMatchObject({ code: kind === "lost-claim" ? "IDEMPOTENCY_CONFLICT" : "STALE_FENCE" });
  expect(stop).not.toHaveBeenCalled();
});

it.each(["no-machine", "stopped", "stopping", "other-mode", "missing-workspace"])("a pending cancellation hold handles %s safely", async kind => {
  const { vi } = await import("vitest");
  const { recoverCriticHold } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const { readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  const workspace = { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" };
  await w.h.store.update({ key: operation, ops: [change.set("status", "CANCEL_REQUESTED"),
    ...(kind === "no-machine" ? [] : [change.set("machineId", "pending-critic")]), ...(kind === "other-mode" ? [change.set("workflowMode", "IMPLEMENT")] : [])] });
  await w.h.store.update({ key: workspace, ops: [change.set("fence", operation.fence + 1)] });
  if (kind === "missing-workspace") await w.h.store.delete({ key: workspace });
  const stop = vi.spyOn(w.h.machines, "stop").mockResolvedValue();
  const health = vi.spyOn(w.h.machines, "health").mockResolvedValue({ state: kind === "stopping" ? "stopping" : "stopped", activeOperations: 0, features: [], checkedAt: new Date(w.clock.ms).toISOString() });
  await expect(recoverCriticHold(w.h.deps, task)).resolves.toBeUndefined();
  const settled = kind === "stopped" || kind === "no-machine";
  expect((await w.h.store.get(operation))?.["status"]).toBe(settled ? "INTERRUPTED" : "CANCEL_REQUESTED");
  if (kind !== "missing-workspace") expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBe(settled ? null : operation.id);
  if (kind === "no-machine" || kind === "other-mode" || kind === "missing-workspace") {
    expect(stop).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  }
});

it.each(["no-machine", "stopped", "stopping", "stop-incomplete"])("a terminal cancellation hold handles %s without unsafe release", async kind => {
  const { vi } = await import("vitest");
  const { recoverCriticHold } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const { readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  await w.h.store.update({ key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }, ops: [change.set("fence", operation.fence + 1)] });
  await w.h.store.update({ key: operation, ops: [change.set("status", "INTERRUPTED"), ...(kind === "no-machine" ? [] : [change.set("machineId", "critic-stop")])] });
  const stop = vi.spyOn(w.h.machines, "stop").mockResolvedValue();
  const health = vi.spyOn(w.h.machines, "health").mockResolvedValue({ state: kind === "stopping" ? "stopping" : "stopped", activeOperations: 0, features: [], checkedAt: new Date(w.clock.ms).toISOString() });
  if (kind === "stop-incomplete") health.mockResolvedValueOnce({ state: "busy", activeOperations: 1, features: [], checkedAt: new Date(w.clock.ms).toISOString() })
    .mockResolvedValue({ state: "stopping", activeOperations: 0, features: [], checkedAt: new Date(w.clock.ms).toISOString() });
  await expect(recoverCriticHold(w.h.deps, task)).resolves.toBeUndefined();
  expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBe(kind === "stopping" || kind === "stop-incomplete" ? operation.id : null);
  if (kind === "stop-incomplete") expect(stop).toHaveBeenCalledOnce();
  else expect(stop).not.toHaveBeenCalled();
  if (kind === "no-machine") expect(health).not.toHaveBeenCalled();
});

it("a deleted workspace leaves no cancellation hold to release", async () => {
  const { releaseCriticHold } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const w = await reviewedFeedbackWorld();
  await w.h.store.delete({ key: { pk: `WORKSPACE#${w.task.workspaceId}`, sk: "META" } });
  await expect(releaseCriticHold(w.h.deps, w.operation)).resolves.toBeUndefined();
});

it.each(["foreign-company", "closed"])("recovery ignores a %s task before reading workspace state", async kind => {
  const { vi } = await import("vitest");
  const w = await feedbackWorld();
  if (kind === "foreign-company") w.task.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
  else w.task.closedAt = new Date(w.clock.ms).toISOString();
  const get = vi.spyOn(w.h.store, "get");
  await recoverPrFeedback(w.h.deps, w.task);
  expect(get).not.toHaveBeenCalled();
});

it("a generic queued workflow block becomes a failed advisory card with owner exits", async () => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await w.h.store.update({ key: task, ops: [change.set(["workflow", "state"], "BLOCKED"), change.set(["workflow", "blockReason"], "Worker unavailable")] });
  await recoverPrFeedback(w.h.deps, (await readTask(w.h.deps, task.taskId))!);
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED" } } });
});

it.each(["mode", "revision", "before-deadline"])("feedback recovery leaves a %s operation running", async kind => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  if (kind === "mode") await w.h.store.update({ key: operation, ops: [change.set("workflowMode", "IMPLEMENT")] });
  if (kind === "revision") await w.h.store.update({ key: operation, ops: [change.set("workflowRevision", task.workflow!.revision + 1)] });
  if (kind !== "before-deadline") w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  await expect(recoverPrFeedback(w.h.deps, task)).resolves.toBeUndefined();
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(task.workflow);
  expect((await workspaceOperations(w.h.deps, task.workspaceId))[0]!.status).toBe(operation.status);
});

it("queued failure with a missing workspace settles nothing and does not throw", async () => {
  const { failQueuedReview } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await w.h.store.delete({ key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" } });
  await expect(failQueuedReview(w.h.deps, task, "Workspace unavailable")).resolves.toBe(false);
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(task.workflow);
});

// STOP-NON-DESTRUCTIVE: the broker's adapter cannot ping a READY worker and refuses (`unavailable`); a Stop now leaves the session STOPPING, so the hold meets that refusal before
// the stop and, when the stop did nothing, after it. Neither is a failure of the pass: the hold waits and confirms only on stopped / terminated.
it("a terminal cancellation hold treats the broker's READY-health refusal as not yet stopped: it stops the machine, keeps the hold, and releases only when stopped", async () => {
  const { vi } = await import("vitest");
  const { MachineError } = await import("@agentx/contracts");
  const { recoverCriticHold } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const { readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  await w.h.store.update({ key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }, ops: [change.set("fence", operation.fence + 1)] });
  await w.h.store.update({ key: operation, ops: [change.set("status", "INTERRUPTED"), change.set("machineId", "critic-stop")] });
  const stop = vi.spyOn(w.h.machines, "stop").mockResolvedValue();
  const refused = () => { throw new MachineError("unavailable", "live worker health is unavailable on the broker"); };
  const stopped = { state: "stopped" as const, activeOperations: 0, features: [], checkedAt: new Date(w.clock.ms).toISOString() };
  // Pass 1: the broker refuses before and after the stop (the session was READY and the stop is only a request): the hold stays.
  const health = vi.spyOn(w.h.machines, "health").mockImplementation(async () => refused());
  await expect(recoverCriticHold(w.h.deps, task)).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledOnce();
  expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBe(operation.id);
  // Pass 2: the session is STOPPING: not confirmed, no second stop.
  health.mockResolvedValue({ ...stopped, state: "stopping" });
  await recoverCriticHold(w.h.deps, task);
  expect(stop).toHaveBeenCalledOnce();
  expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBe(operation.id);
  // Pass 3: the reaper marked it STOPPED: the hold is released.
  health.mockResolvedValue(stopped);
  await recoverCriticHold(w.h.deps, task);
  expect((await readWorkspace(w.h.deps, task.workspaceId))!.activeOperationId).toBeNull();
});

it("a pending critic cancellation does not throw on the broker's health refusal after its stop, and confirms only once the machine reads stopped", async () => {
  const { vi } = await import("vitest");
  const { MachineError } = await import("@agentx/contracts");
  const { quiesceCritic } = await import("../../packages/broker/src/core/pr-feedback/quiesce.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  task = (await readTask(w.h.deps, task.taskId))!;
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  await w.h.store.update({ key: operation, ops: [change.set("machineId", "critic-machine")] });
  const withMachine = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  const stop = vi.spyOn(w.h.machines, "stop").mockResolvedValue();
  const checkedAt = new Date(w.clock.ms).toISOString();
  const health = vi.spyOn(w.h.machines, "health").mockImplementation(async () => { throw new MachineError("unavailable", "live worker health is unavailable on the broker"); });
  expect((await quiesceCritic(w.h.deps, task, withMachine)).confirmed).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  health.mockResolvedValue({ state: "stopping", activeOperations: 0, features: [], checkedAt });
  const claimed = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  expect((await quiesceCritic(w.h.deps, task, claimed)).confirmed).toBe(false);
  health.mockResolvedValue({ state: "stopped", activeOperations: 0, features: [], checkedAt });
  expect((await quiesceCritic(w.h.deps, task, claimed)).confirmed).toBe(true);
  // Only the refusal is tolerated: any other failure is the pass's.
  health.mockRejectedValue(new MachineError("rejected", "no"));
  await expect(quiesceCritic(w.h.deps, task, claimed)).rejects.toMatchObject({ code: "rejected" });
});
