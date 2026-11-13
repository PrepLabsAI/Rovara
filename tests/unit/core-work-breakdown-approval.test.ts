// what approving a plan with a work breakdown binds (Cloud's `decide.ts` breakdown block): the digest of the graph in the stored document the approval's own digest names,
// and the refusals (a version 1 task without the install's switch, a task not pinned to one repository, an invalid graph).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPlanJson, taskGraphDigest, type TaskGraphV1, type WorkflowArtifact } from "@rovara-code/contracts";
import { WORKFLOW_BREAKDOWN_REFUSALS } from "../../packages/core/src/developer/workflow-actions.js";
import { PLAN_UNREADABLE, approvedGraphOf, breakdownForApproval } from "../../packages/core/src/core/work-breakdown/plan-graph.js";
import { planDocument } from "../support/plan-documents.js";

const TASK = "8c330a74-b4c6-4f01-9356-5fe54fc55b19";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const graphOf = (repository = "demo"): TaskGraphV1 => ({ schemaVersion: 1, taskId: TASK, version: 1, items: [
  { id: A, title: "A", description: "Build A.", repository, dependsOn: [] }, { id: B, title: "B", description: "Build B after A.", repository, dependsOn: [A] },
] });

function world(graph: TaskGraphV1 | undefined, options: { repositories?: number; format?: "structured" | "markdown" } = {}) {
  const text = options.format === "markdown" ? "# A plan\n" : canonicalPlanJson(planDocument(graph === undefined ? {} : { workBreakdown: graph }));
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const artifact = { id: "99999999-9999-4999-8999-999999999999", type: "plan", version: 1, sha256, producer: "agentx-worker-untrusted", objectKey: "plans/p.json", createdAt: "2026-11-09T10:00:00.000Z", format: options.format ?? "structured" } as unknown as WorkflowArtifact;
  const repositories = Array.from({ length: options.repositories ?? 1 }, (_, index) => ({ name: index === 0 ? "demo" : `other${String(index)}`, url: `https://examplehost/example/r${String(index)}.git`, path: `repo/r${String(index)}`, defaultBranch: "main", credentialRef: "host-app" }));
  const deps = {
    artifacts: { get: async (key: string) => (key === "plans/p.json" ? new TextEncoder().encode(text) : undefined) },
    projects: { latest: async () => undefined, revision: async () => ({ definition: { name: "payments", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "x" } }) },
  } as unknown as Parameters<typeof breakdownForApproval>[0];
  const task = { taskId: TASK, project: "payments", startingRevision: 1 };
  return { deps, task, artifact, sha256, workflow: (version = "1.1.0") => ({ artifacts: [artifact], definitionVersion: version }) };
}

describe("what approving a plan binds", () => {
  it("is the digest of the graph in the document the approval's digest names", async () => {
    const w = world(graphOf());
    expect(await breakdownForApproval(w.deps, w.task, w.workflow(), w.sha256)).toEqual({ digest: taskGraphDigest(graphOf()) });
  });

  it("is nothing for a plan with no breakdown, a Markdown plan, or a digest that names no plan", async () => {
    const none = world(undefined);
    expect(await breakdownForApproval(none.deps, none.task, none.workflow(), none.sha256)).toEqual({});
    const markdown = world(undefined, { format: "markdown" });
    expect(await breakdownForApproval(markdown.deps, markdown.task, markdown.workflow(), markdown.sha256)).toEqual({});
    const w = world(graphOf());
    expect(await breakdownForApproval(w.deps, w.task, w.workflow(), "f".repeat(64))).toEqual({});
  });

  it("is refused, never approved as a plan with no breakdown, when the structured plan cannot be read back (missing, a storage fault, bytes that no longer match the digest)", async () => {
    const w = world(graphOf());
    const missing = { ...w.deps, artifacts: { get: async () => undefined } };
    const faulty = { ...w.deps, artifacts: { get: async (): Promise<Uint8Array> => { throw new Error("object storage unavailable"); } } };
    const changed = { ...w.deps, artifacts: { get: async () => new TextEncoder().encode(canonicalPlanJson(planDocument({ title: "Another plan" }))) } };
    for (const deps of [missing, faulty, changed]) expect(await breakdownForApproval(deps, w.task, w.workflow(), w.sha256)).toEqual({ refusal: PLAN_UNREADABLE });
    // A Markdown plan has no breakdown to lose, so it is not refused.
    const markdown = world(undefined, { format: "markdown" });
    expect(await breakdownForApproval({ ...markdown.deps, artifacts: { get: async () => undefined } }, markdown.task, markdown.workflow(), markdown.sha256)).toEqual({});
  });

  it("is refused for a version 1 task unless the install's switch is on", async () => {
    const w = world(graphOf());
    expect(await breakdownForApproval(w.deps, w.task, w.workflow("1.0.0"), w.sha256)).toEqual({ refusal: WORKFLOW_BREAKDOWN_REFUSALS.notEnabled });
    expect(await breakdownForApproval({ ...w.deps, workflowDependenciesEnabled: true }, w.task, w.workflow("1.0.0"), w.sha256)).toEqual({ digest: taskGraphDigest(graphOf()) });
  });

  it("is refused when the task is not pinned to exactly one repository, or the graph names another one or another task", async () => {
    const two = world(graphOf(), { repositories: 2 });
    expect(await breakdownForApproval(two.deps, two.task, two.workflow(), two.sha256)).toEqual({ refusal: WORKFLOW_BREAKDOWN_REFUSALS.onePinnedRepository });
    const elsewhere = world(graphOf("elsewhere"));
    expect((await breakdownForApproval(elsewhere.deps, elsewhere.task, elsewhere.workflow(), elsewhere.sha256)).refusal).toMatch(/^the approved work breakdown is invalid: .*repository/u);
    const w = world(graphOf());
    expect((await breakdownForApproval(w.deps, { ...w.task, taskId: "11111111-1111-4111-8111-111111111112" }, w.workflow(), w.sha256)).refusal).toMatch(/does not match the current task/u);
  });
});

describe("the approved graph of a task, read again", () => {
  it("is the one the approval named, checked against the approval's digest; anything else is WORKSPACE_NOT_READY (never plain coding)", async () => {
    const w = world(graphOf());
    const approval = { artifactDigest: w.sha256, graphDigest: taskGraphDigest(graphOf()) };
    expect(await approvedGraphOf(w.deps, { taskId: TASK }, { artifacts: [w.artifact], workflowDependenciesApproval: approval })).toEqual(graphOf());
    expect(await approvedGraphOf(w.deps, { taskId: TASK }, { artifacts: [w.artifact] })).toBeUndefined();
    await expect(approvedGraphOf(w.deps, { taskId: TASK }, { artifacts: [w.artifact], workflowDependenciesApproval: { ...approval, graphDigest: "e".repeat(64) } })).rejects.toThrow(/digest check/u);
    await expect(approvedGraphOf(w.deps, { taskId: TASK }, { artifacts: [], workflowDependenciesApproval: approval })).rejects.toThrow(/plan is missing/u);
    await expect(approvedGraphOf({ ...w.deps, artifacts: { get: async () => new TextEncoder().encode("changed") } }, { taskId: TASK }, { artifacts: [w.artifact], workflowDependenciesApproval: approval })).rejects.toThrow(/digest check/u);
  });
});
