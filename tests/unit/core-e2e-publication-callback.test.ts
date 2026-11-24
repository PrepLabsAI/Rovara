import { linkedChangeRequestKey } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, createCandidateManifest, when, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import type { ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { startPublication, openPullRequest, recordPublished } from "../../packages/broker/src/core/build-step/publish.js";
import { recordMaintained, updatePullRequest } from "../../packages/broker/src/core/build-step/maintain.js";
import { pullRequestRecordKey } from "../../packages/broker/src/core/build-step/records.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument, type OperationRecord, type WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { failClosedAuthority } from "../../packages/broker/src/core/e2e/authority.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { host, ORG } from "../support/service-host.js";

const at = "2026-11-09T10:00:00.000Z";
const authorityKey = { pk: "AUTHORITY#publication-test", sk: "META" };
const authorityItems: TransactItem[] = [{ kind: "check", key: authorityKey, condition: when.eq("revision", 1) }];

/** Fully typed ports: only publication is exercised here; accidental use of another group refuses. */
function ports(publication: ApplicationE2ESeams["publication"]): ApplicationE2ESeams {
  const unused = async (): Promise<never> => { throw new Error("unexpected application port"); };
  const store = new MemoryDocumentStore();
  return { publication, planning: { context: unused, approve: unused }, rounds: { selection: unused, runRow: unused, retry: unused,
    records: { task: unused, baseline: unused, replay: unused, grounding: unused }, verification: { state: { store }, objects: createDocumentObjectStorage(store, { companyId: ORG }), authority: failClosedAuthority, readTask: unused } },
    results: { read: unused, project: unused, artifact: unused, notice: unused } };
}

async function world(options: { required?: boolean; update?: boolean; workspaceId?: string } = {}) {
  const w = await host();
  const task = (await readTask(w.h.deps, w.state.facts.taskId))!;
  if (options.workspaceId !== undefined) task.workspaceId = options.workspaceId;
  const model = w.world.prs[0]!.model;
  const base = model.headOf("main");
  const oldHead = w.world.prs[0]!.head;
  const branch = options.update === true ? model.changeRequests[0]!.sourceBranch : "candidate";
  const commit = model.commit(branch, { "src/a.ts": "export const a = 2;\n" });
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: commit, treeSha: model.revision(commit).tree, baseCommitSha: base }]);
  const planBytes = Buffer.from("# Approved plan\n");
  const planSha = createHash("sha256").update(planBytes).digest("hex");
  const artifact: WorkflowSnapshot["artifacts"][number] = { id: "plan", type: "plan", version: 1, objectKey: "plan.md", sha256: planSha, producer: "op-plan", createdAt: at };
  const workflow: WorkflowSnapshot = { ...task.workflow!, stage: "PULL_REQUEST", state: "READY", candidate, artifacts: [artifact],
    decisions: [{ requestId: "11111111-1111-4111-8111-111111111111", workflowRevision: 2, decision: "APPROVE", actorId: task.developerId, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: planSha, at }],
    verification: { ...task.workflow!.verification!, candidateDigest: candidate.digest }, reviews: task.workflow!.reviews!.map((review) => ({ ...review, candidateDigest: candidate.digest })),
    reviewBase: [{ repositoryId: "app", baseCommitSha: base }],
    pullRequests: options.update === true ? task.workflow!.pullRequests : [],
    ...(options.required === false ? {} : { e2e: { required: true, contractDigest: planSha, policyDigest: "a".repeat(64), bundleDigest: "b".repeat(64), executionPlanDigest: "c".repeat(64), currentRoundId: "11111111-1111-4111-8111-111111111112", currentGroupRunIds: ["11111111-1111-4111-8111-111111111113"], resultRefs: [],
      qualifiedRound: { candidateDigest: candidate.digest, roundId: "11111111-1111-4111-8111-111111111112", groupRunIds: ["11111111-1111-4111-8111-111111111113"], admissionSha256: "d".repeat(64), evidenceSha256: "e".repeat(64), contractDigest: planSha, policyDigest: "a".repeat(64), bundleDigest: "b".repeat(64), executionPlanDigest: "c".repeat(64) } } }),
  };
  const readyTask = { ...task, title: "Add retry", ownerKey: "owner", preparedBase: [{ repositoryId: "app", baseCommitSha: base }], workflow };
  await w.h.store.put({ item: toDocument(readyTask) });
  const workspace: WorkspaceRecord = { ...workspaceKey(ORG, task.workspaceId), sk: "META", entityType: "WORKSPACE", companyId: ORG, orgId: ORG, id: task.workspaceId, ownerKey: "owner", projectName: "web", projectRevision: 1, status: "READY", activeOperationId: null, fence: 1, workspaceProject: "web", workspaceCreatedAt: at, createdAt: at, updatedAt: at };
  await w.h.store.put({ item: toDocument(workspace) });
  await w.h.store.put({ item: { pk: workspace.pk, sk: "DEVELOPER_TASK", taskId: task.taskId } });
  await w.h.store.put({ item: { ...authorityKey, revision: 1 } });
  w.h.deps.codeHosts = w.registry;
  w.h.deps.artifacts = { get: async () => planBytes };
  w.h.deps.applicationE2E = ports(async () => ({ mode: "COMMITTED_HEAD", items: authorityItems }));
  if (options.update === true) {
    model.branches.set(branch, oldHead);
    await w.h.store.put({ item: { ...pullRequestRecordKey(workspace, "app", 1), entityType: "PULL_REQUEST", workspaceId: task.workspaceId, repository: "app", repositoryUrl: "https://github.com/acme/app", number: 1, url: model.crUrl("1"), state: "open", headBranch: branch, baseBranch: "main", expectedHeadCommit: oldHead, title: "fix", body: "fix", createdByOperationId: "old-publish", updatedAt: at } });
  }
  const row = { taskId: task.taskId, workflowRevision: workflow.revision };
  const started = async () => {
    const result = await startPublication(w.h.deps, row);
    const operation = (await workspaceOperations(w.h.deps, task.workspaceId)).find((entry) => entry.kind === (options.update === true ? "maintain" : "publish"));
    return { result, operation };
  };
  const callback = (operation: OperationRecord, pushed = commit) => ({ repository: "app", repositoryUrl: "https://github.com/acme/app", headBranch: operation.publication!.headBranch, baseBranch: "main", title: operation.publication!.title, body: operation.publication!.body, commit: pushed });
  return { ...w, task: readyTask, workspace, row, model, commit, oldHead, started, callback };
}

// Removing the required-seam/nonempty checks would dispatch code that has no current authority.
describe("required E2E publication acceptance", () => {
  for (const refusal of ["absent", "unknown", "empty", "wrong-mode"] as const) it(`does not dispatch on ${refusal} authority`, async () => {
    const w = await world();
    if (refusal === "absent") delete w.h.deps.applicationE2E;
    else w.h.deps.applicationE2E = ports(async () => refusal === "unknown" ? undefined : { mode: refusal === "wrong-mode" ? "CHECKED_TREE" : "COMMITTED_HEAD", items: refusal === "empty" ? [] : authorityItems });
    expect((await w.started()).result).toBe("STALE");
    expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
  });
  it("dispatches the exact committed head and holds the authority rows in the acceptance transaction", async () => {
    const w = await world();
    const { result, operation } = await w.started();
    expect(result).toBe("STARTED");
    expect(operation?.dispatch?.payload).toMatchObject({ publicationMode: "COMMITTED_HEAD", candidateCommitSha: w.commit });
    expect(operation?.publication).toMatchObject({ publicationMode: "COMMITTED_HEAD", expectedCommitSha: w.commit });
  });
  for (const update of [false, true]) it(`rolls back ${update ? "update" : "create"} operation and workspace when authority moves after the read`, async () => {
    const w = await world({ update });
    w.h.deps.applicationE2E = ports(async () => { await w.h.store.put({ item: { ...authorityKey, revision: 2 } }); return { mode: "COMMITTED_HEAD", items: authorityItems }; });
    expect((await w.started()).result).toBe("STALE");
    expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
    expect((await w.h.store.get(w.workspace))?.activeOperationId).toBeNull();
  });
  it("keeps ordinary publication on CHECKED_TREE without an application seam", async () => {
    const w = await world({ required: false }); delete w.h.deps.applicationE2E;
    const { result, operation } = await w.started();
    expect(result).toBe("STARTED"); expect(operation?.dispatch?.payload.publicationMode).toBe("CHECKED_TREE");
  });
  it("rechecks authority on the owner's publication retry", async () => {
    const w = await world();
    await w.h.store.put({ item: toDocument({ ...w.task, workflow: { ...w.task.workflow, state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE } }) });
    delete w.h.deps.applicationE2E;
    expect(await startPublication(w.h.deps, w.row, { ownerRetry: true })).toBe("STALE");
    expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
  });
  it("admits an owner retry and keeps its committed binding valid after the revision advances", async () => {
    const w = await world();
    await w.h.store.put({ item: toDocument({ ...w.task, workflow: { ...w.task.workflow, state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE } }) });
    expect(await startPublication(w.h.deps, w.row, { ownerRetry: true })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find((entry) => entry.kind === "publish")!;
    expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.revision).toBe(w.row.workflowRevision + 1);
    w.model.branches.set(operation.publication!.headBranch, w.commit);
    expect((await openPullRequest(w.h.deps, operation, w.callback(operation))).draft).toBe(true);
  });
  it("applies the same fence to an existing pull request update", async () => {
    const w = await world({ update: true }); delete w.h.deps.applicationE2E;
    expect((await w.started()).result).toBe("STALE");
    expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
  });
});

describe("required E2E callback authority", () => {
  it.each(["no-workflow", "stage", "state", "candidate"] as const)("ignores a successful publication result after %s drift without changing the task", async drift => {
    const w = await world(); const { operation } = await w.started();
    w.model.branches.set(operation!.publication!.headBranch, w.commit);
    const opened = await openPullRequest(w.h.deps, operation!, w.callback(operation!));
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    if (drift === "no-workflow") delete task.workflow;
    else if (drift === "stage") task.workflow!.stage = "IMPLEMENT";
    else if (drift === "state") task.workflow!.state = "BLOCKED";
    else task.workflow!.candidate = { ...task.workflow!.candidate!, digest: "f".repeat(64) };
    await w.h.store.put({ item: toDocument(task) });
    const before = canonicalJson(task);
    await recordPublished(w.h.deps, task, operation!, { status: "SUCCEEDED", outcome: { kind: "published", result: { repository: "app", number: opened.number, url: opened.url, commit: w.commit, headBranch: operation!.publication!.headBranch, baseBranch: "main", checks: [], reconciled: opened.reconciled } } });
    expect(canonicalJson(await readTask(w.h.deps, w.task.taskId))).toBe(before);
  });

  it("opens a draft of the exact committed candidate", async () => {
    const w = await world(); const { operation } = await w.started();
    w.model.branches.set(operation!.publication!.headBranch, w.commit);
    const opened = await openPullRequest(w.h.deps, operation!, w.callback(operation!));
    expect(opened.draft).toBe(true); expect(w.model.headOf(w.model.changeRequests.at(-1)!.sourceBranch)).toBe(w.commit);
  });
  it.each(["authority", "workflow"] as const)("rechecks required %s after the branch read and before opening a draft", async drift => {
    const w = await world(); const { operation } = await w.started();
    w.model.branches.set(operation!.publication!.headBranch, w.commit);
    const adapter = w.h.deps.codeHosts!.require("code-host");
    const branchHead = adapter.branchHead.bind(adapter);
    const spy = vi.spyOn(adapter, "branchHead").mockImplementation(async (...args) => {
      const head = await branchHead(...args);
      if (drift === "authority") await w.h.store.put({ item: { ...authorityKey, revision: 2 } });
      else {
        const task = (await readTask(w.h.deps, w.task.taskId))!;
        await w.h.store.put({ item: toDocument({ ...task, workflow: { ...task.workflow!, stage: "IMPLEMENT" } }) });
      }
      return head;
    });
    try {
      const count = w.model.changeRequests.length;
      await expect(openPullRequest(w.h.deps, operation!, w.callback(operation!))).rejects.toMatchObject({ code: "STALE_FENCE" });
      expect(w.model.changeRequests).toHaveLength(count);
    } finally { spy.mockRestore(); }
  });
  for (const moved of ["authority", "plan", "approval", "commit", "condition-race"] as const) it(`refuses ${moved} drift before opening a draft`, async () => {
    const w = await world(); const { operation } = await w.started();
    w.model.branches.set(operation!.publication!.headBranch, w.commit);
    if (moved === "condition-race") await w.h.store.put({ item: { ...authorityKey, revision: 2 } });
    if (moved === "authority") w.h.deps.applicationE2E = ports(async () => undefined);
    if (moved === "plan") await w.h.store.put({ item: toDocument({ ...w.task, workflow: { ...w.task.workflow, artifacts: [{ ...w.task.workflow.artifacts[0]!, sha256: "f".repeat(64) }] } }) });
    if (moved === "approval") await w.h.store.put({ item: toDocument({ ...w.task, workflow: { ...w.task.workflow, decisions: [] } }) });
    const pushed = moved === "commit" ? w.model.commit(operation!.publication!.headBranch, {}) : w.commit;
    const count = w.model.changeRequests.length;
    const branchHead = vi.spyOn(w.h.deps.codeHosts!.require("code-host"), "branchHead");
    await expect(openPullRequest(w.h.deps, operation!, w.callback(operation!, pushed))).rejects.toBeDefined();
    expect(w.model.changeRequests).toHaveLength(count);
    expect(branchHead).not.toHaveBeenCalled();
    branchHead.mockRestore();
  });
  it("does not register a successful worker result when authority has since become UNKNOWN", async () => {
    const w = await world(); const { operation } = await w.started();
    w.model.branches.set(operation!.publication!.headBranch, w.commit);
    const opened = await openPullRequest(w.h.deps, operation!, w.callback(operation!));
    w.h.deps.applicationE2E = ports(async () => undefined);
    await recordPublished(w.h.deps, w.task, operation!, { status: "SUCCEEDED", outcome: { kind: "published", result: { repository: "app", number: opened.number, url: opened.url, commit: w.commit, headBranch: operation!.publication!.headBranch, baseBranch: "main", checks: [], reconciled: opened.reconciled } } });
    const current = await readTask(w.h.deps, w.task.taskId);
    expect(current?.workflow?.pullRequests).toEqual([]); expect(current?.workflow?.state).toBe("BLOCKED");
  });
  it("records a current append's exact committed head and reconciles its duplicate", async () => {
    const w = await world({ update: true }); const { result, operation } = await w.started();
    expect(result).toBe("STARTED");
    w.model.branches.set(operation!.maintenance!.headBranch, w.commit);
    const input = { repository: "app", pullRequestNumber: 1, action: "append", headBranch: operation!.maintenance!.headBranch, baseBranch: "main", previousCommit: w.oldHead, commit: w.commit };
    expect((await updatePullRequest(w.h.deps, operation!, input)).state).toBe("open");
    expect((await w.h.store.get(pullRequestRecordKey(w.workspace, "app", 1)))?.expectedHeadCommit).toBe(w.commit);
    expect((await updatePullRequest(w.h.deps, operation!, input)).reconciled).toBe(true);
  });
  it("rechecks an append callback before recording the new head", async () => {
    const w = await world({ update: true }); const { operation } = await w.started();
    w.model.branches.set(operation!.maintenance!.headBranch, w.commit);
    w.h.deps.applicationE2E = ports(async () => undefined);
    await expect(updatePullRequest(w.h.deps, operation!, { repository: "app", pullRequestNumber: 1, action: "append", headBranch: operation!.maintenance!.headBranch, baseBranch: "main", previousCommit: w.oldHead, commit: w.commit })).rejects.toBeDefined();
    expect((await w.h.store.get(pullRequestRecordKey(w.workspace, "app", 1)))?.expectedHeadCommit).toBe(w.oldHead);
  });
});

// Exercise the public credential route: no credential may leave before the live fence transaction.
describe("publication credential release", () => {
  async function credentialWorld() {
    const w = await world({ workspaceId: "33333333-3333-4333-8333-333333333333" });
    const { operation } = await w.started();
    const exchange = vi.fn(async () => ({ token: "fixture-token" }));
    const handler = createCallbackHandler({ flow: w.h.deps, blobs: createDocumentObjectStorage(w.h.store, { companyId: ORG }), grants: { exchange, inspect: () => { throw new Error("unused"); } } });
    const post = (access: "clone" | "push" = "push") => handler({ method: "POST",
      path: `/v1/internal/workspaces/${w.workspace.id}/operations/${operation!.id}/repository-credentials`,
      headers: { "x-agentx-repository-grant": "fixture-grant" },
      body: JSON.stringify({ credentialRef: "host-app", repositoryUrl: "https://github.com/acme/app", access }) });
    return { ...w, operation: operation!, exchange, post };
  }

  async function manualCredentialWorld() {
    const w = await credentialWorld();
    const { workflow: _workflow, ...task } = w.task; void _workflow;
    await w.h.store.put({ item: toDocument(task) });
    const publication = w.operation.publication!;
    delete publication.candidateDigest;
    delete publication.publicationMode;
    delete publication.expectedCommitSha;
    delete publication.admittedE2EAuthorityDigest;
    await w.h.store.put({ item: toDocument(w.operation) });
    return w;
  }

  it("releases an unchanged publication push only after checking live authority", async () => {
    const w = await credentialWorld();
    expect((await w.post()).statusCode).toBe(200);
    expect(w.exchange).toHaveBeenCalledExactlyOnceWith("fixture-grant", expect.objectContaining({ access: "push", operationId: w.operation.id }));
  });
  it("refuses unavailable required authority before credential exchange", async () => {
    const w = await credentialWorld();
    w.h.deps.applicationE2E = ports(async () => undefined);
    expect((await w.post()).statusCode).toBe(409);
    expect(w.exchange).not.toHaveBeenCalled();
  });

  it("releases a manual publication push with no workflow through the existing credential input", async () => {
    const w = await manualCredentialWorld();
    expect((await w.post()).statusCode).toBe(200);
    expect(w.exchange).toHaveBeenCalledExactlyOnceWith("fixture-grant", expect.objectContaining({ access: "push", operationId: w.operation.id }));
  });

  it.each(["ordinary", "required"] as const)("OPUS-REPRO refuses a manual credential once the task has an %s workflow", async kind => {
    const w = await manualCredentialWorld();
    const { e2e: _e2e, ...ordinary } = w.task.workflow; void _e2e;
    await w.h.store.put({ item: toDocument({ ...w.task, workflow: kind === "ordinary" ? ordinary : w.task.workflow }) });
    expect((await w.post()).statusCode).toBe(409);
    expect(w.exchange).not.toHaveBeenCalled();
  });

  it.each(["companyId", "workspaceId"] as const)("refuses a manual credential whose task has another %s", async field => {
    const w = await manualCredentialWorld();
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    await w.h.store.put({ item: toDocument({ ...task, [field]: field === "companyId" ? "org_22222222222222222222" : "44444444-4444-4444-8444-444444444444" }) });
    expect((await w.post()).statusCode).toBe(409);
    expect(w.exchange).not.toHaveBeenCalled();
  });

  it.each(["workspaceId", "closeOperationId"] as const)("holds the manual credential's %s binding through the authority transaction", async field => {
    const w = await manualCredentialWorld();
    const transact = w.h.store.transact.bind(w.h.store);
    const spy = vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
      const task = (await readTask(w.h.deps, w.task.taskId))!;
      await w.h.store.put({ item: toDocument({ ...task, [field]: field === "workspaceId" ? "44444444-4444-4444-8444-444444444444" : "accepted-close" }) });
      return transact(items);
    });
    try {
      expect((await w.post()).statusCode).toBe(409);
      expect(w.exchange).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  for (const missing of ["pointer", "task", "workflow"] as const) it(`refuses a push with missing ${missing} before credential exchange`, async () => {
    const w = await credentialWorld();
    if (missing === "pointer") await w.h.store.delete({ key: { pk: w.workspace.pk, sk: "DEVELOPER_TASK" } });
    if (missing === "task") await w.h.store.delete({ key: { pk: w.task.pk, sk: w.task.sk } });
    if (missing === "workflow") {
      const { workflow: _workflow, ...task } = w.task; void _workflow;
      await w.h.store.put({ item: toDocument(task) });
    }
    expect((await w.post()).statusCode).toBe(409);
    expect(w.exchange).not.toHaveBeenCalled();
  });

  for (const moved of ["authority", "task"] as const) it(`refuses ${moved} moving in the credential fence transaction`, async () => {
    const w = await credentialWorld();
    const transact = w.h.store.transact.bind(w.h.store);
    const spy = vi.spyOn(w.h.store, "transact").mockImplementationOnce(async (items) => {
      if (moved === "authority") await w.h.store.put({ item: { ...authorityKey, revision: 2 } });
      else await w.h.store.put({ item: toDocument({ ...w.task, closedAt: at }) });
      return transact(items);
    });
    try {
      expect((await w.post()).statusCode).toBe(409);
      expect(w.exchange).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("allows a clone and an ordinary task push without publication authority", async () => {
    const w = await credentialWorld();
    await w.h.store.delete({ key: { pk: w.task.pk, sk: w.task.sk } });
    expect((await w.post("clone")).statusCode).toBe(200);
    const { publication: _publication, ...ordinary } = w.operation; void _publication;
    await w.h.store.put({ item: toDocument({ ...ordinary, kind: "task" }) });
    expect((await w.post()).statusCode).toBe(200);
    expect(w.exchange).toHaveBeenCalledTimes(2);
  });
});

describe("publication acceptance and append races", () => {
  it("refuses when the application fence disappears between publication and update selection", async () => {
    const w = await world({ update: true });
    let reads = 0;
    w.h.deps.applicationE2E = ports(async () => ++reads === 1 ? { mode: "COMMITTED_HEAD", items: authorityItems } : undefined);
    expect((await w.started()).result).toBe("STALE");
    expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
  });

  for (const moved of [false, true]) it(`holds an already-current pull request with its authority transaction (moved: ${moved})`, async () => {
    const w = await world({ update: true });
    const task = { ...w.task, workflow: { ...w.task.workflow, pullRequests: w.task.workflow.pullRequests!.map((pr) => ({ ...pr, headSha: w.commit, candidateDigest: w.task.workflow.candidate!.digest, headTreeSha: w.task.workflow.candidate!.repositories[0]!.treeSha })) } };
    await w.h.store.put({ item: toDocument(task) });
    if (moved) w.h.deps.applicationE2E = ports(async () => { await w.h.store.put({ item: { ...authorityKey, revision: 2 } }); return { mode: "COMMITTED_HEAD", items: authorityItems }; });
    const before = canonicalJson(await readTask(w.h.deps, w.task.taskId));
    expect((await w.started()).result).toBe(moved ? "STALE" : "STARTED");
    const current = await readTask(w.h.deps, w.task.taskId);
    if (moved) expect(canonicalJson(current)).toBe(before);
    else expect(current?.workflow?.stage).toBe("WAIT_FOR_MERGE");
    expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual([]);
  });

  for (const race of ["initial-authority", "final-authority", "stage"] as const) it(`refuses an append on ${race} drift without recording its head`, async () => {
    const w = await world({ update: true }); const { operation } = await w.started();
    w.model.branches.set(operation!.maintenance!.headBranch, w.commit);
    const key = pullRequestRecordKey(w.workspace, "app", 1);
    const before = await w.h.store.get(key);
    if (race === "stage") {
      const task = (await readTask(w.h.deps, w.task.taskId))!;
      await w.h.store.put({ item: toDocument({ ...task, workflow: { ...task.workflow!, stage: "IMPLEMENT" } }) });
    }
    const transact = w.h.store.transact.bind(w.h.store);
    const spy = vi.spyOn(w.h.store, "transact").mockImplementation(async (items) => {
      const final = items.some((item) => item.kind === "update" && item.key.pk === key.pk && item.key.sk === key.sk);
      if ((race === "final-authority" && final) || race === "initial-authority") await w.h.store.put({ item: { ...authorityKey, revision: 2 } });
      return transact(items);
    });
    try {
      await expect(updatePullRequest(w.h.deps, operation!, { repository: "app", pullRequestNumber: 1, action: "append", headBranch: operation!.maintenance!.headBranch,
        baseBranch: "main", previousCommit: w.oldHead, commit: w.commit })).rejects.toMatchObject({ code: "STALE_FENCE" });
      expect(await w.h.store.get(key)).toEqual(before);
    } finally { spy.mockRestore(); }
  });
});

for (const moved of ["stage", "final-authority", "failed-write", "duplicate", "wrong-operation", "wrong-head"] as const) it(`checks publication recording on ${moved}`, async () => {
  const w = await world(); const { operation } = await w.started();
  w.model.branches.set(operation!.publication!.headBranch, w.commit);
  if (moved === "stage") {
    await w.h.store.put({ item: toDocument({ ...w.task, workflow: { ...w.task.workflow, stage: "IMPLEMENT" } }) });
    const count = w.model.changeRequests.length;
    await expect(openPullRequest(w.h.deps, operation!, w.callback(operation!))).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(w.model.changeRequests).toHaveLength(count); return;
  }
  const transact = w.h.store.transact.bind(w.h.store);
  const spy = vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    const recording = items.some(item => item.kind === "put" && item.item["entityType"] === "PULL_REQUEST");
    if (recording && moved === "final-authority") await w.h.store.put({ item: { ...authorityKey, revision: 2 } });
    if (recording && moved === "failed-write") return { applied: false, reason: "condition_failed", failed: [] };
    if (recording && (moved === "duplicate" || moved === "wrong-operation" || moved === "wrong-head")) {
      const record = items.find(item => item.kind === "put" && item.item["entityType"] === "PULL_REQUEST");
      if (record?.kind === "put") await w.h.store.put({ item: { ...record.item,
        ...(moved === "wrong-operation" ? { createdByOperationId: "other-operation" } : {}),
        ...(moved === "wrong-head" ? { expectedHeadCommit: "f".repeat(40) } : {}),
      } });
      return { applied: false, reason: "condition_failed", failed: [] };
    }
    return transact(items);
  });
  try {
    if (moved === "duplicate") expect((await openPullRequest(w.h.deps, operation!, w.callback(operation!))).number).toBeGreaterThan(0);
    else await expect(openPullRequest(w.h.deps, operation!, w.callback(operation!))).rejects.toMatchObject({ code: "STALE_FENCE" });
  } finally { spy.mockRestore(); }
});

it("does not read a pull request record after the preliminary append authority transaction refuses", async () => {
  const w = await world({ update: true }); const { operation } = await w.started();
  const transact = vi.spyOn(w.h.store, "transact").mockResolvedValue({ applied: false, reason: "condition_failed", failed: [] });
  const get = vi.spyOn(w.h.store, "get");
  try {
    await expect(updatePullRequest(w.h.deps, operation!, { repository: "app", pullRequestNumber: 1, action: "append", headBranch: operation!.maintenance!.headBranch,
      baseBranch: "main", previousCommit: w.oldHead, commit: w.commit })).rejects.toThrow("publication authority moved before recording the update");
    const key = pullRequestRecordKey(w.workspace, "app", 1);
    expect(get.mock.calls.some(([read]) => read.pk === key.pk && read.sk === key.sk)).toBe(false);
  } finally { transact.mockRestore(); get.mockRestore(); }
});

it("allows a reconciled sync callback without consulting application publication authority", async () => {
  const w = await world({ update: true }); const { operation } = await w.started();
  operation!.maintenance!.action = "sync";
  delete w.h.deps.applicationE2E;
  const key = pullRequestRecordKey(w.workspace, "app", 1);
  await w.h.store.update({ key, ops: [{ op: "set", path: ["expectedHeadCommit"], value: w.commit }] });
  expect(await updatePullRequest(w.h.deps, operation!, { repository: "app", pullRequestNumber: 1, action: "sync", headBranch: operation!.maintenance!.headBranch,
    baseBranch: "main", previousCommit: w.oldHead, commit: w.commit })).toMatchObject({ reconciled: true });
});

for (const update of [false, true]) for (const moved of [false, true]) it(`records a completed ${update ? "update" : "publication"} only with live authority (moved: ${moved})`, async () => {
  const w = await world({ update }); const { operation } = await w.started();
  const branch = update ? operation!.maintenance!.headBranch : operation!.publication!.headBranch;
  w.model.branches.set(branch, w.commit);
  let number = 1, url = w.model.crUrl("1");
  if (update) await updatePullRequest(w.h.deps, operation!, { repository: "app", pullRequestNumber: 1, action: "append", headBranch: branch, baseBranch: "main", previousCommit: w.oldHead, commit: w.commit });
  else { const opened = await openPullRequest(w.h.deps, operation!, w.callback(operation!)); number = opened.number; url = opened.url; }
  const task = (await readTask(w.h.deps, w.task.taskId))!; const before = canonicalJson(task.workflow);
  expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: update ? "RUNNING" : "READY" });
  if (update) {
    const key = linkedChangeRequestKey("github", "https://github.com/acme/app", String(number))!;
    await w.h.store.put({ item: { ...key, taskId: task.taskId, candidateDigest: task.workflow!.pullRequests![0]!.candidateDigest } });
  }
  const publicationRead = vi.spyOn(w.h.deps.applicationE2E!, "publication");
  const transact = w.h.store.transact.bind(w.h.store);
  const spy = vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (moved && items.some(item => item.kind === "update" && item.key.pk === task.pk && item.key.sk === task.sk)) await w.h.store.put({ item: { ...authorityKey, revision: 2 } });
    return transact(items);
  });
  try {
    if (update) await recordMaintained(w.h.deps, task, operation!, { status: "SUCCEEDED", outcome: { kind: "published", result: { action: "append", repository: "app", number, url, state: "open", headBranch: branch, baseBranch: "main", previousCommit: w.oldHead, commit: w.commit, treeSha: task.workflow!.candidate!.repositories[0]!.treeSha, checks: [], codeBuildChecks: [], reconciled: false } } });
    else await recordPublished(w.h.deps, task, operation!, { status: "SUCCEEDED", outcome: { kind: "published", result: { repository: "app", number, url, commit: w.commit, headBranch: branch, baseBranch: "main", checks: [], reconciled: false } } });
    expect(publicationRead).toHaveBeenCalled();
    const current = (await readTask(w.h.deps, task.taskId))!.workflow!;
    if (moved) expect(canonicalJson(current)).toBe(before);
    else expect(current).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [expect.objectContaining({ headSha: w.commit })] });
  } finally { spy.mockRestore(); publicationRead.mockRestore(); }
});

it("refuses recording an append if the task closes after its final authority read", async () => {
  const w = await world({ update: true }); const { operation } = await w.started();
  w.model.branches.set(operation!.maintenance!.headBranch, w.commit);
  const key = pullRequestRecordKey(w.workspace, "app", 1); const before = await w.h.store.get(key);
  const transact = w.h.store.transact.bind(w.h.store);
  const spy = vi.spyOn(w.h.store, "transact").mockImplementation(async items => {
    if (items.some(item => item.kind === "update" && item.key.pk === key.pk && item.key.sk === key.sk)) await w.h.store.put({ item: toDocument({ ...w.task, closedAt: at }) });
    return transact(items);
  });
  try {
    await expect(updatePullRequest(w.h.deps, operation!, { repository: "app", pullRequestNumber: 1, action: "append", headBranch: operation!.maintenance!.headBranch,
      baseBranch: "main", previousCommit: w.oldHead, commit: w.commit })).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(await w.h.store.get(key)).toEqual(before);
  } finally { spy.mockRestore(); }
});
