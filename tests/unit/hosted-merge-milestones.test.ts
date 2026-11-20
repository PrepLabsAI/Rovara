// Lead 4 L4-HW7: the hosted merge-tracking pass writes the merge's milestones on the COMPANY's own milestone service (the one with the handlers registered), not on a fresh one with none. Before, a merged
// pull request's `merged` milestone was marked delivered with nobody told (no thread line, no ticket write-back, no lessons capture) and was never retried. Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it, vi } from "vitest";
import { codeMilestoneKey, type CodeMilestone, type OrgId } from "@agentx/contracts";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { CODE_MILESTONE_RETRY_MS, codeMilestoneItems, createDocumentMilestones, type CodeMilestoneHandler } from "../../packages/broker/src/core/milestones/milestones.js";
import { TASK_ID } from "../support/merge-world.js";
import { ORG, host } from "../support/service-host.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

type World = Awaited<ReturnType<typeof host>>;

/** The company's milestone service as the hosted root builds it (core-host/lessons.ts): one per company, handlers registered, attached to the flow. */
function companyMilestones(w: World, companyId: OrgId, handlers: readonly CodeMilestoneHandler[]) {
  const milestones = createDocumentMilestones({ store: w.h.store, now: () => w.clock.ms, companyId });
  for (const handler of handlers) milestones.register(handler);
  return milestones;
}

/** A handler that records what it was told and can be made to fail. */
function recorder(name: string, options: { failFirst?: number } = {}) {
  const told: CodeMilestone[] = [];
  let failures = options.failFirst ?? 0;
  const handler: CodeMilestoneHandler = { name, on: async (milestone) => {
    if (failures > 0) { failures -= 1; throw new Error("the chat was down"); }
    told.push(milestone);
  } };
  return { handler, told };
}

/** The hosted flow as the root leaves it for a company whose lessons are built: its milestone service in `deps.milestones`. */
function jobsWith(w: World, milestones: ReturnType<typeof companyMilestones>) {
  return createBrokerCoreServices({
    companyId: ORG, flow: { ...w.h.flow, deps: { ...w.h.deps, milestones } }, registry: w.registry, ciMode: async () => "their_ci_fix" as const, repository: w.world.host.repository, people: w.people, now: () => new Date(w.clock.ms),
  });
}

const merge = (w: World): void => { const pr = w.world.prs[0]!; expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged"); };
const mergedRow = async (w: World) => {
  const rows = (await w.world.store.query({ pk: `DEVTASK#${TASK_ID}` })).items.filter((item) => String(item.sk).startsWith("CODE_MILESTONE#") && item["kind"] === "merged");
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe("hosted merge tracking tells the company's milestone handlers", () => {

  it("a handler that fails is not marked heard, the row stays due, and the sweep tells it again until it works (once in the end)", async () => {
    const w = await host();
    const flaky = recorder("channel_thread", { failFirst: 2 }), steady = recorder("lessons");
    const milestones = companyMilestones(w, ORG, [flaky.handler, steady.handler]);
    merge(w);
    await jobsWith(w, milestones)["merge-tracking"].pass({ budgetMs: 1000 });
    let row = await mergedRow(w);
    expect(row["deliveredAt"]).toBeUndefined();
    expect(row["done_channel_thread"]).toBeUndefined();
    expect(row["tries_channel_thread"]).toBe(1);
    expect(row["dispatchDueSk"]).toBeDefined();
    // The healthy handler was told and is not told again by the retries.
    expect(row["done_lessons"]).toBe(true);
    expect(steady.told).toHaveLength(1);
    // Not due yet: the sweep leaves it.
    expect(await milestones.deliverDue()).toEqual({ attempted: 0 });
    w.clock.ms += CODE_MILESTONE_RETRY_MS + 1;
    expect(await milestones.deliverDue()).toEqual({ attempted: 1 });
    row = await mergedRow(w);
    expect(row["deliveredAt"]).toBeUndefined();
    expect(row["tries_channel_thread"]).toBe(2);
    w.clock.ms += 2 * CODE_MILESTONE_RETRY_MS + 1;
    expect(await milestones.deliverDue()).toEqual({ attempted: 1 });
    row = await mergedRow(w);
    expect(row["deliveredAt"]).toBeDefined();
    expect(row["done_channel_thread"]).toBe(true);
    expect(flaky.told.map((milestone) => milestone.kind)).toEqual(["merged"]);
    expect(steady.told).toHaveLength(1);
    expect(await milestones.deliverDue()).toEqual({ attempted: 0 });
  });
});

describe("two companies share one store and one due-time index", () => {
  /** A merged milestone of company B for its own task, written the way merge tracking writes it, still to be told. */
  async function plantForeign(w: World, companyId: OrgId, taskId: string) {
    const milestone: CodeMilestone = { kind: "merged", orgId: companyId, taskId, at: new Date(w.clock.ms).toISOString(), text: "The pull request was merged." };
    const put = await w.h.store.transact(codeMilestoneItems(milestone, 1, { definitionVersion: "1.1.0" }));
    expect(put.applied).toBe(true);
    return codeMilestoneKey(taskId, "merged", 1);
  }

  it("telling a task's milestones by id (the after-commit path) leaves another company's row alone too, even if the task id is B's", async () => {
    const w = await host();
    const otherTask = "33333333-3333-4333-8333-333333333333";
    const key = await plantForeign(w, B, otherTask);
    const a = recorder("channel_thread");
    await companyMilestones(w, ORG, [a.handler]).deliver(otherTask);
    expect(a.told).toHaveLength(0);
    const planted = (await w.h.store.get(key))!;
    expect(planted["deliveredAt"]).toBeUndefined();
    expect(planted["tries_channel_thread"]).toBeUndefined();
  });

  it("30 older due rows of companies with no sweeper do not hide this company's own due row (the sweep reads on past them), and each page stays at 25", async () => {
    const w = await host();
    for (let n = 0; n < 30; n++) {
      const task = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
      const milestone: CodeMilestone = { kind: "merged", orgId: B, taskId: task, at: new Date(w.clock.ms - 3_600_000 + n * 1000).toISOString(), text: "The pull request was merged." };
      expect((await w.h.store.transact(codeMilestoneItems(milestone, 1, { definitionVersion: "1.1.0" }))).applied).toBe(true);
    }
    const own = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
    await w.h.store.transact(codeMilestoneItems({ kind: "merged", orgId: ORG, taskId: own, at: new Date(w.clock.ms).toISOString(), text: "The pull request was merged." }, 1, { definitionVersion: "1.1.0" }));
    const heard = recorder("channel_thread");
    const queried = vi.spyOn(w.h.store, "queryIndex");
    expect(await companyMilestones(w, ORG, [heard.handler]).deliverDue()).toEqual({ attempted: 1 });
    expect(heard.told.map((milestone) => milestone.taskId)).toEqual([own]);
    expect(queried.mock.calls.every(([request]) => request.limit === 25)).toBe(true);
    expect(queried.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("an unreadable row (no company named) is still settled by a company's service, so it does not sit in the sweep forever", async () => {
    const w = await host();
    const taskId = "77777777-7777-4777-8777-777777777777";
    const key = codeMilestoneKey(taskId, "merged", 1);
    await w.h.store.put({ item: { ...key, entityType: "CODE_MILESTONE", taskId, kind: "merged", dispatchDuePk: "CODE_MILESTONE", dispatchDueSk: `${String(w.clock.ms).padStart(15, "0")}#${key.pk}#${key.sk}` } });
    const heard = recorder("channel_thread");
    expect(await companyMilestones(w, ORG, [heard.handler]).deliverDue()).toEqual({ attempted: 1 });
    expect(heard.told).toHaveLength(0);
    expect((await w.h.store.get(key))!["deliveredAt"]).toBeDefined();
  });
});
