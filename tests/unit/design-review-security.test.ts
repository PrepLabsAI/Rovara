// The security rules of the design review in Code's own wiring: the packet route (who may read which reviewer's packet), the one-shot model key of a reviewer's slot, the rule that a design-review operation never gets a key of
// its own, the blocker-reason rule and its record, the tier a reviewed design is approved at, the hold nobody can answer, and a flow with the switch off. Each test names the rule it holds; a change that loosens a rule fails one of them.
import { describe, expect, it } from "vitest";
import { DesignReviewBindingSchema, WORKER_INVOCATION_FEATURES, type PlanDocument } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { DESIGN_REVIEW_PACKET_PATH, handleDesignReviewPacket } from "../../packages/broker/src/core/design-review/packet-route.js";
import { readSlotPacket } from "../../packages/broker/src/core/design-review/packet-store.js";
import { readSlotKeyRecord } from "../../packages/broker/src/core/design-review/slot-keys.js";
import { checkDesignApproval, designApprovalRecordItems, designRiskOf, gradeApprovalRisk } from "../../packages/broker/src/core/design-review/decision.js";
import { SubjectRefusal } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { gradePlanRisk } from "../../packages/broker/src/core/decisions/plan-risk.js";
import { NO_LESSONS_USED } from "../../packages/broker/src/core/build-step/changed-files.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { proofDesignOf } from "../../packages/broker/src/core/design-review/design-proof.js";
import { designNotRunLine } from "../../packages/broker/src/core/design-review/not-run.js";
import { designProofLine } from "../../packages/broker/src/core/design-review/proof-line.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY, SIGNING_KEY } from "../support/task-flow-harness.js";
import { runDueDispatches } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { UNPRICED_REFERENCE_PRICE, spendAcceptedFor, unpricedNoteOf, unpricedReferencePriceOf } from "../../packages/broker/src/local/app/design-review.js";
import { answerRound, choose, localDesignReview, design, finish, mintKeys, nextJob, taskOf, toDesignPhase, toRound, waitingWithBlocker, world, planned, type World } from "../support/design-review-flow-world.js";

const CAPABILITY = "x-agentx-callback-capability";
const STAMP = "x-rovara-workspace";
const capabilities = new CallbackCapabilities(SIGNING_KEY);

/** A round handed to the worker: the operation, the capability it carries, and a way to ask the packet route as the worker's gateway would. */
async function dispatched(w: World, tier?: "standard") {
  await toRound(w);
  const round = await nextJob(w);
  const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
  const ask = (slot: string, over: { stamp?: string | null; capability?: string } = {}) => handleDesignReviewPacket(w.h.deps, capabilities, {
    method: "GET", path: `${DESIGN_REVIEW_PACKET_PATH}?slot=${slot}`,
    headers: { [CAPABILITY]: over.capability ?? round.invocation.callbackCapability, ...(over.stamp === null ? {} : { [STAMP]: over.stamp ?? w.workspaceId }) },
  });
  void tier;
  return { round, binding, ask };
}

describe("the packet route", () => {
  it("serves each reviewer exactly the packet the broker stored for its own slot, and no other", async () => {
    const w = await world({ tier: "standard", capUsd: 60 });
    const { round, binding, ask } = await dispatched(w);
    expect(binding.reviewers.length).toBeGreaterThan(1);
    const bodies = new Set<string>();
    for (const reviewer of binding.reviewers) {
      const stored = await readSlotPacket(w.h.store, COMPANY, round.operation.id, binding.round, reviewer.keySlot);
      const answer = await ask(reviewer.keySlot);
      expect(answer.statusCode).toBe(200);
      expect(answer.body).toBe(stored!.text);
      bodies.add(answer.body);
    }
    // The reviewers' packets differ (each has its own role prompt), so a route that served one slot's packet for another would fail above.
    expect(bodies.size).toBe(binding.reviewers.length);
  });

  it("refuses a request whose workspace stamp is missing or another worker's", async () => {
    const w = await world();
    const { ask, binding } = await dispatched(w);
    const slot = binding.reviewers[0]!.keySlot;
    await expect(ask(slot, { stamp: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(ask(slot, { stamp: null })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("refuses a slot the stored binding does not hold, the merge slot, and a slot name that is not a slot's shape, all with the same words", async () => {
    const w = await world({ tier: "standard", capUsd: 60 });
    const { ask, binding } = await dispatched(w);
    const refusals: string[] = [];
    for (const slot of ["r2-critic", "r1-nothing", "r9-merge", "../r1-critic", "R1-CRITIC", ""]) {
      await ask(slot).then(() => { throw new Error(`served ${slot}`); }, (error: unknown) => { refusals.push((error as { message: string }).message); expect((error as { code: string }).code).toBe("FORBIDDEN"); });
    }
    if (binding.merge !== undefined) await expect(ask(binding.merge.keySlot)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(new Set(refusals).size).toBe(1);
  });

  it("refuses a packet that does not hash to the digest the binding carries", async () => {
    const w = await world();
    const { ask, binding, round } = await dispatched(w);
    const slot = binding.reviewers[0]!.keySlot;
    expect((await ask(slot)).statusCode).toBe(200);
    const tampered = { ...binding, reviewers: binding.reviewers.map((reviewer) => ({ ...reviewer, packetDigest: "e".repeat(64) })) };
    await w.h.store.update({ key: operationKey(w.workspaceId, round.operation.id), ops: [{ op: "set", path: ["designReview"], value: JSON.parse(JSON.stringify(tampered)) as never }] });
    await expect(ask(slot)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a capability without the packet action, one with another fence, one for an operation that ended, and one for an ordinary operation", async () => {
    const w = await world();
    const { ask, binding, round } = await dispatched(w);
    const slot = binding.reviewers[0]!.keySlot;
    const issue = (actions: string[], fence = round.operation.fence) => capabilities.issue({ workspaceId: w.workspaceId, operationId: round.operation.id, fence, actions: actions as never, expiresInSeconds: 60 });
    await expect(ask(slot, { capability: issue(["events", "artifacts", "result", "model-access"]) })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(ask(slot, { capability: issue(["design-review-packet"], round.operation.fence + 1) })).rejects.toMatchObject({ code: "STALE_FENCE" });
    await mintKeys(w, round.operation);
    await answerRound(w, round.operation, () => []);
    await expect(ask(slot)).rejects.toMatchObject({ code: "STALE_FENCE" });
    // An ordinary planning operation has no stored binding: its capability cannot read a packet even if it carried the action.
    const second = await world();
    await toDesignPhase(second);
    const planning = await nextJob(second);
    const plain = capabilities.issue({ workspaceId: second.workspaceId, operationId: planning.operation.id, fence: planning.operation.fence, actions: ["design-review-packet"], expiresInSeconds: 60 });
    await expect(handleDesignReviewPacket(second.h.deps, capabilities, { method: "GET", path: `${DESIGN_REVIEW_PACKET_PATH}?slot=r1-critic`, headers: { [CAPABILITY]: plain, [STAMP]: second.workspaceId } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

const slotGrants = localDesignReview;

describe("a reviewer's model key", () => {
  it("is minted once: a second ask for the slot is refused, and the first key is blocked at the proxy", async () => {
    const w = await world();
    const { round, binding } = await dispatched(w);
    const { local, closed } = slotGrants(w);
    const operation = { workspaceId: w.workspaceId, operationId: round.operation.id, fence: round.operation.fence };
    const slot = binding.reviewers[0]!.keySlot;
    const grant = await local.slotGrants.describeSlot(operation, slot);
    expect(grant).toMatchObject({ routes: [{ alias: "anthropic/m1" }], budget: { currency: "USD" }, projectName: "payments" });
    expect(grant!.budget!.micros).toBeGreaterThan(0);
    await local.slotGrants.slotMinted(operation, slot, { keyId: "a".repeat(64), expiresAt: Date.now() + 1 });
    expect(await readSlotKeyRecord(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot })).toMatchObject({ keyId: "a".repeat(64), askedAgain: 0 });
    await expect(local.slotGrants.describeSlot(operation, slot)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(closed).toEqual(["a".repeat(64)]);
    expect(await readSlotKeyRecord(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot })).toMatchObject({ askedAgain: 1 });
  });

  it("is recorded once even when two asks race past the check: the second record is refused", async () => {
    const w = await world();
    const { round, binding } = await dispatched(w);
    const { local } = slotGrants(w);
    const operation = { workspaceId: w.workspaceId, operationId: round.operation.id, fence: round.operation.fence };
    const slot = binding.reviewers[0]!.keySlot;
    await local.slotGrants.slotMinted(operation, slot, { keyId: "b".repeat(64), expiresAt: Date.now() + 1 });
    await expect(local.slotGrants.slotMinted(operation, slot, { keyId: "c".repeat(64), expiresAt: Date.now() + 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await readSlotKeyRecord(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot }))!.keyId).toBe("b".repeat(64));
  });

  it("is given only for a slot of the stored binding and only for the model the binding names", async () => {
    const w = await world();
    const { round, binding } = await dispatched(w);
    const operation = { workspaceId: w.workspaceId, operationId: round.operation.id, fence: round.operation.fence };
    const slot = binding.reviewers[0]!.keySlot;
    expect(await slotGrants(w).local.slotGrants.describeSlot(operation, "r1-other")).toBeUndefined();
    expect(await slotGrants(w, { model: "other" }).local.slotGrants.describeSlot(operation, slot)).toBeUndefined();
  });

  it("is never the operation's own: a design-review operation is known as one, an ordinary one is not", async () => {
    const w = await world();
    const { round } = await dispatched(w);
    const { local } = slotGrants(w);
    expect(await local.isDesignReviewOperation({ workspaceId: w.workspaceId, operationId: round.operation.id })).toBe(true);
    const other = await world();
    await toDesignPhase(other);
    const planning = await nextJob(other);
    expect(await slotGrants(other).local.isDesignReviewOperation({ workspaceId: other.workspaceId, operationId: planning.operation.id })).toBe(false);
  });
});

describe("approving a design with an open blocker", () => {
  it("needs a one-line reason, takes no reason where no blocker is open, and leaves the approval record with the reason", async () => {
    const w = await world();
    const waiting = await waitingWithBlocker(w);
    expect(waiting).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN" });
    // No reason: refused in the review's own words. A reason: allowed. Other outcomes are not held to it.
    expect(() => checkDesignApproval(waiting, { outcome: "approve" })).toThrow(SubjectRefusal);
    expect(() => checkDesignApproval(waiting, { outcome: "approve", reason: "   " })).toThrow(/reason/u);
    expect(() => checkDesignApproval(waiting, { outcome: "approve", reason: "The plan sets the limit." })).not.toThrow();
    expect(() => checkDesignApproval(waiting, { outcome: "request_changes" })).not.toThrow();
    expect(() => checkDesignApproval(waiting, { outcome: "reject", reason: "no" })).not.toThrow();
    const record = designApprovalRecordItems({ taskId: w.taskId, before: waiting, after: waiting, attempt: { outcome: "approve", reason: "The plan sets the limit.", requestId: "r-1" }, approverId: "local-owner", approverLabel: "You", risk: "medium", at: "2026-11-09T10:00:00.000Z" });
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ kind: "put", item: { entityType: "DESIGN_APPROVAL", openBlockers: 1, proofReason: "The plan sets the limit.", approverLabel: "You", tier: "medium" } });
    // Nothing is recorded for a rejection, and a design without an open blocker takes no reason.
    expect(designApprovalRecordItems({ taskId: w.taskId, before: waiting, after: waiting, attempt: { outcome: "reject", requestId: "r-2" }, approverId: "x", approverLabel: "x", risk: "low", at: "t" })).toEqual([]);
  });

  it("takes no reason on a clean design: a reason where no blocker is open is refused, so it cannot be smuggled onto a clean approval", async () => {
    const w = await world();
    await toRound(w);
    const round1 = await nextJob(w);
    await mintKeys(w, round1.operation);
    await answerRound(w, round1.operation, () => []);
    const clean = (await taskOf(w)).workflow;
    expect(clean).toMatchObject({ stage: "PLAN_REVIEW", reviewPhase: "DESIGN" });
    expect(() => checkDesignApproval(clean, { outcome: "approve" })).not.toThrow();
    expect(() => checkDesignApproval(clean, { outcome: "approve", reason: "because" })).toThrow(SubjectRefusal);
  });
});

describe("the tier a reviewed design is approved at", () => {
  it("is high for a design that names infrastructure and a migration, whatever the review says (never lower than the plan's own grading)", async () => {
    const w = await world();
    await toRound(w);
    const round1 = await nextJob(w);
    await mintKeys(w, round1.operation);
    await answerRound(w, round1.operation, () => []);
    const waiting = (await taskOf(w)).workflow;
    const naming = `${design()}\nThis changes infra/terraform/iam.tf and adds db/migrations/0042_add_col.sql.\n`;
    const loaded = { format: "markdown" as const, markdown: naming } as never;
    // The review's own facts alone (areas touched: a new API) grade it medium; the paths the design names make it high.
    expect(gradeApprovalRisk({ loaded, workflow: waiting })).toBe("high");
    // It is never lower than what the plan grading says of the same document, and a design with nothing alarming stays at the review's own tier.
    const base = gradePlanRisk({ loaded, workflow: waiting });
    expect(["medium", "high"]).toContain(gradeApprovalRisk({ loaded, workflow: waiting }));
    expect(base).toBe("high");
    expect(gradeApprovalRisk({ loaded: { format: "markdown", markdown: design() } as never, workflow: waiting })).toBe("medium");
    // The review's own grading takes the paths the design names: the same design with an infrastructure path is high, without it medium.
    expect(designRiskOf(waiting, design(), ["infra/terraform/iam.tf", "db/migrations/0042_add_col.sql"])).toBe("high");
    expect(designRiskOf(waiting, design(), [])).toBe("medium");
    // The plan's keyword floor over the request is kept too: a request that says "migration" and "IAM" for production is high although the design names no path and the review alone says medium.
    const requestText = "Rotate the IAM roles and run a database migration for production";
    const plain = { format: "markdown" as const, markdown: design() } as never;
    expect(designRiskOf(waiting, design(), [])).toBe("medium");
    expect(gradePlanRisk({ loaded: plain, workflow: waiting, requestText })).toBe("high");
    expect(gradeApprovalRisk({ loaded: plain, workflow: waiting, requestText })).toBe("high");
  });
});

describe("a reviewer's model key when the model has no price here", () => {
  it("is not given unless the owner accepted \"price unknown\" at the cost hold: a model nobody priced and nobody accepted gets no key", async () => {
    const w = await world();
    const { round, binding } = await dispatched(w);
    const { local } = slotGrants(w, { priced: false });
    const operation = { workspaceId: w.workspaceId, operationId: round.operation.id, fence: round.operation.fence };
    expect(await local.slotGrants.describeSlot(operation, binding.reviewers[0]!.keySlot)).toBeUndefined();
  });

  it("is bounded by an assumed price once the owner accepted: the review runs on a laptop with an unpriced model, and its ceiling is held at the dearest public class", async () => {
    const w = await world({ price: false, holdAnswerable: true });
    await toRound(w);
    expect((await taskOf(w)).workflow.designReview).toMatchObject({ status: "waiting_cost" });
    expect(await choose(w, "run_unpriced")).toMatchObject({ status: "decided" });
    await runDueDispatches(w.h.deps);
    const round = await nextJob(w);
    const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
    const { local } = slotGrants(w, { priced: false });
    const operation = { workspaceId: w.workspaceId, operationId: round.operation.id, fence: round.operation.fence };
    const grant = await local.slotGrants.describeSlot(operation, binding.reviewers[0]!.keySlot);
    expect(grant).toMatchObject({ assumedPrice: UNPRICED_REFERENCE_PRICE, routes: [{ alias: "anthropic/m1" }], budget: { currency: "USD" } });
    expect(grant!.budget!.micros).toBeGreaterThan(0);
    expect(UNPRICED_REFERENCE_PRICE).toEqual({ inputMicrosPerMillionTokens: 15_000_000, outputMicrosPerMillionTokens: 75_000_000 });
    // A priced model never carries one.
    const priced = slotGrants(w, { priced: true }).local;
    expect((await priced.slotGrants.describeSlot(operation, binding.reviewers[1]?.keySlot ?? binding.reviewers[0]!.keySlot))).not.toHaveProperty("assumedPrice");
  });
});

describe("the figure an unpriced run is counted at", () => {
  it("is $15 and $75 per million tokens unless the install states another, and a figure that is not two positive numbers is ignored", () => {
    expect(unpricedReferencePriceOf({})).toEqual(UNPRICED_REFERENCE_PRICE);
    // The smallest figure that is a price: one micro-dollar per million tokens.
    expect(unpricedReferencePriceOf({ ROVARA_UNPRICED_REFERENCE_PRICE: "0.000001,0.000001" })).toEqual({ inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 });
    expect(unpricedReferencePriceOf({ ROVARA_UNPRICED_REFERENCE_PRICE: "150, 600" })).toEqual({ inputMicrosPerMillionTokens: 150_000_000, outputMicrosPerMillionTokens: 600_000_000 });
    for (const bad of ["", "15", "15,75,1", "a,b", "0,75", "-1,5", "15,Infinity", "1000000,5", "0.0000001,0.0000001", "1e-9,1e-9", "0.0000004,75", "15,0.0000004"]) expect(unpricedReferencePriceOf({ ROVARA_UNPRICED_REFERENCE_PRICE: bad })).toEqual(UNPRICED_REFERENCE_PRICE);
    expect(unpricedNoteOf(UNPRICED_REFERENCE_PRICE)).toBe("If you run it anyway, Rovara counts it at $15 and $75 per million tokens (input and output). A dearer model can cost more than the limit.");
  });
});

describe("which round an accepted \"price unknown\" is for", () => {
  const at = (minute: number) => `2026-11-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const reviewer = (endedAt: string) => ({ endedAt }) as never;
  const review = (approvalMinutes: number[], round1EndedMinute?: number) => ({
    rounds: round1EndedMinute === undefined ? [] : [{ round: 1, reviewers: [reviewer(at(round1EndedMinute))] }],
    approvals: approvalMinutes.map((minute) => ({ kind: "spend", at: at(minute), by: { actorId: "a" } })),
  }) as never;
  it("is the round the approval was made for: an approval from before the previous round ended does not cover a later round, and one made after it does", () => {
    // Round 1: the approval came before its operation was made.
    expect(spendAcceptedFor(review([5]), 1, at(6))).toBe(true);
    expect(spendAcceptedFor(review([]), 1, at(6))).toBe(false);
    // An approval made after the operation started is not for it.
    expect(spendAcceptedFor(review([7]), 1, at(6))).toBe(false);
    // Round 2: the round-1 approval (minute 5) is older than the end of round 1 (minute 20): no.
    expect(spendAcceptedFor(review([5], 20), 2, at(30))).toBe(false);
    // A fresh approval after round 1 ended covers round 2.
    expect(spendAcceptedFor(review([5, 25], 20), 2, at(30))).toBe(true);
    // Only a spend approval counts.
    expect(spendAcceptedFor({ rounds: [], approvals: [{ kind: "raise_cap", at: at(5), by: { actorId: "a" }, fromUsd: 10, capUsd: 20 }] } as never, 1, at(6))).toBe(false);
  });
});

describe("the hold nobody can answer", () => {
  it("ends the review as not run with a plain word, and the design goes to the owner: a task is never stranded at a cost choice it cannot be asked", async () => {
    const w = await world({ price: false });
    await toRound(w);
    expect((await taskOf(w)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN", designReview: { status: "not_run", notRunReason: "cost_declined" } });
  });
});

describe("the cost hold on this install", () => {
  it("is answerable in the local wiring: the owner's page offers the choices, so a hold waits for the owner instead of ending the review", async () => {
    const { local } = slotGrants(await world());
    expect(local.runtime.holdAnswerable).toBe(true);
  });
});

describe("a design that went through no review", () => {
  it("says so in plain words on the page and in the Proof line, with the reason in fixed words", async () => {
    const w = await world({ price: false });
    await toRound(w);
    const review = (await taskOf(w)).workflow.designReview!;
    expect(designNotRunLine(review)).toBe("Design review did not run: no price is known for the model on this install, so its cost could not be held to a limit.");
    expect(designNotRunLine({ ...review, status: "done" })).toBeUndefined();
    expect(designNotRunLine(undefined)).toBeUndefined();
    const waiting = (await taskOf(w)).workflow;
    const digest = waiting.artifacts.filter((artifact) => artifact.type === "design").at(-1)!.sha256;
    const context = { approved: { digest, text: design() }, review, approval: { approverLabel: "Priya", tier: "medium" as const, openBlockers: 0 } };
    expect(designProofLine(context)).toBe("Design review did not run: no price is known for the model on this install, so its cost could not be held to a limit. Approved by Priya (medium risk).");
    // The pull request's Proof section carries the same line.
    const task = await taskOf(w);
    const plan: PlanDocument = {
      schemaVersion: 1, title: "Retry", why: [{ text: "Timed-out payments are dropped.", author: "Priya" }], claims: [{ id: "1", text: "A timed-out payment is retried once." }], notChanging: ["Refunds stay as they are."], risks: ["A retry could charge twice."], decisions: [],
    };
    const body = workflowPullRequestBody(task, waiting, undefined, undefined, { lessonsUsed: NO_LESSONS_USED, proof: { plan, design: proofDesignOf(context) } });
    expect(body).toContain("### Proof");
    expect(body).toContain("Design review did not run: no price is known");
  });
});

describe("a reviewer's packet once the round is recorded", () => {
  it("is no longer served: the packet of a round the task already holds a record of is refused, whoever asks", async () => {
    const w = await world();
    const { round, binding, ask } = await dispatched(w);
    const slot = binding.reviewers[0]!.keySlot;
    expect((await ask(slot)).statusCode).toBe(200);
    const task = await taskOf(w);
    await w.h.store.update({ key: { pk: `DEVTASK#${w.taskId}`, sk: "META" }, ops: [{ op: "set", path: ["workflow", "designReview", "rounds"], value: [{ round: binding.round }] as never }] });
    void task;
    await expect(ask(slot)).rejects.toMatchObject({ code: "FORBIDDEN" });
    void round;
  });
});

describe("the switch", () => {
  it("is off: no review is made, no row, no key, and the task plans as it did before the stage existed", async () => {
    const w = await world({ flag: false });
    const prepare = await nextJob(w);
    await finish(w, prepare.operation, { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: "b".repeat(40) }] });
    const understand = await nextJob(w);
    await finish(w, understand.operation, { kind: "understood", assessment: { kind: "ready", path: "QUICK", restatement: "Retry once.", assumptions: [], design: { needed: true, reasons: ["data_model"], note: "x" } } });
    const planning = await nextJob(w);
    expect(planning.invocation.payload).toMatchObject({ workflowMode: "PLAN" });
    expect((planning.invocation.payload as { prompt: string }).prompt).not.toContain("rovara-design-meta");
    const after = (await taskOf(w)).workflow;
    expect(after.designReview).toBeUndefined();
    expect(after.path).toBe("QUICK");
    await finish(w, planning.operation, planned(w, planning.operation, "plan", "# Plan\nDo it.\n", 1));
    // The plan gets the plan check of every coding plan (a read-only step), and nothing of the design review: no binding, no packet, no key.
    const check = await nextJob(w);
    expect(check.operation).toMatchObject({ workflowMode: "PLAN_CRITIQUE" });
    expect(check.operation.designReview).toBeUndefined();
    expect(check.invocation.payload).not.toHaveProperty("designReview");
    expect((await taskOf(w)).workflow.designReview).toBeUndefined();
    void WORKER_INVOCATION_FEATURES;
  });
});
