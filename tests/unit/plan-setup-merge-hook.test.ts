// L4-SC (DEC 254z c): the merge hook. A task whose approved plan carried a mock or a command leaves ONE "Update setup" offer in the merge's own transaction, only when its pull request MERGED; a pull request closed
// without a merge, a plan with no setup change, or a plan nobody approved leaves nothing. Fake adapters only, as the service layer's own test.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPlanJson, change, type PlanSetupChangeItem } from "@agentx/contracts";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/index.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/index.js";
import { readSetupUpdates, setupUpdateKey } from "../../packages/broker/src/core/setup-agent/plan-update.js";
import { TASK_ID } from "../support/merge-world.js";
import { ORG, host } from "../support/service-host.js";
import { planDocument } from "../support/plan-documents.js";

const mock: PlanSetupChangeItem = { id: "s1", kind: "mock", service: "Stripe", variable: "STRIPE_API_URL", spec: "repo/app/openapi.yaml", reason: "The refund code calls Stripe." };
const variable: PlanSetupChangeItem = { id: "s3", kind: "variable", name: "STRIPE_WEBHOOK_SECRET", reason: "The webhook handler reads it." };

/** The host of the service layer's test, with the task's plan stored and (unless `approved` is false) approved by a person, and a merge tracking service that can read it. */
async function withPlan(items: PlanSetupChangeItem[] | undefined, options: { approved?: boolean } = {}) {
  const w = await host();
  const plan = planDocument(items === undefined ? {} : { setupChanges: items });
  const text = canonicalPlanJson(plan);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const at = "2026-11-09T10:00:00.000Z";
  const artifact = { id: "11111111-1111-4111-8111-111111111111", type: "plan", version: 1, sha256, producer: "agentx-worker-untrusted", objectKey: "plans/p.json", createdAt: at, format: "structured" };
  const approve = { requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 1, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "Approved.", artifactDigest: sha256, at };
  await w.world.store.update({ key: taskKey(TASK_ID), ops: [change.set(["workflow", "artifacts"], [artifact] as never), change.set(["workflow", "decisions"], (options.approved === false ? [] : [approve]))] });
  const reader = { get: async (key: string) => (key === "plans/p.json" ? new TextEncoder().encode(text) : undefined) };
  const tracking = createMergeTrackingService({
    flow: { ...w.h.deps, artifacts: reader }, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }),
    people: w.people, settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now: () => w.clock.ms,
  });
  return { ...w, tracking };
}
const offersOf = (w: Awaited<ReturnType<typeof withPlan>>) => readSetupUpdates({ store: w.world.store, companyId: ORG }, "web");

describe("the merge records the Update setup offer, once, in its own commit", () => {
  it("leaves one offer when the pull request merges, holding the approved items and the merged pull request", async () => {
    const w = await withPlan([mock, variable]);
    expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
    // not merged yet: nothing is offered
    expect(await offersOf(w)).toEqual([]);
    const pr = w.world.prs[0]!;
    expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
    w.clock.ms += 10 * 60_000;
    await w.tracking.sweep();
    const task = (await w.world.store.get(taskKey(TASK_ID)))!;
    expect(task["workflow"]).toMatchObject({ stage: "MERGED", outcome: "MERGED" });
    const offers = await offersOf(w);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ taskId: TASK_ID, title: "Update setup", carried: 1, pullRequests: [{ repository: "app", number: pr.number }] });
    expect(await w.world.store.get(setupUpdateKey(ORG, "web", TASK_ID))).toMatchObject({ state: "offered", planDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown });
    // a second sweep has nothing to record and the offer is still the one
    w.clock.ms += 10 * 60_000;
    await w.tracking.sweep();
    expect(await offersOf(w)).toHaveLength(1);
  });

  it("leaves nothing for a pull request closed without a merge", async () => {
    const w = await withPlan([mock]);
    const pr = w.world.prs[0]!;
    pr.model.update(String(pr.number), { state: "closed" });
    await w.tracking.sweep();
    expect(await offersOf(w)).toEqual([]);
    expect(await w.world.store.get(setupUpdateKey(ORG, "web", TASK_ID))).toBeUndefined();
  });

  it("leaves nothing when the plan had no setup change, only a variable, or no approval", async () => {
    for (const w of [await withPlan(undefined), await withPlan([variable]), await withPlan([mock], { approved: false })]) {
      const pr = w.world.prs[0]!;
      expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
      await w.tracking.sweep();
      expect((await w.world.store.get(taskKey(TASK_ID)))!["workflow"]).toMatchObject({ stage: "MERGED" });
      expect(await offersOf(w)).toEqual([]);
    }
  });
});
