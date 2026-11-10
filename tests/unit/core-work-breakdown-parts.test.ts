// the broker's decisions about parts, ported from Cloud's `rovara-code-parallel-parts-broker.test.ts` onto the document store: how many parts may run together (held to the free
// workspace slots of the person and of the company), when ordered work may start, the trees a part may start from, and whether an older worker can take over a plan's retained progress.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PARALLEL_PARTS_MAX, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";
import { developerCharge, type WorkspaceCharge } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { parallelPartsDecision, parallelPartsForTask, parallelStartTrees, serialWorkerCanResume, widestStep, workflowDependenciesAllowed } from "../../packages/broker/src/core/work-breakdown/parallel-parts.js";

const charge = developerCharge({ companyId: IMPLICIT_COMPANY_ID, developerId: "dev-1" });
const V2 = { definitionVersion: "1.1.0" };

/** A store of counters, read the way the flow reads them; `fail` makes every read throw. */
function counters(input: { memberCount?: number; orgCount?: number; fail?: boolean }, limits: { member: number; organization: number } = { member: 3, organization: 20 }) {
  const store = new MemoryDocumentStore();
  const reader = input.fail === true ? { ...store, get: async () => { throw new Error("store unavailable"); } } : store;
  return (async () => {
    if (input.memberCount !== undefined) await store.put({ item: { ...charge.member, entityType: "DEVELOPER_LIMIT", count: input.memberCount } });
    if (input.orgCount !== undefined) await store.put({ item: { ...charge.organization, entityType: "ORG_LIMIT", count: input.orgCount } });
    return { store: reader as unknown as MemoryDocumentStore, limits };
  })();
}
const task = (extra: { charge?: WorkspaceCharge; workflow?: { definitionVersion?: string } } = {}) => ({ charge, workflow: V2, ...extra });

describe("the number of parts that may run together", () => {
  it("version 1 tasks get no parts setting at all", async () => {
    expect(await parallelPartsForTask(await counters({}), task({ workflow: { definitionVersion: "1.0.0" } }))).toBeUndefined();
    expect(await parallelPartsForTask(await counters({}), { charge })).toBeUndefined();
  });

  it("a version 2 task gets the plan's cap when the person and the company have room", async () => {
    expect(await parallelPartsForTask(await counters({ memberCount: 1, orgCount: 1 }, { member: 50, organization: 1000 }), task())).toEqual({ max: PARALLEL_PARTS_MAX });
  });

  it("is held to the free workspace slots of the person and of the company: the task's own slot, plus what is free", async () => {
    const run = async (member: number, organization: number, memberCount: number, orgCount: number) => parallelPartsForTask(await counters({ memberCount, orgCount }, { member, organization }), task());
    expect(await run(3, 20, 3, 5)).toEqual({ max: 1 });
    expect(await run(3, 20, 2, 5)).toEqual({ max: 2 });
    expect(await run(5, 6, 2, 5)).toEqual({ max: 2 });
    expect(await run(5, 5, 2, 5)).toEqual({ max: 1 });
    expect(await run(5, 20, 1, 5)).toEqual({ max: 3 });
    // The smaller room decides: the company is nearly full though the person is not.
    expect(await run(5, 7, 1, 6)).toEqual({ max: 2 });
    // Counts above the limits (a limit lowered after tasks were started) leave one part.
    expect(await run(2, 3, 9, 9)).toEqual({ max: 1 });
  });

  it("counts nothing as no room used, and reads the counters of the charge the task actually holds", async () => {
    expect(await parallelPartsForTask(await counters({}), task())).toEqual({ max: PARALLEL_PARTS_MAX });
    const payer = developerCharge({ companyId: IMPLICIT_COMPANY_ID, developerId: "payer-9" });
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...payer.member, entityType: "DEVELOPER_LIMIT", count: 3 } });
    await store.put({ item: { ...payer.organization, entityType: "ORG_LIMIT", count: 5 } });
    const deps = { store, limits: { member: 3, organization: 20 } };
    // The payer's counters are full, though the creator's own keys are free.
    expect(await parallelPartsForTask(deps, task({ charge: payer }))).toEqual({ max: 1 });
    expect(await parallelPartsForTask(deps, task())).toEqual({ max: PARALLEL_PARTS_MAX });
  });

  it("uses the flow's default limits when it was given none", async () => {
    const store = new MemoryDocumentStore();
    expect(await parallelPartsForTask({ store }, task())).toEqual({ max: PARALLEL_PARTS_MAX });
  });

  it("fails closed to one part when the counts cannot be read", async () => {
    expect(await parallelPartsForTask(await counters({ fail: true }), task())).toEqual({ max: 1 });
  });
});

describe("when ordered work is allowed", () => {
  it("a version 2 task always may; a version 1 task only when the install's switch is on", () => {
    expect(workflowDependenciesAllowed({ workflowDependenciesEnabled: false }, { definitionVersion: "1.1.0" })).toBe(true);
    expect(workflowDependenciesAllowed({}, { definitionVersion: "1.1.0" })).toBe(true);
    expect(workflowDependenciesAllowed({ workflowDependenciesEnabled: false }, { definitionVersion: "1.0.0" })).toBe(false);
    expect(workflowDependenciesAllowed({}, undefined)).toBe(false);
    expect(workflowDependenciesAllowed({ workflowDependenciesEnabled: true }, { definitionVersion: "1.0.0" })).toBe(true);
  });
});

describe("the trees a part may start from", () => {
  const t = (digit: string) => digit.repeat(40);
  it("are the tree the run began at and each tree a finished part was merged into, and no other", () => {
    const trees = parallelStartTrees([
      { state: "STARTED", candidateTreeSha: undefined }, { state: "IMPLEMENTED", candidateTreeSha: t("1"), integratedTreeSha: t("2") },
      { state: "FAILED" }, { state: "IMPLEMENTED", candidateTreeSha: t("3"), integratedTreeSha: t("4") }, { state: "UNKNOWN" },
    ], t("0"));
    expect([...trees].sort()).toEqual([t("0"), t("2"), t("4")]);
    expect(trees.has(t("1"))).toBe(false);
    expect(trees.has(t("3"))).toBe(false);
  });

  it("count a part built one after another by the tree it ended on", () => {
    expect([...parallelStartTrees([{ state: "IMPLEMENTED", candidateTreeSha: t("5") }], t("0"))].sort()).toEqual([t("0"), t("5")]);
  });

  it("are only the finished parts' when the run has no first tree", () => {
    expect([...parallelStartTrees([{ state: "IMPLEMENTED", integratedTreeSha: t("2") }], undefined)]).toEqual([t("2")]);
    expect(parallelStartTrees([], undefined).size).toBe(0);
  });
});

describe("whether an older worker can take over a plan's retained progress", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const graph: TaskGraphV1 = { schemaVersion: 1, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items: [
    { id: A, title: "A", description: "A.", repository: "r", dependsOn: [] }, { id: B, title: "B", description: "B.", repository: "r", dependsOn: [] },
    { id: C, title: "C", description: "C.", repository: "r", dependsOn: [A, B] },
  ] };
  const done = (itemId: string, tree: string, state: WorkItemProgressV1["state"] = "IMPLEMENTED"): WorkItemProgressV1 => ({
    schemaVersion: 1, graphDigest: "d".repeat(64), runId: "8c330a74-b4c6-4f01-9356-5fe54fc55b21", itemId, sequence: 1, state, operationId: "8c330a74-b4c6-4f01-9356-5fe54fc55b20",
    baseTreeSha: "0".repeat(40), ...(state === "IMPLEMENTED" ? { candidateTreeSha: tree, integratedTreeSha: tree } : {}), at: "2026-10-26T12:00:00.000Z", producer: "agentx-worker",
  });
  const t = (digit: string) => digit.repeat(40);

  it("can when nothing was finished", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [], resumeTreeSha: undefined })).toBe(true);
    expect(serialWorkerCanResume({ graph })).toBe(true);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1"), "UNKNOWN")] })).toBe(true);
  });

  it("can from a completed prefix of the plan's order that ended on the workspace's tree", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1"))], resumeTreeSha: t("1") })).toBe(true);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1")), done(B, t("2"))], resumeTreeSha: t("2") })).toBe(true);
  });

  it("cannot from a set that is closed under dependencies but is not a prefix (B done, A not)", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(B, t("2"))], resumeTreeSha: t("2") })).toBe(false);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(B, t("2")), done(A, t("1"), "FAILED")], resumeTreeSha: t("2") })).toBe(false);
  });

  it("cannot from a prefix whose last item did not end on the tree the workspace holds (the parts were merged after it)", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1")), done(B, t("2"))], resumeTreeSha: t("3") })).toBe(false);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1"))], resumeTreeSha: undefined })).toBe(false);
  });
});

describe("the timeline line that says why parts run one after another", () => {
  const item = (id: string, dependsOn: string[] = []) => ({ id: `${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-8${id.repeat(3)}-${id.repeat(12)}`, title: id, description: id, repository: "r", dependsOn });
  const ids = { a: item("a").id, b: item("b").id };
  const graph = (...items: ReturnType<typeof item>[]): TaskGraphV1 => ({ schemaVersion: 1, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items });
  const independent = graph(item("a"), item("b"));
  const note = async (input: Parameters<typeof counters>[0], limits: { member: number; organization: number }, plan = independent, workflow = V2) => (await parallelPartsDecision(await counters(input, limits), task({ workflow }), plan)).note;

  it("says how many of the person's workspaces are in use when the person's limit allows one part", async () => {
    expect(await note({ memberCount: 3, orgCount: 5 }, { member: 3, organization: 20 })).toBe("Running parts one at a time: 3 of 3 of your workspaces are in use.");
    expect((await parallelPartsDecision(await counters({ memberCount: 3, orgCount: 5 }), task(), independent)).parallel).toEqual({ max: 1 });
  });

  it("names the company when its limit is the tighter one", async () => {
    expect(await note({ memberCount: 2, orgCount: 5 }, { member: 5, organization: 5 })).toBe("Running parts one at a time: 5 of 5 of your company's workspaces are in use.");
  });

  it("says up to how many parts run when the room allows some but fewer than the plan could use", async () => {
    expect(await note({ memberCount: 4, orgCount: 5 }, { member: 5, organization: 20 }, graph(item("a"), item("b"), item("c")))).toBe("Running up to 2 parts at a time: 4 of 5 of your workspaces are in use.");
  });

  it("says nothing when the room covers every part the plan can run together, or the plan has nothing to run together", async () => {
    expect(await note({ memberCount: 1, orgCount: 1 }, { member: 50, organization: 1000 })).toBeUndefined();
    // Two parts and room for two: no line, though the cap is three.
    expect(await note({ memberCount: 4, orgCount: 5 }, { member: 5, organization: 20 })).toBeUndefined();
    expect(await note({ memberCount: 3, orgCount: 5 }, { member: 3, organization: 20 }, graph(item("a"), item("b", [ids.a]), item("c", [item("b").id])))).toBeUndefined();
    expect(await note({ memberCount: 3, orgCount: 5 }, { member: 3, organization: 20 }, graph(item("a")))).toBeUndefined();
  });

  it("says nothing for a version 1 task, which never runs parts together", async () => {
    expect(await note({ memberCount: 3, orgCount: 5 }, { member: 3, organization: 20 }, independent, { definitionVersion: "1.0.0" })).toBeUndefined();
  });

  it("says so when the counts could not be read, and still runs one part", async () => {
    const decision = await parallelPartsDecision(await counters({ fail: true }), task(), independent);
    expect(decision.parallel).toEqual({ max: 1 });
    expect(decision.note).toBe("Running parts one at a time: Rovara could not read your workspace limits.");
  });

  it("counts the widest step of a plan's order", () => {
    expect(widestStep(independent)).toBe(2);
    expect(widestStep(graph(item("a")))).toBe(1);
  });
});
