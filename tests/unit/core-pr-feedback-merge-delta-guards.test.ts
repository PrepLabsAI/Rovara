import { createPrFeedbackRoutes } from "../../packages/broker/src/core-host/pr-feedback-routes.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { CodeHost } from "@agentx/contracts";
import { feedbackWorld } from "../support/pr-feedback-world.js";
import { createHarness } from "../support/task-flow-harness.js";
import { collectPrFeedback } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { runDueDispatches } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";

it("MT1: unread feedback permits merge observation but holds full reconciliation", async () => {
  const w = await feedbackWorld();
  createPrFeedbackRoutes(w.h.deps, async () => ({}));
  w.read.mockRejectedValue(new Error("feedback unavailable"));
  const host = w.registry.get("code-host", "github") as CodeHost;
  const status = vi.spyOn(host, "changeRequestStatus");
  const observe = vi.spyOn(host, "mergeObservation");
  const before = await readTask(w.h.deps, w.task.taskId);
  expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
  expect(w.read).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(status).not.toHaveBeenCalled();
  // Published-change verification precedes collection and may attach risk/tier facts.
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toMatchObject(before!.workflow!);
  expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
  expect(await w.h.store.get(recoveryRowKey(w.task.taskId))).toMatchObject({ attempts: 1, nextAttemptAt: w.clock.ms + 60_000 });
});

it("MT2: unread feedback still observes a merged PR and removes its terminal recovery row", async () => {
  const w = await feedbackWorld();
  createPrFeedbackRoutes(w.h.deps, async () => ({}));
  w.read.mockRejectedValue(new Error("feedback unavailable"));
  const host = w.registry.get("code-host", "github") as CodeHost;
  const readObservation = host.mergeObservation!.bind(host);
  const observe = vi.spyOn(host, "mergeObservation").mockImplementation(async (...args) => ({
    ...await readObservation(...args), state: "merged", headRevision: w.task.workflow!.pullRequests![0]!.headSha!,
  }));
  const status = vi.spyOn(host, "changeRequestStatus");
  expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
  expect(w.read).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(status).not.toHaveBeenCalled();
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toMatchObject({ stage: "MERGED", pullRequests: [{ state: "MERGED" }] });
  expect(await w.h.store.get(recoveryRowKey(w.task.taskId))).toBeUndefined();
});

it("SM9: an exhausted stale REVIEW row cannot fail the newer collecting feedback review", async () => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const revision = task.workflow!.revision;
  const currentKey = dispatchRowKey(w.h.deps.companyId, task.taskId, revision);
  await w.h.store.delete({ key: currentKey });
  const item = dispatchRowItem(w.h.deps, task.taskId, revision - 1, "REVIEW", new Date(w.h.clock.now).toISOString());
  await w.h.store.put({ item: { ...item.item, attempts: 7 } });
  w.h.deps.buildSteps = { runRow: async () => { throw new Error("old row exhausted"); }, onEnded: async () => undefined };
  w.put.mockClear();
  expect(await runDueDispatches(w.h.deps)).toEqual({ started: 0, waiting: 0, stale: 0, failed: 0, blocked: 1 });
  expect(await readTask(w.h.deps, task.taskId)).toEqual(task);
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toEqual([]);
  expect(w.put).not.toHaveBeenCalled();
  expect(await w.h.store.get(currentKey)).toBeUndefined();
  expect(await w.h.store.get(dispatchRowKey(w.h.deps.companyId, task.taskId, revision - 1))).toBeUndefined();
});

it.each(["FEEDBACK_REVIEW", "PLAN"] as const)("CB5: a 1 MB feedback-report artifact is allowed only for feedback runs (mode=%s)", async mode => {
  const h = createHarness();
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Bound feedback artifacts" });
  const operation = (await workspaceOperations(h.deps, started.task.workspaceId)).find(op => op.kind === "prepare")!;
  await h.store.put({ item: toDocument({ ...operation, workflowMode: mode }) });
  const put = vi.fn(async () => {});
  const handler = createCallbackHandler({ flow: h.deps, blobs: { put, get: async () => undefined } as never, grants: { exchange: async () => { throw new Error("unused"); } } });
  const token = new CallbackCapabilities(Buffer.from(h.deps.callbackSigningKey)).issue({ workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, actions: ["artifacts"], expiresInSeconds: 600 });
  const response = await handler({ method: "POST", path: `/v1/internal/workspaces/${operation.workspaceId}/operations/${operation.id}/artifacts`, headers: { [CAPABILITY_HEADER]: token },
    body: JSON.stringify({ name: `workflow-feedback-review-${"a".repeat(64)}.json`, mediaType: "application/json", content: "x".repeat(1_000_000) }) });
  expect(response.statusCode).toBe(mode === "FEEDBACK_REVIEW" ? 200 : 400);
  expect(put).toHaveBeenCalledTimes(mode === "FEEDBACK_REVIEW" ? 1 : 0);
});
