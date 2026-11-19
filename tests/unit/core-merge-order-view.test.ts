// MR3b (TE-R3): where the merge order is SHOWN. The pure lines (the order, and what happened when a pull request was merged ahead of the one it depends on) on the Merge section's view, the pull request
// description and the task page. The view's field is added readers first (DEC 152a): the writer is off until an install turns it on. Words are fixed; every repository name is one inert line. Never GitHub.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MergePressBodySchema, MergeViewSchema, MERGE_VIEW_MESSAGE_MAX, IMPLICIT_COMPANY_ID } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { MERGE_ORDER_WORDS, createMergeOrderLines, mergeOrderLinesOfTask, mergeOrderOf, mergeOrderStateLines, mergeViewOf, readMergeTracking } from "../../packages/broker/src/core/merge/index.js";
import { rovaraStatusLines, rovaraPullRequestBody } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { attentionOf } from "../../packages/broker/src/local/app/attention.js";
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

  it("is today's view, byte for byte, until an install turns the writer on (readers first, DEC 152a)", async () => {
    const off = await viewOf([edge("app", "payments-lib")], { orderInView: false });
    const none = await viewOf(undefined, { seam: false, orderInView: false });
    expect(JSON.stringify(off.view)).toBe(JSON.stringify(none.view));
    expect(off.view).not.toHaveProperty("order");
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

  it("stays inside the view's bounds whatever the repositories are called, and reads every name as inert text", () => {
    const names = Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(198)}`);
    const order = mergeOrderOf(names, [edge(names[0]!, names[1]!)]);
    const lines = mergeOrderStateLines(order, names.map((repositoryId, index) => ({ repositoryId, number: index + 1 })));
    expect(lines).toHaveLength(1);
    // The view cuts it to its own bound (the line itself is bounded by the 32 names).
    expect(lines[0]!.length).toBeLessThan(32 * 60);
    const hostile = mergeOrderStateLines(mergeOrderOf(["a@everyone", "b‮[x](http://evil.example)\n#12"], [edge("a@everyone", "b‮[x](http://evil.example)\n#12")]), [{ repositoryId: "a@everyone", number: 1 }, { repositoryId: "b‮[x](http://evil.example)\n#12", number: 2 }]);
    expect(hostile[0]).not.toMatch(/\n|‮|\]\(/u);
    expect(hostile[0]).not.toContain("@everyone");
    void MERGE_VIEW_MESSAGE_MAX;
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

  it("says nothing without a seam, without facts, for one repository, or for today's order", async () => {
    const workflow = workflowOf([{ repositoryId: "app", number: 1 }, { repositoryId: "lib", number: 2 }]);
    expect(await mergeOrderLinesOfTask({}, taskOf(workflow))).toEqual([]);
    expect(await mergeOrderLinesOfTask({ repositoryEdges: async () => undefined }, taskOf(workflow))).toEqual([]);
    expect(await mergeOrderLinesOfTask({ repositoryEdges: async () => [] }, taskOf(workflow))).toEqual([]);
    expect(await mergeOrderLinesOfTask({ repositoryEdges: async () => [edge("app", "lib")] }, taskOf(workflowOf([{ repositoryId: "app", number: 1 }])))).toEqual([]);
  });

  it("says no safe order for a cycle or a seam that throws, naming no cause", async () => {
    const workflow = workflowOf([{ repositoryId: "app", number: 1 }, { repositoryId: "lib", number: 2 }]);
    expect(await mergeOrderLinesOfTask({ repositoryEdges: async () => [edge("app", "lib"), edge("lib", "app")] }, taskOf(workflow))).toEqual([MERGE_ORDER_WORDS.noSafeOrder.cycle]);
    const logged: string[] = [];
    const lines = await mergeOrderLinesOfTask({ repositoryEdges: () => { throw new Error("secret-canary"); }, log: (event, fields) => { logged.push(`${event}${JSON.stringify(fields)}`); } }, taskOf(workflow));
    expect(lines).toEqual([MERGE_ORDER_WORDS.noSafeOrder.unreadable]);
    expect(logged.join("")).not.toContain("secret-canary");
  });

  it("is empty for another company's task and never throws", async () => {
    const lines = createMergeOrderLines({ flow: { store: undefined as never }, companyId: ORG, repositoryEdges: async () => { throw new Error("must not be asked"); } });
    const record = { taskId: TASK_ID, companyId: `org_${"b".repeat(20)}`, project: "web", startingRevision: 1, workspaceId: "ws", workflow: workflowOf(PRS) } as never;
    expect(await lines(record)).toEqual([]);
    expect(await lines({ ...(record as object), companyId: ORG, workflow: undefined } as never)).toEqual([]);
    // Control: the same record in its own company reads the facts (and its unreadable facts are words, not a throw).
    expect(await lines({ ...(record as object), companyId: ORG, workflow: { ...workflowOf(PRS), definitionVersion: "1.1.0" } } as never)).toEqual([MERGE_ORDER_WORDS.noSafeOrder.unreadable]);
    void IMPLICIT_COMPANY_ID;
  });
});

describe("the pull request description and the task page", () => {
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const workflow = () => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate,
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-13T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] },
    reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-11-13T12:00:00.000Z" })),
  });
  const status = (mergeOrderLines?: readonly string[]) => rovaraStatusLines(workflow(), { ...(mergeOrderLines === undefined ? {} : { mergeOrderLines }) }, () => ["- no findings"]);

  it("is byte for byte today's description without lines", () => {
    expect(status([])).toEqual(status());
    expect(status().join("\n")).not.toContain("Merge order");
    expect(status().join("\n")).not.toContain("order of merging");
  });

  it("lists the lines as one thing to check, above the first drawer, once, as inert text", () => {
    const lines = status(["Merge order: payments-lib #12 first, then app #40."]);
    const text = lines.join("\n");
    expect(lines.filter((line) => /^\d+\. \*\*The order of merging matters\.\*\*/u.test(line))).toHaveLength(1);
    expect(text.indexOf("The order of merging matters.")).toBeLessThan(text.indexOf("<details>"));
    // A `#12` would link another repository's issue 12: it is broken up.
    expect(text).not.toContain("#12 ");
    expect(text).toContain("payments-lib #‍12");
    // Whatever a caller passes cannot add a heading, a link or a second line, and at most four lines are listed (the rest are counted).
    const hostile = status(["# Heading\n## Another [click](http://evil.example) @team <!-- x -->", "a", "b", "c", "d", "e"]).join("\n");
    expect(hostile).not.toMatch(/\n#+ Heading/u);
    expect(hostile).not.toContain("](http");
    expect(hostile).not.toContain("<!-- x");
    expect(hostile.match(/The order of merging matters\./gu)).toHaveLength(1);
    const sub = hostile.split("**The order of merging matters.**")[1]!.split("\n\n")[0]!.split("\n").filter((line) => line.trim().startsWith("- "));
    expect(sub).toHaveLength(5);
    expect(sub.at(-1)).toContain("and 2 more");
  });

  it("is in the whole description between the markers, and the description stays within its cap", () => {
    const text = rovaraPullRequestBody({ summary: ["Retry the payment"], fallbackTitle: "t", workflow: workflow(), context: { mergeOrderLines: ["Merge order: payments-lib first, then app."] }, reviewLines: () => ["- no findings"], pageUrl: undefined });
    expect(text.indexOf("The order of merging matters.")).toBeGreaterThan(text.indexOf("<!-- rovara:checks-and-reviews -->"));
    expect(text.indexOf("The order of merging matters.")).toBeLessThan(text.indexOf("<!-- /rovara:checks-and-reviews -->"));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(30_000);
  });

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
