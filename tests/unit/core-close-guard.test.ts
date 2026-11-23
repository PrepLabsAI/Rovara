// The close guard (CORE-CLOSE-PREVIEW). Every provider and every machine here is a fake port, NOT machine proof: whether real unpublished work on a real machine is found and kept is proven by the retention
// lane's Linux grid and a real call after install. What these tests pin is the DECISION and the commit conditions around it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { change, workspaceSessionKey } from "@agentx/contracts";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { closeLoadedTask } from "../../packages/broker/src/core/task-flow/close.js";
import { assertCloseGuardComposition, sessionEvidenceOf, type CloseCheckPort } from "../../packages/broker/src/core/task-flow/close-guard.js";
import { CLOSE_CANNOT_CHECK_WORDS, CLOSE_CHECKING_WORDS, CLOSE_TRY_AGAIN_WORDS, retainedCloseWords } from "../../packages/broker/src/core/task-flow/close-words.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { operationKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { guardWorld, refusal, sessionItem, type GuardWorld } from "../support/close-guard-world.js";

const checker = (answer: "queued" | "already" | "unsupported" = "queued"): CloseCheckPort & { request: ReturnType<typeof vi.fn> } => ({ request: vi.fn(async () => answer) });
// eslint-disable-next-line @typescript-eslint/unbound-method -- the port's `request` is the test's own mock function
const asked = (check: CloseCheckPort) => vi.mocked(check.request);
const closedAt = async (w: GuardWorld) => (await readTask(w.h.deps, w.task.taskId))?.closedAt;
/** The refusal left everything as it was: no row changed and no machine was stopped, terminated or started. */
async function expectUntouched(w: GuardWorld, before: Awaited<ReturnType<GuardWorld["rows"]>>) {
  expect(await w.rows()).toEqual(before);
  for (const effect of [w.terminate, w.stop, w.start]) expect(effect).not.toHaveBeenCalled();
  expect(await closedAt(w)).toBeUndefined();
}

describe("without the guard on the install (the laptop, and today's hosted close)", () => {
  it("closes a machine-backed workspace exactly as before: the guard is a seam, nothing is wired by this lane", async () => {
    const w = await guardWorld({ guard: false, machine: "backed" });
    await w.close();
    expect(await closedAt(w)).toBeDefined();
    expect(w.terminate).toHaveBeenCalledWith(w.machineId);
  });
});

describe("G1: a workspace that never had a machine", () => {
  it("is closed, and no machine is terminated", async () => {
    const w = await guardWorld({ machine: "none" });
    await w.close();
    expect(await closedAt(w)).toBeDefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("a session item that says NONE (generation 0) is still no machine", async () => {
    const w = await guardWorld({ machine: "none", session: { state: "NONE", generation: 0 } });
    await w.close();
    expect(await closedAt(w)).toBeDefined();
  });
  it("a machine recorded between the read and the commit makes the close conflict: nothing is closed", async () => {
    const w = await guardWorld({ machine: "none" });
    w.raceOnce(async () => { await w.h.store.update({ key: w.wk, ops: [change.set("machine", { machineId: w.machineId, machineKey: w.task.workspaceId })] }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("a machine COUNT recorded in that window is also a conflict (the count, not only the machine, is the commit condition)", async () => {
    const w = await guardWorld({ machine: "none" });
    w.raceOnce(async () => { await w.h.store.update({ key: w.wk, ops: [change.set("machineGeneration", 1)] }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
  });
  it("a session item created in that window is a conflict", async () => {
    const w = await guardWorld({ machine: "none" });
    w.raceOnce(async () => { await w.h.store.put({ item: sessionItem(w.task.workspaceId, { state: "PROVISIONING" }) }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
  });
  it("a session item that is not gone (the dispatch is starting a machine) is machine-backed, not G1", async () => {
    const w = await guardWorld({ machine: "none", session: { state: "PROVISIONING" } });
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    await expectUntouched(w, before);
  });
});

describe("G2: a machine was recorded and its session is gone", () => {
  it("no session item at all: closed, and the machine is terminated once", async () => {
    const w = await guardWorld({ machine: "backed", session: "absent" });
    await w.close();
    expect(await closedAt(w)).toBeDefined();
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(w.terminate).toHaveBeenCalledWith(w.machineId);
  });
  it("a DELETED session: closed", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "DELETED", generation: 2 } });
    await w.close();
    expect(await closedAt(w)).toBeDefined();
  });
  it("the machine port saying 'terminated' is NOT the proof: a live session item is refused whatever health says", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "READY" } });
    // The fake port answers `terminated` for a machine id it never started: the old reading of "gone".
    expect((await w.h.machines.health(w.machineId)).state).toBe("terminated");
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    await expectUntouched(w, before);
  });
  for (const state of ["READY", "STOPPED", "STOPPING", "PROVISIONING", "DELETING"] as const) {
    it(`a ${state} session is machine-backed: refused, nothing written, nothing terminated`, async () => {
      const w = await guardWorld({ machine: "backed", session: { state, generation: 1 } });
      const before = await w.rows();
      expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
      await expectUntouched(w, before);
    });
  }
  it("a session re-created between the read and the commit (the same machine id, the next generation) is a conflict", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "DELETED", generation: 1 } });
    w.raceOnce(async () => { await w.h.store.put({ item: sessionItem(w.task.workspaceId, { state: "PROVISIONING", generation: 2 }) }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("a machine recorded again in that window (generation + 1, no session yet) is a conflict even though the session item is still absent", async () => {
    const w = await guardWorld({ machine: "backed", session: "absent" });
    w.raceOnce(async () => { await w.h.store.update({ key: w.wk, ops: [change.set("machineGeneration", 2)] }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("a step started in that window (the holder changed) is a conflict", async () => {
    const w = await guardWorld({ machine: "backed", session: "absent" });
    w.raceOnce(async () => { await w.h.store.update({ key: w.wk, ops: [change.set("activeOperationId", randomUUID())] }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
  });
});

describe("G2f: a FORGOTTEN machine (the machine removed, its count kept)", () => {
  it("with its session gone: closed", async () => {
    const w = await guardWorld({ machine: "forgotten", session: "absent" });
    expect((await w.workspace())?.machine).toBeUndefined();
    expect((await w.workspace())?.machineGeneration).toBe(1);
    await w.close();
    expect(await closedAt(w)).toBeDefined();
  });
  for (const state of ["READY", "STOPPED"] as const) {
    it(`with a ${state} session: NOT the never-had-a-machine case, and refused`, async () => {
      const w = await guardWorld({ machine: "forgotten", session: { state } });
      const before = await w.rows();
      expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
      await expectUntouched(w, before);
    });
  }
  it("a session that appears in the window is a conflict", async () => {
    const w = await guardWorld({ machine: "forgotten", session: "absent" });
    w.raceOnce(async () => { await w.h.store.put({ item: sessionItem(w.task.workspaceId, { state: "READY", generation: 2 }) }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
  });
});

describe("a FAILED session", () => {
  it("the FIRST generation that never reached READY is proven empty: closed", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "FAILED", generation: 1 }, check: checker() });
    await w.close();
    expect(await closedAt(w)).toBeDefined();
    expect(asked(w.h.deps.closeCheck!)).not.toHaveBeenCalled();
  });
  it("a later generation may sit on an earlier one's volume: it cannot be proven, so it is refused and no wake is requested (a wake would build a fresh empty volume)", async () => {
    const check = checker();
    const w = await guardWorld({ machine: "backed", session: { state: "FAILED", generation: 2 }, check });
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    expect(asked(check)).not.toHaveBeenCalled();
    await expectUntouched(w, before);
  });
  it("a FAILED first generation that did list worker features had been READY: refused", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "FAILED", generation: 1, extra: { workerFeatures: ["x"] } } });
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
  });
  it("V1: the session item's own fields prove the first generation never reached READY (a READY item always carries them)", () => {
    expect(sessionEvidenceOf({ state: "FAILED", generation: 1 }).kind).toBe("gone");
    for (const proof of [{ readyAt: "2026-11-09T09:00:00.000Z" }, { lastActivityAt: "2026-11-09T09:00:00.000Z" }, { workerFeatures: [] }]) expect(sessionEvidenceOf({ state: "FAILED", generation: 1, ...proof }).kind).toBe("unproven_failed");
    expect(sessionEvidenceOf({ state: "FAILED", generation: 3 }).kind).toBe("unproven_failed");
  });
});

describe("unknown is a refusal, never an allowance", () => {
  for (const [name, item] of [
    ["an unknown state", { state: "BOGUS", generation: 1 }],
    ["no generation", { state: "READY" }],
    ["a negative generation", { state: "READY", generation: -1 }],
    ["a fractional generation", { state: "READY", generation: 1.5 }],
  ] as const) {
    it(`a session item with ${name}`, async () => {
      const w = await guardWorld({ machine: "backed", session: "absent" });
      await w.h.store.put({ item: { ...workspaceSessionKey(w.task.workspaceId), ...item } });
      const before = await w.rows();
      expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
      await expectUntouched(w, before);
    });
  }
  it("an unreadable session item asks for no check either: a wake could not be told what it would wake", async () => {
    const check = checker();
    const w = await guardWorld({ machine: "backed", session: "absent", check });
    await w.h.store.put({ item: { ...workspaceSessionKey(w.task.workspaceId), state: "BOGUS", generation: 1 } });
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    expect(asked(check)).not.toHaveBeenCalled();
  });
  it("a session read that throws", async () => {
    const w = await guardWorld({ machine: "none" });
    const get = w.h.store.get.bind(w.h.store);
    w.h.store.get = async (key) => { if (key.sk === "SESSION") throw new Error("table unavailable"); return get(key); };
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    await expectUntouched(w, before);
  });
});

describe("G4: machine-backed with no preview", () => {
  it("no way to start a check: the exact 'can't check' words, nothing written, nothing terminated", async () => {
    const w = await guardWorld({ machine: "backed" });
    const before = await w.rows(), spies = w.writes();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    await expectUntouched(w, before);
  });
  it("an unbound discard flag is the same refusal: a discard needs a digest", async () => {
    const w = await guardWorld({ machine: "backed", check: checker("queued") });
    const before = await w.rows();
    expect(await refusal(w.close({ requestId: randomUUID(), discard_unpublished: true }))).toBe(CLOSE_CHECKING_WORDS);
    await expectUntouched(w, before);
  });
  for (const answer of ["queued", "already"] as const) {
    it(`a check ${answer}: the exact 'checking' words, and the request is made exactly once`, async () => {
      const check = checker(answer);
      const w = await guardWorld({ machine: "backed", check });
      const before = await w.rows();
      expect(await refusal(w.close())).toBe(CLOSE_CHECKING_WORDS);
      expect(asked(check)).toHaveBeenCalledTimes(1);
      expect(check.request.mock.calls[0]![1]).toMatchObject({ id: w.task.workspaceId });
      await expectUntouched(w, before);
    });
  }
  it("a check that cannot be started, or that throws, is 'can't check'", async () => {
    for (const check of [checker("unsupported"), { request: vi.fn(async () => { throw new Error("queue down"); }) }]) {
      const w = await guardWorld({ machine: "backed", check });
      expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
      expect(await closedAt(w)).toBeUndefined();
    }
  });
  it("a step is running: no check can start under it, so no request is made", async () => {
    const check = checker();
    const w = await guardWorld({ machine: "backed", check, idle: false });
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    expect(asked(check)).not.toHaveBeenCalled();
    await expectUntouched(w, before);
  });
  it("a check already holds the workspace (a close operation is running): 'checking', and no second request", async () => {
    const check = checker();
    const w = await guardWorld({ machine: "backed", check, idle: false });
    const holder = (await w.workspace())!.activeOperationId!;
    await w.h.store.update({ key: operationKey(w.h.deps.companyId, w.task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
    expect(await refusal(w.close())).toBe(CLOSE_CHECKING_WORDS);
    expect(asked(check)).not.toHaveBeenCalled();
  });
  it("one request per press and nothing more: repeated presses ask again only through the port (which makes it idempotent)", async () => {
    const check = checker("already");
    const w = await guardWorld({ machine: "backed", check });
    for (let press = 1; press <= 3; press += 1) {
      await refusal(w.close());
      expect(asked(check)).toHaveBeenCalledTimes(press);
    }
  });
});

describe("G3: a retained inspection exists (a fake provider)", () => {
  async function retained(safeToClose: boolean) {
    const w = await guardWorld({ machine: "backed", idle: false, check: checker() });
    const holder = (await w.workspace())!.activeOperationId!;
    await w.h.store.update({ key: operationKey(w.h.deps.companyId, w.task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
    w.h.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose, repositories: safeToClose ? [] : [{ name: "demo", reasons: ["unpushed_head"] }], contentDigest: "d".repeat(64) }, retentionId: "kept-1" }; } };
    expect(await prepareCloseInspection(w.h.deps, w.task.workspaceId, holder)).toBe(true);
    return w;
  }
  for (const safe of [false, true]) {
    it(`${safe ? "a clean" : "a dirty"} retained preview still refuses an UNBOUND close, with the exact retained words`, async () => {
      const w = await retained(safe);
      const before = await w.rows();
      expect(await refusal(w.close())).toBe(retainedCloseWords(w.task.taskId));
      expect(asked(w.h.deps.closeCheck!)).not.toHaveBeenCalled();
      await expectUntouched(w, before);
    });
  }
});

describe("system mode (Q4: skip or retain, never delete)", () => {
  const system = { mode: "system", closer: "test-sweep", key: "7" } as const;
  async function taskOf(w: GuardWorld) { return (await readTask(w.h.deps, w.task.taskId))!; }

  it("a workspace that may hold work is SKIPPED: a typed outcome, a log line, nothing written, nothing terminated", async () => {
    const w = await guardWorld({ machine: "backed", check: checker("queued") });
    const before = await w.rows();
    const outcome = await closeLoadedTask(w.h.deps, await taskOf(w), "owner", system);
    expect(outcome).toEqual({ outcome: "skipped", reason: "checking", words: CLOSE_CHECKING_WORDS });
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "task_flow.close_skipped", taskId: w.task.taskId, closer: "test-sweep", reason: "checking" }));
    expect(await w.rows()).toEqual(before);
    expect(w.terminate).not.toHaveBeenCalled();
    expect(asked(w.h.deps.closeCheck!)).toHaveBeenCalledTimes(1);
  });
  it("proof of no machine closes it, as a person's would", async () => {
    const w = await guardWorld({ machine: "none" });
    expect(await closeLoadedTask(w.h.deps, await taskOf(w), "owner", system)).toMatchObject({ outcome: "closed" });
    expect(await closedAt(w)).toBeDefined();
  });
  it("a clean retained preview closes through the BOUND path: accepted under the system's own identity, never a discard", async () => {
    const w = await guardWorld({ machine: "backed", idle: false });
    const holder = (await w.workspace())!.activeOperationId!;
    await w.h.store.update({ key: operationKey(w.h.deps.companyId, w.task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
    w.h.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: true, repositories: [], contentDigest: "e".repeat(64) }, retentionId: "kept-2" }; } };
    expect(await prepareCloseInspection(w.h.deps, w.task.workspaceId, holder)).toBe(true);
    const resumed = vi.fn(async () => {});
    w.h.deps.resumeAcceptedClose = resumed;
    const outcome = await closeLoadedTask(w.h.deps, await taskOf(w), "owner", system);
    expect(outcome.outcome).toBe("accepted");
    expect(resumed).toHaveBeenCalledTimes(1);
    const accepted = (await w.h.store.get(operationKey(w.h.deps.companyId, w.task.workspaceId, (await taskOf(w)).closeOperationId!)))!;
    expect(accepted).toMatchObject({ kind: "close", closeAcceptance: { discardUnpublished: false, actorId: "system:test-sweep" } });
    // A second close of the accepted task is the accepted close's conflict, not another acceptance.
    await expect(closeLoadedTask(w.h.deps, await taskOf(w), "owner", system)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("a preview that changed between the guard's read and the acceptance is not accepted: skipped, nothing accepted", async () => {
    const w = await guardWorld({ machine: "backed", idle: false });
    const holder = (await w.workspace())!.activeOperationId!;
    await w.h.store.update({ key: operationKey(w.h.deps.companyId, w.task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
    let proofs = 0;
    // The first reads of the preview are proven; the acceptance's own read finds the retention gone (a step started, a newer inspection).
    w.h.deps.closeInspection = { async raiseFence() {}, async retained() { proofs += 1; return proofs <= 2; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: true, repositories: [], contentDigest: "e".repeat(64) }, retentionId: "kept-4" }; } };
    expect(await prepareCloseInspection(w.h.deps, w.task.workspaceId, holder)).toBe(true);
    w.h.deps.resumeAcceptedClose = vi.fn(async () => {});
    const outcome = await closeLoadedTask(w.h.deps, await taskOf(w), "owner", system);
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "retained" });
    expect((await taskOf(w)).closeOperationId).toBeUndefined();
    expect(w.h.deps.resumeAcceptedClose).not.toHaveBeenCalled();
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("a DIRTY retained preview is never closed by the system: skipped with the retained words", async () => {
    const w = await guardWorld({ machine: "backed", idle: false });
    const holder = (await w.workspace())!.activeOperationId!;
    await w.h.store.update({ key: operationKey(w.h.deps.companyId, w.task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
    w.h.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }], contentDigest: "f".repeat(64) }, retentionId: "kept-3" }; } };
    await prepareCloseInspection(w.h.deps, w.task.workspaceId, holder);
    const outcome = await closeLoadedTask(w.h.deps, await taskOf(w), "owner", system);
    expect(outcome).toEqual({ outcome: "skipped", reason: "retained", words: retainedCloseWords(w.task.taskId) });
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
});

describe("the bound path and a closed task", () => {
  it("the bound close is untouched by the guard: a closed task answers as before", async () => {
    const w = await guardWorld({ machine: "none" });
    await w.close();
    const again = await w.close();
    expect(again.taskId).toBe(w.task.taskId);
    expect((await w.h.store.get(taskKey(w.task.taskId)))?.["closedAt"]).toBeDefined();
  });
});

describe("startup assertion: the guard and the retention provider are wired together or not at all", () => {
  it("both, or neither, is fine", () => {
    expect(() => assertCloseGuardComposition({})).not.toThrow();
    expect(() => assertCloseGuardComposition({ closeGuard: { enforce: true }, closeInspection: {}, closeCheck: {} })).not.toThrow();
  });
  it("F2: the guard and the provider without the check seam throw too: nothing would ever ask for a preview, so a task without one could never be closed", () => {
    expect(() => assertCloseGuardComposition({ closeGuard: { enforce: true }, closeInspection: {} })).toThrow(/without closeCheck/u);
  });
  it("a guard without a provider strands every close, and a provider without the guard leaves the hole open: both throw", () => {
    expect(() => assertCloseGuardComposition({ closeGuard: { enforce: true } })).toThrow(/without closeInspection/u);
    expect(() => assertCloseGuardComposition({ closeInspection: {} })).toThrow(/without closeGuard/u);
  });
});
