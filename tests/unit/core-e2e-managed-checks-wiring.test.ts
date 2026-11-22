import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, canonicalJson, change, createCandidateManifest } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createBuildSteps } from "../../packages/broker/src/core/build-step/index.js";
import { autofixRowFor, recordBuilt } from "../../packages/broker/src/core/build-step/results.js";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { taskKey, dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { failClosedAuthority } from "../../packages/broker/src/core/e2e/authority.js";
import { candidateSourceObjectKey } from "../../packages/broker/src/core/e2e/uploads.js";
import type { ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";

async function fixture() {
  const h = createHarness(); await h.registerProject();
  const start = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Check the app", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, start.task.taskId))!;
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) }]);
  task.workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "IMPLEMENT", state: "RUNNING", reviewBase: [{ repositoryId: "demo", baseCommitSha: "c".repeat(40) }],
    checkPolicy: { required: [], optional: [], proposed: [], selectedOptionalIds: [], noneReason: "Application scenarios only" },
    e2e: { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [] } };
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(task.workflow))] });
  const objects = createDocumentObjectStorage(h.store, { companyId: h.deps.companyId });
  h.deps.e2e = { state: { store: h.store }, objects, authority: failClosedAuthority, readTask: (id) => readTask(h.deps, id) };
  h.deps.applicationE2E = { rounds: { runRow: async () => "WAITING" } } as unknown as ApplicationE2ESeams;
  const bytes = Buffer.from(canonicalJson({ schemaVersion: "workflow-candidate-source/v1", candidate, repositories: candidate.repositories.map((repository) => ({ ...repository, treeComplete: true, treePaths: [], sources: [] })) }));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = { key: candidateSourceObjectKey(sha256), sha256, byteLength: bytes.byteLength, candidateDigest: candidate.digest };
  await objects.put(ref.key, bytes, { contentType: "application/json", metadata: {}, retention: "e2e" });
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const operation = { ...workspace, sk: `OPERATION#${randomUUID()}`, id: randomUUID(), entityType: "OPERATION", kind: "task", workflowMode: "IMPLEMENT", workflowRevision: task.workflow.revision,
    companyId: h.deps.companyId, workspaceId: task.workspaceId, candidateSourceRef: ref } as unknown as OperationRecord;
  const ended = { status: "SUCCEEDED" as const, outcome: { kind: "built" as const, result: { checks: { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "v1", preambleSha256: "a".repeat(64), extraTry: "not_needed", agentClaim: "none", checks: [] }, workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories } } };
  return { ...h, task, candidate, operation, ended, workspace };
}

describe("managed CHECKS wiring", () => {
  it("persists the exported IMPLEMENT candidate and a due CHECKS row without claiming a coding round", async () => {
    const h = await fixture();
    await recordBuilt(h.deps, h.task, h.operation, h.ended);
    const workflow = (await readTask(h.deps, h.task.taskId))!.workflow!;
    expect(workflow, workflow.blockReason).toMatchObject({ stage: "VERIFY", state: "WAITING", candidate: h.candidate });
    expect(workflow.e2e?.qualifiedRound).toBeUndefined();
    expect(await h.store.get(dispatchRowKey(h.deps.companyId, h.task.taskId, workflow.revision))).toMatchObject({ kind: "CHECKS" });
  });

  it("keeps a missing required verifier blocked, never falling through to ordinary review", async () => {
    const h = await fixture(); delete h.deps.e2e;
    await recordBuilt(h.deps, h.task, h.operation, h.ended);
    expect((await readTask(h.deps, h.task.taskId))!.workflow!).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
  });

  it("stores the admission on the operation atomically with its worker payload", async () => {
    const h = await fixture();
    await h.store.update({ key: { pk: h.workspace.pk, sk: "META" }, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
    const workspace = (await readWorkspace(h.deps, h.task.workspaceId))!;
    const admission = { schemaVersion: 1 as const, kind: "application" as const, taskId: h.task.taskId, workflowRevision: h.task.workflow!.revision, candidateDigest: h.candidate.digest,
      roundId: randomUUID(), groupRunIds: [randomUUID()], admissionRef: { key: "admission.json", sha256: "a".repeat(64), byteLength: 100 } };
    const accepted = await acceptStep(h.deps, { task: h.task, workspace, requestId: randomUUID(), prompt: "Run checks", workflowMode: "CHECKS", workflowE2EAdmission: admission, payload: { workflowE2EAdmission: toDocument(admission) } });
    expect(accepted.result).toBe("STARTED");
    expect(accepted.operation?.workflowE2EAdmission).toEqual(admission);
    expect(accepted.operation?.dispatch.payload["workflowE2EAdmission"]).toEqual(admission);
  });
});

it("CHECKS dispatch refuses a missing application seam and forwards a valid row once", async () => {
  const h = createHarness();
  const row = { kind: "CHECKS" as const, taskId: "11111111-1111-4111-8111-111111111111", workflowRevision: 1 };
  const steps = createBuildSteps();
  delete h.deps.applicationE2E;
  await expect(steps.runRow(h.deps, row)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  const seen: unknown[] = [];
  h.deps.applicationE2E = { rounds: { runRow: async (actual: typeof row) => { seen.push(actual); return "WAITING"; } } } as never;
  await expect(steps.runRow(h.deps, row)).resolves.toBe("WAITING");
  expect(seen).toEqual([row]);
});

for (const invalid of ["candidate-base", "task-base", "different-base"] as const) it(`blocks ${invalid} before queueing application checks`, async () => {
  const h = await fixture();
  if (invalid === "candidate-base") {
    delete h.task.workflow!.e2e;
    const repositories = h.candidate.repositories.map(({ baseCommitSha: _base, ...repo }) => { void _base; return repo; });
    h.ended.outcome.result.workflowCandidateRepositories = repositories;
    h.ended.outcome.result.workflowCheckCandidateRepositories = repositories;
  }
  if (invalid === "task-base") { delete h.task.workflow!.reviewBase; delete h.task.preparedBase; }
  if (invalid === "different-base") h.task.workflow!.reviewBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
  await recordBuilt(h.deps, h.task, h.operation, h.ended);
  const workflow = (await readTask(h.deps, h.task.taskId))!.workflow!;
  expect(workflow.state).toBe("BLOCKED");
  expect(workflow.blockReason).toBe(invalid === "different-base" ? WORKFLOW_BLOCK_REASONS.startChanged : WORKFLOW_BLOCK_REASONS.startUnrecorded);
  expect(await h.store.get(dispatchRowKey(h.deps.companyId, h.task.taskId, workflow.revision))).toBeUndefined();
});

it("queues autofix only for an actual failed application round", async () => {
  const h = await fixture();
  const blocked = { ...h.task.workflow!, stage: "VERIFY" as const, state: "BLOCKED" as const };
  expect(autofixRowFor(h.deps, h.task.taskId, blocked, new Date().toISOString())).toEqual([]);
  const ordinary = { ...blocked }; delete ordinary.e2e;
  expect(autofixRowFor(h.deps, h.task.taskId, ordinary, new Date().toISOString())).toHaveLength(1);
});

it("lets an ordinary implementation proceed to review without application checks", async () => {
  const h = await fixture(); delete h.task.workflow!.e2e;
  await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set("workflow", toDocument(h.task.workflow!))] });
  await recordBuilt(h.deps, h.task, h.operation, h.ended);
  const workflow = (await readTask(h.deps, h.task.taskId))!.workflow!;
  expect(workflow.state).not.toBe("BLOCKED");
  expect(workflow.e2e).toBeUndefined();
});

it("clears prior application rounds before queueing the changed candidate's checks", async () => {
  const h = await fixture();
  let commits = 0;
  const transact = h.store.transact.bind(h.store);
  h.store.transact = async items => {
    if (items.some(item => item.kind === "update" && item.key.pk === h.task.pk && item.key.sk === h.task.sk)) commits++;
    return transact(items);
  };
  h.task.workflow!.e2e!.currentRoundId = "11111111-1111-4111-8111-111111111111";
  h.task.workflow!.e2e!.currentGroupRunIds = ["22222222-2222-4222-8222-222222222222"];
  h.task.workflow!.e2e!.failedRound = { status: "FAILED", candidateDigest: "e".repeat(64), roundId: h.task.workflow!.e2e!.currentRoundId,
    groupRunIds: h.task.workflow!.e2e!.currentGroupRunIds, admissionSha256: "e".repeat(64), evidenceSha256: "f".repeat(64) };
  await recordBuilt(h.deps, h.task, h.operation, h.ended);
  const workflow = (await readTask(h.deps, h.task.taskId))!.workflow!;
  expect(workflow.state).toBe("WAITING");
  expect(workflow.e2e?.currentRoundId).toBeUndefined();
  expect(workflow.e2e?.currentGroupRunIds).toEqual([]);
  expect(workflow.e2e?.failedRound).toBeUndefined();
  expect(commits).toBe(1);
});
