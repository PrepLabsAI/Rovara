// MR3 (TE-R3): the merge order across a task's repositories, and the state of a half-merged task. A library merges before the app that uses it; a person presses Merge, Rovara
// never merges by itself (owner decision 1); only a person overrides the order (DEC 209). Over W0's in-memory store and the fake code host. Never the real GitHub.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, type CodeHost } from "../../packages/contracts/src/index.js";
import {
  MERGE_ORDER_EDGES_MAX, MERGE_ORDER_WORDS, heldAfterHalfMerge, mergeOrderLines, mergeOrderOf, partialMergeState, pressMerge, prepareMerge, type MergeDependencies,
} from "../../packages/broker/src/core/merge/index.js";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { expectLinearScaling } from "../support/scaling.js";
import { TASK_ID, githubShapedHost, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const edge = (consumer: string, provider: string) => ({ consumer, provider, language: "node", source: "both" });
const rejects = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await run(); } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { ...(code === undefined ? {} : { code }), message: code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
  throw new Error("expected a refusal");
};

describe("mergeOrderOf", () => {
  it("keeps today's repository order when there are no facts or no edges among the task's repositories", () => {
    expect(mergeOrderOf(["web", "lib", "api"], undefined)).toEqual({ kind: "repository", repositories: ["api", "lib", "web"] });
    expect(mergeOrderOf(["web", "lib"], [])).toEqual({ kind: "repository", repositories: ["lib", "web"] });
    // An edge to a repository the task did not change says nothing about the order of its pull requests.
    expect(mergeOrderOf(["web", "lib"], [edge("web", "shared-utils"), edge("other", "lib")])).toEqual({ kind: "repository", repositories: ["lib", "web"] });
    expect(mergeOrderOf(["solo"], [edge("solo", "lib")])).toEqual({ kind: "repository", repositories: ["solo"] });
  });

  it("merges a provider before its consumers, whatever their names, and breaks ties by repository order", () => {
    // payments-lib sorts after app, but app uses it.
    expect(mergeOrderOf(["app", "payments-lib"], [edge("app", "payments-lib")])).toMatchObject({ kind: "dependencies", repositories: ["payments-lib", "app"] });
    // A chain: z <- m <- a.
    expect(mergeOrderOf(["a", "m", "z"], [edge("a", "m"), edge("m", "z")])).toMatchObject({ repositories: ["z", "m", "a"] });
    // A diamond, plus an independent repository: the ready ones go in repository order at each step.
    const diamond = mergeOrderOf(["app", "core", "left", "right", "docs"], [edge("left", "core"), edge("right", "core"), edge("app", "left"), edge("app", "right")]);
    expect(diamond).toMatchObject({ kind: "dependencies", repositories: ["core", "docs", "left", "right", "app"] });
    expect(diamond.kind === "dependencies" ? diamond.providersOf : undefined).toEqual({ app: ["left", "right"], left: ["core"], right: ["core"] });
    // Duplicate facts (one per language) count once.
    expect(mergeOrderOf(["app", "lib"], [edge("app", "lib"), { ...edge("app", "lib"), language: "python" }])).toMatchObject({ repositories: ["lib", "app"], providersOf: { app: ["lib"] } });
  });

  it("finds no safe order for a cycle among the task's repositories, even with a safe part beside it", () => {
    expect(mergeOrderOf(["a", "b"], [edge("a", "b"), edge("b", "a")])).toEqual({ kind: "no_safe_order", reason: "cycle", repositories: ["a", "b"] });
    expect(mergeOrderOf(["a", "b", "c", "lib"], [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "lib")])).toMatchObject({ kind: "no_safe_order", reason: "cycle" });
  });

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
    }, { n: MERGE_ORDER_EDGES_MAX / 8, label: "merge order: edges" });
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

  it("flags a consumer merged (on the code host, by hand) before the repository it depends on", () => {
    expect(partialMergeState(order, ["app"])).toMatchObject({ kind: "partial", merged: ["app"], next: "docs", outOfOrder: [{ consumer: "app", provider: "payments-lib" }] });
    // Without dependency facts nothing is out of order.
    expect(partialMergeState(mergeOrderOf(["app", "lib"], undefined), ["app"])).toMatchObject({ outOfOrder: [] });
  });

  it("writes the order line for the PR and task page", () => {
    const prs = [{ repositoryId: "app", number: 40 }, { repositoryId: "payments-lib", number: 12 }, { repositoryId: "docs", number: 3 }];
    expect(mergeOrderLines(order, prs)).toEqual(["Merge order: docs #3 first, then payments-lib #12, then app #40."]);
    expect(mergeOrderLines(mergeOrderOf(["app"], undefined), [{ repositoryId: "app", number: 1 }])).toEqual([]);
    expect(mergeOrderLines(mergeOrderOf(["a", "b"], [edge("a", "b"), edge("b", "a")]), [{ repositoryId: "a", number: 1 }, { repositoryId: "b", number: 2 }])).toEqual([MERGE_ORDER_WORDS.noSafeOrder.cycle]);
  });

  it("names what a stop held back, in merge order", () => {
    expect(heldAfterHalfMerge(order, "docs", ["payments-lib"])).toBe(MERGE_ORDER_WORDS.held(["docs", "app"], ["payments-lib"]));
    expect(MERGE_ORDER_WORDS.held(["docs", "app"], ["payments-lib"])).toBe("Rovara stopped there, so these were not merged: docs, app. Press Merge again to finish in order, or ask for a revert of payments-lib.");
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
  it("merges the library before the app that uses it, and the person approves that order", async () => {
    const world = await world2([edge("app", "payments-lib")]);
    const prepared = await world.prepare();
    expect(prepared.changes).toEqual([`Merge payments-lib pull request 1 (squash) first`, `Merge app pull request 1 (squash) then`]);
    expect(prepared.mergeOrder).toEqual(["payments-lib", "app"]);
    const result = await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) });
    expect(result.status).toBe("MERGED");
    expect(mergedOrder(world)).toEqual(["acme/payments-lib", "acme/app"]);
    // The order is part of what the proof is bound to.
    const plain = await world2(undefined, { seam: false });
    expect((await plain.prepare()).request.artifactDigest).not.toBe(prepared.request.artifactDigest);
  });

  it("is byte-identical to today without dependency facts: same order, digest, words and shape", async () => {
    const absent = await world2(undefined, { seam: false });
    const none = await world2(undefined);
    const empty = await world2([]);
    const foreign = await world2([edge("app", "elsewhere")]);
    const [a, b, c, d] = [await absent.prepare(), await none.prepare(), await empty.prepare(), await foreign.prepare()];
    for (const other of [b, c, d]) {
      expect(other.request.artifactDigest).toBe(a.request.artifactDigest);
      expect(other.changes).toEqual(a.changes);
      expect(Object.keys(other).sort()).toEqual(Object.keys(a).sort());
    }
    expect(a.changes).toEqual(["Merge app pull request 1 (squash)", "Merge payments-lib pull request 1 (squash)"]);
    expect("mergeOrder" in a).toBe(false);
    // An override with nothing to override changes nothing.
    const overridden = await prepareMerge(absent.deps, { taskId: TASK_ID, requestId: absent.requestId(), orderOverride: true });
    expect(overridden.request.artifactDigest).toBe(a.request.artifactDigest);
    await pressMerge(absent.deps, { taskId: TASK_ID, requestId: a.request.requestId, proof: absent.proofFor(a) });
    expect(mergedOrder(absent)).toEqual(["acme/app", "acme/payments-lib"]);
  });

  it("stops when the library will not merge, and merges nothing that depends on it", async () => {
    const world = await world2([edge("app", "payments-lib")], { codeHost: refusingFor("payments-lib") });
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal).toMatchObject({ code: "MERGE_NOT_READY", message: M.notMerged("payments-lib", "the code host would not merge it (the host says: Required checks have not passed.)") });
    expect(world.models.get("app")!.getChangeRequest("1").state).toBe("open");
  });

  it("tells a half merge with what was held back and the two next steps", async () => {
    // docs has no dependency; app depends on payments-lib. Order: docs (tie, repository order), payments-lib, app. payments-lib is refused after docs merged.
    const world = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }, { repositoryId: "docs", number: 1 }], codeHost: refusingFor("payments-lib") });
    await world.seedTracking();
    world.deps.repositoryEdges = async () => [edge("app", "payments-lib")];
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    const why = "the code host would not merge it (the host says: Required checks have not passed.)";
    expect(refusal.message).toBe(`${M.halfMerged("docs", "payments-lib", why)} ${MERGE_ORDER_WORDS.held(["payments-lib", "app"], ["docs"])}`);
    expect(world.models.get("app")!.getChangeRequest("1").state).toBe("open");
    expect(world.milestones.written.map((m) => m.kind)).toEqual(["stuck"]);
    expect((world.milestones.written[0] as { text?: string }).text).toBe(refusal.message);
    expect(((world.milestones.written[0] as { pullRequests?: Array<{ repository: string }> }).pullRequests ?? []).map((pr) => pr.repository)).toEqual(["docs", "payments-lib", "app"]);
  });

  it("refuses a cycle or unreadable facts until a person confirms the override, which is bound into the proof", async () => {
    for (const [facts, words] of [[[edge("app", "payments-lib"), edge("payments-lib", "app")], MERGE_ORDER_WORDS.noSafeOrder.cycle], ["garbage", MERGE_ORDER_WORDS.noSafeOrder.unreadable]] as const) {
      const world = await world2(facts);
      expect(await rejects(() => world.prepare())).toEqual({ code: "MERGE_NOT_READY", message: words });
      const overridden = await prepareMerge(world.deps, { taskId: TASK_ID, requestId: world.requestId(), orderOverride: true });
      expect(overridden.orderOverride).toBe(true);
      expect(overridden.changes).toEqual(["Merge app pull request 1 (squash) (in the order listed, which you confirmed)", "Merge payments-lib pull request 1 (squash) (in the order listed, which you confirmed)"]);
      // A proof made for the override does not press without it: the digest differs.
      const plain = await world2(undefined, { seam: false });
      expect(overridden.request.artifactDigest).not.toBe((await plain.prepare()).request.artifactDigest);
      expect(await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: overridden.request.requestId, proof: world.proofFor(overridden) }))).toMatchObject({ code: "MERGE_NOT_READY", message: words });
      await pressMerge(world.deps, { taskId: TASK_ID, requestId: overridden.request.requestId, proof: world.proofFor(overridden), orderOverride: true });
      expect(mergedOrder(world)).toEqual(["acme/app", "acme/payments-lib"]);
    }
  });

  it("fails closed when the dependency facts cannot be read at all, whatever way the read throws, and never echoes the cause", async () => {
    const throwing = { get consumer(): string { throw new Error("getter secret-ish detail"); }, provider: "payments-lib" };
    for (const seam of [
      async () => { throw new Error("store down: secret-ish detail"); },
      () => { throw new Error("sync secret-ish detail"); },
      async () => [throwing],
    ]) {
      const world = await world2(undefined);
      world.deps.repositoryEdges = seam;
      expect(await rejects(() => world.prepare())).toEqual({ code: "MERGE_NOT_READY", message: MERGE_ORDER_WORDS.noSafeOrder.unreadable });
    }
  });

  it("does not refuse the last pull request of a half merge over a cycle: there is no order left to get wrong", async () => {
    const world = await world2([edge("app", "payments-lib"), edge("payments-lib", "app")]);
    const app = world.prs.find((pr) => pr.repositoryId === "app")!;
    expect(app.model.merge("1", { revision: app.head, method: "squash" }).outcome).toBe("merged");
    await world.setWorkflow({ pullRequests: ((await world.task()).workflow.pullRequests ?? []).map((pr) => (pr.repositoryId === "app" ? { ...pr, state: "MERGED" } : pr)) });
    const prepared = await world.prepare();
    expect(prepared.changes).toEqual(["Merge payments-lib pull request 1 (squash)"]);
    expect("orderOverride" in prepared).toBe(false);
    await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) });
    expect(mergedOrder(world)).toEqual(["acme/payments-lib"]);
  });

  it("treats facts that changed after the person confirmed as a new question", async () => {
    const world = await world2([edge("app", "payments-lib")]);
    const prepared = await world.prepare();
    world.deps.repositoryEdges = async () => [];
    expect(await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }))).toMatchObject({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    expect(world.models.get("payments-lib")!.getChangeRequest("1").state).toBe("open");
  });

  it("finishes a half merge in order after the library merged by hand, and an app merged first only leaves the library", async () => {
    const world = await world2([edge("app", "payments-lib")]);
    // The app was merged on GitHub by hand, out of order: the press merges the library that is left.
    const app = world.prs.find((pr) => pr.repositoryId === "app")!;
    expect(app.model.merge("1", { revision: app.head, method: "squash" }).outcome).toBe("merged");
    await world.setWorkflow({ pullRequests: ((await world.task()).workflow.pullRequests ?? []).map((pr) => (pr.repositoryId === "app" ? { ...pr, state: "MERGED" } : pr)) });
    const prepared = await world.prepare();
    expect(prepared.subject.pullRequests.map((pr) => pr.repositoryId)).toEqual(["payments-lib"]);
    await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) });
    expect(mergedOrder(world)).toEqual(["acme/payments-lib"]);
  });
});
