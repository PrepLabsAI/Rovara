// The design review's spend and the install's Admission port. A round asks the port for the whole sum its reviewers' keys may be given before anything is stored or dispatched; a refusal is the review
// not run; the round's reservation is kept on its allocation and given back when the round ends, whichever way it ends (what the keys spent is booked by the proxy's metering, never twice); a round that never starts
// gives it back too; and a second dispatch racing the first one waits instead of ending the review.
import { describe, expect, it } from "vitest";
import { DesignReviewBindingSchema, queryAll, type Admission, type AdmissionRequest, type Cost, type TransactItem } from "@rovara-code/contracts";
import { designReviewPartition } from "../../packages/core/src/core/design-review/packet-store.js";
import { designNotRunLine } from "../../packages/core/src/core/design-review/not-run.js";
import { readSlotAllocationReservation, readSlotCeiling } from "../../packages/core/src/core/design-review/slot-keys.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { claimRound, ROUND_CLAIM_SECONDS } from "../../packages/core/src/core/design-review/round-start.js";
import { recordDesignReviewRound, releaseDesignReviewRound } from "../../packages/core/src/core/design-review/round-record.js";
import { answerRound, design, finish, mintKeys, nextJob, planned, taskOf, toDesignPhase, toRound, world } from "../support/design-review-flow-world.js";

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
    expect(admission.released).not.toContain(reservationId);

    // Each key spent 0.05 as the proxy measured it: that is the review's spend, and the reservation is given back once the round is recorded (never settled: the proxy's metering books the spend).
    await mintKeys(w, round.operation);
    await answerRound(w, round.operation, () => []);
    const recorded = (await taskOf(w)).workflow.designReview!;
    const spent = recorded.rounds[0]!.reviewers.reduce((sum, run) => sum + run.costUsd, 0);
    expect(spent).toBeCloseTo(0.05 * binding.reviewers.length, 6);
    expect(admission.released.filter((id) => id === reservationId)).toEqual([reservationId]);
    expect(admission.settled).toEqual([]);
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

  it("gives back the reservation of a round whose operation failed, and charges the review a key the proxy cannot measure at its whole budget", async () => {
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
    expect(admission.released.filter((id) => id === reservationId)).toEqual([reservationId]);
    expect(admission.settled).toEqual([]);
    expect((await taskOf(w)).workflow.designReview!.spentUsd).toBeGreaterThanOrEqual(budgets - 1e-6);
  });

  it("charges a failed round everything its keys could have been given when the keys cannot be read, never nothing", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission });
    await toRound(w);
    const round = await nextJob(w);
    await mintKeys(w, round.operation);
    const total = (await w.h.store.get({ pk: designReviewPartition(COMPANY, round.operation.id), sk: "ALLOC" }))!["totalUsd"] as number;
    expect(total).toBeGreaterThan(0);
    const query = w.h.store.query.bind(w.h.store);
    w.h.store.query = async (request) => {
      if (request.pk === designReviewPartition(COMPANY, round.operation.id) && JSON.stringify(request.sk ?? "").includes("KEY#")) throw new Error("the store is down");
      return query(request);
    };
    await finish(w, round.operation, undefined, "FAILED", "the worker stopped");
    const review = (await taskOf(w)).workflow.designReview!;
    expect(review).toMatchObject({ status: "not_run", notRunReason: "worker_failed" });
    expect(review.spentUsd).toBeGreaterThanOrEqual(total - 1e-6);
    expect(admission.released).toContain(`res:design-review:${w.taskId}:${round.operation.id}`);
  });

  it("records no figure, never $0, for a failed round when neither its keys nor its allocation can be read, and says so in the log", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission });
    await toRound(w);
    const round = await nextJob(w);
    await mintKeys(w, round.operation);
    const partition = designReviewPartition(COMPANY, round.operation.id);
    // Every read of this round's partition fails (the hold then expires on its own: its id cannot be read either).
    const [query, get] = [w.h.store.query.bind(w.h.store), w.h.store.get.bind(w.h.store)];
    w.h.store.query = async (request) => { if (request.pk === partition) throw new Error("the store is down"); return query(request); };
    w.h.store.get = async (key) => { if (key.pk === partition && key.sk === "ALLOC") throw new Error("the store is down"); return get(key); };
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { logged.push(String(line)); };
    let released: Awaited<ReturnType<typeof releaseDesignReviewRound>>;
    try {
      released = await releaseDesignReviewRound({ table: w.h.store, keySpend: async () => undefined, closeKeys: async () => undefined, admission }, round.operation);
    } finally { console.log = log; }
    expect(released.spentUsd).toBeUndefined();
    expect(logged.some((line) => line.includes("design_review.spend_unknown"))).toBe(true);
  });

  it("gives back the hold of a round whose result has no binding it can read", async () => {
    const admission = recordingAdmission();
    const w = await world({ admission });
    await toRound(w);
    const round = await nextJob(w);
    const workflow = (await taskOf(w)).workflow;
    const reservationId = `res:design-review:${w.taskId}:${round.operation.id}`;
    const next = await recordDesignReviewRound({ table: w.h.store, keySpend: async () => 0, closeKeys: async () => undefined, readResult: async () => undefined, admission },
      { workflow, operation: { ...round.operation, designReview: { broken: true } as never }, design: { text: "", sha256: "0".repeat(64) }, requirementsText: "", now: "2026-11-09T10:00:00.000Z" });
    expect(next.designReview).toMatchObject({ status: "not_run", notRunReason: "worker_failed" });
    expect(admission.released).toContain(reservationId);
  });

  it("lets a second dispatch of the same round wait, and never end the review, while the first one holds the round", async () => {
    // The port refuses: if the racing dispatch asked it, the review would end as not run on a refusal the first dispatch's hold caused.
    const admission = recordingAdmission("refuse");
    const w = await world({ admission });
    await toDesignPhase(w);
    const planning = await nextJob(w);
    const revision = (await taskOf(w)).workflow.revision;
    for (let next = revision; next < revision + 10; next += 1) expect(await claimRound(w.h.store, { companyId: COMPANY, taskId: w.taskId, revision: next, operationId: "first-dispatch", nowMs: w.h.clock.now })).toBe(true);
    await finish(w, planning.operation, planned(w, planning.operation, "design", design(), 1));
    expect((await taskOf(w)).workflow.designReview).toMatchObject({ status: "estimating" });
    expect(admission.asked.filter(isReview)).toEqual([]);
    // Once the claim has expired, a dispatch prepares the round again (and here the port's refusal ends it).
    w.h.clock.advance(ROUND_CLAIM_SECONDS + 1);
    await w.h.flow.sweepOnce();
    await w.h.flow.relayOnce();
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    expect(admission.asked.filter(isReview).length).toBeGreaterThan(0);
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
