// F4-0 (plan rev 3, 7.2): the money exits of a second review's hold, pinned as they are TODAY, before the feature interface moves anything. One test per exit, on a REAL hosted Admission (real holds on the
// company's day row): "the hold is released (or not) exactly as today, and a double release changes nothing".
//   E1a  the step is not started, or acceptStep throws, after `prepare`   build-step/start.ts:482,486     released at once
//   E1b  `prepare` itself throws after its own reservation                  build-step/start.ts:464        NOT released by the engine; only the sweep
//   E2   an operation ends through a worker result                          task-flow/results.ts:98        released at once
//   E3   the acceptedCloseForRun early return                               task-flow/results.ts:91        NOT released here (left to E5)
//   E4   a close with an active operation                                   task-flow/close.ts:69          released at once
//   E5   close recovery                                                     close-recovery-finish.ts:33    released at once, by the engine itself, then the member, then the proxy bookkeeping
//   E6   the dispatcher ends an operation (no second review wired there)    dispatch.ts endOperation       NOT released at the exit; only the sweep
//   E7   the backstop: admission-hold-sweep                                 core/cost/holds.ts sweepExpiredHolds
// One finding (see DONE): the sweep gives back a hold PAST ITS OWN EXPIRY (a model call's hold lasts CALL_HOLD_SECONDS, 2 hours), not "within 15 minutes"; the job only RUNS every 15 minutes.
import { describe, expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { CALL_HOLD_SECONDS } from "../../packages/broker/src/core/cost/holds.js";
import { startReview } from "../../packages/broker/src/core/build-step/start.js";
import { closeTask } from "../../packages/broker/src/core/task-flow/close.js";
import { createTaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { acceptedCloseForRun } from "../../packages/broker/src/core/task-flow/close-recovery-state.js";
import { textField } from "../support/close-recovery-harness.js";
import { COMPANY, TASK_ID, WORKSPACE_ID, closeWithRunHold, failAcceptingTheStep, hostedHolds, reviewWorld, startReviewStep } from "../support/f4-pins-world.js";

/**
 * What the dispatcher's own exit does with a second review's hold TODAY: "sweep-only" (`deps.secondReview` is undefined on the dispatch-only root, so nothing is released at the exit and the admission-hold-sweep gives
 * it back when the hold expires). Lane DISPATCHER-RELEASE flips this ONE constant to "at-exit" (a release-only `operationEnded` on the dispatch-only root).
 */
const DISPATCH_EXIT_RELEASE = "sweep-only" as "sweep-only" | "at-exit";

/** A hold is a model call's: it lasts this long before the sweep may give it back. The sweep job itself runs every 15 minutes (core-host/jobs.ts). */
const HOLD_TTL_SECONDS = CALL_HOLD_SECONDS;
const SWEEP_EVERY_SECONDS = 15 * 60;

const reservationOf = (operation: { secondReviewPlan?: { reservationId?: string | undefined } | undefined } | undefined): string => {
  const id = operation?.secondReviewPlan?.reservationId;
  if (id === undefined) throw new Error("the review operation carries no reservation");
  return id;
};

describe("E1a: the step is not started, or acceptStep throws, after prepare: the hold goes back at once", () => {
  it("acceptStep throws: released, and a repeat changes nothing", async () => {
    const w = await reviewWorld();
    const admit = vi.spyOn(w.money.admission, "admit");
    const restore = failAcceptingTheStep(w.h);
    await expect(startReviewStep(w.h)).rejects.toThrow("store down");
    restore();
    // The hold WAS taken (the admission's own write went through) and the engine gave it back (start.ts:482).
    expect(admit.mock.calls.filter(([request]) => request.action === "model.call")).toHaveLength(1);
    expect(await w.money.stateOf((await admit.mock.results[0]!.value as { reservationId?: string }).reservationId)).toBe("released");
    expect(await w.money.reserved()).toBe(0);
    const before = await w.money.dayRow();
    await w.review.releaseHold(undefined);
    expect(await w.money.dayRow()).toBe(before);
  });

  it.each([
    ["the workspace is busy: WAITING", "WAITING", 1],
    ["the person the step runs for no longer holds it: STALE", "STALE", 1],
    ["the task moved on before prepare: STALE, no hold was ever taken", "STALE", 0],
  ] as const)("%s", async (why, expected, holdsTaken) => {
    const w = await reviewWorld();
    const admit = vi.spyOn(w.money.admission, "admit");
    let revision = (await readTask(w.h.deps, TASK_ID))!.workflow!.revision;
    if (expected === "WAITING") await w.h.store.update({ key: workspaceKey(COMPANY, WORKSPACE_ID), ops: [change.set("activeOperationId", "someone-else")] });
    else if (holdsTaken === 0) revision = 999;
    else w.h.deps.access = { ...w.h.deps.access, async checkStep() { return { allowed: false, message: "no longer allowed" }; } };
    expect(await startReview(w.h.deps, { taskId: TASK_ID, workflowRevision: revision }), why).toBe(expected);
    expect(admit.mock.calls.filter(([request]) => request.action === "model.call")).toHaveLength(holdsTaken);
    expect(await w.money.reserved()).toBe(0);
  });
});

describe("E1b: prepare itself throws after its own reservation: the engine releases nothing, only the sweep does", () => {
  it("the review step is not started; the hold stays open past the first sweep passes and is given back at its own expiry", async () => {
    const w = await reviewWorld();
    const real = w.review;
    let reserved: string | undefined;
    w.h.deps.secondReview = { ...real, prepare: async (input) => {
      const start = await real.prepare(input);
      reserved = start.record?.reservationId;
      throw new Error("prepare failed after its own reservation");
    } };
    await expect(startReviewStep(w.h)).rejects.toThrow("prepare failed after its own reservation");
    expect(reserved).toBeDefined();
    // No operation was accepted, and the engine (start.ts:464 has no catch, :482 and :486 are after it) released nothing.
    expect((await workspaceOperations(w.h.deps, WORKSPACE_ID)).filter((entry) => entry.workflowMode === "REVIEW")).toEqual([]);
    expect(await w.money.stateOf(reserved)).toBe("open");
    expect(await w.money.reserved()).toBeGreaterThan(0);
    // One sweep pass at every scheduled run for the first 15-minute steps finds nothing past its expiry.
    for (let elapsed = SWEEP_EVERY_SECONDS; elapsed < HOLD_TTL_SECONDS; elapsed += SWEEP_EVERY_SECONDS) {
      w.h.clock.advance(SWEEP_EVERY_SECONDS);
      expect(await w.money.sweepOnce()).toMatchObject({ released: 0 });
      expect(await w.money.stateOf(reserved)).toBe("open");
    }
    // Past the hold's own expiry one pass gives it back: net zero after one sweep pass.
    w.h.clock.advance(SWEEP_EVERY_SECONDS + 60);
    expect(await w.money.sweepOnce()).toMatchObject({ released: 1, failed: 0 });
    expect(await w.money.stateOf(reserved)).toBe("released");
    expect(await w.money.reserved()).toBe(0);
    // A second pass, and a release again, change nothing (E7: the backstop is idempotent).
    const before = await w.money.dayRow();
    expect(await w.money.sweepOnce()).toMatchObject({ released: 0 });
    await w.money.admission.release(reserved!);
    expect(await w.money.dayRow()).toBe(before);
  });

  it("with today's REAL service a throw after the reservation never reaches the engine: prepare releases its own hold and the review goes on", async () => {
    const w = await reviewWorld();
    w.review.deps.seams.route = async () => { throw new Error("route lookup down"); };
    const { result, operation } = await startReviewStep(w.h);
    expect(result).toBe("STARTED");
    expect(operation?.secondReviewPlan).toMatchObject({ notRun: { mode: "on", reason: "no-candidate" } });
    expect(await w.money.reserved()).toBe(0);
  });
});

describe("E2: an operation ended through a worker result: the hold goes back at once", () => {
  it("released at the result; a repeated result and a repeated release change nothing", async () => {
    const w = await reviewWorld();
    const { operation } = await startReviewStep(w.h);
    const id = reservationOf(operation);
    expect(await w.money.stateOf(id)).toBe("open");
    await w.h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: operation!.id, fence: operation!.fence, status: "FAILED", error: "the worker stopped" });
    expect(await w.money.stateOf(id)).toBe("released");
    expect(await w.money.reserved()).toBe(0);
    const before = await w.money.dayRow();
    await w.h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: operation!.id, fence: operation!.fence, status: "FAILED", error: "the worker stopped" });
    await w.review.operationEnded(operation!);
    await w.money.admission.release(id);
    expect(await w.money.dayRow()).toBe(before);
  });
});

describe("E4: a close with an active operation: the hold goes back at once", () => {
  it("the close ends the running review itself and gives the hold back; a repeated close changes nothing", async () => {
    const w = await reviewWorld();
    const { operation } = await startReviewStep(w.h);
    const id = reservationOf(operation);
    expect(await w.money.reserved()).toBeGreaterThan(0);
    await closeTask(w.h.deps, w.h.owner, TASK_ID);
    expect(await w.money.stateOf(id)).toBe("released");
    expect(await w.money.reserved()).toBe(0);
    const before = await w.money.dayRow();
    await w.review.operationEnded(operation!);
    await w.money.admission.release(id);
    expect(await w.money.dayRow()).toBe(before);
  });
});

describe("E3 and E5: a close accepted while a run holds a second review's allowance", () => {
  /** The run carries a plan with a real reservation, and the second review member only records what it saw (the engine releases the stored reservation itself, so the member sees it already closed). */
  async function withRunHold() {
    const { w, money, reservationId } = await closeWithRunHold();
    const calls: string[] = [];
    const proxy: string[] = [];
    w.h.deps.secondReview = { operationEnded: async (operation: { id: string }) => { calls.push(`${operation.id}:${String(await money.stateOf(reservationId))}`); } } as never;
    w.h.deps.onOperationEnded = (operationId) => { proxy.push(`${operationId}:${calls.length}`); };
    return { w, money, reservationId, calls, proxy };
  }

  it("E3: the run's own result after the close was accepted returns early: nothing is released at this exit, and the member and the proxy are not called", async () => {
    const { w, money, reservationId, calls, proxy } = await withRunHold();
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    const run = (await readOperation(w.h.deps, w.task.workspaceId, w.run.id))!;
    expect(await acceptedCloseForRun(w.h.deps, run)).toBeDefined();
    expect(await money.stateOf(reservationId)).toBe("open");
    expect(await w.h.flow.recordResult({ workspaceId: w.task.workspaceId, operationId: run.id, fence: run.fence, status: "CANCELLED" })).toEqual({ duplicate: false });
    expect(calls).toEqual([]);
    expect(proxy).toEqual([]);
    expect(await money.stateOf(reservationId)).toBe("open");
    // Left to close recovery (E5), the same hold is still there.
    expect(await money.reserved()).toBeGreaterThan(0);
  });

  it("E5: close recovery releases the stored reservation itself, then calls the member, then the proxy; a repeat changes nothing", async () => {
    const { w, money, reservationId, calls, proxy } = await withRunHold();
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    expect(await money.stateOf(reservationId)).toBe("open");
    w.restart();
    await w.pump();
    expect((await w.accepted())?.closeAcceptance?.phase).toBe("complete");
    expect(await money.stateOf(reservationId)).toBe("released");
    // The engine released it BEFORE the member ran (the member saw it already closed), and the proxy bookkeeping came after the member.
    expect(calls).toEqual([`${w.run.id}:released`]);
    expect(proxy).toEqual([`${w.run.id}:1`]);
    const before = await money.dayRow();
    await money.admission.release(reservationId);
    await w.pump();
    expect(await money.dayRow()).toBe(before);
    expect(textField((await w.h.store.get(w.tk))!, "taskId")).toBe(w.task.taskId);
  });
});

describe("E6: the dispatcher ends an operation: no second review is wired there, so the exit releases nothing", () => {
  it("an old worker ends the review step at the dispatcher; the hold is released only by the sweep (the ONE constant DISPATCH_EXIT_RELEASE flips this)", async () => {
    const w = await reviewWorld();
    const { operation } = await startReviewStep(w.h);
    const id = reservationOf(operation);
    // The dispatcher's deps: the same flow without the broker-only second review (dispatcher-core.ts hands the dispatch host no `secondReview`).
    const { secondReview: _kept, ...dispatcherDeps } = w.h.deps;
    void _kept;
    const dispatcher = createTaskFlow({ ...dispatcherDeps });
    expect(dispatcher.deps.secondReview).toBeUndefined();
    await dispatcher.relayOnce();
    // The harness's worker does not list the review feature (an old worker): the dispatcher ends the step, FAILED, "too old".
    let ended = await readOperation(dispatcher.deps, WORKSPACE_ID, operation!.id);
    for (let pass = 0; pass < 12 && ended?.status !== "FAILED"; pass += 1) {
      await dispatcher.dispatchOnce({ maxMessages: 10 });
      w.h.clock.advance(31);
      ended = await readOperation(dispatcher.deps, WORKSPACE_ID, operation!.id);
    }
    expect(ended?.status).toBe("FAILED");
    expect(ended?.error).toContain("too old");
    // The exit itself: nothing released (today), or released (once DISPATCHER-RELEASE lands).
    expect(await w.money.stateOf(id)).toBe(DISPATCH_EXIT_RELEASE === "sweep-only" ? "open" : "released");
    if (DISPATCH_EXIT_RELEASE === "at-exit") return;
    expect(await w.money.reserved()).toBeGreaterThan(0);
    // Net zero after the sweep passes the hold's own expiry, not before.
    expect(await w.money.sweepOnce()).toMatchObject({ released: 0 });
    w.h.clock.advance(HOLD_TTL_SECONDS + SWEEP_EVERY_SECONDS);
    expect(await w.money.sweepOnce()).toMatchObject({ released: 1, failed: 0 });
    expect(await w.money.stateOf(id)).toBe("released");
    expect(await w.money.reserved()).toBe(0);
  });
});

describe("E7: the backstop, admission-hold-sweep, and a double release", () => {
  it("gives back only a hold past its expiry; the same hold released twice, or swept after a release, changes nothing", async () => {
    const w = await reviewWorld({ mode: "off" });
    const money = hostedHolds(w.h);
    const open = await money.take();
    const released = await money.take();
    await money.admission.release(released);
    expect(await money.reserved()).toBeGreaterThan(0);
    w.h.clock.advance(HOLD_TTL_SECONDS - 60);
    expect(await money.sweepOnce()).toMatchObject({ released: 0 });
    expect(await money.stateOf(open)).toBe("open");
    w.h.clock.advance(120);
    // The pass finds the closed one's stale index row and the open one; only the open one is given back.
    await money.sweepOnce();
    expect(await money.stateOf(open)).toBe("released");
    expect(await money.reserved()).toBe(0);
    const before = await money.dayRow();
    await money.admission.release(open);
    await money.admission.release(released);
    await money.sweepOnce();
    expect(await money.dayRow()).toBe(before);
  });
});
