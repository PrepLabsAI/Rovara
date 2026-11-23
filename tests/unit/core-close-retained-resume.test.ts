// CLOSE-RETENTION: a retained session that was idle-stopped resumes work exactly like a plain stopped one (Continue, a Retry / any new step), on the same volume, and a Close afterwards is still refused until it is
// previewed and bound. Retention changes only what a Close does, never whether work can resume. Fake ports (not machine proof): that a real stopped instance restarts on its kept volume and its worker lifts the
// retention is proven by the Linux grid and the real calls after install.
import { textField } from "../support/close-recovery-harness.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, change, workspaceSessionKey } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { acceptStep } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { retainedCloseWords } from "../../packages/broker/src/core/task-flow/close-words.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";

async function finishedAndIdleStopped(sessionState: "STOPPED" | "FAILED" | "READY" | "DELETING" = "STOPPED", extra: Record<string, unknown> = {}) {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "retained follow-up" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId), workspace = (await h.store.get(wk))!, id = textField(workspace, "activeOperationId");
  const op = operationKey(h.deps.companyId, task.workspaceId, id), sk = workspaceSessionKey(task.workspaceId);
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const retained = { inspectionOperationId: id, inspectionFence: Number(workspace.fence), retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
  await h.store.update({ key: wk, ops: [change.set("status", "READY"), change.set("machine", { machineId: "machine", machineKey: task.workspaceId })] });
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING"), change.set("closePreflight", { schemaVersion: 1, target: generation })] });
  await h.store.update({ key: taskPointerKey(h.deps.companyId, task.workspaceId), ops: [change.remove("pendingPrompt")] });
  h.deps.closeInspection = { raiseFence: async () => {}, retained: async () => true, inspectWorkspaceForClose: async () => ({ retentionId: retained.retentionId, inspection: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }], contentDigest: retained.contentDigest }, retentionProof: { schemaVersion: 1, generation } }) };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, id)).toBe(true);
  // The idle reaper ended the instance: the session is STOPPED with no instance, the volume and the retention record kept.
  const stopped = sessionState === "READY" ? { instanceId: generation.instanceId } : {};
  await h.store.put({ item: { ...sk, state: sessionState, generation: 1, volumeId: generation.volumeId, closeRetention: { schemaVersion: 1, operationId: id, fence: retained.inspectionFence, generation, retained }, workspaceDataIdentity: generation, ...stopped, ...extra } });
  const terminate = vi.spyOn(h.machines, "terminate");
  return { h, task, wk, sk, retained, terminate, session: async () => (await h.store.get(sk))! };
}
type World = Awaited<ReturnType<typeof finishedAndIdleStopped>>;
const workspaceOf = async (w: World) => (await readWorkspace(w.h.deps, w.task.workspaceId))!;
const operations = async (w: World) => (await w.h.store.query({ pk: w.wk.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items;
const superseding = async (w: World) => (await operations(w)).filter((item) => item["supersedesRetention"] !== undefined);

describe("finish, idle-stop, then Continue", () => {
  it("Continue WORKS on a retained STOPPED session: a new step is accepted on the same workspace and supersedes the retention; the session item, volume and retention record are not touched here", async () => {
    const w = await finishedAndIdleStopped();
    const before = await w.session();
    const view = await createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "more work" });
    expect(view.status).toBe("RUNNING");
    expect(await superseding(w)).toHaveLength(1);
    expect((await superseding(w))[0]).toMatchObject({ kind: "task", supersedesRetention: w.retained, fence: w.retained.inspectionFence + 1 });
    expect(await w.session()).toEqual(before);
    expect(w.terminate).not.toHaveBeenCalled();
  });

  it("a FAILED retained session (its wake did not provision) continues too: the next step starts it again", async () => {
    const w = await finishedAndIdleStopped("FAILED");
    await createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "again" });
    expect(await superseding(w)).toHaveLength(1);
  });

  it("an ACCEPTED close owns the session: Continue is refused, as for a READY one, and nothing is written", async () => {
    const w = await finishedAndIdleStopped();
    await w.h.store.update({ key: w.sk, ops: [change.set("closeRetention.acceptedOperationId", randomUUID())] });
    const before = await w.h.store.get(w.wk);
    await expect(createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "no" })).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(await w.h.store.get(w.wk)).toEqual(before);
    expect(await superseding(w)).toEqual([]);
  });

  it("a DELETING session is never continued over its retention", async () => {
    const w = await finishedAndIdleStopped("DELETING");
    await expect(createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "no" })).rejects.toBeInstanceOf(AgentXError);
    expect(await superseding(w)).toEqual([]);
  });
});

describe("a new step (what Retry and every workflow step use) on a retained STOPPED session", () => {
  it("is accepted, superseding the retention", async () => {
    const w = await finishedAndIdleStopped();
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    const started = await acceptStep(w.h.deps, { task, workspace: await workspaceOf(w), requestId: randomUUID(), prompt: "retry the step" });
    expect(started.result).toBe("STARTED");
    expect(started.operation).toMatchObject({ supersedesRetention: w.retained });
  });
});

describe("and a Close afterwards is still refused until it is previewed and bound", () => {
  it("after Continue the retention record is still on the session until the woken worker lifts it, so an unbound Close is refused with the retained sentence and nothing is terminated", async () => {
    const w = await finishedAndIdleStopped();
    await createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "more work" });
    const error = await w.h.flow.close(w.h.owner, w.task.taskId).then(() => undefined, (caught: unknown) => caught);
    expect((error as AgentXError).message).toContain(retainedCloseWords(w.task.taskId));
    expect(w.terminate).not.toHaveBeenCalled();
    expect((await readTask(w.h.deps, w.task.taskId))?.closedAt).toBeUndefined();
  });
  it("before any Continue, an unbound Close of the idle-stopped retained task is the same refusal", async () => {
    const w = await finishedAndIdleStopped();
    const error = await w.h.flow.close(w.h.owner, w.task.taskId).then(() => undefined, (caught: unknown) => caught);
    expect((error as AgentXError).message).toContain(retainedCloseWords(w.task.taskId));
    expect(w.terminate).not.toHaveBeenCalled();
  });
});
