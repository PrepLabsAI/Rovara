import { hostedE2EStoreFixture } from "../support/core-e2e-hosted-store.js";
import { INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt } from "@agentx/contracts";
import { e2eAgentRoutePolicyLimits } from "../../packages/broker/src/e2e/model-route-registry.js";
import { requestWorkflowE2EBaselineRound, readWorkflowE2EBaselineRecord } from "../../packages/broker/src/core/e2e/baseline.js";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, canonicalJson, change, companyScoped, createWorkflowSnapshot, when, type WorkflowSnapshot, type TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createApplicationRounds, prepareApplicationAdmission, type ApplicationStepInput, type ApplicationRoundsDeps, readApplicationCandidateSource } from "../../packages/broker/src/core/e2e/application-rounds.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";
import { acceptStep } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { failClosedAuthority } from "../../packages/broker/src/core/e2e/authority.js";
import { candidateSourceObjectKey } from "../../packages/broker/src/core/e2e/uploads.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { planDocument } from "../support/plan-documents.js";
import { sha, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { startImplementation, uuidFrom } from "../../packages/broker/src/core/build-step/start.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { applicationApprovedPlanDigest } from "../../packages/broker/src/e2e/application-admission.js";
import { builtWebAndApiAdmission } from "../support/e2e-web-and-api-admission.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";

const COMPANY = "org_11111111111111111111";
const approval = { artifactId: "feature-plan", artifactDigest: "1".repeat(64), graphDigest: null, runId: null, workflowRevision: 2, actorId: "a".repeat(64) };
afterEach(disposeRealCandidates);

describe("managed core application admission", () => {
  it.each([false, true])("keeps creator checks in the real admission transaction (creator moved: %s)", async (moved) => {
    const fixture = await builtWebAndApiAdmission();
    const h = createHarness({ companyId: COMPANY }); h.clock.now = Date.now(); await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Check", workflow: true, workflowPath: "QUICK" });
    const task = (await readTask(h.deps, started.task.taskId))!;
    const objects = createDocumentObjectStorage(h.store, { companyId: COMPANY });
    const bytes = Buffer.from(canonicalJson(planDocument({ e2e: fixture.intent })));
    const artifact = { id: "feature-plan", type: "plan" as const, version: 1, format: "structured" as const, sha256: sha(bytes), producer: "planner", createdAt: new Date(h.clock.now).toISOString(), objectKey: "plans/approved.json" };
    await objects.put(artifact.objectKey, bytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
    const inputs = { ...fixture.input, registeredRuntimes: [...fixture.input.registeredRuntimes] };
    const evaluated = evaluateApplicationPlanApproval({ ...inputs, taskId: task.taskId, artifact, accounts: { entries: fixture.input.accountEntries, mode: "approve", pinned: [] } });
    if (!evaluated.ok) throw new Error(evaluated.reason);
    const workflow: WorkflowSnapshot = { ...task.workflow!, revision: 7, stage: "VERIFY", state: "WAITING", candidate: fixture.input.snapshot.candidate, artifacts: [artifact],
      decisions: [{ requestId: newRequestId(), workflowRevision: 2, decision: "APPROVE", actorId: task.ownerKey, actorRole: "TASK_OWNER", artifactDigest: artifact.sha256, reason: "Approved", at: artifact.createdAt }],
      e2e: { required: true, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [], applicationSelection: evaluated.selection } };
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
    const location = await workspaceKeys(h.deps, task.workspaceId);
    await h.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
    const sourceBytes = Buffer.from(canonicalJson(fixture.candidate.source));
    const sourceRef = { key: candidateSourceObjectKey(sha(sourceBytes)), sha256: sha(sourceBytes), byteLength: sourceBytes.byteLength, candidateDigest: workflow.candidate!.digest };
    await objects.put(sourceRef.key, sourceBytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
    const stored = fixture.candidate.stored;
    await objects.put(stored.manifestRef.key, fixture.candidate.manifestBytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
    const sourceId = newRequestId();
    await h.store.put({ item: toDocument({ ...location.operationKey(sourceId), id: sourceId, kind: "task", workflowMode: "IMPLEMENT", createdAt: artifact.createdAt, fence: 1, candidateSourceRef: sourceRef, candidateBuildSource: stored }) });
    await h.store.put({ item: toDocument({ pk: location.workspaceKey.pk, sk: `CANDIDATE_EXPORT#${sourceId}`, status: "COMPLETE", operationId: sourceId, fence: 1, buildSource: stored }) });
    const creatorKey = { pk: "creator-authority", sk: task.developerId };
    await h.store.put({ item: { ...creatorKey, generation: 1 } });
    const creatorCheck = { kind: "check" as const, key: creatorKey, condition: when.eq("generation", 1) };
    const current = { selection: evaluated.selection, items: [], baselineWanted: false, inputs };
    const before = await h.store.getMany([taskKey(task.taskId), location.workspaceKey]);
    let accepted: ApplicationStepInput | undefined;
    const rounds = createApplicationRounds({ flow: h.deps, objects, selection: { selection: async () => current, current: async () => current },
      creator: async () => ({ companyId: COMPANY, proof: { kind: "direct-membership", developerId: task.developerId, project: task.project, role: "developer", grantId: "grant-1" }, items: [creatorCheck] }),
      verification: { state: { store: h.store }, objects, authority: failClosedAuthority, readTask: (id) => readTask(h.deps, id) },
      checksRow: (id, revision, at) => dispatchRowItem(h.deps, id, revision, "CHECKS", at), cancelBaseline: async () => { throw new Error("no baseline requested"); },
      accept: async (input) => {
        accepted = input;
        // All authority reads succeeded; only the creator's transaction condition now fails.
        if (moved) await h.store.update({ key: creatorKey, ops: [change.set("generation", 2)] });
        return acceptStep(h.deps, input);
      } });
    expect(await rounds.runRow({ taskId: task.taskId, workflowRevision: workflow.revision })).toBe(moved ? "STALE" : "STARTED");
    expect(accepted?.extra).toContainEqual(creatorCheck);
    expect(accepted?.workflowE2EAdmission).toMatchObject({ kind: "application", taskId: task.taskId });
    const operations = await workspaceOperations(h.deps, task.workspaceId);
    const admitted = operations.filter((operation) => operation.workflowMode === "CHECKS");
    if (moved) {
      expect(admitted).toEqual([]);
      expect(await h.store.getMany([taskKey(task.taskId), location.workspaceKey])).toEqual(before);
      expect(await h.store.get({ pk: companyScoped(COMPANY, `OUTBOX#${accepted!.operationId!}`), sk: "OUTBOX" })).toBeUndefined();
    } else {
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.workflowE2EAdmission).toEqual(accepted?.workflowE2EAdmission);
    }
  });

  it("stores one v2 admission for web and API, bound to the canonical approval and exact operation fence", async () => {
    const fixture = await builtWebAndApiAdmission();
    const store = new MemoryDocumentStore(); const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
    const prepared = await prepareApplicationAdmission({ store, objects }, { ...fixture.input, approval });
    expect(prepared.reference.kind).toBe("application");
    expect(prepared.reference.groupRunIds).toHaveLength(2);
    expect(prepared.built.admission.runtimeBindings.map((row) => row.key).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/#api$/u), expect.stringMatching(/#web$/u)]));
    expect(prepared.built.admission.round.groupBindings.every((group) => group.operationFence === fixture.input.operationFence && group.planDigest === applicationApprovedPlanDigest(fixture.input.taskId, approval))).toBe(true);
    const bytes = await objects.get(prepared.reference.admissionRef.key, prepared.reference.admissionRef.byteLength);
    expect(Buffer.from(bytes!).equals(prepared.built.bytes)).toBe(true);
    expect(prepared.reference.purpose).toBeUndefined();
  });
  it("keeps a baseline signed as baseline and separate from candidate workflow state", async () => {
    const fixture = await builtWebAndApiAdmission({}, { web: true, api: true }, { baseline: true });
    const store = new MemoryDocumentStore(); const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
    const workflow = createWorkflowSnapshot({ taskId: fixture.input.taskId, ownerId: "a".repeat(64), now: new Date().toISOString() });
    const before = structuredClone(workflow);
    const prepared = await prepareApplicationAdmission({ store, objects }, { ...fixture.input, approval });
    expect(prepared.reference).toMatchObject({ purpose: "baseline", attempt: 1, baseCommitSha: fixture.input.snapshot.commitSha });
    expect(workflow).toEqual(before);
  });
  it("refuses stale approved runtime rows before storing or dispatching an admission", async () => {
    const fixture = await builtWebAndApiAdmission();
    const store = new MemoryDocumentStore(); const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
    const input = { ...fixture.input, approval, registeredRuntimes: fixture.input.registeredRuntimes.map((row) => ({ ...row, generation: row.generation + 1 })) };
    await expect(prepareApplicationAdmission({ store, objects }, input)).rejects.toThrow(/runtime|approved/iu);
    expect(store.size).toBe(0);
  });
});

it.each([true, false])("requests baseline export on the real IMPLEMENT operation only for a readable project (readable=%s)", async readable => {
  const fixture = await builtWebAndApiAdmission();
  const h = createHarness({ companyId: COMPANY }); await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Fix", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  const workflow: WorkflowSnapshot = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["a.txt"],
    checkPolicy: { required: [], optional: [], proposed: [], selectedOptionalIds: [], noneReason: "Application scenarios" },
    e2e: { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [], applicationSelection: fixture.approved.selection } };
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
  const location = await workspaceKeys(h.deps, task.workspaceId);
  await h.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  if (!readable) h.deps.projects.revision = async () => undefined;
  expect(await startImplementation(h.deps, { taskId: task.taskId, workflowRevision: workflow.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(h.deps, task.workspaceId)).find((operation) => operation.workflowMode === "IMPLEMENT")!;
  expect(operation.dispatch.payload["workflowE2EBaselineSource"]).toBe(readable ? true : undefined);
  expect(operation.dispatch.requires?.includes("task.workflowE2EBaselineSource")).toBe(readable);
});

async function admissionWorld(backend: "memory" | "dynamodb" | "hosted" = "memory") {
  const fixture = await builtWebAndApiAdmission();
  const hosted = backend === "hosted" ? await hostedE2EStoreFixture(TASK_FLOW_INDEXES) : undefined;
  const h = createHarness({ companyId: COMPANY, ...(backend === "memory" ? {} : { backend: (clock: { now: number }) => ({
    store: hosted?.store ?? dynamoWorld({ indexes: TASK_FLOW_INDEXES }).store, queues: new MemoryQueueService({ now: () => clock.now }),
  }) }) }); h.clock.now = Date.now(); await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Check", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  hosted?.seedIdentity({ developerId: task.developerId, project: task.project });
  const objects = createDocumentObjectStorage(h.store, { companyId: COMPANY });
  const bytes = Buffer.from(canonicalJson(planDocument({ e2e: fixture.intent })));
  const artifact = { id: "feature-plan", type: "plan" as const, version: 1, format: "structured" as const, sha256: sha(bytes), producer: "planner", createdAt: new Date(h.clock.now).toISOString(), objectKey: "plans/approved.json" };
  await objects.put(artifact.objectKey, bytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const inputs = { ...fixture.input, registeredRuntimes: [...fixture.input.registeredRuntimes] };
  const evaluated = evaluateApplicationPlanApproval({ ...inputs, taskId: task.taskId, artifact, accounts: { entries: fixture.input.accountEntries, mode: "approve", pinned: [] } });
  if (!evaluated.ok) throw new Error(evaluated.reason);
  const workflow: WorkflowSnapshot = { ...task.workflow!, revision: 7, stage: "VERIFY", state: "WAITING", candidate: fixture.input.snapshot.candidate, artifacts: [artifact],
    decisions: [{ requestId: newRequestId(), workflowRevision: 2, decision: "APPROVE", actorId: task.ownerKey, actorRole: "TASK_OWNER", artifactDigest: artifact.sha256, reason: "Approved", at: artifact.createdAt }],
    e2e: { required: true, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [], applicationSelection: evaluated.selection } };
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
  await h.store.transact([dispatchRowItem(h.deps, task.taskId, workflow.revision, "CHECKS", new Date(h.clock.now).toISOString())]);
  const location = await workspaceKeys(h.deps, task.workspaceId);
  await h.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  const sourceBytes = Buffer.from(canonicalJson(fixture.candidate.source));
  const sourceRef = { key: candidateSourceObjectKey(sha(sourceBytes)), sha256: sha(sourceBytes), byteLength: sourceBytes.byteLength, candidateDigest: workflow.candidate!.digest };
  await objects.put(sourceRef.key, sourceBytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const stored = fixture.candidate.stored;
  await objects.put(stored.manifestRef.key, fixture.candidate.manifestBytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const sourceId = newRequestId();
  await h.store.put({ item: toDocument({ ...location.operationKey(sourceId), id: sourceId, kind: "task", workflowMode: "IMPLEMENT", createdAt: artifact.createdAt, fence: 1, candidateSourceRef: sourceRef, candidateBuildSource: stored }) });
  await h.store.put({ item: toDocument({ pk: location.workspaceKey.pk, sk: `CANDIDATE_EXPORT#${sourceId}`, status: "COMPLETE", operationId: sourceId, fence: 1, buildSource: stored }) });
  const creatorKey = { pk: "creator-authority", sk: task.developerId };
  await h.store.put({ item: { ...creatorKey, generation: 1 } });
  const creatorCheck = { kind: "check" as const, key: creatorKey, condition: when.eq("generation", 1) };
  const current = { selection: evaluated.selection, items: [], baselineWanted: false, inputs };
  let accepted: ApplicationStepInput | undefined;
  const deps: ApplicationRoundsDeps = { flow: h.deps, objects,
    selection: { selection: async () => current, current: async () => current },
    creator: hosted?.creator ?? (async () => ({ companyId: COMPANY, proof: { kind: "direct-membership", developerId: task.developerId, project: task.project, role: "developer", grantId: "grant-1" }, items: [creatorCheck] })),
    verification: { state: { store: h.store }, objects, authority: failClosedAuthority, readTask: id => readTask(h.deps, id) },
    checksRow: (id, revision, at) => dispatchRowItem(h.deps, id, revision, "CHECKS", at), cancelBaseline: async () => {},
    accept: async input => { accepted = input; return acceptStep(h.deps, input); } };
  const rounds = createApplicationRounds(deps);
  const actual = { ...task, workflow };
  return { fixture, h, hosted, task: actual, workflow, objects, location, stored, sourceRef, sourceId, creatorKey, creatorCheck, current, deps, rounds,
    row: { taskId: task.taskId, workflowRevision: workflow.revision }, accepted: () => accepted };
}

for (const invalid of ["manifest", "manifest-digest", "build-record", "export-fence", "source", "build-tree"] as const) it(`refuses candidate ${invalid} before accepting compute`, async () => {
  const w = await admissionWorld();
  if (invalid === "manifest") await w.objects.delete(w.stored.manifestRef.key);
  if (invalid === "manifest-digest") {
    w.stored.manifestDigest = "e".repeat(64);
    await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("candidateBuildSource", toDocument(w.stored))] });
    await w.h.store.update({ key: { pk: w.location.workspaceKey.pk, sk: `CANDIDATE_EXPORT#${w.sourceId}` }, ops: [change.set("buildSource", toDocument(w.stored))] });
  }
  if (invalid === "build-record") await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("candidateBuildSource", { status: "REFUSED", reason: "missing export" })] });
  if (invalid === "export-fence") await w.h.store.update({ key: { pk: w.location.workspaceKey.pk, sk: `CANDIDATE_EXPORT#${w.sourceId}` }, ops: [change.set("fence", 2)] });
  if (invalid === "source") await w.objects.delete(w.sourceRef.key);
  if (invalid === "build-tree") {
    const changed = { ...w.stored, treeSha: "e".repeat(40) };
    await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("candidateBuildSource", toDocument(changed))] });
    await w.h.store.update({ key: { pk: w.location.workspaceKey.pk, sk: `CANDIDATE_EXPORT#${w.sourceId}` }, ops: [change.set("buildSource", toDocument(changed))] });
  }
  const message = invalid === "manifest" ? "The exported build source manifest is missing or changed." : invalid === "manifest-digest" ? "The build source manifest is not the one the record names."
    : invalid === "build-record" ? "No usable build source was exported for this candidate." : invalid === "export-fence" ? "The candidate export and its operation disagree about the build source."
    : invalid === "source" ? "The committed candidate export is unavailable or ambiguous." : "The build source names another commit or tree.";
  await expect(readApplicationCandidateSource(w.deps, w.task)).rejects.toThrow(message);
  expect(w.accepted()).toBeUndefined();
});

it("rejects an absent candidate or source operation with the round refusal contract", async () => {
  const w = await admissionWorld();
  const candidate = w.task.workflow.candidate; delete w.task.workflow.candidate;
  await expect(readApplicationCandidateSource(w.deps, w.task)).rejects.toThrow("The task has no committed candidate.");
  w.task.workflow.candidate = candidate;
  await w.h.store.delete({ key: w.location.operationKey(w.sourceId) });
  await expect(readApplicationCandidateSource(w.deps, w.task)).rejects.toThrow("The candidate has no committed source export.");
});

for (const field of ["operation", "export"] as const) it(`holds the candidate ${field} fence through the next write`, async () => {
  const w = await admissionWorld(); const source = await readApplicationCandidateSource(w.deps, w.task);
  const key = field === "operation" ? w.location.operationKey(w.sourceId) : { pk: w.location.workspaceKey.pk, sk: `CANDIDATE_EXPORT#${w.sourceId}` };
  await w.h.store.update({ key, ops: [change.set("fence", 2)] });
  const marker = { pk: "admission-marker", sk: field };
  expect(await w.h.store.transact([...source.items, { kind: "put", item: marker }])).toMatchObject({ applied: false });
  expect(await w.h.store.get(marker)).toBeUndefined();
});

for (const invalid of ["missing", "closed", "busy"] as const) it(`does not accept an application round on a ${invalid} workspace`, async () => {
  const w = await admissionWorld();
  if (invalid === "missing") await w.h.store.delete({ key: w.location.workspaceKey });
  else await w.h.store.update({ key: w.location.workspaceKey, ops: [change.set("status", invalid === "closed" ? "CLOSED" : "BUSY")] });
  expect(await w.rounds.runRow(w.row)).toBe(invalid === "busy" ? "WAITING" : "STALE");
  expect(w.accepted()).toBeUndefined();
});

for (const missing of ["artifact", "approval", "creator"] as const) it(`blocks missing ${missing} before application dispatch`, async () => {
  const w = await admissionWorld();
  if (missing === "artifact") w.workflow.artifacts = [];
  if (missing === "approval") w.workflow.decisions = [];
  if (missing === "creator") w.deps.creator = async () => undefined;
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  expect(await w.rounds.runRow(w.row)).toBe("STALE");
  const actual = (await readTask(w.h.deps, w.task.taskId))!.workflow!;
  expect(actual.blockReason).toContain(missing === "artifact" ? "current canonical plan" : missing === "approval" ? "current owner approval" : "original creator");
  expect(w.accepted()).toBeUndefined();
});

for (const authority of ["selection", "access", "source"] as const) it(`refuses admission when ${authority} changes after its read`, async () => {
  const w = await admissionWorld();
  const key = { pk: `round-authority-${authority}`, sk: "META" };
  await w.h.store.put({ item: { ...key, revision: 1 } });
  const check = { kind: "check" as const, key, condition: when.eq("revision", 1) };
  if (authority === "selection") (w.current.items as TransactItem[]).push(check);
  if (authority === "access") w.h.deps.access = { ...w.h.deps.access, checkStep: async () => ({ allowed: true, items: [check] }) };
  const accept = w.deps.accept.bind(w.deps);
  w.deps.accept = async input => {
    if (authority === "source") await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("fence", 2)] });
    else await w.h.store.update({ key, ops: [change.set("revision", 2)] });
    return accept(input);
  };
  expect(await w.rounds.runRow(w.row)).toBe("STALE");
  expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "CHECKS")).toEqual([]);
  const accepted = w.accepted();
  expect(accepted).toBeDefined();
  expect(await w.h.store.get({ pk: companyScoped(COMPANY, `OUTBOX#${accepted!.operationId!}`), sk: "OUTBOX" })).toBeUndefined();
});

it("propagates unexpected selection errors without committing a refused workflow", async () => {
  const w = await admissionWorld();
  const before = await w.h.store.get(taskKey(w.task.taskId));
  w.deps.selection.current = async () => { throw new Error("transient selection read failure"); };
  await expect(w.rounds.runRow(w.row)).rejects.toThrow("transient selection read failure");
  expect(await w.h.store.get(taskKey(w.task.taskId))).toEqual(before);
});

async function baselineWorld(backend: "memory" | "dynamodb" | "hosted" = "memory") {
  const w = await admissionWorld(backend);
  w.workflow.reviewBase = [{ repositoryId: w.stored.repositoryId, baseCommitSha: w.stored.commitSha }];
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  const baselineSource = { status: "READY" as const, sourceRef: w.sourceRef, buildSource: w.stored, repositoryId: w.stored.repositoryId, baseCommitSha: w.stored.commitSha, baseTreeSha: w.stored.treeSha };
  await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("baselineSource", toDocument(baselineSource))] });
  await requestWorkflowE2EBaselineRound({ store: w.h.store }, w.task, { enabled: true });
  return { ...w, baselineSource };
}

it.each(["memory", "dynamodb"] as const)("starts a real baseline before the candidate and holds the task's waiting revision (%s)", async backend => {
  const w = await baselineWorld(backend);
  expect(await w.rounds.runRow(w.row)).toBe("WAITING");
  expect(w.accepted()?.workflowE2EAdmission.purpose).toBe("baseline");
  const record = await readWorkflowE2EBaselineRecord({ store: w.h.store }, w.task);
  expect(record?.state).toBe("STARTED");
  const admitted = (await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "CHECKS");
  expect(admitted).toHaveLength(1);
  expect(admitted[0]?.workflowE2EAdmission?.purpose).toBe("baseline");
  expect(await w.h.store.get({ pk: companyScoped(COMPANY, `OUTBOX#${admitted[0]!.id}`), sk: "OUTBOX" })).toBeDefined();
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.revision).toBe(w.workflow.revision);
});

for (const changed of ["closedAt", "revision", "state"] as const) it(`refuses a baseline admission when task ${changed} moves`, async () => {
  const w = await baselineWorld(); const accept = w.deps.accept.bind(w.deps);
  w.deps.accept = async input => {
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set(changed === "closedAt" ? ["closedAt"] : ["workflow", changed], changed === "revision" ? w.workflow.revision + 1 : changed === "state" ? "BLOCKED" : new Date().toISOString())] });
    return accept(input);
  };
  expect(await w.rounds.runRow(w.row)).toBe(changed === "state" ? "STARTED" : "STALE");
  expect((await readWorkflowE2EBaselineRecord({ store: w.h.store }, w.task))?.state).toBe("REQUESTED");
  expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowE2EAdmission?.purpose === "baseline")).toEqual([]);
});

for (const invalid of ["record", "base", "host-tree", "export"] as const) it(`records baseline ${invalid} refusal without admitting that baseline`, async () => {
  const w = await baselineWorld();
  if (invalid === "record") await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.remove("baselineSource")] });
  if (invalid === "base") {
    w.baselineSource.baseCommitSha = "e".repeat(40);
    await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("baselineSource", toDocument(w.baselineSource))] });
  }
  if (invalid === "host-tree") w.deps.baseTree = async () => "e".repeat(40);
  if (invalid === "export") {
    const missing = { ...w.baselineSource, sourceRef: { ...w.sourceRef, key: "missing-baseline" } };
    await w.h.store.update({ key: w.location.operationKey(w.sourceId), ops: [change.set("baselineSource", toDocument(missing))] });
  }
  expect(await w.rounds.runRow(w.row)).toBe("STARTED");
  const record = await readWorkflowE2EBaselineRecord({ store: w.h.store }, w.task);
  expect(record).toMatchObject({ state: "UNAVAILABLE", reason: "refused" });
  expect(w.accepted()?.workflowE2EAdmission.purpose).toBeUndefined();
});

for (const terminal of ["CANCELLED", "INTERRUPTED"] as const) it(`blocks candidate dispatch after a ${terminal} baseline still holding the workspace`, async () => {
  const w = await baselineWorld(); expect(await w.rounds.runRow(w.row)).toBe("WAITING");
  const operation = w.accepted()!;
  await w.h.store.update({ key: w.location.operationKey(operation.operationId!), ops: [change.set("status", terminal)] });
  expect(await w.rounds.runRow(w.row)).toBe("STALE");
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.state).toBe("BLOCKED");
});

for (const race of ["selection", "creator"] as const) it(`refuses a retry when ${race} moves before the waiting revision commits`, async () => {
  const w = await admissionWorld(); w.workflow.state = "BLOCKED";
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  const key = race === "creator" ? w.creatorKey : { pk: "retry-selection", sk: "META" };
  await w.h.store.put({ item: { ...key, generation: 1 } });
  if (race === "selection") (w.current.items as TransactItem[]).push({ kind: "check", key, condition: when.eq("generation", 1) });
  let taskReads = 0;
  const get = w.h.store.get.bind(w.h.store);
  w.h.store.get = async key => { if (key.pk === w.task.pk && key.sk === w.task.sk) taskReads++; return get(key); };
  const transact = w.h.store.transact.bind(w.h.store);
  w.h.store.transact = async items => { await w.h.store.update({ key, ops: [change.set("generation", 2)] }); return transact(items); };
  expect(await w.rounds.retry(w.task, { requestId: "retry-once", actorId: w.task.ownerKey })).toBe("STALE");
  expect(taskReads).toBe(1);
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow).toEqual(w.workflow);
  expect(w.accepted()).toBeUndefined();
});

it("records an application retry once, then refuses a replay and a stale revision", async () => {
  const w = await admissionWorld(); w.workflow.state = "BLOCKED";
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  const retry = { requestId: "retry-once", actorId: w.task.ownerKey };
  expect(await w.rounds.retry(w.task, retry)).toBe("STARTED");
  expect(await w.rounds.retry(w.task, retry)).toBe("DUPLICATE");
  expect(await w.rounds.retry(w.task, { ...retry, requestId: "retry-twice" })).toBe("STALE");
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.verificationRetries).toHaveLength(1);
});

it("ignores a stale dispatch row before reading creator or plan authority", async () => {
  const w = await admissionWorld();
  w.deps.creator = async () => { throw new Error("stale row must not consult creator authority"); };
  expect(await w.rounds.runRow({ ...w.row, workflowRevision: w.row.workflowRevision + 1 })).toBe("STALE");
  expect(w.accepted()).toBeUndefined();
});

async function agentWorld() {
  const w = await admissionWorld(); const fx = w.fixture.fx;
  const intent = fx.build({ web: true, api: true }, [{ ...fx.webScenario, steps: [{ kind: "agent", goal: "Inspect the orders page", maxActions: 3 }] }, fx.apiScenario]);
  const policy = { ...fx.policy, modelRouteRevision: "route-v1", limits: e2eAgentRoutePolicyLimits(E2E_MODEL_ROUTE_DEFAULT_BUDGETS) };
  const rows = [webApiRow("web", {}, value => ({ ...value, supportedSteps: [...value.supportedSteps, "agent"] })), webApiRow("api")];
  const bytes = Buffer.from(canonicalJson(planDocument({ e2e: intent }))); const artifact = w.workflow.artifacts[0]!;
  artifact.sha256 = sha(bytes); w.workflow.decisions[0]!.artifactDigest = artifact.sha256; w.workflow.e2e!.contractDigest = artifact.sha256;
  await w.objects.delete(artifact.objectKey); await w.objects.put(artifact.objectKey, bytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const evaluated = evaluateApplicationPlanApproval({ ...w.current.inputs, intent, policy, artifact, taskId: w.task.taskId,
    snapshot: fx.snapshot, registeredRuntimes: rows, now: Date.now(), accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!evaluated.ok) throw new Error(evaluated.reason);
  w.workflow.e2e!.applicationSelection = evaluated.selection;
  w.current.selection = evaluated.selection; w.current.inputs.policy = policy; w.current.inputs.registeredRuntimes = rows;
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  return w;
}

it("refuses an AI navigation admission before compute when no model route can be authorized", async () => {
  const w = await agentWorld();
  expect(await w.rounds.runRow(w.row)).toBe("STALE");
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.blockReason).toContain("approved AI navigation route cannot be admitted");
  expect(w.accepted()).toBeUndefined();
});

for (const moved of [false, true]) it(`carries AI navigation route authority into admission (moved: ${moved})`, async () => {
  const w = await agentWorld(); const key = { pk: "navigation-route", sk: "META" };
  await w.h.store.put({ item: { ...key, revision: 1 } });
  const check = { kind: "check" as const, key, condition: when.eq("revision", 1) };
  w.deps.agentRoute = async () => [check];
  const accept = w.deps.accept.bind(w.deps);
  w.deps.accept = async input => {
    if (moved) await w.h.store.put({ item: { ...key, revision: 2 } });
    return accept(input);
  };
  expect(await w.rounds.runRow(w.row)).toBe(moved ? "STALE" : "STARTED");
  expect(w.accepted()?.extra).toContainEqual(check);
  if (moved) expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "CHECKS")).toEqual([]);
});

it("waits for baseline settlement even if its worker releases the workspace after the status read", async () => {
  const w = await baselineWorld(); expect(await w.rounds.runRow(w.row)).toBe("WAITING");
  const baseline = w.accepted()!;
  const key = w.location.operationKey(baseline.operationId!); const get = w.h.store.get.bind(w.h.store);
  let released = false;
  w.h.store.get = async request => {
    const result = await get(request);
    if (!released && request.pk === key.pk && request.sk === key.sk) {
      released = true;
      await w.h.store.update({ key, ops: [change.set("status", "CANCELLED")] });
      await w.h.store.update({ key: w.location.workspaceKey, ops: [change.set("activeOperationId", null), change.set("status", "READY")] });
    }
    return result;
  };
  expect(await w.rounds.runRow(w.row)).toBe("WAITING");
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.revision).toBe(w.workflow.revision);
  expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowE2EAdmission?.purpose !== "baseline" && op.workflowMode === "CHECKS")).toEqual([]);
});

// Both authority reads must hold on the same item at commit, independently.
for (const backend of ["memory", "dynamodb"] as const) {
  for (const moved of [undefined, "preflight", "commit"] as const) it(`admits with shared access conditions only while both hold (${backend}, ${moved ?? "valid"})`, async () => {
    const w = await admissionWorld(backend);
    const key = { pk: "round-authority-access", sk: "META" };
    await w.h.store.put({ item: { ...key, preflight: 1, commit: 1 } });
    let reads = 0;
    w.h.deps.access.checkStep = async () => ({ allowed: true, items: [
      { kind: "check", key, condition: when.eq(++reads <= 2 ? "preflight" : "commit", 1) },
    ] });
    const before = await w.h.store.getMany([taskKey(w.task.taskId), w.location.workspaceKey]);
    const transact = w.h.store.transact.bind(w.h.store);
    w.h.store.transact = async items => {
      if (moved !== undefined && items.some(item => item.kind === "update" && item.key.pk === w.task.pk)) {
        await w.h.store.update({ key, ops: [change.set(moved, 2)] });
      }
      return transact(items);
    };
    expect(await w.rounds.runRow(w.row)).toBe(moved === undefined ? "STARTED" : "STALE");
    const operations = (await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "CHECKS");
    const outboxKey = { pk: companyScoped(COMPANY, `OUTBOX#${w.accepted()!.operationId!}`), sk: "OUTBOX" };
    if (moved === undefined) {
      expect(operations).toHaveLength(1);
      expect(operations[0]?.workflowE2EAdmission).toEqual(w.accepted()?.workflowE2EAdmission);
      expect(await w.h.store.get(outboxKey)).toBeDefined();
    } else {
      expect(operations).toEqual([]);
      expect(await w.h.store.getMany([taskKey(w.task.taskId), w.location.workspaceKey])).toEqual(before);
      expect(await w.h.store.get(outboxKey)).toBeUndefined();
    }
  });
}

it("commits retry selection and creator conditions on a shared key before real admission", async () => {
  const w = await admissionWorld();
  w.workflow.state = "BLOCKED";
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  (w.current.items as TransactItem[]).push({ kind: "check", key: w.creatorKey, condition: when.eq("generation", 1) });
  expect(await w.rounds.retry(w.task, { requestId: "shared-retry", actorId: w.task.ownerKey })).toBe("STARTED");
  expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "CHECKS")).toHaveLength(1);
});

it.each([false, true])("admits a baseline through real hosted retention and creator authority (revoked: %s)", async revoked => {
  const w = await baselineWorld("hosted");
  const before = await w.h.store.getMany([taskKey(w.task.taskId), w.location.workspaceKey]);
  const accept = w.deps.accept.bind(w.deps);
  w.deps.accept = async input => {
    // Revoke after the real creator read; the joined transaction must still refuse every admission write.
    if (revoked) w.hosted!.revokeCreator();
    const result = await accept(input);
    if (revoked) expect(await w.h.store.getMany([taskKey(w.task.taskId), w.location.workspaceKey])).toEqual(before);
    return result;
  };
  expect(await w.rounds.runRow(w.row)).toBe(revoked ? "STALE" : "WAITING");
  const record = await readWorkflowE2EBaselineRecord({ store: w.h.store }, w.task);
  const admitted = (await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "CHECKS");
  expect(w.accepted()?.workflowE2EAdmission.purpose).toBe("baseline");
  if (revoked) {
    expect(record?.state).toBe("REQUESTED");
    expect(admitted).toEqual([]);
    expect(await w.h.store.get(w.location.workspaceKey)).toEqual(before[1]);
    expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.blockReason).toContain("original creator");
    expect(await w.h.store.get({ pk: companyScoped(COMPANY, `OUTBOX#${w.accepted()!.operationId!}`), sk: "OUTBOX" })).toBeUndefined();
  } else {
    expect(record).toMatchObject({ state: "STARTED", operationId: admitted[0]?.id });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.workflowE2EAdmission?.purpose).toBe("baseline");
    const raw = await w.h.store.get({ pk: `DEVTASK#${w.task.taskId}`, sk: `E2E_BASELINE#${record!.contractDigest}` });
    expect(raw).toMatchObject({ entityType: "WORKFLOW_E2E_BASELINE", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(record!.startedAt!) });
    expect(await w.h.store.get({ pk: companyScoped(COMPANY, `OUTBOX#${admitted[0]!.id}`), sk: "OUTBOX" })).toBeDefined();
    expect(await w.h.store.get(taskKey(w.task.taskId))).toEqual(before[0]);
    expect((await w.h.store.get(w.location.workspaceKey))?.activeOperationId).toBe(admitted[0]!.id);
  }
});

// Opus review 83c2611d6: the core parity route recognises a replay of a committed e2e checks retry by uuidFrom(requestId) in verificationRetries
// (parity-task-actions.ts replayedStep). Pin that the REAL application retry stores exactly that key; the parity test only uses a stub.
it("review: the application retry stores the owner's request id as uuidFrom(requestId), the key the parity replay check reads", async () => {
  const w = await admissionWorld(); w.workflow.state = "BLOCKED";
  await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("workflow", toDocument(w.workflow))] });
  const requestId = "0b6c5c1e-8a3f-4b52-9d7e-1f2a3b4c5d6e";
  expect(await w.rounds.retry(w.task, { requestId, actorId: w.task.ownerKey })).toBe("STARTED");
  expect((await readTask(w.h.deps, w.task.taskId))?.workflow?.verificationRetries?.map((retry) => retry.requestId)).toEqual([uuidFrom(requestId)]);
});
