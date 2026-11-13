// Each reviewer's key is its own, a repeated or unknown role is refused, and the review's spend is held to the smaller of its two limits. These pin the rules a hosted install will rely on when it adopts this
// core: a slot is looked up only in the stored binding, a slot asked for twice gives no result and is charged its whole budget, a key is given exactly its ceiling, and the ceilings never add up past either room.
import { describe, expect, it } from "vitest";
import { DesignReviewBindingSchema, DesignReviewWorkerResultSchema, type DesignReviewBinding } from "@rovara-code/contracts";
import { bindingSlotOf, designReviewKeyIds, planSlotBudgets, readSlotCeiling, recordSlotReask } from "../../packages/core/src/core/design-review/slot-keys.js";
import { mergeBindingFor } from "../../packages/core/src/core/design-review/merge-binding.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { answerRound, localDesignReview, mintKeys, nextJob, taskOf, toRound, world } from "../support/design-review-flow-world.js";

const MODEL = { provider: "anthropic", modelId: "m1" };
const DIGEST = "d".repeat(64);
const binding = (withMerge = false): DesignReviewBinding => DesignReviewBindingSchema.parse({
  version: 1, round: 1,
  reviewers: [{ role: "critic", keySlot: "r1-critic", packetDigest: DIGEST, model: MODEL }, { role: "zoom_out", keySlot: "r1-zoom_out", packetDigest: DIGEST, model: MODEL }],
  ...(withMerge ? { merge: mergeBindingFor({ keySlot: "r1-merge", model: MODEL }) } : {}),
});

describe("a reviewer's slot", () => {
  it("is found only in the stored binding: a well-formed slot the binding does not name is nobody's", () => {
    const stored = binding();
    expect(bindingSlotOf(stored, "r1-critic")).toMatchObject({ keySlot: "r1-critic", purpose: "reviewer", role: "critic" });
    expect(bindingSlotOf(stored, "r1-zoom_out")).toMatchObject({ role: "zoom_out" });
    for (const slot of ["r2-critic", "r1-comprehension", "r1-merge", "R1-CRITIC", "", "r1 critic"]) expect(bindingSlotOf(stored, slot), slot).toBeUndefined();
  });
});

describe("a slot asked for its key twice", () => {
  it("gives no result: its key is not one the round verifies with, the reviewer does not count, and it is charged its key's whole budget", async () => {
    const w = await world();
    await toRound(w);
    const round = await nextJob(w);
    const stored = DesignReviewBindingSchema.parse(round.operation.designReview);
    await mintKeys(w, round.operation);
    const twice = stored.reviewers[0]!.keySlot;
    const budget = (await readSlotCeiling(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot: twice }))!;
    expect(await recordSlotReask(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot: twice }, Date.now())).toMatch(/^[0-9a-f]{64}$/u);
    const keys = await designReviewKeyIds(w.h.store, round.operation);
    expect(keys.bySlot.has(twice)).toBe(false);
    expect(keys.askedAgain.has(twice)).toBe(true);
    for (const reviewer of stored.reviewers.slice(1)) expect(keys.bySlot.has(reviewer.keySlot)).toBe(true);
    // The worker's report names the key it was minted, but the slot asked twice: it is not counted, and what it is charged is never less than its whole budget.
    await answerRound(w, round.operation, () => []);
    const runs = (await taskOf(w)).workflow.designReview!.rounds[0]!.reviewers;
    const run = runs.find((entry) => entry.role === stored.reviewers[0]!.role)!;
    expect(run.verified).toBe(false);
    expect(run.costUsd).toBeCloseTo(budget, 6);
  });
});

describe("a reviewer's key at the model proxy", () => {
  it("is given exactly its slot's ceiling, never more", async () => {
    const w = await world();
    await toRound(w);
    const round = await nextJob(w);
    const stored = DesignReviewBindingSchema.parse(round.operation.designReview);
    const { local } = localDesignReview(w);
    for (const reviewer of stored.reviewers) {
      const ceiling = (await readSlotCeiling(w.h.store, { orgId: COMPANY, operationId: round.operation.id, slot: reviewer.keySlot }))!;
      const grant = await local.slotGrants.describeSlot({ workspaceId: w.workspaceId, operationId: round.operation.id, fence: round.operation.fence }, reviewer.keySlot);
      expect(grant!.budget).toEqual({ micros: Math.round(ceiling * 1_000_000), currency: "USD" });
    }
  });
});

describe("the round's ceilings", () => {
  it("never add up past the smaller of the review's room and the task's room, whichever is smaller", () => {
    for (const [reviewRoomUsd, taskRoomUsd] of [[1, 100], [100, 1], [2.5, 2.5]] as const) {
      for (const withMerge of [false, true]) {
        const planned = planSlotBudgets({ binding: binding(withMerge), reviewRoomUsd, taskRoomUsd });
        const sum = Object.values(planned.ceilings).reduce((total, usd) => total + usd, 0);
        expect(sum).toBeCloseTo(planned.totalUsd, 9);
        expect(planned.totalUsd).toBeLessThanOrEqual(Math.min(reviewRoomUsd, taskRoomUsd) + 1e-9);
        expect(planned.totalUsd).toBeGreaterThan(0);
      }
    }
    expect(() => planSlotBudgets({ binding: binding(), reviewRoomUsd: 0, taskRoomUsd: 100 })).toThrow(/no budget left/u);
    expect(() => planSlotBudgets({ binding: binding(), reviewRoomUsd: 100, taskRoomUsd: 0 })).toThrow(/no budget left/u);
  });
});

describe("a worker's result", () => {
  it("is refused by its schema when a role, or a key slot, appears twice", () => {
    const outcome = (role: string, keySlot: string) => ({ role, keySlot, status: "no_result", failure: "timeout", retried: false, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-09T10:00:00.000Z", endedAt: "2026-11-09T10:00:00.000Z" });
    const result = (reviewers: unknown[]) => ({ version: 1, round: 1, reviewers, merge: { status: "skipped", tokensIn: 0, tokensOut: 0, costUsd: 0 }, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false });
    expect(DesignReviewWorkerResultSchema.safeParse(result([outcome("critic", "r1-critic"), outcome("zoom_out", "r1-zoom_out")])).success).toBe(true);
    expect(DesignReviewWorkerResultSchema.safeParse(result([outcome("critic", "r1-critic"), outcome("critic", "r1-zoom_out")])).success).toBe(false);
    expect(DesignReviewWorkerResultSchema.safeParse(result([outcome("critic", "r1-critic"), outcome("zoom_out", "r1-critic")])).success).toBe(false);
  });
});
