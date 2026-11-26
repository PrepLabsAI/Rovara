// MR3b (TE-R3): where the merge order is SHOWN. The pure lines (the order, and what happened when a pull request was merged ahead of the one it depends on) on the Merge section's view, the pull request
// description and the task page. The view's field is added readers first (DEC 152a): the writer is off until an install turns it on. Words are fixed; every repository name is one inert line. Never GitHub.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MergePressBodySchema, MergeViewSchema, MERGE_VIEW_MESSAGE_MAX } from "../../packages/contracts/src/index.js";
import { MERGE_ORDER_WORDS, mergeOrderLinesOfTask, mergeViewOf, readMergeTracking } from "../../packages/broker/src/core/merge/index.js";
import { attentionOf } from "../../packages/broker/src/core-host/app/attention.js";
import { nextFor } from "../../packages/mcp/src/tools.js";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";

const edge = (consumer: string, provider: string) => ({ consumer, provider, language: "node", source: "both" });
const PRS = [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }];

describe("the Merge section's view", () => {
  const viewOf = async (facts: unknown, over: { orderInView?: boolean; pullRequests?: typeof PRS; seam?: false } = {}) => {
    const world = await mergeWorld({ pullRequests: over.pullRequests ?? PRS });
    await world.seedTracking();
    if (over.seam !== false) world.deps.repositoryEdges = async () => facts;
    const deps = { ...world.deps, ...(over.orderInView === false ? {} : { orderInView: true }) };
    return { world, view: await mergeViewOf(deps, await world.task(), await readMergeTracking(world.store, TASK_ID, ORG), undefined) };
  };

  it("carries the order for a task with dependency facts, and nothing for today's repository order", async () => {
    const { view, world } = await viewOf([edge("app", "payments-lib")]);
    const numbers = world.prs.map((pr) => pr.number);
    expect(view).toMatchObject({ ready: true, order: { lines: [`Merge order: payments-lib #${String(numbers[1])} first, then app #${String(numbers[0])}.`] } });
    expect(MergeViewSchema.safeParse(view).success).toBe(true);
    expect((view!.order as { needsOverride?: true }).needsOverride).toBeUndefined();
    for (const facts of [undefined, [], [edge("app", "elsewhere")]]) expect((await viewOf(facts)).view).not.toHaveProperty("order");
    expect((await viewOf([edge("app", "payments-lib")], { pullRequests: [{ repositoryId: "app", number: 1 }] })).view).not.toHaveProperty("order");
  });

  it("says no safe order, and that a person must confirm, for a cycle and for facts that cannot be read", async () => {
    for (const [facts, reason] of [[[edge("app", "payments-lib"), edge("payments-lib", "app")], "cycle"], ["not edges", "unreadable"]] as const) {
      const { view } = await viewOf(facts);
      expect(view?.order).toEqual({ lines: [MERGE_ORDER_WORDS.noSafeOrder[reason]], needsOverride: true });
      expect(MergeViewSchema.safeParse(view).success).toBe(true);
    }
    // A seam that throws is "unreadable" too, never the repository order.
    const world = await mergeWorld({ pullRequests: PRS });
    await world.seedTracking();
    world.deps.repositoryEdges = async () => { throw new Error("secret-canary"); };
    const view = await mergeViewOf({ ...world.deps, orderInView: true }, await world.task(), await readMergeTracking(world.store, TASK_ID, ORG), undefined);
    expect(view?.order).toEqual({ lines: [MERGE_ORDER_WORDS.noSafeOrder.unreadable], needsOverride: true });
    expect(JSON.stringify(view)).not.toContain("secret-canary");
  });

  it("cuts a long order line to the view's bound, with an ellipsis, and the view still reads", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, "0")}-${"r".repeat(36)}`);
    const { view } = await viewOf([edge(names[0]!, names[1]!)], { pullRequests: names.map((repositoryId) => ({ repositoryId, number: 1 })) });
    expect(view?.order?.lines[0]).toHaveLength(MERGE_VIEW_MESSAGE_MAX);
    expect(view?.order?.lines[0]?.endsWith("\u2026")).toBe(true);
    expect(MergeViewSchema.safeParse(view).success).toBe(true);
  });

  it("names a pull request merged ahead of the one it depends on", async () => {
    const world = await mergeWorld({ pullRequests: PRS });
    await world.seedTracking();
    const task = await world.task();
    await world.setWorkflow({ pullRequests: task.workflow.pullRequests!.map((entry) => ({ ...entry, state: entry.repositoryId === "app" ? "MERGED" : entry.state })) });
    world.deps.repositoryEdges = async () => [edge("app", "payments-lib")];
    const view = await mergeViewOf({ ...world.deps, orderInView: true }, await world.task(), await readMergeTracking(world.store, TASK_ID, ORG), undefined);
    expect(view?.order?.lines.at(-1)).toBe(MERGE_ORDER_WORDS.outOfOrderWarning("app", "payments-lib", [], 0));
  });

  it("the press body takes the override only as `true`, and nothing else new", () => {
    const requestId = randomUUID();
    expect(MergePressBodySchema.safeParse({ requestId }).success).toBe(true);
    expect(MergePressBodySchema.safeParse({ requestId, orderOverride: true }).success).toBe(true);
    for (const orderOverride of [false, "true", 1, null, {}]) expect(MergePressBodySchema.safeParse({ requestId, orderOverride }).success).toBe(false);
    expect(MergePressBodySchema.safeParse({ requestId, orderOverride: true, approved: true }).success).toBe(false);
    expect(MergeViewSchema.safeParse({ ready: true, order: { lines: [] } }).success).toBe(false);
    expect(MergeViewSchema.safeParse({ ready: true, order: { lines: ["a", "b", "c", "d"] } }).success).toBe(true);
    expect(MergeViewSchema.safeParse({ ready: true, order: { lines: ["a", "b", "c", "d", "e"] } }).success).toBe(false);
    expect(MergeViewSchema.safeParse({ ready: true, order: { lines: ["x".repeat(501)] } }).success).toBe(false);
    expect(MergeViewSchema.safeParse({ ready: true, order: { lines: ["x"], needsOverride: false } }).success).toBe(false);
    expect(MergeViewSchema.safeParse({ ready: true, order: { lines: ["x"], extra: 1 } }).success).toBe(false);
    expect(MergeViewSchema.safeParse({ ready: true }).success).toBe(true);
  });
});

describe("the order lines of a task", () => {
  const workflowOf = (pullRequests: Array<{ repositoryId: string; number: number; state?: string }>, repositories = pullRequests.map((pr) => pr.repositoryId)) => ({
    definitionVersion: "1.1.0", candidate: { digest: "c".repeat(64), repositories: repositories.map((repositoryId) => ({ repositoryId })) },
    pullRequests: pullRequests.map((pr) => ({ ...pr, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, required: true, state: pr.state ?? "OPEN" })),
  });
  const taskOf = (workflow: unknown) => ({ taskId: TASK_ID, orgId: ORG, project: "web", startingRevision: 1, workspaceId: "ws", ownerId: "o", ownerName: "n", workflow }) as never;

  it("knows the order from the candidate's repositories before the other pull requests are open", async () => {
    const lines = await mergeOrderLinesOfTask({ repositoryEdges: async () => [edge("app", "payments-lib")] }, taskOf(workflowOf([{ repositoryId: "app", number: 40 }], ["app", "payments-lib"])));
    expect(lines).toEqual(["Merge order: payments-lib first, then app #40."]);
    const both = await mergeOrderLinesOfTask({ repositoryEdges: async () => [edge("app", "payments-lib")] }, taskOf(workflowOf([{ repositoryId: "app", number: 40 }, { repositoryId: "payments-lib", number: 12 }])));
    expect(both).toEqual(["Merge order: payments-lib #12 first, then app #40."]);
  });

  it("says no safe order for a cycle or a seam that throws, naming no cause", async () => {
    const workflow = workflowOf([{ repositoryId: "app", number: 1 }, { repositoryId: "lib", number: 2 }]);
    expect(await mergeOrderLinesOfTask({ repositoryEdges: async () => [edge("app", "lib"), edge("lib", "app")] }, taskOf(workflow))).toEqual([MERGE_ORDER_WORDS.noSafeOrder.cycle]);
    const logged: string[] = [];
    const lines = await mergeOrderLinesOfTask({ repositoryEdges: () => { throw new Error("secret-canary"); }, log: (event, fields) => { logged.push(`${event}${JSON.stringify(fields)}`); } }, taskOf(workflow));
    expect(lines).toEqual([MERGE_ORDER_WORDS.noSafeOrder.unreadable]);
    expect(logged.join("")).not.toContain("secret-canary");
  });
});

describe("the pull request description and the task page", () => {

  it("is on the task page's merge lines through the flow's seam, and absent without it", async () => {
    const world = await mergeWorld({ pullRequests: PRS });
    await world.seedTracking();
    const task = (await world.task()) as never;
    const plain = await attentionOf({ store: world.store, companyId: ORG }, task);
    const seen: string[] = [];
    const shown = await attentionOf({ store: world.store, companyId: ORG, mergeOrderLines: async () => { seen.push("asked"); return ["Merge order: payments-lib #1 first, then app #1."]; } }, task);
    expect(seen).toEqual(["asked"]);
    expect(shown.view.merge?.lines).toContain("Merge order: payments-lib #1 first, then app #1.");
    expect(plain.view.merge?.lines).not.toContain("Merge order: payments-lib #1 first, then app #1.");
    // A seam that fails leaves the page as it was.
    const failing = await attentionOf({ store: world.store, companyId: ORG, mergeOrderLines: async () => { throw new Error("down"); } }, task);
    expect(failing.view).toEqual(plain.view);
  });
});

describe("the AI tool's words (a reader of the view's new field)", () => {
  const task = (merge: Record<string, unknown>) => ({ workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 3 }, merge }) as never;
  it("says the order, and that only a person confirms one that could not be found; unchanged without the field", () => {
    const plain = nextFor(task({ ready: true }));
    expect(nextFor(task({ ready: true, order: { lines: ["Merge order: payments-lib #12 first, then app #40."] } }))).toBe(plain.replace("this tool can't merge.", "this tool can't merge. Merge order: payments-lib #12 first, then app #40."));
    const override = nextFor(task({ ready: false, message: "x", order: { lines: [MERGE_ORDER_WORDS.noSafeOrder.cycle], needsOverride: true } }));
    expect(override).toContain(MERGE_ORDER_WORDS.noSafeOrder.cycle);
    expect(override).toContain("Only a person can confirm merging them in the order listed; this tool can't.");
    expect(nextFor(task({ ready: false, message: "x" }))).not.toContain("Merge order");
  });
});
