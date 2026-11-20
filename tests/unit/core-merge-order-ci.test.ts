// MR4 (TE-R4): honest per-repository CI. Each repository's own CI tests that repository alone, against the other repositories' main, so a change that spans repositories can pass in Rovara (tested together) and
// fail in a consumer's own CI until the repository it depends on has merged. The description and the task page say so, and Rovara does not send such a failure to its CI fix loop while the provider is waiting.
// Rovara never merges and never re-runs a person's CI by itself (owner decision 1; the host port has no re-run call yet). Fake code host and the in-memory store; never GitHub.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MERGE_ORDER_WORDS, createCiWaitLines, createMergeOrderLines, mergeOrderLinesOfTask, mergeOrderOf, perRepositoryCiLines, registerMergeActionDecider, trackTask,
  waitingProviders,
} from "../../packages/broker/src/core/merge/index.js";
import { rovaraStatusLines } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { attentionOf } from "../../packages/broker/src/local/app/attention.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const edge = (consumer: string, provider: string) => ({ consumer, provider, language: "node", source: "both" });
const pr = (repositoryId: string, number: number, state = "OPEN") => ({ repositoryId, number, state });

describe("what a consumer's CI is told", () => {
  const order = mergeOrderOf(["app", "docs", "payments-lib"], [edge("app", "payments-lib"), edge("docs", "payments-lib")]);

  it("names every waiting provider of a chain or a diamond, at most three, then counts the rest", () => {
    const diamond = mergeOrderOf(["app", "core", "left", "right"], [edge("app", "left"), edge("app", "right"), edge("left", "core"), edge("right", "core")]);
    expect(waitingProviders(diamond, "app", [])).toEqual(["left", "right"]);
    expect(perRepositoryCiLines(diamond, "app", [pr("app", 1), pr("core", 2), pr("left", 3), pr("right", 4)])).toEqual(["Tested together in Rovara; your CI tests each repository alone and may fail until left #3 and right #4 merge."]);
    const many = mergeOrderOf(["app", "a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e"].map((provider) => edge("app", provider)));
    const prs = [pr("app", 1), ...["a", "b", "c", "d", "e"].map((name, index) => pr(name, index + 2))];
    expect(perRepositoryCiLines(many, "app", prs)).toEqual(["Tested together in Rovara; your CI tests each repository alone and may fail until a #2, b #3, c #4 and 2 more merge."]);
  });

  it("names a provider with no pull request yet by its repository alone", () => {
    expect(perRepositoryCiLines(order, "app", [pr("app", 40)])).toEqual(["Tested together in Rovara; your CI tests each repository alone and may fail until payments-lib merges."]);
  });
});

describe("the lines of a task", () => {
  const workflowOf = (pullRequests: Array<{ repositoryId: string; number: number; state?: string }>) => ({
    definitionVersion: "1.1.0", candidate: { digest: "c".repeat(64), repositories: pullRequests.map((entry) => ({ repositoryId: entry.repositoryId })) },
    pullRequests: pullRequests.map((entry) => ({ ...entry, url: `https://github.com/acme/${entry.repositoryId}/pull/${String(entry.number)}`, required: true, state: entry.state ?? "OPEN" })),
  });
  const taskOf = (workflow: unknown) => ({ taskId: TASK_ID, orgId: ORG, project: "web", startingRevision: 1, workspaceId: "ws", ownerId: "o", ownerName: "n", workflow }) as never;
  const deps = { repositoryEdges: async () => [edge("app", "payments-lib")] };

  it("is today's lines without facts or for one repository, whichever repository is asked about", async () => {
    const task = taskOf(workflowOf([pr("app", 40), pr("payments-lib", 12)]));
    for (const repositoryEdges of [undefined, async () => undefined, async () => [], async () => [edge("app", "elsewhere")]]) {
      expect(await mergeOrderLinesOfTask({ ...(repositoryEdges === undefined ? {} : { repositoryEdges }) }, task, "app")).toEqual([]);
    }
    expect(await mergeOrderLinesOfTask(deps, taskOf(workflowOf([pr("app", 40)])), "app")).toEqual([]);
  });

  it("says the CI words alone for the page, and nothing once the provider merged or when the facts cannot be read", async () => {
    const lines = (task: unknown, repositoryId: string, repositoryEdges: () => unknown = deps.repositoryEdges) => createCiWaitLines({ flow: { store: undefined as never }, companyId: ORG, repositoryEdges: async () => repositoryEdges() })({ ...(task as object), companyId: ORG } as never, repositoryId);
    const record = workflowOf([pr("app", 40), pr("payments-lib", 12)]);
    expect(await lines({ taskId: TASK_ID, project: "web", startingRevision: 1, workspaceId: "ws", workflow: { ...record, ownerId: "o" } }, "app")).toEqual([MERGE_ORDER_WORDS.ciFailureWaits("payments-lib #12")]);
    const merged = workflowOf([pr("app", 40), pr("payments-lib", 12, "MERGED")]);
    expect(await lines({ taskId: TASK_ID, project: "web", startingRevision: 1, workspaceId: "ws", workflow: { ...merged, ownerId: "o" } }, "app")).toEqual([]);
    expect(await lines({ taskId: TASK_ID, project: "web", startingRevision: 1, workspaceId: "ws", workflow: { ...record, ownerId: "o" } }, "app", () => { throw new Error("secret-canary"); })).toEqual([]);
  });

  it("is empty for another company's task, and the description seam passes the repository through", async () => {
    const foreign = { taskId: TASK_ID, companyId: `org_${"b".repeat(20)}`, project: "web", startingRevision: 1, workspaceId: "ws", workflow: { ...workflowOf([pr("app", 40), pr("payments-lib", 12)]), ownerId: "o" } } as never;
    const lines = createMergeOrderLines({ flow: { store: undefined as never }, companyId: ORG, repositoryEdges: async () => { throw new Error("must not be asked"); } });
    expect(await lines(foreign, "app")).toEqual([]);
    const own = createMergeOrderLines({ flow: { store: undefined as never }, companyId: ORG, repositoryEdges: async () => [edge("app", "payments-lib")] });
    expect(await own({ ...(foreign as object), companyId: ORG } as never, "app")).toContain("Tested together in Rovara; your CI tests each repository alone and may fail until payments-lib #12 merges.");
  });
});

describe("the description", () => {
  it("carries the CI words under the Merge order section and breaks up the pull request numbers", () => {
    const status = (lines: readonly string[]) => rovaraStatusLines({
      definitionVersion: "1.1.0", stage: "PULL_REQUEST", state: "READY", candidate: { digest: "c".repeat(64) },
      reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ role, candidateDigest: "c".repeat(64), status: "PASS", findings: [] })),
    } as never, { mergeOrderLines: lines }, () => ["- no findings"]);
    const text = status(["Merge order: payments-lib #12 first, then app #40.", "Tested together in Rovara; your CI tests each repository alone and may fail until payments-lib #12 merges."]).join("\n");
    // L4-C: the merge order is one of the things to check, above the first drawer, with the CI words under it.
    expect(text).toContain("**The order of merging matters.**");
    expect(text.indexOf("**The order of merging matters.**")).toBeLessThan(text.indexOf("<details>"));
    expect(text).toContain("Tested together in Rovara; your CI tests each repository alone and may fail until payments-lib #‍12 merges.");
  });
});

// ---- the fix loop

describe("failing CI while the repository it depends on waits", () => {
  const prs = [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }];
  /** The CI slot is filled with a decider that only records that it was asked (its own behaviour is not this lane's). */
  let asked: string[] = [];
  let release: (() => void) | undefined;
  beforeEach(() => {
    asked = [];
    release = registerMergeActionDecider("ci_fix", async (input) => { if (input.item.ci === "failing") asked.push(input.context?.repositoryId ?? "?"); return undefined; });
  });
  afterEach(() => { release?.(); });

  const setChecks = (w: MergeWorld, repositoryId: string, state: "failing" | "pending"): void => {
    const target = w.prs.find((entry) => entry.repositoryId === repositoryId)!;
    target.model.setChecks(target.head, [state === "failing" ? { name: "unit", state: "completed", conclusion: "failure", required: false, url: "", runId: "11" } : { name: "unit", state: "pending", required: false, url: "" }]);
  };
  const setup = async (facts: unknown, options: { providerMerged?: boolean } = {}) => {
    const w = await mergeWorld({ pullRequests: prs });
    const task = await w.task();
    if (options.providerMerged === true) await w.setWorkflow({ pullRequests: task.workflow.pullRequests!.map((entry) => ({ ...entry, state: entry.repositoryId === "payments-lib" ? "MERGED" : entry.state })) });
    const events: string[] = [];
    const deps = { ...w.tracking, ...(facts === "none" ? {} : { repositoryEdges: async () => { events.push("facts"); return facts; } }), log: (event: string) => { events.push(event); } };
    return { w, deps, events };
  };

  it("asks the CI slot nothing for the consumer, and says so once per head", async () => {
    const { w, deps, events } = await setup([edge("app", "payments-lib")]);
    setChecks(w, "app", "failing");
    await trackTask(deps, TASK_ID);
    expect(asked).toEqual([]);
    expect(events.filter((entry) => entry === "merge_tracking.ci_failure_waits_for_provider")).toHaveLength(1);
    await trackTask(deps, TASK_ID);
    expect(asked).toEqual([]);
    expect(events.filter((entry) => entry === "merge_tracking.ci_failure_waits_for_provider")).toHaveLength(1);
  });

  it("control: the slot is asked with no facts, with facts that cannot be read, a cycle, for the provider itself, and once the provider has merged", async () => {
    for (const [facts, target, merged] of [["none", "app", false], [[], "app", false], ["bad", "app", false], [[edge("app", "payments-lib"), edge("payments-lib", "app")], "app", false], [[edge("app", "payments-lib")], "payments-lib", false], [[edge("app", "payments-lib")], "app", true]] as const) {
      asked = [];
      const { w, deps } = await setup(facts, { providerMerged: merged });
      setChecks(w, target, "failing");
      await trackTask(deps, TASK_ID);
      expect(asked, JSON.stringify([facts, target, merged])).toEqual([target]);
    }
  });
});

describe("the task page", () => {
  it("says a failing consumer's CI is waiting for its provider, and only asks about pull requests whose checks are failing", async () => {
    const asked: string[] = [];
    const ciWaitLines = async (_task: unknown, repositoryId: string) => { asked.push(repositoryId); return [MERGE_ORDER_WORDS.ciFailureWaits("payments-lib #1")]; };
    const passing = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }] });
    await passing.seedTracking();
    const okTask = (await passing.task()) as never;
    const plain = await attentionOf({ store: passing.store, companyId: ORG }, okTask);
    expect((await attentionOf({ store: passing.store, companyId: ORG, ciWaitLines }, okTask)).view).toEqual(plain.view);
    expect(asked).toEqual([]);
    const world = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }] });
    await world.seedTracking({ ci: "failing", failingChecks: ["unit"] });
    const task = (await world.task()) as never;
    const shown = await attentionOf({ store: world.store, companyId: ORG, ciWaitLines }, task);
    expect(shown.view.merge?.lines).toContain(MERGE_ORDER_WORDS.ciFailureWaits("payments-lib #1"));
    expect(new Set(asked)).toEqual(new Set(["app", "payments-lib"]));
    // A seam that fails leaves the page as it was.
    const base = await attentionOf({ store: world.store, companyId: ORG }, task);
    const broken = await attentionOf({ store: world.store, companyId: ORG, ciWaitLines: async () => { throw new Error("down"); } }, task);
    expect(broken.view).toEqual(base.view);
  });
});
