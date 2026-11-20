// MR3b (TE-R3): the tracking pass WATCHES the merge order. A pull request merged by hand ahead of the one it depends on is said once (a `stuck` milestone naming every pull request of the task), and a pull request
// that depends on the repository still waiting stays a draft until it merges. Rovara never merges and never takes a merge back (owner decision 1). Fake code host and the in-memory store; never GitHub.
import { describe, expect, it } from "vitest";
import { codeMilestoneKey } from "../../packages/contracts/src/index.js";
import { trackTask, fixedCodeSettings, outOfOrderMilestoneItems, MERGE_ORDER_WORDS } from "../../packages/broker/src/core/merge/index.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/index.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { TASK_ID, mergeWorld } from "../support/merge-world.js";
import { ORG, host } from "../support/service-host.js";

const edge = (consumer: string, provider: string) => ({ consumer, provider, language: "node", source: "both" });

describe("the warning", () => {
  const SESSION_STUCK = (taskId: string) => ({ pk: codeMilestoneKey(taskId, "stuck", 0).pk });
  const stuckRows = async (w: Awaited<ReturnType<typeof host>>) => (await w.world.store.query({ pk: SESSION_STUCK(TASK_ID).pk, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#stuck#" } })).items;
  const mergeByHand = (w: Awaited<ReturnType<typeof host>>, repositoryId: string): void => {
    const pr = w.world.prs.find((entry) => entry.repositoryId === repositoryId)!;
    expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
  };
  /** A host with two repositories and a tracking service that reads `facts` (the word "none": no seam at all). */
  const withEdges = async (facts: unknown, repositories?: string[], seam?: () => unknown, wrap?: (milestones: ReturnType<typeof createMilestoneService>) => ReturnType<typeof createMilestoneService>) => {
    const w = await host(repositories === undefined ? { repositories: ["app", "payments-lib"] } : { repositories });
    const logged: Array<Record<string, unknown>> = [];
    const tracking = createMergeTrackingService({
      flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: (wrap ?? ((m) => m))(createMilestoneService({ store: w.h.store, now: () => w.clock.ms })), people: w.people,
      settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now: () => w.clock.ms, log: (entry) => { logged.push(entry); },
      ...(seam !== undefined ? { repositoryEdges: seam } : facts === "none" ? {} : { repositoryEdges: async () => facts }),
    });
    return { ...w, tracking, logged };
  };

  it("says once, naming every pull request, when a consumer is merged by hand before its provider", async () => {
    const w = await withEdges([edge("app", "payments-lib")]);
    mergeByHand(w, "app");
    await w.tracking.sweep();
    const rows = await stuckRows(w);
    expect(rows).toHaveLength(1);
    const text = rows[0]!["text"] as string;
    expect(text).toBe(MERGE_ORDER_WORDS.outOfOrderWarning("app", "payments-lib", [], 0));
    expect(text).toBe("app merged before payments-lib, which it depends on. Merge payments-lib next, or ask for a revert of app.");
    expect((rows[0]!["pullRequests"] as Array<{ repository: string }>).map((entry) => entry.repository)).toEqual(["app", "payments-lib"]);
    expect(rows[0]!["kind"]).toBe("stuck");
    // The session's timeline carries the same line (the milestone hook writes it in the same transaction).
    // Said once: the same facts seen again write nothing more.
    await w.world.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    await w.tracking.sweep();
    expect(await stuckRows(w)).toHaveLength(1);
    // The provider merging later does not undo what was said, and says nothing new.
    mergeByHand(w, "payments-lib");
    await w.world.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    await w.tracking.sweep();
    expect(await stuckRows(w)).toHaveLength(1);
  });

  it("says nothing when the merges follow the order, or when both merged before the pass looked (the host says the provider merged)", async () => {
    const inOrder = await withEdges([edge("app", "payments-lib")]);
    mergeByHand(inOrder, "payments-lib");
    await inOrder.tracking.sweep();
    mergeByHand(inOrder, "app");
    await inOrder.world.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    await inOrder.tracking.sweep();
    expect(await stuckRows(inOrder)).toEqual([]);
    // app sorts first, so the pass sees app merged while the workflow still has payments-lib open: the host is asked, and says it merged.
    const both = await withEdges([edge("app", "payments-lib")]);
    mergeByHand(both, "payments-lib");
    mergeByHand(both, "app");
    await both.tracking.sweep();
    expect(await stuckRows(both)).toEqual([]);
    expect(both.logged.some((entry) => entry["event"] === "merge_tracking.order_provider_unreadable")).toBe(false);
  });

  it("a seam that throws never fails the pass: the merge is recorded, nothing is warned, and the log names no cause", async () => {
    const w = await withEdges("none", undefined, () => { throw new Error("secret-canary down"); });
    mergeByHand(w, "app");
    await w.tracking.sweep();
    expect((await readTask(w.h.deps, TASK_ID))!.workflow?.pullRequests?.find((entry) => entry.repositoryId === "app")?.state).toBe("MERGED");
    expect(await stuckRows(w)).toEqual([]);
    expect(w.logged.some((entry) => entry["event"] === "merge_tracking.order_unreadable")).toBe(true);
    expect(JSON.stringify(w.logged)).not.toContain("secret-canary");
  });

  it("a provider the host cannot read is not guessed about", async () => {
    const pullRequests = [{ repositoryId: "app", number: 1, url: "https://github.com/acme/app/pull/1", required: true, state: "MERGED" }, { repositoryId: "payments-lib", number: 1, url: "https://github.com/acme/payments-lib/pull/1", required: true, state: "OPEN" }];
    const task = { taskId: TASK_ID, orgId: ORG, project: "web", startingRevision: 1, workspaceId: "ws", ownerId: "o", ownerName: "n", workflow: { definitionVersion: "1.1.0", pullRequests } };
    const logged: string[] = [];
    const found = await outOfOrderMilestoneItems({
      milestones: { items: () => [{ kind: "put", item: { pk: "x", sk: "y" } }], deliver: async () => undefined }, repositoryEdges: async () => [edge("app", "payments-lib")],
      providerState: async () => { throw new Error("down"); }, log: (event) => { logged.push(event); },
    }, task as never, { pullRequests: pullRequests.map((entry) => ({ ...entry, state: "OPEN" })) } as never, task.workflow as never, "2026-11-16T00:00:00.000Z");
    expect(found).toEqual([]);
    expect(logged).toEqual(["merge_tracking.order_provider_unreadable"]);
    // Control: the host says it is not merged, so the same input warns.
    const warned = await outOfOrderMilestoneItems({
      milestones: { items: () => [{ kind: "put", item: { pk: "x", sk: "y" } }], deliver: async () => undefined }, repositoryEdges: async () => [edge("app", "payments-lib")], providerState: async () => "not_merged",
    }, task as never, { pullRequests: pullRequests.map((entry) => ({ ...entry, state: "OPEN" })) } as never, task.workflow as never, "2026-11-16T00:00:00.000Z");
    expect(warned).toHaveLength(1);
  });

  it("says each hand merge once, and the second names only the pull request that just merged", async () => {
    const w = await withEdges([edge("app", "payments-lib"), edge("docs", "payments-lib")], ["app", "docs", "payments-lib"]);
    mergeByHand(w, "app");
    await w.tracking.sweep();
    expect((await stuckRows(w)).map((row) => row["text"])).toEqual([MERGE_ORDER_WORDS.outOfOrderWarning("app", "payments-lib", ["docs"], 0)]);
    mergeByHand(w, "docs");
    await w.world.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    await w.tracking.sweep();
    // The first is not said again as "one more": only what merged in this pass is.
    expect((await stuckRows(w)).map((row) => row["text"]).sort()).toEqual([
      MERGE_ORDER_WORDS.outOfOrderWarning("app", "payments-lib", ["docs"], 0), MERGE_ORDER_WORDS.outOfOrderWarning("docs", "payments-lib", [], 0),
    ].sort());
  });

  it("a fault while building the warning never stops the merge from being recorded, and is logged by name", async () => {
    const w = await withEdges([edge("app", "payments-lib")], undefined, undefined, (milestones) => ({
      ...milestones, items: (milestone, n, options) => { if (milestone.kind === "stuck") throw new Error("secret-canary schema"); return milestones.items(milestone, n, options); },
    }));
    mergeByHand(w, "app");
    await w.tracking.sweep();
    expect((await readTask(w.h.deps, TASK_ID))!.workflow?.pullRequests?.find((entry) => entry.repositoryId === "app")?.state).toBe("MERGED");
    expect(await stuckRows(w)).toEqual([]);
    expect(w.logged.some((entry) => entry["event"] === "merge_tracking.order_warning_failed")).toBe(true);
    expect(JSON.stringify(w.logged)).not.toContain("secret-canary");
  });

  it("a host that says slow down while the provider is read goes up (the sweep pauses) and records nothing yet", async () => {
    const w = await withEdges([edge("app", "payments-lib")]);
    mergeByHand(w, "app");
    w.world.prs.find((entry) => entry.repositoryId === "payments-lib")!.model.rateLimitedUntil = w.clock.ms + 3_600_000;
    // The pass itself, not the sweep: the sweep reads the host first and would stop earlier.
    const budget = { signal: new AbortController().signal, beforeRequest: () => undefined };
    await expect(w.tracking.deps.observeMerge(TASK_ID, budget)).rejects.toMatchObject({ name: "HostRateLimitError" });
    expect((await readTask(w.h.deps, TASK_ID))!.workflow?.pullRequests?.find((entry) => entry.repositoryId === "app")?.state).toBe("OPEN");
  });

  it("a provider that was closed without merging is not said about as waiting", async () => {
    const w = await withEdges([edge("app", "payments-lib")]);
    const lib = w.world.prs.find((entry) => entry.repositoryId === "payments-lib")!;
    lib.model.update(String(lib.number), { state: "closed" });
    mergeByHand(w, "app");
    await w.tracking.sweep();
    expect(await stuckRows(w)).toEqual([]);
  });

  it("keeps the words inside the milestone's 500 characters whatever the repositories are called", async () => {
    const names = ["a".repeat(200), "b".repeat(200), "c".repeat(200), "d".repeat(200), "e".repeat(200), "f".repeat(200)];
    const written: Array<{ text: string; pullRequests?: unknown[] }> = [];
    const task = {
      taskId: TASK_ID, orgId: ORG, project: "web", startingRevision: 1, workspaceId: "ws", ownerId: "o", ownerName: "n",
      workflow: { definitionVersion: "1.1.0", pullRequests: names.map((name, index) => ({ repositoryId: name, number: index + 1, url: `https://github.com/acme/r${String(index)}/pull/${String(index + 1)}`, required: true, state: index === 0 ? "MERGED" : "OPEN" })) },
    };
    const items = await outOfOrderMilestoneItems({
      milestones: { items: (milestone) => { written.push(milestone as never); return []; }, deliver: async () => undefined },
      repositoryEdges: async () => names.slice(1).map((provider) => edge(names[0]!, provider)).concat(names.slice(2).map((consumer) => edge(consumer, names[1]!))),
      providerState: async () => "not_merged",
    }, task as never, { ...task.workflow, pullRequests: task.workflow.pullRequests.map((entry) => ({ ...entry, state: "OPEN" })) } as never, task.workflow as never, "2026-11-16T00:00:00.000Z");
    expect(items).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]!.text.length).toBeLessThanOrEqual(500);
    expect(written[0]!.text).toContain("more merged out of order");
    expect(written[0]!.pullRequests).toHaveLength(6);
  });
});

describe("holding the dependents at draft", () => {
  const prs = [{ repositoryId: "app", number: 1 }, { repositoryId: "docs", number: 1 }, { repositoryId: "payments-lib", number: 1 }];
  const world = async (facts: unknown) => {
    const w = await mergeWorld({ pullRequests: prs });
    // Every pull request is a draft whose checks pass, and the app was merged by hand ahead of payments-lib.
    for (const pr of w.prs) pr.model.getChangeRequest(String(pr.number)).draft = true;
    const app = w.prs.find((pr) => pr.repositoryId === "app")!;
    app.model.merge(String(app.number), { revision: app.head, method: "squash" });
    const task = await w.task();
    await w.setWorkflow({ pullRequests: task.workflow.pullRequests!.map((entry) => ({ ...entry, state: entry.repositoryId === "app" ? "MERGED" : entry.state })) });
    const deps = { ...w.tracking, ...(facts === "none" ? {} : { repositoryEdges: async () => facts }) };
    return { w, deps };
  };
  const draftOf = (w: Awaited<ReturnType<typeof mergeWorld>>, repositoryId: string): boolean => {
    const pr = w.prs.find((entry) => entry.repositoryId === repositoryId)!;
    return pr.model.getChangeRequest(String(pr.number)).draft;
  };

  it("holds nothing without facts, with facts that cannot be read, or while the merges follow the order (control run)", async () => {
    for (const facts of ["none", [], "bad", [edge("app", "payments-lib"), edge("payments-lib", "app")]]) {
      const { w, deps } = await world(facts);
      await trackTask(deps, TASK_ID);
      expect(draftOf(w, "docs"), JSON.stringify(facts)).toBe(false);
    }
    // In order: the provider merged first, so nothing is held for the consumer.
    const inOrder = await mergeWorld({ pullRequests: prs });
    for (const pr of inOrder.prs) pr.model.getChangeRequest(String(pr.number)).draft = true;
    const lib = inOrder.prs.find((pr) => pr.repositoryId === "payments-lib")!;
    lib.model.merge(String(lib.number), { revision: lib.head, method: "squash" });
    const task = await inOrder.task();
    await inOrder.setWorkflow({ pullRequests: task.workflow.pullRequests!.map((entry) => ({ ...entry, state: entry.repositoryId === "payments-lib" ? "MERGED" : entry.state })) });
    await trackTask({ ...inOrder.tracking, repositoryEdges: async () => [edge("app", "payments-lib"), edge("docs", "payments-lib")] }, TASK_ID);
    expect(draftOf(inOrder, "docs")).toBe(false);
    expect(draftOf(inOrder, "app")).toBe(false);
  });
});
