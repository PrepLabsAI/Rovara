import { describe, expect, it } from "vitest";
import { canonicalPlanJson, createWorkflowSnapshot, submitWorkflowArtifact, decideWorkflow, when, type JsonValue, type TransactItem } from "@agentx/contracts";
import { createApplicationApproval } from "../../packages/broker/src/core/e2e/application-approval.js";
import type { ApplicationE2ESeams, ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { planDocument } from "../support/plan-documents.js";
import { definition } from "../support/task-flow-harness.js";
import { NOW, binding, planFixture, sha, webApiRow } from "../support/e2e-application-plan-fixtures.js";

function approvalFixture() {
  const fx = planFixture({});
  const canonical = canonicalPlanJson(planDocument({ e2e: fx.intent }));
  const artifact = { id: "feature-plan", type: "plan" as const, version: 1, format: "structured" as const, sha256: sha(canonical), objectKey: "plan.json", producer: "agentx-planner" as const, createdAt: new Date(NOW).toISOString() };
  const initial = createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: artifact.createdAt });
  const before = submitWorkflowArtifact(initial, { expectedRevision: initial.revision, now: artifact.createdAt, artifact });
  const after = decideWorkflow(before, { requestId: "11111111-1111-4111-8111-111111111111", expectedRevision: before.revision, decision: "APPROVE", artifactDigest: artifact.sha256, reason: "Approved." },
    { actorId: before.ownerId, role: "TASK_OWNER" }, { now: artifact.createdAt, allowedSkipStages: [] });
  const task: ApplicationTask = { pk: `DEVTASK#${before.taskId}`, sk: "META", entityType: "DEVELOPER_TASK",
    taskId: before.taskId, companyId: "company-a", project: "payments", startingRevision: 1, workflow: before, developerId: "developer-a", provider: "local-owner", developerName: "Owner", client: "test", title: "Orders export", workspaceId: "22222222-2222-4222-8222-222222222222",
    ownerKey: "a".repeat(64), conversationId: "33333333-3333-4333-8333-333333333333", shared: false, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    charge: { member: { pk: "company-a#member", sk: "LIMIT" }, organization: { pk: "company-a", sk: "LIMIT" } } };
  const fences: TransactItem[] = [{ kind: "check", key: { pk: "company-a#runtime", sk: "web" }, condition: when.eq("generation", 4) }];
  const selection: ApplicationE2ESeams["rounds"]["selection"] = async (_task, intent, art, accounts) => {
    const evaluated = evaluateApplicationPlanApproval({ intent, taskId: task.taskId, artifact: art, snapshot: fx.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval,
      policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: NOW, accounts: { entries: fx.registry, ...accounts } });
    if (!evaluated.ok) throw new Error(evaluated.reason);
    return { selection: evaluated.selection, items: fences, baselineWanted: true };
  };
  const ports = { artifacts: { get: async () => Buffer.from(canonical) }, projects: { revision: async () => ({ definition: { ...definition, e2e: fx.policy } }) }, selection };
  return { fx, task, before, after, artifact, ports, fences, canonical, input: { task, before, after, artifact, at: artifact.createdAt } };
}

describe("core atomic required-E2E approval", () => {
  it("binds the approved canonical plan, policy and live selection with its transaction fences", async () => {
    const f = approvalFixture();
    const result = await createApplicationApproval(f.ports)(f.input);
    expect(result.workflow.e2e).toMatchObject({ required: true, contractDigest: f.artifact.sha256, currentGroupRunIds: [], resultRefs: [],
      applicationSelection: { semanticApproval: { artifactId: f.artifact.id, digest: f.artifact.sha256 }, accountRefs: [f.fx.accountRef] } });
    expect(result.workflow.e2e?.policyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.items).toEqual(f.fences);
    expect(f.before.e2e).toBeUndefined();
  });
  it("refuses a changed document, missing selection seam, or absent authority fences", async () => {
    const f = approvalFixture();
    await expect(createApplicationApproval({ ...f.ports, artifacts: { get: async () => Buffer.from("changed") } })(f.input)).rejects.toThrow();
    await expect(createApplicationApproval({ ...f.ports, selection: undefined })(f.input)).rejects.toThrow();
    await expect(createApplicationApproval({ ...f.ports, selection: async (...args) => ({ ...await f.ports.selection(...args), items: [] }) })(f.input)).rejects.toThrow();
  });
  it("refuses stale account/runtime selection before any approved workflow is returned", async () => {
    const f = approvalFixture();
    for (const reason of ["account definition changed", "runtime expired"]) {
      await expect(createApplicationApproval({ ...f.ports, selection: async () => { throw new Error(reason); } })(f.input)).rejects.toThrow(reason);
    }
    const selection = await f.ports.selection(f.task, f.fx.intent, f.artifact, { mode: "approve", pinned: [] });
    await expect(createApplicationApproval({ ...f.ports, selection: async () => ({ ...selection, selection: { ...selection.selection, semanticApproval: { ...selection.selection.semanticApproval, digest: "f".repeat(64) } } }) })(f.input)).rejects.toThrow();
    expect(f.task.workflow).toBe(f.before);
    expect(f.before.decisions).toHaveLength(0);
  });
});

// Regression: dropping selection fences, writing approval first, or applying a replay twice must never dispatch IMPLEMENT.
it("rolls back approval and IMPLEMENT together when a selected runtime moves; replays once", async () => {
  const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
  const { createDecisionGate, approvalRecordKey } = await import("../../packages/broker/src/core/decisions/approval-gate.js");
  const { createWorkflowDocumentSubject, workflowTaskKey } = await import("../../packages/broker/src/core/decisions/workflow-subject.js");
  const { createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal, LOCAL_SESSION_METHOD } = await import("../../packages/broker/src/ports/policy-defaults.js");
  const f = approvalFixture();
  const store = new MemoryDocumentStore();
  const key = workflowTaskKey(f.task.taskId);
  await store.put({ item: { ...key, companyId: f.task.companyId, project: f.task.project, startingRevision: 1, workflow: JSON.parse(JSON.stringify(f.before)) as JsonValue } });
  await store.put({ item: { pk: "company-a#runtime", sk: "web", generation: 4 } });
  const dispatchKey = { pk: `DEVTASK#${f.task.taskId}`, sk: "DISPATCH#implement" };
  let move = true;
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low", applicationPlanning: { context: async () => undefined, approve: createApplicationApproval(f.ports) },
    onDecided: async ({ after }) => {
      if (move) await store.put({ item: { pk: "company-a#runtime", sk: "web", generation: 5 } });
      return [{ kind: "put", item: { ...dispatchKey, required: after.e2e?.required ?? false }, condition: when.absent() }];
    } });
  const owner = localOwnerPrincipal({ companyId: f.task.companyId });
  const gate = createDecisionGate({ store, subjects: [subject], audit: createNoopAuditSink(),
    approvers: createLocalOwnerApprovers({ owner, verifySession: () => true }), now: () => new Date(NOW) });
  const request = { companyId: f.task.companyId, kind: subject.kind, subjectId: f.task.taskId, requestId: "11111111-1111-4111-8111-111111111111", outcome: "approve" as const,
    seen: { revision: f.before.revision, artifactDigest: f.artifact.sha256 }, credentials: [{ method: LOCAL_SESSION_METHOD, token: "fixture-session" }] };
  expect(await gate.decide(request)).toMatchObject({ status: "refused" });
  expect(await store.get(dispatchKey)).toBeUndefined();
  expect(await store.get(approvalRecordKey(request.companyId, request.requestId))).toBeUndefined();
  expect((await store.get(key))?.["workflow"]).toEqual(f.before);
  move = false;
  await store.put({ item: { pk: "company-a#runtime", sk: "web", generation: 4 } });
  const accepted = await gate.decide(request);
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ status: "decided" });
  expect(await store.get(dispatchKey)).toMatchObject({ required: true });
  const committed = await store.get(key);
  expect(await gate.decide(request)).toMatchObject({ status: "replayed" });
  expect(await store.get(key)).toEqual(committed);
});

describe("approval refusal boundaries", () => {
  for (const invalid of ["decision", "digest", "artifact"] as const) it(`refuses a mismatched approved ${invalid} with the configuration contract`, async () => {
    const f = approvalFixture();
    if (invalid === "decision") f.after.decisions = [];
    if (invalid === "digest") f.after.decisions[0]!.artifactDigest = "e".repeat(64);
    if (invalid === "artifact") f.before.artifacts = [];
    await expect(createApplicationApproval(f.ports)(f.input)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("returns unrelated approvals without loading application authority", async () => {
    const f = approvalFixture();
    const ports = { ...f.ports, artifacts: { get: async () => { throw new Error("unrelated approval must not read a plan"); } } };
    for (const input of [{ ...f.input, artifact: { ...f.artifact, type: "requirements" as const } }, { ...f.input, after: { ...f.after, stage: "VERIFY" as const } },
      { ...f.input, artifact: { ...f.artifact, format: "markdown" as const } }]) {
      expect(await createApplicationApproval(ports)(input)).toEqual({ workflow: input.after, items: [] });
    }
  });
  it("reports an unreadable document as runtime unavailable before selection", async () => {
    const f = approvalFixture();
    await expect(createApplicationApproval({ ...f.ports, artifacts: { get: async () => undefined } })(f.input)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(createApplicationApproval({ ...f.ports, selection: undefined })(f.input)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(createApplicationApproval({ ...f.ports, projects: { revision: async () => undefined } })(f.input)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("approves an ordinary structured plan without adding an E2E obligation", async () => {
    const f = approvalFixture();
    const canonical = canonicalPlanJson(planDocument());
    const artifact = { ...f.artifact, sha256: sha(canonical) };
    const before = { ...f.before, artifacts: [artifact] };
    const after = { ...f.after, decisions: [{ ...f.after.decisions[0]!, artifactDigest: artifact.sha256 }] };
    const ports = { ...f.ports, artifacts: { get: async () => Buffer.from(canonical) }, projects: { revision: async () => { throw new Error("ordinary plan must not load E2E policy"); } } };
    expect(await createApplicationApproval(ports)({ ...f.input, artifact, before, after })).toEqual({ workflow: after, items: [] });
  });
});

it("requires both the artifact id and digest in the pre-approval workflow", async () => {
  const f = approvalFixture();
  f.before.artifacts = [{ ...f.artifact, sha256: "e".repeat(64) }];
  await expect(createApplicationApproval(f.ports)(f.input)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

it("fences live approver authority together with the approved workflow", async () => {
  const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
  const { createDecisionGate } = await import("../../packages/broker/src/core/decisions/approval-gate.js");
  const { createWorkflowDocumentSubject, workflowTaskKey } = await import("../../packages/broker/src/core/decisions/workflow-subject.js");
  const { createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal, LOCAL_SESSION_METHOD } = await import("../../packages/broker/src/ports/policy-defaults.js");
  const f = approvalFixture(); const store = new MemoryDocumentStore(); const key = workflowTaskKey(f.task.taskId);
  await store.put({ item: { ...key, companyId: f.task.companyId, project: f.task.project, startingRevision: 1, workflow: JSON.parse(JSON.stringify(f.before)) as JsonValue } });
  const authority = { pk: "live-approver", sk: "META" };
  await store.put({ item: { ...authority, revision: 1 } });
  const marker = { pk: "dispatch-marker", sk: "implement" };
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low", ownerActing: async () => ({ actorId: f.before.ownerId,
    items: [{ kind: "check", key: authority, condition: when.eq("revision", 1) }] }),
    onDecided: async () => { await store.put({ item: { ...authority, revision: 2 } }); return [{ kind: "put", item: marker }]; } });
  const owner = localOwnerPrincipal({ companyId: f.task.companyId });
  const gate = createDecisionGate({ store, subjects: [subject], audit: createNoopAuditSink(), approvers: createLocalOwnerApprovers({ owner, verifySession: () => true }), now: () => new Date(NOW) });
  expect(await gate.decide({ companyId: f.task.companyId, kind: subject.kind, subjectId: f.task.taskId, requestId: "11111111-1111-4111-8111-111111111111", outcome: "approve",
    seen: { revision: f.before.revision, artifactDigest: f.artifact.sha256 }, credentials: [{ method: LOCAL_SESSION_METHOD, token: "fixture-session" }] })).toMatchObject({ status: "refused" });
  expect((await store.get(key))?.["workflow"]).toEqual(f.before);
  expect(await store.get(marker)).toBeUndefined();
});
