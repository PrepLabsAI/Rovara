// MR3 (TE-R3): the merge order across a task's repositories, and the state of a half-merged task. A library merges before the app that uses it; a person presses Merge, Rovara
// never merges by itself (owner decision 1); only a person overrides the order (DEC 209). Over W0's in-memory store and the fake code host. Never the real GitHub.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, type CodeHost } from "../../packages/contracts/src/index.js";
import {
  MERGE_ORDER_EDGES_MAX, MERGE_ORDER_WORDS, mergeOrderLines, mergeOrderOf, partialMergeState, type MergeDependencies,
} from "../../packages/broker/src/core/merge/index.js";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { expectLinearScaling } from "../support/scaling.js";
import { githubShapedHost, mergeWorld, pressAsOwner, type MergeWorld } from "../support/merge-world.js";

const edge = (consumer: string, provider: string) => ({ consumer, provider, language: "node", source: "both" });
const rejects = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await run(); } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { ...(code === undefined ? {} : { code }), message: code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
  throw new Error("expected a refusal");
};

describe("mergeOrderOf", () => {

  it("refuses facts it cannot read as a whole, never a guessed order", () => {
    const unreadable = { kind: "no_safe_order", reason: "unreadable", repositories: ["app", "lib"] };
    for (const facts of [
      "app->lib", { edges: [] }, [null], [edge("app", "app")], [{ consumer: "app" }], [{ consumer: "app", provider: 7 }], [{ consumer: "", provider: "lib" }],
      [{ consumer: "app", provider: "l".repeat(201) }], [edge("app", "lib"), 3],
      Array.from({ length: MERGE_ORDER_EDGES_MAX + 1 }, (_, index) => edge("app", `lib${String(index)}`)),
    ]) expect(mergeOrderOf(["app", "lib"], facts)).toEqual(unreadable);
    // Exactly the bound is read.
    expect(mergeOrderOf(["app", "lib"], [edge("app", "lib"), ...Array.from({ length: MERGE_ORDER_EDGES_MAX - 1 }, (_, index) => edge("app", `x${String(index)}`))])).toMatchObject({ kind: "dependencies" });
  });

  it("orders a large input in bounded time", () => {
    // The task's 32 repositories stay; the work grows linearly with the edges up to the 64 the reader allows (8, then 64), not faster.
    const repositories = Array.from({ length: 32 }, (_, index) => `r${String(index).padStart(2, "0")}`);
    const factsFor = (count: number) => Array.from({ length: count }, (_, index) => edge(repositories[(index % 31) + 1]!, repositories[index % 31 > 0 ? (index % 31) : 0]!)).filter((fact) => fact.consumer !== fact.provider);
    const orders = new Map<number, ReturnType<typeof mergeOrderOf>>();
    expectLinearScaling((count) => {
      const facts = factsFor(count);
      return () => { orders.set(count, mergeOrderOf(repositories, facts)); };
    }, { n: MERGE_ORDER_EDGES_MAX / 8, unitBytes: 150, label: "merge order: edges" });
    expect(orders.get(MERGE_ORDER_EDGES_MAX / 8)).toMatchObject({ kind: "dependencies" });
    expect(orders.get(MERGE_ORDER_EDGES_MAX)).toMatchObject({ kind: "dependencies", repositories });
    expect(mergeOrderOf(Array.from({ length: 33 }, (_, index) => `r${String(index)}`), [])).toMatchObject({ kind: "no_safe_order", reason: "unreadable" });
  });
});

describe("partialMergeState and the words", () => {
  const order = mergeOrderOf(["app", "payments-lib", "docs"], [edge("app", "payments-lib")]);

  it("says none, complete, or partial with what is merged, what waits, what is next and the two actions", () => {
    expect(partialMergeState(order, [])).toEqual({ kind: "none" });
    expect(partialMergeState(order, ["app", "payments-lib", "docs"])).toEqual({ kind: "complete" });
    expect(partialMergeState(order, ["payments-lib"])).toEqual({
      kind: "partial", merged: ["payments-lib"], waiting: ["docs", "app"], next: "docs", outOfOrder: [], actions: ["finish_in_order", "offer_revert"],
    });
  });

  it("writes the order line for the PR and task page", () => {
    const prs = [{ repositoryId: "app", number: 40 }, { repositoryId: "payments-lib", number: 12 }, { repositoryId: "docs", number: 3 }];
    expect(mergeOrderLines(order, prs)).toEqual(["Merge order: docs #3 first, then payments-lib #12, then app #40."]);
    expect(mergeOrderLines(mergeOrderOf(["app"], undefined), [{ repositoryId: "app", number: 1 }])).toEqual([]);
    expect(mergeOrderLines(mergeOrderOf(["a", "b"], [edge("a", "b"), edge("b", "a")]), [{ repositoryId: "a", number: 1 }, { repositoryId: "b", number: 2 }])).toEqual([MERGE_ORDER_WORDS.noSafeOrder.cycle]);
  });
});

// ---- the press

function refusingFor(name: string) {
  return (model: FakeHostModel): CodeHost => {
    if (model.fullName !== `acme/${name}`) return githubShapedHost(model);
    const fake = new FakeCodeHost(model);
    return Object.create(fake, { kind: { value: "github" }, merge: { value: async () => ({ outcome: "refused", reason: "not_mergeable", hostMessage: "Required checks have not passed." }) } }) as CodeHost;
  };
}

/** The order the host saw the merges in: from the audit facts, which commit with each claim. */
const mergedOrder = (world: MergeWorld): string[] => world.audit.events.map((event) => (event.details as { repository: string }).repository);

async function world2(facts: unknown, options: { codeHost?: (model: FakeHostModel) => CodeHost; seam?: false } = {}): Promise<MergeWorld & { deps: MergeDependencies }> {
  const world = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }], ...(options.codeHost === undefined ? {} : { codeHost: options.codeHost }) });
  await world.seedTracking();
  if (options.seam !== false) world.deps.repositoryEdges = async () => facts;
  return world;
}

describe("merge all in order", () => {

  it("tells a half merge with what was held back and the two next steps", async () => {
    // docs has no dependency; app depends on payments-lib. Order: docs (tie, repository order), payments-lib, app. payments-lib is refused after docs merged.
    const world = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }, { repositoryId: "docs", number: 1 }], codeHost: refusingFor("payments-lib") });
    await world.seedTracking();
    world.deps.repositoryEdges = async () => [edge("app", "payments-lib")];
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressAsOwner(world.deps, prepared));
    const why = "the code host would not merge it (the host says: Required checks have not passed.)";
    expect(refusal.message).toBe(`${M.halfMerged("docs", "payments-lib", why)} ${MERGE_ORDER_WORDS.held(["payments-lib", "app"], ["docs"])}`);
    expect(world.models.get("app")!.getChangeRequest("1").state).toBe("open");
    expect(world.milestones.written.map((m) => m.kind)).toEqual(["stuck"]);
    expect((world.milestones.written[0] as { text?: string }).text).toBe(refusal.message);
    expect(((world.milestones.written[0] as { pullRequests?: Array<{ repository: string }> }).pullRequests ?? []).map((pr) => pr.repository)).toEqual(["docs", "payments-lib", "app"]);
  });

  it("does not refuse the last pull request of a half merge over a cycle: there is no order left to get wrong", async () => {
    const world = await world2([edge("app", "payments-lib"), edge("payments-lib", "app")]);
    const app = world.prs.find((pr) => pr.repositoryId === "app")!;
    expect(app.model.merge("1", { revision: app.head, method: "squash" }).outcome).toBe("merged");
    await world.setWorkflow({ pullRequests: ((await world.task()).workflow.pullRequests ?? []).map((pr) => (pr.repositoryId === "app" ? { ...pr, state: "MERGED" } : pr)) });
    const prepared = await world.prepare();
    expect(prepared.changes).toEqual(["Merge payments-lib pull request 1 (squash)"]);
    expect("orderOverride" in prepared).toBe(false);
    await pressAsOwner(world.deps, prepared);
    expect(mergedOrder(world)).toEqual(["acme/payments-lib"]);
  });
});
