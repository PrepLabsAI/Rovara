import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2ERegisteredRuntimeSchema, canonicalJson, change, createCandidateManifest, orgProjectCatalogKey, projectRevisionKey, when, type E2EApplicationExecutionAdmission, type TransactItem } from "@agentx/contracts";
import { createHostedE2EAuthority, type HostedAuthorityDeps } from "../../packages/broker/src/core/e2e/hosted-authority.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import type { E2EVerificationDiagnostic } from "../../packages/broker/src/core/e2e/authority.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { applicationApprovedPlanDigest, buildApplicationExecutionAdmission } from "../../packages/broker/src/e2e/application-admission.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { candidateSourceObjectKey } from "../../packages/broker/src/core/e2e/uploads.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/core/e2e/runtime-readiness.js";
import { accountDefinitionRow, accountLatestRow } from "../../packages/broker/src/e2e/application-account-registry.js";
import { builtWebAndApiAdmission } from "../support/e2e-web-and-api-admission.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { sha } from "../support/e2e-application-plan-fixtures.js";
import { planDocument } from "../support/plan-documents.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { definition } from "../support/task-flow-harness.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

const COMPANY = "org_11111111111111111111";
async function world() {
  const h = createHarness({ companyId: COMPANY }); await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Run checks", workflow: true, workflowPath: "QUICK" });
  const store = new MemoryDocumentStore();
  const task: TaskRecord = (await readTask(h.deps, started.task.taskId))!;
  const deps: HostedAuthorityDeps = { companyId: COMPANY, state: { store }, objects: createDocumentObjectStorage(store, { companyId: COMPANY }),
    projects: { latest: async () => undefined, revision: async () => undefined }, access: { checkStep: async () => ({ allowed: true }) }, operationsOf: async () => [],
    creator: async () => ({ companyId: COMPANY, proof: { kind: "direct-membership", developerId: task.developerId, project: "payments", role: "developer", grantId: "11111111-1111-4111-8111-111111111111" },
      items: [{ kind: "check", key: { pk: "company-member", sk: "maya" }, condition: when.eq("role", "member") } satisfies TransactItem] }) };
  const candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const admission = { taskId: task.taskId, candidateDigest: candidate.digest } as E2EApplicationExecutionAdmission;
  return { task, deps, candidate, admission };
}

describe("hosted application authority", () => {
  it("refuses another company's task before loading a project or creator", async () => {
    const w = await world();
    w.deps.creator = async () => { throw new Error("foreign creator must not be read"); };
    const diagnostic: E2EVerificationDiagnostic = {};
    expect(await createHostedE2EAuthority(w.deps).application({ ...w, task: { ...w.task, companyId: "org_22222222222222222222" } }, diagnostic)).toBe(false);
    expect(diagnostic.reason).toBe("current-company-or-candidate-mismatch");
    expect(diagnostic.authorityChecks).toBeUndefined();
  });
  it("does not let an earlier successful diagnostic lend authority to a later refusal", async () => {
    const w = await world();
    const diagnostic: E2EVerificationDiagnostic = { authorityChecks: [{ kind: "check", key: { pk: "stale", sk: "stale" }, condition: when.present() }] };
    expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
    expect(diagnostic.authorityEvaluated).toBe(true);
    expect(diagnostic.authorityChecks).toBeUndefined();
  });
  it("never grants a portable round using application authority", async () => {
    const w = await world(); const diagnostic: E2EVerificationDiagnostic = {};
    expect(await createHostedE2EAuthority(w.deps).portable({ task: w.task, candidate: w.candidate, admission: {}, snapshot: { candidate: w.candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: [], sources: [] } }, diagnostic)).toBe(false);
    expect(diagnostic.reason).toBe("no-current-authority-source");
  });
});

afterEach(disposeRealCandidates);
async function authoritativeRound() {
  const w = await world();
  const fixture = await builtWebAndApiAdmission();
  const { task, deps } = w;
  const bytes = Buffer.from(canonicalJson(planDocument({ e2e: fixture.intent })));
  const artifact = { id: "feature-plan", type: "plan" as const, version: 1, sha256: sha(bytes), producer: "planner", format: "structured" as const,
    createdAt: new Date().toISOString(), objectKey: "plans/approved.json" };
  await deps.objects.put(artifact.objectKey, bytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const evaluation = evaluateApplicationPlanApproval({ intent: fixture.intent, taskId: task.taskId, artifact, snapshot: fixture.fx.snapshot,
    setupProposal: fixture.fx.setup.proposal, setupApproval: fixture.fx.setup.setupApproval, policy: fixture.input.policy, registeredRuntimes: [...fixture.input.registeredRuntimes],
    runtimeCatalogId: fixture.input.runtimeCatalogId, runtimeBinding: fixture.input.runtimeBinding, now: Date.now(), accounts: { entries: fixture.input.accountEntries, mode: "approve", pinned: [] } });
  if (!evaluation.ok) throw new Error(evaluation.reason);
  const creator = (await deps.creator(task))!;
  const approval = { artifactId: artifact.id, artifactDigest: artifact.sha256, graphDigest: null, runId: null, workflowRevision: 2, actorId: task.developerId };
  const built = buildApplicationExecutionAdmission({ ...fixture.input, taskId: task.taskId, artifact, recordedSelection: evaluation.selection, creatorAuthority: creator.proof,
    planDigest: applicationApprovedPlanDigest(task.taskId, approval) });
  task.workflow = { ...task.workflow!, revision: fixture.input.workflowRevision, stage: "VERIFY", state: "RUNNING", candidate: fixture.input.snapshot.candidate, artifacts: [artifact],
    decisions: [{ requestId: randomUUID(), workflowRevision: 2, decision: "APPROVE", actorId: task.developerId, actorRole: "TASK_OWNER", artifactDigest: artifact.sha256, reason: "Approved", at: artifact.createdAt }],
    e2e: { required: true, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64),
      currentGroupRunIds: built.groupRunIds, currentRoundId: built.roundId, resultRefs: [], applicationSelection: evaluation.selection } };
  const store = deps.state.store;
  const projectKey = projectRevisionKey(COMPANY, task.project, 1);
  await store.put({ item: toDocument({ ...projectKey, entityType: "PROJECT", registeredBy: "registrar", runtimeBinding: fixture.input.runtimeBinding,
    setupApproval: fixture.fx.setup.setupApproval, definition: { ...definition, e2e: fixture.input.policy } }) });
  await store.put({ item: { ...orgProjectCatalogKey(COMPANY, task.project), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  deps.projects = createStoreProjectSource(store, COMPANY);
  for (const row of fixture.input.registeredRuntimes) await store.put({ item: toDocument({ ...e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, (row.capabilities.kind === "api" ? "api" : "web")), ...row }) });
  for (const entry of fixture.input.accountEntries) {
    await store.put({ item: toDocument(accountDefinitionRow(COMPANY, task.project, entry.definition)) });
    await store.put({ item: toDocument(accountLatestRow(COMPANY, task.project, entry.definition.applicationId, entry.definition.profileId, entry.latest)) });
  }
  await store.put({ item: { pk: "company-member", sk: "maya", role: "member" } });
  const sourceBytes = Buffer.from(canonicalJson({ schemaVersion: "workflow-candidate-source/v1", candidate: fixture.input.snapshot.candidate,
    repositories: [{ repositoryId: fixture.input.snapshot.candidate.repositories[0]!.repositoryId, commitSha: fixture.input.snapshot.commitSha, treeSha: fixture.input.snapshot.treeSha,
      treeComplete: true, treePaths: fixture.input.snapshot.treePaths, sources: fixture.input.snapshot.sources.map(({ bytes, ...source }) => ({ ...source, bytesBase64: Buffer.from(bytes).toString("base64") })) }] }));
  const sourceRef = { key: candidateSourceObjectKey(sha(sourceBytes)), sha256: sha(sourceBytes), byteLength: sourceBytes.byteLength, candidateDigest: fixture.input.snapshot.candidate.digest };
  await deps.objects.put(sourceRef.key, sourceBytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const location = await workspaceKeys({ store, companyId: COMPANY }, task.workspaceId);
  const operation: OperationRecord & { candidateSourceRef: typeof sourceRef } = { ...location.operationKey(fixture.input.operationId), entityType: "OPERATION", companyId: COMPANY,
    id: fixture.input.operationId, workspaceId: task.workspaceId, kind: "task", requestId: randomUUID(), payloadHash: "a".repeat(64), status: "SUCCEEDED", fence: 1, eventSequence: 0,
    createdAt: artifact.createdAt, updatedAt: artifact.createdAt, workflowMode: "IMPLEMENT", candidateSourceRef: sourceRef, dispatch: { kind: "task", projectRevision: 1, payload: {} } };
  await store.put({ item: toDocument(operation) });
  deps.operationsOf = async () => [operation];
  deps.currentSelection = async () => ({ ok: true, selection: evaluation.selection, accountEntries: fixture.input.accountEntries,
    rows: await Promise.all(fixture.input.registeredRuntimes.map(async (row) => {
      const stored = (await store.get(e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, row.capabilities.kind === "api" ? "api" : "web")))!;
      const { pk: _pk, sk: _sk, ...runtime } = stored; void _pk; void _sk;
      return E2ERegisteredRuntimeSchema.parse(runtime);
    })) });
  return { ...w, candidate: fixture.input.snapshot.candidate, admission: built.admission, store, fixture };
}

it("returns live project, runtime, account, creator and source fences for a genuine canonical round", async () => {
  const w = await authoritativeRound(); const diagnostic: E2EVerificationDiagnostic = {};
  const valid = await createHostedE2EAuthority(w.deps).application(w, diagnostic);
  expect(diagnostic.reason).toBeUndefined();
  expect(valid).toBe(true);
  expect(diagnostic.authorityChecks!.length).toBeGreaterThanOrEqual(7);
  expect(await w.store.transact(diagnostic.authorityChecks!)).toEqual({ applied: true });
  await w.store.update({ key: { pk: "company-member", sk: "maya" }, ops: [change.set("role", "revoked")] });
  expect(await w.store.transact(diagnostic.authorityChecks!)).toMatchObject({ applied: false });
});

it("refuses requalified runtime rows and revoked creator proofs at verdict time", async () => {
  const w = await authoritativeRound(); const row = w.fixture.input.registeredRuntimes[0]!;
  await w.store.update({ key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, (row.capabilities.kind === "api" ? "api" : "web")), ops: [change.set("generation", row.generation + 1)] });
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.reason).toMatch(/requalified/u);
  expect(diagnostic.runtimeChange).toBe("requalified");
  w.deps.creator = async () => undefined;
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.reason).toBe("creator-membership-proof-changed-or-unavailable");
  expect(diagnostic.authorityChecks).toBeUndefined();
});

for (const latestRevision of [1, 2]) it(`refuses recording when any live authority row moves after verification (latest revision ${latestRevision})`, async () => {
  const w = await authoritativeRound();
  const pinnedKey = projectRevisionKey(COMPANY, w.task.project, w.task.startingRevision);
  const latestKey = projectRevisionKey(COMPANY, w.task.project, latestRevision);
  const catalogKey = orgProjectCatalogKey(COMPANY, w.task.project);
  if (latestRevision === 2) {
    const pinned = (await w.store.get(pinnedKey))!;
    await w.store.put({ item: toDocument({ ...pinned, ...latestKey, definition: { ...(pinned["definition"] as Record<string, unknown>), revision: 2 } }) });
    await w.store.update({ key: catalogKey, ops: [change.set("latestRevision", 2)] });
  }
  const accessKey = { pk: "authority-access", sk: "META" };
  await w.store.put({ item: { ...accessKey, revision: 1 } });
  w.deps.access = { checkStep: async () => ({ allowed: true, items: [{ kind: "check", key: accessKey, condition: when.eq("revision", 1) }] }) };
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(true);
  const checks = diagnostic.authorityChecks!;
  expect(await w.store.transact(checks)).toEqual({ applied: true });
  const operations = await w.deps.operationsOf(w.task);
  const operation = operations[0]!;
  const targets = [
    { key: catalogKey, field: "latestRevision", value: 3 },
    { key: latestKey, field: "setupApproval", value: { changed: true } },
    ...(latestRevision === 2 ? [{ key: pinnedKey, field: "definition", value: { changed: true } }] : []),
    ...w.admission.runtimeBindings.map(({ value: row }) => ({ key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, row.capabilities.kind === "api" ? "api" : "web"), field: "generation", value: row.generation + 1 })),
    ...w.task.workflow!.e2e!.applicationSelection!.accountRefs.map((ref) => {
      const entry = w.fixture.input.accountEntries.find((item) => item.definition.applicationId === ref.applicationId && item.definition.profileId === ref.profileId)!;
      const row = accountLatestRow(COMPANY, w.task.project, ref.applicationId, ref.profileId, entry.latest);
      return { key: { pk: String(row.pk), sk: String(row.sk) }, field: "revision", value: entry.latest.revision + 1 };
    }),
    { key: { pk: "company-member", sk: "maya" }, field: "role", value: "revoked" },
    { key: accessKey, field: "revision", value: 2 },
    { key: { pk: operation.pk, sk: operation.sk }, field: "fence", value: operation.fence + 1 },
  ];
  for (const [index, target] of targets.entries()) {
    const before = (await w.store.get(target.key))!;
    const marker = { pk: "AUTHORITY_RECORDING", sk: String(index) };
    try {
      await w.store.update({ key: target.key, ops: [change.set(target.field, toDocument({ value: target.value })["value"]!)] });
      expect(await w.store.transact([...checks, { kind: "put", item: { ...marker, recorded: true } }]), `${target.key.pk}/${target.key.sk}:${target.field}`).toMatchObject({ applied: false });
      expect(await w.store.get(marker)).toBeUndefined();
    } finally { await w.store.put({ item: before }); }
  }
});

type AuthorityWorld = Awaited<ReturnType<typeof authoritativeRound>>;
const authorityRefusals: Array<{ name: string; reason: string | RegExp; change(w: AuthorityWorld): void | Promise<void> }> = [
  { name: "closed task", reason: "current-task-or-approval-missing", change: w => { w.task.closedAt = new Date().toISOString(); } },
  { name: "missing canonical artifact", reason: "current-canonical-plan-missing-or-stale", change: w => { w.task.workflow!.artifacts = []; } },
  { name: "unreadable canonical artifact", reason: "canonical-artifact-or-owner-decision-mismatch", change: async w => { await w.deps.objects.delete(w.task.workflow!.artifacts[0]!.objectKey); } },
  { name: "missing owner approval", reason: "canonical-artifact-or-owner-decision-mismatch", change: w => { w.task.workflow!.decisions = []; } },
  { name: "another canonical approval", reason: "canonical-approval-binding-mismatch", change: w => { w.admission.round.groupBindings[0]!.planDigest = "e".repeat(64); } },
  { name: "missing recorded selection", reason: "no-recorded-application-selection", change: w => { delete w.task.workflow!.e2e!.applicationSelection; } },
  { name: "another admitted intent", reason: "approved-plan-is-not-the-admitted-intent", change: w => { w.admission.intent.scenarios[0]!.requirementId += "-changed"; } },
  { name: "missing latest project", reason: "current-project-latest-revision-unavailable", change: w => { w.deps.projects = { ...w.deps.projects, latest: async () => undefined }; } },
  { name: "changed catalog", reason: "current-project-latest-revision-unavailable", change: async w => { await w.store.update({ key: orgProjectCatalogKey(COMPANY, w.task.project), ops: [change.set("latestRevision", 99)] }); } },
  { name: "missing setup approval", reason: "current-project-setup-approval-unavailable", change: async w => { const key = projectRevisionKey(COMPANY, w.task.project, 1); const row = (await w.store.get(key))!; delete row["setupApproval"]; await w.store.put({ item: row }); } },
  { name: "changed admitted policy", reason: "current-project-policy-or-runtime-changed", change: w => { w.admission.policy.capture.screenshots = !w.admission.policy.capture.screenshots; } },
  { name: "creator can only view", reason: "current-creator-can-only-view-project", change: w => { w.deps.access = { checkStep: async () => ({ allowed: false, message: "view-only" }) }; } },
  { name: "missing source operation", reason: "candidate-source-operation-missing", change: w => { w.deps.operationsOf = async () => []; } },
  { name: "missing source export", reason: "candidate-source-export-missing-or-ambiguous", change: async w => { const op = (await w.deps.operationsOf(w.task))[0]! as OperationRecord & { candidateSourceRef: { key: string } }; await w.deps.objects.delete(op.candidateSourceRef.key); } },
  { name: "different source tree", reason: "current-admission-runtime-plan-or-source-mismatch", change: w => { w.admission.sourceSnapshot.treeSha = "e".repeat(40); } },
  { name: "missing selection reader", reason: "no-current-authority-source", change: w => { delete w.deps.currentSelection; } },
  { name: "selection unavailable", reason: "application-selection-unavailable: unavailable", change: w => { w.deps.currentSelection = async () => ({ ok: false, kind: "unevaluable", reason: "unavailable" }); } },
  { name: "changed semantic selection", reason: /application-selection-changed/u, change: w => { const read = w.deps.currentSelection!; w.deps.currentSelection = async input => { const result = await read(input); if (result.ok) result.selection = { ...result.selection, semanticApproval: { ...result.selection.semanticApproval, digest: "e".repeat(64) } }; return result; }; } },
  { name: "changed admission selection binding", reason: "canonical-approval-binding-mismatch", change: w => { w.admission.selectionInput.approvedSemanticApproval!.digest = "e".repeat(64); } },
  { name: "missing runtime", reason: /is not ready now/u, change: w => { const read = w.deps.currentSelection!; w.deps.currentSelection = async input => { const result = await read(input); return result.ok ? { ...result, rows: [] } : result; }; } },
];
for (const scenario of authorityRefusals) it(`refuses ${scenario.name} at the owning authority boundary`, async () => {
  const w = await authoritativeRound(); await scenario.change(w);
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  if (typeof scenario.reason === "string") expect(diagnostic.reason).toBe(scenario.reason);
  else expect(diagnostic.reason).toMatch(scenario.reason);
  expect(diagnostic.authorityChecks).toBeUndefined();
});

for (const field of ["qualifiedAt", "generation", "capabilities"] as const) it(`explains runtime ${field} changes without losing the refusal`, async () => {
  const w = await authoritativeRound();
  const read = w.deps.currentSelection!;
  w.deps.currentSelection = async input => {
    const current = await read(input);
    if (!current.ok) return current;
    return { ...current, rows: current.rows.map((row, index) => index !== 0 ? row : field === "generation" ? { ...row, generation: row.generation + 1 }
      : field === "qualifiedAt" ? { ...row, qualifiedAt: new Date(Date.parse(row.qualifiedAt) - 1000).toISOString() }
      : { ...row, capabilities: { ...row.capabilities, supportedSteps: [] } }) };
  };
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.runtimeChange).toBe("requalified");
  expect(diagnostic.reason).toContain(field === "capabilities" ? "another field of its record changed" : field);
});

for (const latestRevision of [1, 2]) it(`requires raw project rows even with a cached definition (latest: ${latestRevision})`, async () => {
  const w = await authoritativeRound();
  if (latestRevision === 2) {
    const row = (await w.store.get(projectRevisionKey(COMPANY, w.task.project, 1)))!;
    await w.store.put({ item: toDocument({ ...row, ...projectRevisionKey(COMPANY, w.task.project, 2), definition: { ...(row["definition"] as object), revision: 2 } }) });
    await w.store.update({ key: orgProjectCatalogKey(COMPANY, w.task.project), ops: [change.set("latestRevision", 2)] });
  }
  const pinned = await w.deps.projects.revision(w.task.project, w.task.startingRevision);
  const latest = await w.deps.projects.latest(w.task.project);
  w.deps.projects = { revision: async () => pinned, latest: async () => latest };
  await w.store.delete({ key: projectRevisionKey(COMPANY, w.task.project, w.task.startingRevision) });
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.reason).toBe("current-project-latest-revision-unavailable");
});

it("refuses a latest runtime binding that differs from the pinned project", async () => {
  const w = await authoritativeRound();
  const key = projectRevisionKey(COMPANY, w.task.project, 1); const row = (await w.store.get(key))!;
  await w.store.put({ item: toDocument({ ...row, ...projectRevisionKey(COMPANY, w.task.project, 2), runtimeBinding: { changed: true }, definition: { ...(row["definition"] as object), revision: 2 } }) });
  await w.store.update({ key: orgProjectCatalogKey(COMPANY, w.task.project), ops: [change.set("latestRevision", 2)] });
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.reason).toBe("current-project-policy-or-runtime-changed");
});

it("refuses a portable canonical plan as authority for an application admission", async () => {
  const w = await authoritativeRound(); const artifact = w.task.workflow!.artifacts[0]!;
  const { applicationRuntimeRefs: _apps, runtimeAccountRefs: _accounts, unavailableTargetRefs: _unavailable, ...portable } = w.fixture.intent;
  void _apps; void _accounts; void _unavailable;
  const bytes = Buffer.from(canonicalJson(planDocument({ e2e: { ...portable, schemaVersion: 1 } })));
  artifact.sha256 = sha(bytes); w.task.workflow!.decisions[0]!.artifactDigest = artifact.sha256;
  w.task.workflow!.e2e!.contractDigest = artifact.sha256;
  await w.deps.objects.delete(artifact.objectKey);
  await w.deps.objects.put(artifact.objectKey, bytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const digest = applicationApprovedPlanDigest(w.task.taskId, { artifactId: artifact.id, artifactDigest: artifact.sha256, graphDigest: null, runId: null, workflowRevision: 2, actorId: w.task.developerId });
  for (const group of w.admission.round.groupBindings) group.planDigest = digest;
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.reason).toBe("application-admission-needs-application-plan");
});

it("refuses unsupported admitted runtime kinds rather than returning unusable authority fences", async () => {
  const w = await authoritativeRound();
  (w.admission.runtimeBindings[0]!.value.capabilities as { kind: string }).kind = "android";
  const current = w.deps.currentSelection!;
  w.deps.currentSelection = async input => {
    const selected = await current(input);
    return selected.ok ? { ...selected, rows: w.admission.runtimeBindings.map(binding => binding.value) } : selected;
  };
  const diagnostic: E2EVerificationDiagnostic = {};
  expect(await createHostedE2EAuthority(w.deps).application(w, diagnostic)).toBe(false);
  expect(diagnostic.reason).toBe("the runtime rows this round was admitted on are not among the rows read now");
  expect(diagnostic.authorityChecks).toBeUndefined();
});
