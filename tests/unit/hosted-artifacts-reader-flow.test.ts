// L4-ART: what the flow does on a hosted root once its `artifacts` reader is wired (the company-bound reader of core-host/company-artifact-reader.ts). Two halves:
//  1. the eval request: a hosted task whose project asks for an eval gets the request, a second pass reads the first round the worker saved (under the engine's own callback key), and a key of
//     another operation, task or company, a missing, unreadable or oversized round gives no new request (never a reset spend);
//  2. every other reader of `deps.artifacts` in the flow: with the reader it reads the task's own documents; given a pointer to another company's key it gives exactly the answer it gives with no reader at
//     all (today's hosted answer), so no reader can be made to show another company's document. The set of readers is pinned (a new one must be classified here).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_ROUND_ARTIFACT, WORKER_INVOCATION_FEATURES, canonicalPlanJson, captureEvalRoundEvidence, type JsonValue, type ObjectStorage, type OrgId, type TaskGraphV1, type WorkflowArtifact, type WorkflowSnapshot,
} from "@agentx/contracts";
import { approvedCodingPlan, reviewPlanOf } from "../../packages/broker/src/core/build-step/plan-input.js";
import { WORKSPACE_DIFF_ARTIFACT, artifactRowKey, reportedChangedFiles } from "../../packages/broker/src/core/build-step/changed-files.js";
import { evalRequestForChecks } from "../../packages/broker/src/core/proof/eval-round-reader.js";
import { earlierPlans } from "../../packages/broker/src/core/plan/context.js";
import { PLAN_UNREADABLE, approvedGraphOf, breakdownForApproval } from "../../packages/broker/src/core/work-breakdown/plan-graph.js";
import { planContextOf, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import { createCompanyArtifactReader } from "../../packages/broker/src/core-host/company-artifact-reader.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { planDocument } from "../support/plan-documents.js";
import { COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const OTHER_COMPANY = COMPANY_B_ID as OrgId;
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The object port as the S3 adapter behaves (undefined when missing or bigger than maxBytes), every ask counted; `down` makes it throw. */
function objectsWorld() {
  const objects = new Map<string, Uint8Array>();
  const asked: string[] = [];
  const state = { down: false };
  const blobs: Pick<ObjectStorage, "get"> = {
    async get(key, maxBytes) {
      asked.push(key);
      if (state.down) throw new Error("object storage down");
      const found = objects.get(key);
      return found === undefined || found.byteLength > maxBytes ? undefined : found;
    },
  };
  return { objects, asked, blobs, state };
}

async function world(options: { hint?: boolean } = {}) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: WORKER_INVOCATION_FEATURES } });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Eval change", workflow: true, workflowPath: "QUICK" });
  const answered = new Set<string>();
  for (let round = 0; round < 8; round++) {
    const current = (await readWorkspace(h.deps, started.task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 }); h.clock.advance(70);
    const after = (await readWorkspace(h.deps, started.task.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find(entry => !answered.has(entry.operationId));
    if (job === undefined) continue; answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const task = (await readTask(h.deps, started.task.taskId))!;
  const workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results",
    flow: { ...task.workflow?.flow, tier: { kind: "small", reasons: options.hint === false ? [] : [{ code: "eval_hint" }] } },
    checkPolicy: { required: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  } as unknown as WorkflowSnapshot;
  await h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  const stored = objectsWorld();
  const hosted = () => createCompanyArtifactReader({ blobs: stored.blobs, store: h.store, companyId: h.deps.companyId });
  h.deps.artifacts = hosted();
  const companyId = h.deps.companyId;
  const workspace = workspaceKey(companyId, task.workspaceId);
  return { h, task, workflow, stored, hosted, companyId, workspace };
}
type World = Awaited<ReturnType<typeof world>>;

const roundJson = (pass: 1 | 2, extra: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "check_unsealed", evalPass: pass, outcome: "done", usage: { calls: 4, costMicros: 40 }, cache: "hit", evalConfigured: true,
  ...captureEvalRoundEvidence({ context: { aiChange: true, discovery: "configured", previousPasses: (pass - 1) as 0 | 1 }, comparison: { questions: [{ id: "q", category: "ordinary", old: Array.from({ length: 3 }, () => ({ pass: true, answer: "yes" })), first: { pass: false, answer: "no" } }], changedPromptCalls: 1 } }), ...extra,
});

/** A finished eval attempt the way the engine writes it: the operation row that carried the request, its ARTIFACT row, and the round the worker saved under the core callback's key. */
async function savedRound(w: World, options: { operation?: string; workspaceId?: string; objectKey?: string; body?: string | Uint8Array; pass?: 1 | 2 } = {}) {
  const operation = options.operation ?? "op-eval-1";
  const workspaceId = options.workspaceId ?? w.task.workspaceId;
  const objectKey = options.objectKey ?? artifactObjectKey(workspaceId, operation, EVAL_ROUND_ARTIFACT);
  await w.h.store.put({ item: { ...operationKey(w.companyId, w.task.workspaceId, operation), entityType: "OPERATION", id: operation, workspaceId: w.task.workspaceId, kind: "task", workflowMode: "CHECKS", status: "SUCCEEDED", fence: 1,
    createdAt: "2026-11-14T00:00:00.000Z", companyId: w.companyId, dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evalRequest: { aiChange: true } } } } });
  await w.h.store.put({ item: { ...artifactRowKey(w.workspace, operation, EVAL_ROUND_ARTIFACT), entityType: "ARTIFACT", id: `art-${operation}`, workspaceId: w.task.workspaceId, operationId: operation, name: EVAL_ROUND_ARTIFACT, objectKey, sha256: "0".repeat(64), bytes: 1, createdAt: "2026-11-14T00:00:01.000Z" } });
  const body = options.body ?? roundJson(options.pass ?? 1);
  w.stored.objects.set(objectKey, typeof body === "string" ? bytesOf(body) : body);
  return { operation, objectKey };
}
/** A workspace record of its own (the same company, or another), for the key shapes that name somebody else's. */
async function otherWorkspace(w: World, companyId: OrgId, workspaceId: string, ownerKey: string) {
  await w.h.store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId, orgId: companyId, ownerKey, projectName: "payments" } });
}

describe("hosted eval request: the reader turns it on, and only for the task's own evidence", () => {

  it("another operation's key is refused: the row for an eval attempt points at a different operation's folder, so spend stays unknown and no request is made", async () => {
    const w = await world();
    await savedRound(w, { objectKey: artifactObjectKey(w.task.workspaceId, "op-someone-else", EVAL_ROUND_ARTIFACT) });
    expect(await evalRequestForChecks(w.h.deps, w.task, w.workflow)).toBeUndefined();
    expect(w.stored.asked).toEqual([]);
  });

  it("an unreadable object store never resets the spend to zero: no request", async () => {
    const w = await world();
    await savedRound(w);
    w.stored.state.down = true;
    expect(await evalRequestForChecks(w.h.deps, w.task, w.workflow)).toBeUndefined();
  });
});

// ---- every other reader of deps.artifacts ----

const TASK_GRAPH = (taskId: string): TaskGraphV1 => ({ schemaVersion: 1, taskId, version: 1, items: [
  { id: "11111111-1111-4111-8111-111111111111", title: "A", description: "Build A.", repository: "demo", dependsOn: [] },
] });

/** One document of the task: stored under its own workspace's callback key, and a second copy under ANOTHER company's key that the task's workflow could be made to point at. */
async function documents(w: World, kind: "markdown" | "structured", name: string, text: string) {
  const own = artifactObjectKey(w.task.workspaceId, "op-doc-1", name);
  const foreignWorkspace = "ws-foreign-doc";
  await otherWorkspace(w, OTHER_COMPANY, foreignWorkspace, "owner-foreign");
  const foreign = artifactObjectKey(foreignWorkspace, "op-doc-1", name);
  w.stored.objects.set(own, bytesOf(text)); w.stored.objects.set(foreign, bytesOf(text));
  // the engine's own record of the worker's artifact (services/callbacks.ts), which the hosted reader requires for a callback-shaped key
  await w.h.store.put({ item: { ...w.workspace, sk: `ARTIFACT#op-doc-1#${name}`, entityType: "ARTIFACT", objectKey: own } });
  const artifact = (objectKey: string): WorkflowArtifact => ({ id: "99999999-9999-4999-8999-999999999999", type: "plan", version: 1, sha256: sha(text), producer: "agentx-worker-untrusted", objectKey, createdAt: "2026-11-09T10:00:00.000Z", format: kind });
  return { own: artifact(own), foreign: artifact(foreign) };
}
const approved = (artifact: WorkflowArtifact) => ({ artifacts: [artifact], decisions: [{ decision: "APPROVE", artifactDigest: artifact.sha256, source: "GATE" }] }) as unknown as Pick<WorkflowSnapshot, "artifacts" | "decisions">;
const PLAN_TEXT = "# The plan\n\nChange one file.\n";
const settle = async <T>(run: () => Promise<T>): Promise<{ value: T } | { error: string }> => run().then((value) => ({ value }), (error: unknown) => ({ error: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : (error as Error).name }));

describe("every other reader of the flow's artifacts, with the hosted reader", () => {
  it("approvedCodingPlan and reviewPlanOf (the coding step, the reviewers, the PR body, setup offers, mocks): the own plan reads; another company's pointer is today's refusal", async () => {
    const w = await world();
    const { own, foreign } = await documents(w, "markdown", "plan.md", PLAN_TEXT);
    const reader = w.hosted();
    expect(await approvedCodingPlan(reader, approved(own))).toMatchObject({ text: PLAN_TEXT, sha256: own.sha256 });
    expect(await reviewPlanOf(reader, approved(own))).toMatchObject({ markdown: PLAN_TEXT, sha256: own.sha256 });
    const withoutReader = await settle(() => approvedCodingPlan(undefined, approved(foreign)));
    expect(withoutReader).toEqual({ error: "WORKSPACE_NOT_READY" });
    expect(await settle(() => approvedCodingPlan(reader, approved(foreign)))).toEqual(withoutReader);
    expect(await reviewPlanOf(reader, approved(foreign))).toBe(await reviewPlanOf(undefined, approved(foreign)));
    expect(await reviewPlanOf(reader, approved(foreign))).toBeUndefined();
  });

  it("planContextOf (a planning run is given the earlier document): own reads; another company's pointer leaves it out, as with no reader", async () => {
    const w = await world();
    const { own, foreign } = await documents(w, "markdown", "plan.md", PLAN_TEXT);
    const ask = (reader: ReturnType<World["hosted"]> | undefined, artifact: WorkflowArtifact) => planContextOf({ ...(reader === undefined ? {} : { artifacts: reader }) }, { path: "QUICK", artifacts: [artifact] } as never);
    const given = await ask(w.hosted(), own);
    expect(given.earlier).toEqual([]);
    expect(given.previous).toContain("The plan");
    expect(await ask(w.hosted(), foreign)).toEqual(await ask(undefined, foreign));
    expect(await ask(w.hosted(), foreign)).toEqual({ earlier: [] });
  });

  it("earlierPlans and breakdownForApproval (a structured plan: the plan critic, a revision, the approval's breakdown): own reads; another company's pointer is unreadable, as with no reader", async () => {
    const w = await world();
    const text = canonicalPlanJson(planDocument({ workBreakdown: TASK_GRAPH(w.task.taskId) }));
    const { own, foreign } = await documents(w, "structured", "plan.json", text);
    const reader = w.hosted();
    expect((await earlierPlans({ artifacts: reader }, { artifacts: [own] })).map((entry) => entry.sha256)).toEqual([own.sha256]);
    expect(await earlierPlans({ artifacts: reader }, { artifacts: [foreign] })).toEqual(await earlierPlans({}, { artifacts: [foreign] }));
    expect(await earlierPlans({ artifacts: reader }, { artifacts: [foreign] })).toEqual([]);
    const deps = (artifacts: typeof reader | undefined) => ({ ...(artifacts === undefined ? {} : { artifacts }), workflowDependenciesEnabled: false, projects: { latest: async () => undefined, revision: async () => undefined } }) as unknown as Parameters<typeof breakdownForApproval>[0];
    const task = { taskId: w.task.taskId, project: "payments", startingRevision: 1 };
    // With the reader the plan is readable, and its work breakdown is then refused only because the install's switch is off (never treated as "no breakdown")
    expect(await breakdownForApproval(deps(reader), task, { artifacts: [own], definitionVersion: "1.1.0" }, own.sha256)).not.toEqual({ refusal: PLAN_UNREADABLE });
    expect(await breakdownForApproval(deps(reader), task, { artifacts: [foreign], definitionVersion: "1.1.0" }, foreign.sha256)).toEqual({ refusal: PLAN_UNREADABLE });
    expect(await breakdownForApproval(deps(undefined), task, { artifacts: [foreign], definitionVersion: "1.1.0" }, foreign.sha256)).toEqual({ refusal: PLAN_UNREADABLE });
  });

  it("approvedGraphOf (ordered work): own reloads the graph; another company's pointer is today's WORKSPACE_NOT_READY", async () => {
    const w = await world();
    const graph = TASK_GRAPH(w.task.taskId);
    const { own, foreign } = await documents(w, "structured", "plan.json", canonicalPlanJson(planDocument({ workBreakdown: graph })));
    const { taskGraphDigest } = await import("@agentx/contracts");
    const approval = (artifact: WorkflowArtifact) => ({ artifacts: [artifact], workflowDependenciesApproval: { artifactDigest: artifact.sha256, graphDigest: taskGraphDigest(graph) } });
    const reader = w.hosted();
    expect(await approvedGraphOf({ artifacts: reader }, { taskId: w.task.taskId }, approval(own))).toEqual(graph);
    const none = await settle(() => approvedGraphOf({}, { taskId: w.task.taskId }, approval(foreign)));
    expect(none).toEqual({ error: "WORKSPACE_NOT_READY" });
    expect(await settle(() => approvedGraphOf({ artifacts: reader }, { taskId: w.task.taskId }, approval(foreign)))).toEqual(none);
  });

  it("reportedChangedFiles (the laptop page's 'reported by the worker' list; nothing on a hosted root calls it): own reads the saved diff; another company's key reads as nothing", async () => {
    const w = await world();
    const diff = "## demo\n### status\n### diff\ndiff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const key = artifactObjectKey(w.task.workspaceId, "op-impl-1", WORKSPACE_DIFF_ARTIFACT);
    w.stored.objects.set(key, bytesOf(diff));
    await w.h.store.put({ item: { ...operationKey(w.companyId, w.task.workspaceId, "op-impl-1"), entityType: "OPERATION", id: "op-impl-1", workspaceId: w.task.workspaceId, kind: "task", workflowMode: "IMPLEMENT", status: "SUCCEEDED", fence: 1, createdAt: "2026-11-14T00:00:00.000Z", companyId: w.companyId, dispatch: { kind: "task", payload: {} } } });
    await w.h.store.put({ item: { ...artifactRowKey(w.workspace, "op-impl-1", WORKSPACE_DIFF_ARTIFACT), entityType: "ARTIFACT", id: "art-1", workspaceId: w.task.workspaceId, operationId: "op-impl-1", name: WORKSPACE_DIFF_ARTIFACT, objectKey: key, sha256: sha(diff), bytes: diff.length, createdAt: "2026-11-14T00:00:01.000Z" } });
    expect((await reportedChangedFiles({ store: w.h.store, companyId: w.companyId, artifacts: w.hosted() }, w.task.workspaceId))?.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    // The row now points at another company's folder: the hosted reader refuses, the answer is the one with no reader
    await otherWorkspace(w, OTHER_COMPANY, "ws-foreign-diff", "owner-foreign");
    const foreignKey = artifactObjectKey("ws-foreign-diff", "op-impl-1", WORKSPACE_DIFF_ARTIFACT);
    w.stored.objects.set(foreignKey, bytesOf(diff));
    await w.h.store.update({ key: artifactRowKey(w.workspace, "op-impl-1", WORKSPACE_DIFF_ARTIFACT), ops: [{ op: "set", path: ["objectKey"], value: foreignKey }] });
    expect(await reportedChangedFiles({ store: w.h.store, companyId: w.companyId, artifacts: w.hosted() }, w.task.workspaceId)).toBeUndefined();
    expect(await reportedChangedFiles({ store: w.h.store, companyId: w.companyId }, w.task.workspaceId)).toBeUndefined();
  });
});

// ---- the set of readers is pinned ----

/** Every source file under core/ (and the proof reader's neighbours) that reads the flow's `artifacts`, and how it behaves on a hosted root. A new reader fails this test until it is classified here and in briefs/lead4/L4-ART-SCOPE.md. */
const READERS: Record<string, string> = {
  "core/build-step/autofix.ts": "ON: the plan's dry-run results refine an unclear check fault (autofix is on by default on hosted; counts bound it)",
  "core/build-step/changed-files.ts": "ON: the approved plan's mocks flag unplanned mock sources in the PR risk; reportedChangedFiles is the laptop page's (no hosted caller)",
  "core/build-step/plan-input.ts": "ON: the coding step's and reviewers' approved plan (today hosted refuses WORKSPACE_NOT_READY / shows no plan)",
  "core/build-step/publish.ts": "ON: the PR body's plan section and mock lines",
  "core/build-step/start.ts": "ON: general-fakes payload from the approved plan, the coding prompt, the review plan, and the eval request (first pass reads nothing)",
  "core/build-step/tier-checks.ts": "ON: the plan's named files scope the change tier (an outside-plan code file raises it)",
  "core/design-review/design-proof.ts": "DORMANT on hosted: no design review is wired (deps.designReview unset)",
  "core/design-review/outcome.ts": "DORMANT on hosted: no design review is wired",
  "core/design-review/resolve-run.ts": "DORMANT on hosted: no design review is wired",
  "core/design-review/round-start.ts": "DORMANT on hosted: no design review is wired",
  "core/design-review/steps.ts": "DORMANT on hosted: no design review is wired",
  "core/plan/check.ts": "DORMANT on hosted: the plan check runs only for a task with the Rovara Code program (understandFirst), which no hosted root sets",
  "core/plan/context.ts": "ON: a structured planning run's earlier documents (a revision, a Full task's design from its requirements)",
  "core/plan/document.ts": "ON: every approval surface reads the structured plan through it (hosted approvals of a structured plan were refused as unreadable)",
  "core/proof/eval-round-reader.ts": "ON: the eval request (first pass reads nothing; later passes read the saved rounds, bounded and operation-folder checked)",
  "core/setup-agent/plan-update.ts": "ON: at merge, the approved plan's setup changes become the setup-update offer (wrapper of approvedCodingPlan)",
  "core/sessions/ask-context-load.ts": "NOT the flow's reader: takes its own `artifacts` (not wired on a hosted root here; the hosted ask surface is separate)",
  "core/task-flow/stage-machine.ts": "ON: the earlier documents a planning run is given, and the plan text for the lighter flow's small-change route (lighter flow is not wired on hosted)",
  "core/task-log/plan-summary-source.ts": "NOT the flow's reader: the hosted plan summary is built over the registry's blobs directly (core-host/plan-summary.ts)",
  "core/work-breakdown/plan-graph.ts": "ON: the approval's work breakdown digest and ordered work's reload (ordered work stays off while workflowDependenciesEnabled is unset)",
};

function sourcesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path); else if (name.endsWith(".ts")) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe("the readers of the flow's artifacts are a known set", () => {
  it("lists exactly the files under core/ that read deps.artifacts or build a reader from it", () => {
    const root = join(process.cwd(), "packages/broker/src");
    // A read of the flow's reader (`deps.artifacts`, a text reader built from it, the approved plan), or a Pick of it. The type's own definition (task-flow/deps.ts) is not a reader.
    const reading = /\bdeps\.artifacts\b|\btextReaderOf\(|\bapprovedCodingPlan\(|\bArtifactReader\b|TaskFlowDeps, "[^>]*\bartifacts\b/u;
    const files = sourcesUnder(join(root, "core")).filter((path) => reading.test(readFileSync(path, "utf8"))).map((path) => relative(root, path)).filter((path) => path !== "core/task-flow/deps.ts").sort();
    expect(files).toEqual(Object.keys(READERS).sort());
  });

  it("no file outside core/ reads the flow's artifacts except the laptop page's (a hosted consumer would need classifying)", () => {
    const root = join(process.cwd(), "packages/broker/src");
    const outside = sourcesUnder(root).map((path) => relative(root, path)).filter((path) => !path.startsWith("core/"))
      .filter((path) => /\b(?:flow|deps\.flow|flow\.deps)\.artifacts\b|\bdeps\.artifacts\b/u.test(readFileSync(join(root, path), "utf8"))).sort();
    expect(outside).toEqual(["local/app/page-data.ts"]);
  });
});
