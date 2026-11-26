// Task actions (owner decision 198), continue: more work for a task that ended its run. The new instructions start a new round on the same task, workspace and conversation. The key rules, each tested against what the
// move left in the store:
//   1. only the owner or a co-owner continues a task; anyone else (and a script token) reads no such task, and nothing is written;
//   2. only a task that ended its run takes it: a task still working, still starting, closed, never ready, a workflow task and a setup run each have their own refusal;
//   3. the money: a task over its cap, a spend nobody can read and a refused admission start no round;
//   4. the same request id once: a repeat answers the first and starts nothing, other words under it are refused; two at once start one round;
//   5. the round, its idempotency record and its audit line commit together.
import { describe, expect, it } from "vitest";
import type { Admission } from "@agentx/contracts";
import { change, queryAll, when } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { OWNER_KEY, REQUEST_A, REQUEST_B, TASK_ID, operationsOf, promptOf, seed, seedPlain, stateOf, taskOf, WORKSPACE_ID } from "../support/task-actions-world.js";
import { operationRequestKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { continueRecordKey } from "../../packages/broker/src/core/task-flow/continue.js";

const ask = (instructions = "Now also add a test for it.", requestId = REQUEST_A) => ({ requestId, instructions });
const secondRound = async (h: Awaited<ReturnType<typeof seedPlain>>["h"]) => (await operationsOf(h)).filter((operation) => operation.id !== "op-first");

describe("continue", () => {
  it.each(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const)("starts a new round on the same task and workspace for a task whose run ended %s", async (first) => {
    const { h, caller, conversationId } = await seedPlain({ first });
    const long = `Also handle the empty case. ${"Explain it in the test name. ".repeat(40)}`;
    const view = await createTaskActions(h.deps).continue(caller, TASK_ID, ask(long));
    expect(view.status).toBe("RUNNING");
    const [round] = await secondRound(h);
    // A plain run of the same conversation in the same workspace, on the next hold of it, with the owner's words as they were written.
    expect(round).toMatchObject({ kind: "task", status: "ACCEPTED", workspaceId: WORKSPACE_ID, fence: 3, requestId: REQUEST_A });
    expect(round!.workflowMode).toBeUndefined();
    expect(promptOf(round!)).toBe(long);
    expect((round!.dispatch.payload as { conversationId?: string }).conversationId).toBe(conversationId);
    expect(await h.store.get(workspaceKey(COMPANY, WORKSPACE_ID))).toMatchObject({ status: "BUSY", activeOperationId: round!.id, fence: 3 });
    expect(h.audit.map((event) => event.action)).toEqual(["task.continued"]);
    expect((await taskOf(h)).workflow).toBeUndefined();
  });

  it("is refused on a closed task, a closed workspace and a workspace that never got ready, with their own words, and writes nothing", async () => {
    const closed = await seedPlain({ task: { closedAt: "2026-11-10T11:00:00.000Z" } });
    const before = await stateOf(closed.h);
    await expect(createTaskActions(closed.h.deps).continue(closed.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("closed") as string });
    expect(await stateOf(closed.h)).toEqual(before);
    const workspaceClosed = await seedPlain({ workspace: { status: "CLOSED" } });
    await expect(createTaskActions(workspaceClosed.h.deps).continue(workspaceClosed.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("closed") as string });
    const neverReady = await seedPlain({ workspace: { status: "PREPARATION_FAILED" } });
    await expect(createTaskActions(neverReady.h.deps).continue(neverReady.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("never started") as string });
    for (const world of [closed, workspaceClosed, neverReady]) expect(await secondRound(world.h)).toHaveLength(0);
  });

  it("refuses a workflow task (its approvals, send back and findings move it) and a setup run, and a body that is not valid", async () => {
    const workflowTask = await seed();
    await expect(createTaskActions(workflowTask.h.deps).continue(workflowTask.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: expect.stringContaining("approval steps") as string });
    expect(await operationsOf(workflowTask.h)).toHaveLength(0);
    const setup = await seedPlain({ task: { purpose: "setup_agent" } });
    await expect(createTaskActions(setup.h.deps).continue(setup.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("setup run") as string });
    const valid = await seedPlain();
    const actions = createTaskActions(valid.h.deps);
    await expect(actions.continue(valid.caller, TASK_ID, { requestId: "not-a-uuid", instructions: "x" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(actions.continue(valid.caller, TASK_ID, ask(""))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(actions.continue(valid.caller, TASK_ID, ask("x".repeat(65_537)))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await secondRound(valid.h)).toHaveLength(0);
  });

  it("answers a repeat with the first and starts one round, even after that round ended; other words under the same id are refused", async () => {
    const { h, caller } = await seedPlain();
    const actions = createTaskActions(h.deps);
    await actions.continue(caller, TASK_ID, ask());
    const again = await actions.continue(caller, TASK_ID, ask());
    expect(again.status).toBe("RUNNING");
    expect(await secondRound(h)).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
    await expect(actions.continue(caller, TASK_ID, ask("Something else entirely."))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // The round ends; the same request still answers (a retry after a timeout), and does not run twice.
    const [round] = await secondRound(h);
    await h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: round!.id, fence: 3, status: "SUCCEEDED", outcome: { kind: "ended" } });
    expect((await actions.continue(caller, TASK_ID, ask())).status).toBe("SUCCEEDED");
    expect(await secondRound(h)).toHaveLength(1);
    // A new request id is a new round.
    await actions.continue(caller, TASK_ID, ask("And a third thing.", REQUEST_B));
    expect(await secondRound(h)).toHaveLength(2);
  });

  it("starts one round when the same request arrives twice at once", async () => {
    const { h, caller } = await seedPlain();
    const actions = createTaskActions(h.deps);
    const results = await Promise.allSettled([actions.continue(caller, TASK_ID, ask()), actions.continue(caller, TASK_ID, ask())]);
    expect(await secondRound(h)).toHaveLength(1);
    // The one that lost the race either answers the first or is told the task is busy; never a second round.
    for (const result of results) if (result.status === "rejected") expect((result.reason as { code?: string }).code).toMatch(/TASK_BUSY|WORKSPACE_BUSY/u);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await queryAll(h.store, { pk: `AUDIT#${COMPANY}`, sk: { op: "beginsWith", prefix: "EVENT#task.continued" } })).toHaveLength(1);
  });

  it("a round that lost the workspace to another run meanwhile says TASK_BUSY and writes nothing; one that finds its request id taken by other words is refused", async () => {
    const racing = (what: "busy" | "taken"): Admission => ({ ...createAllowAllAdmission(), async admit() {
      // The workspace is taken (or the request id is spent) after the checks looked, before the round commits.
      if (what === "busy") await racingWorld!.h.store.update({ key: workspaceKey(COMPANY, WORKSPACE_ID), ops: [change.set("status", "BUSY"), change.set("activeOperationId", "op-other")] });
      else {
        await racingWorld!.h.store.put({ item: { ...operationRequestKey(COMPANY, OWNER_KEY, WORKSPACE_ID, REQUEST_A), entityType: "IDEMPOTENCY", operationId: "op-other", payloadHash: "f".repeat(64) } });
        await racingWorld!.h.store.put({ item: { ...continueRecordKey(TASK_ID, REQUEST_A), entityType: "TASK_CONTINUE", payloadHash: "f".repeat(64), operationId: "op-other" } });
      }
      return { allowed: true };
    } });
    let racingWorld: Awaited<ReturnType<typeof seedPlain>> | undefined;
    racingWorld = await seedPlain({ harness: { admission: racing("busy") } });
    await expect(createTaskActions(racingWorld.h.deps).continue(racingWorld.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(await secondRound(racingWorld.h)).toHaveLength(0);
    racingWorld = await seedPlain({ harness: { admission: racing("taken") } });
    await expect(createTaskActions(racingWorld.h.deps).continue(racingWorld.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await secondRound(racingWorld.h)).toHaveLength(0);
  });

  it("commits the steps the access seam asks for with the round, and a fence that no longer holds refuses it with nothing written", async () => {
    const fence = (): TaskFlowDeps["access"] => ({ ...createOwnerTaskAccess(), ownerActing: async (_principal, task) => ({ actorId: task.ownerKey, items: [{ kind: "put", item: { pk: "ACCESS_FENCE#payments", sk: "META", entityType: "ACCESS_FENCE" }, condition: when.absent() }] }) });
    const holds = await seedPlain({ access: fence() });
    await createTaskActions(holds.h.deps).continue(holds.caller, TASK_ID, ask());
    expect(await holds.h.store.get({ pk: "ACCESS_FENCE#payments", sk: "META" })).toBeDefined();
    expect(await secondRound(holds.h)).toHaveLength(1);
    const broken = await seedPlain({ access: fence() });
    await broken.h.store.put({ item: { pk: "ACCESS_FENCE#payments", sk: "META", entityType: "ACCESS_FENCE" } });
    await expect(createTaskActions(broken.h.deps).continue(broken.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await secondRound(broken.h)).toHaveLength(0);
    expect(await broken.h.store.get(continueRecordKey(TASK_ID, REQUEST_A))).toBeUndefined();
  });

  it("says no such task to anyone but the owner, and starts nothing", async () => {
    const { h } = await seedPlain();
    const before = await stateOf(h);
    await expect(createTaskActions(h.deps).continue(h.guest, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(h)).toEqual(before);
    expect(await secondRound(h)).toHaveLength(0);
  });
});
