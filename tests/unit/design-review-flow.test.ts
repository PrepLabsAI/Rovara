// the design review stage end to end on the task flow's fakes. A Full task whose project asks for design review goes through Understand, the requirements, the design, a round of fresh
// reviewers (their packets and keys are the broker's), the planner's answer to their findings, a second round, and ends at the owner's approval card: nothing here approves anything, the approval gate does that.
// The worker is simulated by recording results directly; what the broker keeps (packets, slot budgets, key rows) is checked in the store.
import { describe, expect, it } from "vitest";
import { DesignReviewBindingSchema } from "@rovara-code/contracts";
import { designReviewPartition, readSlotPacket } from "../../packages/core/src/core/design-review/packet-store.js";
import { readSlotCeiling } from "../../packages/core/src/core/design-review/slot-keys.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { answerRound, approve, design, finish, mintKeys, nextJob, planned, taskOf, toDesignPhase, toRound, world } from "../support/design-review-flow-world.js";
import { queryAll } from "@rovara-code/contracts";

describe("the design review stage, end to end on the task flow", () => {
  it("runs a design through two rounds of fresh reviewers and the planner's answer, then waits for the owner", async () => {
    const w = await world();
    await toDesignPhase(w);

    // The design is written in the fixed template: the planner is told so beside its prompt.
    const planning = await nextJob(w);
    expect(planning.invocation.payload).toMatchObject({ workflowMode: "PLAN" });
    expect((planning.invocation.payload as { prompt: string }).prompt).toContain("rovara-design-meta");
    await finish(w, planning.operation, planned(w, planning.operation, "design", design(), 1));
    expect((await taskOf(w)).workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running" } });

    // Round 1: a plan-check operation with the binding; a worker without the feature would have been refused. The capability carries the packet and nothing a reviewer may not use.
    const round1 = await nextJob(w);
    expect(round1.operation).toMatchObject({ workflowMode: "PLAN_CRITIQUE", modelSourceId: "anthropic" });
    const binding1 = DesignReviewBindingSchema.parse(round1.operation.designReview);
    expect(round1.invocation.payload).toMatchObject({ workflowMode: "PLAN_CRITIQUE", designReview: binding1 });
    const actions = (JSON.parse(Buffer.from(round1.invocation.callbackCapability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] }).actions;
    expect(actions).toEqual(expect.arrayContaining(["design-review-packet", "artifacts", "events", "result"]));
    expect(actions).not.toContain("pull-request");
    // The packets are stored under the operation, one per reviewer, and each slot has a ceiling; nothing came from the worker.
    for (const reviewer of binding1.reviewers) {
      const stored = await readSlotPacket(w.h.store, COMPANY, round1.operation.id, 1, reviewer.keySlot);
      expect(stored, reviewer.keySlot).toBeDefined();
      expect(await readSlotCeiling(w.h.store, { orgId: COMPANY, operationId: round1.operation.id, slot: reviewer.keySlot })).toBeGreaterThan(0);
    }
    await mintKeys(w, round1.operation);
    await answerRound(w, round1.operation, () => [{ id: "1", severity: "major", section: "§3", text: "The retry has no limit.", citations: [{ kind: "design", section: "§3" }] }]);
    // The round is recorded from what the broker holds (the keys it minted, the packets it stored): a major finding goes to the planner. The packets are gone with the commit.
    const afterRound1 = await taskOf(w);
    expect(afterRound1.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", designReview: { status: "resolving" } });
    expect(afterRound1.workflow.designReview!.rounds[0]!.reviewers.every((run) => run.verified)).toBe(true);
    expect(afterRound1.workflow.designReview!.spentUsd).toBeGreaterThan(0);
    expect(await queryAll(w.h.store, { pk: designReviewPartition(COMPANY, round1.operation.id), sk: { op: "beginsWith", prefix: "PACKET#" } })).toEqual([]);

    // The planner answers the findings in its own run: the findings as data, the registered resolve prompt.
    const resolveRun = await nextJob(w);
    expect(resolveRun.invocation.payload).toMatchObject({ workflowMode: "PLAN" });
    expect((resolveRun.invocation.payload as { prompt: string }).prompt).toContain("The retry has no limit.");
    const revised = design("\nAt most three times.");
    const findingIds = (await taskOf(w)).workflow.designReview!.rounds[0]!.findings.map((finding) => finding.id);
    w.results.set(`${resolveRun.operation.id}:plan.md`, `${revised}\n\`\`\`rovara-design-resolve\n${JSON.stringify({ resolutions: findingIds.map((findingId) => ({ findingId, action: "fixed", note: "Added the limit." })) })}\n\`\`\`\n`);
    await finish(w, resolveRun.operation, { kind: "ended" });
    expect((await taskOf(w)).workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running" } });

    // Round 2 reviews the revised design (a new document under its own digest) and finds nothing: the design goes to the person.
    const round2 = await nextJob(w);
    expect(DesignReviewBindingSchema.parse(round2.operation.designReview).round).toBe(2);
    await mintKeys(w, round2.operation);
    await answerRound(w, round2.operation, () => []);
    const done = await taskOf(w);
    expect(done.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN", designReview: { status: "done" } });
    expect(done.workflow.designReview!.rounds).toHaveLength(2);
    expect(done.workflow.artifacts.filter((artifact) => artifact.type === "design")).toHaveLength(2);
  });
});

describe("the plan check of a coding plan, with the design review switched on", () => {
  it("still checks the coding plan after its design was reviewed and approved: the plan check is the plan check's own step, with no design-review binding, packet or key", async () => {
    const w = await world();
    await toRound(w);
    const round = await nextJob(w);
    await mintKeys(w, round.operation);
    await answerRound(w, round.operation, () => []);
    expect((await taskOf(w)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN", designReview: { status: "done" } });
    await approve(w);
    const planning = await nextJob(w);
    expect(planning.invocation.payload).toMatchObject({ workflowMode: "PLAN" });
    await finish(w, planning.operation, planned(w, planning.operation, "plan", "# Plan\n\nRetry a timed-out payment once.\n", 1));
    // The coding plan is read by the plan check, a read-only step of its own: no design-review binding, and no key slot.
    const check = await nextJob(w);
    expect(check.operation).toMatchObject({ workflowMode: "PLAN_CRITIQUE" });
    expect(check.operation.designReview).toBeUndefined();
    expect(check.invocation.payload).not.toHaveProperty("designReview");
    expect((await taskOf(w)).workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", reviewPhase: "IMPLEMENTATION_PLAN" });
    // The design review's own record is untouched by it.
    expect((await taskOf(w)).workflow.designReview).toMatchObject({ status: "done" });
  });
});
