// The design review's spend and the install's Admission port. A round asks the port for the whole sum its reviewers' keys may be given before anything is stored or dispatched; a refusal is the review
// not run; the round's reservation is kept on its allocation and settled with what the keys were measured to spend when the round ends, whichever way it ends; and a round that never starts gives it back.
import { describe, expect, it } from "vitest";
import { DesignReviewBindingSchema, queryAll, type Admission, type AdmissionRequest, type Cost, type TransactItem } from "@agentx/contracts";
import { designReviewPartition } from "../../packages/broker/src/core/design-review/packet-store.js";
import { designNotRunLine } from "../../packages/broker/src/core/design-review/not-run.js";
import { readSlotAllocationReservation, readSlotCeiling } from "../../packages/broker/src/core/design-review/slot-keys.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { answerRound, finish, mintKeys, nextJob, taskOf, toRound, world } from "../support/design-review-flow-world.js";

const isReview = (request: { idempotencyKey: string }): boolean => request.idempotencyKey.startsWith("design-review:");

/** An admission that answers the design review as told, allows everything else, and records what was asked, settled and given back. */
function recordingAdmission(review: "allow" | "refuse" | "throw" = "allow"): Admission & { asked: AdmissionRequest[]; settled: Array<{ id: string; cost: Cost | undefined }>; released: string[] } {
  const asked: AdmissionRequest[] = [];
  const settled: Array<{ id: string; cost: Cost | undefined }> = [];
  const released: string[] = [];
  return {
    asked, settled, released,
    async admit(request) {
      asked.push(request);
      if (isReview(request) && review === "refuse") return { allowed: false, code: "budget_exhausted", message: "The company's budget is used up." };
      if (isReview(request) && review === "throw") throw new Error("the ledger is down");
      return { allowed: true, reservationId: `res:${request.idempotencyKey}` };
    },
    async stage(request) { asked.push(request); return { decision: { allowed: true, reservationId: `res:${request.idempotencyKey}` }, items: [] as readonly TransactItem[] }; },
    async settle(id, actual) { settled.push({ id, cost: actual.cost }); },
    async release(id) { released.push(id); },
  };
}

describe("a design review round and the Admission port", () => {
  it("asks for the whole sum of the slots' ceilings before the round is dispatched, keeps the reservation on the allocation and settles it with the keys' measured spend", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission });
    await toRound(w);
    const round = await nextJob(w);
    const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
    const reviewAsks = admission.asked.filter(isReview);
    expect(reviewAsks).toHaveLength(1);
    const ask = reviewAsks[0]!;
    expect(ask).toMatchObject({ companyId: COMPANY, action: "model.call", idempotencyKey: `design-review:${w.taskId}:${round.operation.id}`, projectName: "payments", subject: { type: "task", id: w.taskId } });
    // What the port is asked to hold is every slot's ceiling together, never less (an estimate could be lower than what the keys may spend).
    let ceilings = 0;
    for (const reviewer of binding.reviewers) ceilings += (await readSlotCeiling(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot: reviewer.keySlot }))!;
    expect(ceilings).toBeGreaterThan(0);
    expect(ask.estimate?.cost).toEqual({ micros: Math.ceil(ceilings * 1_000_000), currency: "USD" });
    const reservationId = `res:design-review:${w.taskId}:${round.operation.id}`;
    expect(await readSlotAllocationReservation(w.h.store, { orgId: COMPANY, operationId: round.operation.id })).toBe(reservationId);
    expect(admission.settled.filter((entry) => entry.id === reservationId)).toEqual([]);

    // Each key spent 0.05 as the proxy measured it: the reservation is settled with that, once, and not given back.
    await mintKeys(w, round.operation);
    await answerRound(w, round.operation, () => []);
    const recorded = (await taskOf(w)).workflow.designReview!;
    const spent = recorded.rounds[0]!.reviewers.reduce((sum, run) => sum + run.costUsd, 0);
    expect(spent).toBeCloseTo(0.05 * binding.reviewers.length, 6);
    expect(admission.settled.filter((entry) => entry.id === reservationId)).toEqual([{ id: reservationId, cost: { micros: Math.ceil(spent * 1_000_000), currency: "USD" } }]);
    expect(admission.released).not.toContain(reservationId);
  });

  it("does not run the review when the port refuses it: nothing is stored or dispatched for the round, and the line says the spending limit left no room", async () => {
    const admission = recordingAdmission("refuse");
    const w = await world({ admission });
    await toRound(w);
    const task = await taskOf(w);
    expect(task.workflow.designReview).toMatchObject({ status: "not_run", notRunReason: "task_limit" });
    expect(designNotRunLine(task.workflow.designReview)).toBe("Design review did not run: the spending limit left no room for it.");
    const ask = admission.asked.filter(isReview);
    expect(ask).toHaveLength(1);
    // No round's operation exists, and nothing was stored under the operation id the round would have had.
    const operationId = ask[0]!.idempotencyKey.split(":").at(-1)!;
    expect(await queryAll(w.h.store, { pk: designReviewPartition(COMPANY, operationId), sk: { op: "beginsWith", prefix: "" } })).toEqual([]);
    expect(admission.settled).toEqual([]);
  });

  it("does not run the review when the port fails (a step that failed, never a round that runs unadmitted)", async () => {
    const admission = recordingAdmission("throw");
    const w = await world({ admission });
    await toRound(w);
    const task = await taskOf(w);
    expect(task.workflow.designReview).toMatchObject({ status: "not_run", notRunReason: "worker_failed" });
    const operationId = admission.asked.filter(isReview)[0]!.idempotencyKey.split(":").at(-1)!;
    expect(await queryAll(w.h.store, { pk: designReviewPartition(COMPANY, operationId), sk: { op: "beginsWith", prefix: "" } })).toEqual([]);
  });

  it("settles the reservation of a round whose operation failed with what its keys spent, charging a key the proxy cannot measure its whole budget", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission });
    w.runtime.keys.keySpend = async () => undefined;
    await toRound(w);
    const round = await nextJob(w);
    const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
    await mintKeys(w, round.operation);
    let budgets = 0;
    for (const reviewer of binding.reviewers) budgets += (await readSlotCeiling(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot: reviewer.keySlot }))!;
    await finish(w, round.operation, undefined, "FAILED", "the worker stopped");
    expect((await taskOf(w)).workflow.designReview).toMatchObject({ status: "not_run", notRunReason: "worker_failed" });
    const reservationId = `res:design-review:${w.taskId}:${round.operation.id}`;
    const settled = admission.settled.filter((entry) => entry.id === reservationId);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.cost!.micros).toBeGreaterThanOrEqual(Math.floor(budgets * 1_000_000));
  });

  it("gives the reservation back when the round cannot be stored after the port allowed it, and the review does not run", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission });
    const transact = w.h.store.transact.bind(w.h.store);
    w.h.store.transact = async (items) => {
      if (items.some((item) => item.kind === "put" && item.item["entityType"] === "DESIGN_REVIEW_PACKET")) throw new Error("the store is down");
      return transact(items);
    };
    await toRound(w);
    expect((await taskOf(w)).workflow.designReview).toMatchObject({ status: "not_run", notRunReason: "worker_failed" });
    const ask = admission.asked.filter(isReview);
    expect(ask).toHaveLength(1);
    expect(admission.released).toEqual(expect.arrayContaining([`res:${ask[0]!.idempotencyKey}`]));
    expect(admission.settled).toEqual([]);
  });

  it("asks nothing of the port for a round held for its cost: the hold comes before any money is asked for", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission, price: false, holdAnswerable: true });
    await toRound(w);
    expect((await taskOf(w)).workflow.designReview).toMatchObject({ status: "waiting_cost" });
    expect(admission.asked.filter(isReview)).toEqual([]);
  });
});
