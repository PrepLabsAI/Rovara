// CORE-SESSION-ACTIONS-BEHAVIOUR-TESTS (row 2335): the behaviours the session actions kept without a test (mutants on them survived the move): the retry of each stage, the closed guard, the design
// review's own retry, and the `./core` subpath export. (The machine stop of a cancel is pinned by core-cancel-fence.test.ts.) The steps a retry starts are spied on, so what is asserted is what the retry asks of them.
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, change, createCandidateManifest, createWorkflowSnapshot } from "@agentx/contracts";
import * as services from "../../packages/broker/src/services/index.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { NOTHING_TO_RETRY_STEP } from "../../packages/broker/src/core/task-flow/retry.js";
import type * as PublishModule from "../../packages/broker/src/core/build-step/publish.js";
import type * as StartModule from "../../packages/broker/src/core/build-step/start.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

const starts = vi.hoisted(() => ({ checks: vi.fn(), review: vi.fn(), publication: vi.fn() }));
vi.mock("../../packages/broker/src/core/build-step/start.js", async (importOriginal) => {
  const original = await importOriginal<typeof StartModule>();
  return { ...original, startChecksRerun: (...args: Parameters<typeof original.startChecksRerun>) => starts.checks(...args) as ReturnType<typeof original.startChecksRerun>, startReview: (...args: Parameters<typeof original.startReview>) => starts.review(...args) as ReturnType<typeof original.startReview> };
});
vi.mock("../../packages/broker/src/core/build-step/publish.js", async (importOriginal) => {
  const original = await importOriginal<typeof PublishModule>();
  return { ...original, startPublication: (...args: Parameters<typeof original.startPublication>) => starts.publication(...args) as ReturnType<typeof original.startPublication> };
});

async function setup() {
  const h = createHarness({ understandFirst: true });
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a health endpoint", workflow: true });
  const actions = services.createSessionActionsService(h.deps);
  /** The task's workflow, moved to a stage and state at the next revision. A stage at or after verification carries the candidate, passing checks and reviews its schema asks for (a blocked step, as a failed run leaves it). */
  const move = async (patch: Record<string, unknown>) => {
    const current = (await readTask(h.deps, task.taskId))!.workflow!;
    const now = h.deps.now!().toISOString();
    const stage = patch.stage as string;
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const atOrAfterPr = ["PULL_REQUEST", "WAIT_FOR_MERGE"].includes(stage);
    const base = createWorkflowSnapshot({ taskId: task.taskId, ownerId: current.ownerId, now });
    const workflow = WorkflowSnapshotSchema.parse({ ...base, revision: current.revision + 1, artifacts: current.artifacts,
      ...(atOrAfterPr || ["REVIEW", "VERIFY"].includes(stage) ? { candidate, verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }] } } : {}),
      ...(atOrAfterPr ? { reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } : {}),
      ...(stage === "WAIT_FOR_MERGE" ? { pullRequests: [{ repositoryId: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headSha: "d".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }] } : {}),
      ...patch });
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
    return workflow;
  };
  return { h, task, actions, move };
}

describe("retry of a blocked step asks the step that owns it", () => {
  it("VERIFY reruns the checks under a request id that names the task and the blocked revision, for the workflow's owner", async () => {
    const { h, task, actions, move } = await setup();
    starts.checks.mockResolvedValueOnce("STARTED");
    const blocked = await move({ stage: "VERIFY", state: "BLOCKED", blockReason: "The checks stopped." });
    await actions.retryBlockedStep(task.taskId, blocked.revision);
    expect(starts.checks).toHaveBeenCalledTimes(1);
    expect(starts.checks.mock.calls[0]![0]).toBe(h.deps);
    expect(starts.checks.mock.calls[0]!.slice(1)).toEqual([{ taskId: task.taskId, workflowRevision: blocked.revision }, { requestId: `retry-${task.taskId}-${String(blocked.revision)}`, actorId: blocked.ownerId }]);
  });
  it("REVIEW starts the review as a retry and PULL_REQUEST starts the publication as an owner retry", async () => {
    const { task, actions, move } = await setup();
    starts.review.mockResolvedValueOnce("STARTED"); starts.publication.mockResolvedValueOnce("STARTED");
    const review = await move({ stage: "REVIEW", state: "BLOCKED", blockReason: "The review stopped." });
    await actions.retryBlockedStep(task.taskId, review.revision);
    expect(starts.review.mock.calls[0]!.slice(1)).toEqual([{ taskId: task.taskId, workflowRevision: review.revision }, { retry: true }]);
    const publish = await move({ stage: "PULL_REQUEST", state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE });
    await actions.retryBlockedStep(task.taskId, publish.revision);
    expect(starts.publication.mock.calls[0]!.slice(1)).toEqual([{ taskId: task.taskId, workflowRevision: publish.revision }, { ownerRetry: true }]);
  });
  it("says there is nothing to retry when the step is gone (STALE), and that the workspace is not ready when it is WAITING", async () => {
    const { task, actions, move } = await setup();
    const blocked = await move({ stage: "VERIFY", state: "BLOCKED", blockReason: "The checks stopped." });
    starts.checks.mockResolvedValueOnce("STALE");
    await expect(actions.retryBlockedStep(task.taskId, blocked.revision)).rejects.toThrow(NOTHING_TO_RETRY_STEP);
    starts.checks.mockResolvedValueOnce("WAITING");
    await expect(actions.retryBlockedStep(task.taskId, blocked.revision)).rejects.toThrow("The workspace is not ready yet");
  });
  it("a push of an approved fix that failed at WAIT_FOR_MERGE comes due again as a PUBLISH row at the next revision; any other block there is not retried", async () => {
    const { h, task, actions, move } = await setup();
    starts.publication.mockResolvedValue("STARTED");
    const other = await move({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: "Something else stopped it." });
    await expect(actions.retryBlockedStep(task.taskId, other.revision)).rejects.toThrow(NOTHING_TO_RETRY_STEP);
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(other);
    const failed = await move({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed });
    await actions.retryBlockedStep(task.taskId, failed.revision);
    const after = (await readTask(h.deps, task.taskId))!.workflow!;
    expect(after).toMatchObject({ stage: "PULL_REQUEST", revision: failed.revision + 1 });
    expect(after.state).not.toBe("BLOCKED");
    expect(after.blockReason).toBeUndefined();
    expect(after.pullRequestUpdateFailure).toBeUndefined();
  });
});

describe("the closed guard", () => {
  it("a closed task is not retried and has nothing to cancel", async () => {
    const { h, task, actions, move } = await setup();
    const blocked = await move({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "Stopped." });
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("closedAt", new Date(0).toISOString())] });
    await expect(actions.retryBlockedStep(task.taskId, blocked.revision)).rejects.toThrow(NOTHING_TO_RETRY_STEP);
    expect(await actions.cancelTask(task.taskId)).toEqual({ nothingRunning: true });
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(blocked);
  });
  it("a task that is closing (a close operation is under way) has nothing to cancel", async () => {
    const { h, task, actions } = await setup();
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("closeOperationId", "close-1")] });
    expect(await actions.cancelTask(task.taskId)).toEqual({ nothingRunning: true });
  });
});

describe("the design review's own retry", () => {
  it("takes the retry when it says it is the review's (nothing else is changed), and passes the revision it was given", async () => {
    const { h, task, move } = await setup();
    const blocked = await move({ definitionVersion: "1.1.0", stage: "PLAN_CRITIQUE", state: "BLOCKED", blockReason: "A review round stopped." });
    const retryBlocked = vi.fn<(deps: unknown, task: unknown, revision: number | undefined) => Promise<boolean>>(() => Promise.resolve(true));
    const actions = services.createSessionActionsService({ ...h.deps, designReview: { retryBlocked } as never });
    await actions.retryBlockedStep(task.taskId, blocked.revision);
    expect(retryBlocked).toHaveBeenCalledTimes(1);
    expect(retryBlocked.mock.calls[0]![2]).toBe(blocked.revision);
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(blocked);
  });
  it("falls back to the ordinary retry of the stage when it says the block is not the review's", async () => {
    const { h, task, move } = await setup();
    const blocked = await move({ stage: "PLAN", state: "BLOCKED", blockReason: "The plan stopped." });
    const retryBlocked = vi.fn<(deps: unknown, task: unknown, revision: number | undefined) => Promise<boolean>>(() => Promise.resolve(false));
    const actions = services.createSessionActionsService({ ...h.deps, designReview: { retryBlocked, planInstructions: () => undefined } as never });
    await actions.retryBlockedStep(task.taskId, blocked.revision);
    expect(retryBlocked).toHaveBeenCalledTimes(1);
    expect((await readTask(h.deps, task.taskId))!.workflow).toMatchObject({ stage: "PLAN", revision: blocked.revision + 1 });
  });
});

describe("the ./core subpath of the broker package", () => {
  it("is exported, and names the session actions the engine calls", async () => {
    const manifest = (await import("../../packages/broker/package.json", { with: { type: "json" } })).default as { exports: Record<string, string> };
    expect(manifest.exports["./core"]).toBe("./dist/core/index.js");
    const core = await import("../../packages/broker/src/core/index.js");
    for (const name of ["retryBlockedStep", "cancelTask", "revisePlanWithLiveMessage"]) expect(core).toHaveProperty(name);
  });
});
