// Task actions (owner decision 198), continue: more work for a task that ended its run. The new instructions start a new round on the same task, workspace and conversation. The key rules, each tested against what the
// move left in the store:
//   1. only the owner or a co-owner continues a task; anyone else (and a script token) reads no such task, and nothing is written;
//   2. only a task that ended its run takes it: a task still working, still starting, closed, never ready, a workflow task and a setup run each have their own refusal;
//   3. the money: a task over its cap, a spend nobody can read and a refused admission start no round;
//   4. the same request id once: a repeat answers the first and starts nothing, other words under it are refused; two at once start one round;
//   5. the round, its idempotency record and its audit line commit together.
import { describe, expect, it } from "vitest";
import type { Admission } from "@agentx/contracts";
import { change, queryAll } from "@agentx/contracts";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { scriptTokenRoute } from "../../packages/broker/src/core/script-tokens/authenticate.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { OWNER_KEY, REQUEST_A, REQUEST_B, TASK_ID, accessWithoutOwners, operationsOf, promptOf, seed, seedPlain, stateOf, taskOf, WORKSPACE_ID } from "../support/task-actions-world.js";
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
    expect(await h.store.get(workspaceKey(WORKSPACE_ID))).toMatchObject({ status: "BUSY", activeOperationId: round!.id, fence: 3 });
    expect(h.audit.map((event) => event.action)).toEqual(["task.continued"]);
    expect((await taskOf(h)).workflow).toBeUndefined();
  });

  it("is refused for anyone but the owner or a co-owner, and a script token, and writes nothing", async () => {
    const guest = await seedPlain();
    const before = await stateOf(guest.h);
    await expect(createTaskActions(guest.h.deps).continue(guest.h.guest, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(guest.h)).toEqual(before);
    const viewer = await seedPlain({ access: accessWithoutOwners() });
    await expect(createTaskActions(viewer.h.deps).continue(viewer.h.guest, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const token = await seedPlain();
    await expect(createTaskActions(token.h.deps).continue({ ...token.h.owner, scriptToken: { tokenId: "t", name: "CI", permissions: ["read", "start"], projects: ["payments"] } }, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(scriptTokenRoute("POST", `/v1/dev/tasks/${TASK_ID}/continue`)).toBeUndefined();
    for (const world of [viewer, token]) expect(await secondRound(world.h)).toHaveLength(0);
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

  it("says TASK_BUSY for a task that is still working or whose first instructions have not run, and starts nothing", async () => {
    for (const first of ["running", "starting"] as const) {
      const { h, caller } = await seedPlain({ first });
      const before = await stateOf(h);
      await expect(createTaskActions(h.deps).continue(caller, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_BUSY" });
      expect(await stateOf(h)).toEqual(before);
    }
    const preparing = await seedPlain({ workspace: { status: "PREPARING" } });
    await expect(createTaskActions(preparing.h.deps).continue(preparing.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "TASK_BUSY" });
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

  it("starts no round for a task over its cap, whose spend cannot be told, or when no cap can be read; room under the cap goes ahead", async () => {
    for (const cap of [{ limitUsd: 6, spentUsd: 6 }, { limitUsd: 6, spentUsd: 7.25 }, { limitUsd: 6, spentUsd: undefined }]) {
      const { h, caller } = await seedPlain();
      const before = await stateOf(h);
      await expect(createTaskActions(h.deps, { roundCap: async () => cap }).continue(caller, TASK_ID, ask())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(await stateOf(h)).toEqual(before);
    }
    const unreadable = await seedPlain();
    await expect(createTaskActions(unreadable.h.deps, { roundCap: async () => { throw new Error("ledger down"); } }).continue(unreadable.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const room = await seedPlain();
    await createTaskActions(room.h.deps, { roundCap: async () => ({ limitUsd: 6, spentUsd: 3 }) }).continue(room.caller, TASK_ID, ask());
    expect(await secondRound(room.h)).toHaveLength(1);
  });

  it("asks admission before anything is written; a refusal starts no round", async () => {
    const refusing: Admission = { ...createAllowAllAdmission(), async admit() { return { allowed: false, code: "budget_exhausted", message: "The monthly budget is used up." }; } };
    const { h, caller } = await seedPlain({ harness: { admission: refusing } });
    const before = await stateOf(h);
    await expect(createTaskActions(h.deps).continue(caller, TASK_ID, ask())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringContaining("monthly budget") as string });
    expect(await stateOf(h)).toEqual(before);
  });

  it("is refused for an archived project and for a person who may no longer have work run", async () => {
    const archived = await seedPlain();
    const projects = archived.h.deps.projects;
    archived.h.deps.projects = { ...projects, latest: async (project) => { const found = await projects.latest(project); return found === undefined ? undefined : { ...found, archived: true }; } };
    await expect(createTaskActions(archived.h.deps).continue(archived.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    const lost = await seedPlain();
    lost.h.deps.access = { ...lost.h.deps.access, checkStep: async () => ({ allowed: false, message: "This person no longer has access to the project." }) };
    const before = await stateOf(lost.h);
    await expect(createTaskActions(lost.h.deps).continue(lost.caller, TASK_ID, ask())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stateOf(lost.h)).toEqual(before);
    for (const world of [archived, lost]) expect(await secondRound(world.h)).toHaveLength(0);
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
      if (what === "busy") await racingWorld!.h.store.update({ key: workspaceKey(WORKSPACE_ID), ops: [change.set("status", "BUSY"), change.set("activeOperationId", "op-other")] });
      else {
        await racingWorld!.h.store.put({ item: { ...operationRequestKey(OWNER_KEY, WORKSPACE_ID, REQUEST_A), entityType: "IDEMPOTENCY", operationId: "op-other", payloadHash: "f".repeat(64) } });
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

  it("does not start a second round while the first is still running, whatever the request id", async () => {
    const { h, caller } = await seedPlain();
    const actions = createTaskActions(h.deps);
    await actions.continue(caller, TASK_ID, ask());
    await expect(actions.continue(caller, TASK_ID, ask("Another.", REQUEST_B))).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(await secondRound(h)).toHaveLength(1);
  });
});

describe("the owner's route", () => {
  const route = async (who: "owner" | "guest") => {
    const { h } = await seedPlain();
    const routes = createOwnerRoutes({ flow: h.flow, blobs: {} as never, openPage: async () => undefined, version: "0.0.0-test" });
    const answered = (await routes({ method: "POST", path: `/v1/dev/tasks/${TASK_ID}/continue`, headers: {}, body: JSON.stringify(ask()) }, who === "owner" ? h.owner : h.guest))!;
    return { h, status: answered.statusCode, json: JSON.parse(answered.body) as { task?: { status: string }; error?: { code: string; message: string } } };
  };

  it("serves continue at /continue as the owner, and says no such task to anyone else", async () => {
    const ok = await route("owner");
    expect(ok.status).toBe(200);
    expect(ok.json.task?.status).toBe("RUNNING");
    const no = await route("guest");
    expect(no.status).toBe(404);
    expect(no.json.error?.code).toBe("TASK_NOT_FOUND");
    expect(await secondRound(no.h)).toHaveLength(0);
  });
});
