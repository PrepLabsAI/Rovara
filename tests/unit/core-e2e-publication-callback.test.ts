import { linkedChangeRequestKey } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, createCandidateManifest, when, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import type { ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { siblingSpellings, tamperedGrant } from "../support/grant-tamper.js";
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

/** A grant id as the broker logs it: 12 hex characters. */
const GRANT_ID = expect.stringMatching(/^[0-9a-f]{12}$/u) as string;
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
    const handler = createCallbackHandler({ flow: w.h.deps, blobs: createDocumentObjectStorage(w.h.store, { companyId: ORG }), grants: { exchange, inspect: () => ({ grantId: "fixture-id", version: 3, ownerKey: "owner", projectName: w.workspace.projectName, workspaceId: w.workspace.id, operationId: operation!.id, expiresAt: 4_000_000_000,
      repositories: (["clone", "push"] as const).map((access) => ({ credentialRef: "host-app", repositoryUrl: "https://github.com/acme/app", access })) }) } });
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

// G1 (grant exchange binding): the core's Git exchange gives a credential only to a LIVE operation that still holds its workspace, counts the exchanges, audits a push before it leaves and logs every outcome with the grant's id.
describe("repository credential exchange: liveness, count, audit and log", () => {
  const TOKEN = "ghs_FIXTURE_INSTALLATION_TOKEN";
  const URL_OF_APP = "https://github.com/acme/app";
  async function exchangeWorld() {
    const w = await world({ workspaceId: "33333333-3333-4333-8333-333333333333" });
    const { operation } = await w.started();
    const resolve = vi.fn(async () => ({ username: "x-access-token", password: TOKEN }));
    const grants = new RepositoryGrantService(Buffer.alloc(32, 7), resolve);
    const lines: Array<Record<string, unknown>> = [];
    w.h.deps.log = (entry) => { lines.push(entry); };
    const handler = createCallbackHandler({ flow: w.h.deps, blobs: createDocumentObjectStorage(w.h.store, { companyId: ORG }), grants });
    const grantFor = () => grants.issue({ ownerKey: "owner", projectName: "web", workspaceId: w.workspace.id, operationId: operation!.id,
      repositories: (["clone", "push"] as const).map((access) => ({ credentialRef: "host-app", repositoryUrl: URL_OF_APP, access })) });
    const post = async (grant: string, access: "clone" | "push" = "push", repositoryUrl: string = URL_OF_APP) => {
      const answer = await handler({ method: "POST", path: `/v1/internal/workspaces/${w.workspace.id}/operations/${operation!.id}/repository-credentials`,
        headers: { "x-agentx-repository-grant": grant }, body: JSON.stringify({ credentialRef: "host-app", repositoryUrl, access }) });
      const body = JSON.parse(answer.body ?? "{}") as { error?: { code?: string } };
      return { status: answer.statusCode, code: body.error?.code };
    };
    const setOperation = (changes: Record<string, unknown>) => w.h.store.put({ item: toDocument({ ...operation!, ...changes }) });
    /** The workspace as stored now (the start of the publication raised its fence and made the operation its active one). */
    const changeWorkspace = async (changes: Record<string, string | number | null>) => { const stored = (await w.h.store.get({ pk: w.workspace.pk, sk: w.workspace.sk }))!; await w.h.store.put({ item: { ...stored, ...changes } }); return stored; };
    const countOf = async () => (await w.h.store.get({ pk: operation!.pk, sk: operation!.sk }))?.["repositoryCredentialCount"];
    const refusals = () => lines.filter((line) => line["event"] === "repository.credential_refused");
    const nonceOf = (grant: string) => (JSON.parse(Buffer.from(grant.split(".")[0]!, "base64url").toString("utf8")) as { nonce: string }).nonce;
    return { ...w, operation: operation!, resolve, lines, grantFor, post, setOperation, changeWorkspace, countOf, refusals, nonceOf, grants };
  }

  it("the happy publish path: two exchanges for the repository pass, each audited before it leaves, counted, and logged with the grant's id and no secret", async () => {
    const w = await exchangeWorld();
    const grant = w.grantFor();
    expect(await w.post(grant)).toEqual({ status: 200, code: undefined });
    expect(await w.post(grant)).toEqual({ status: 200, code: undefined });
    expect(w.resolve).toHaveBeenCalledTimes(2);
    expect(await w.countOf()).toBe(2);
    const issued = w.lines.filter((line) => line["event"] === "repository.credential_issued");
    const id = createHash("sha256").update(w.nonceOf(grant)).digest("hex").slice(0, 12);
    expect(issued).toHaveLength(2);
    expect(issued[1]).toMatchObject({ outcome: "issued", grantId: id, operationId: w.operation.id, workspaceId: w.workspace.id, repository: "app", kind: "push", headBranch: w.operation.publication!.headBranch, count: 2 });
    const requested = w.h.audit.filter((event) => event.action === "repository_credential.requested");
    const given = w.h.audit.filter((event) => event.action === "repository_credential.issued");
    expect([requested.length, given.length], "a row for the request before the mint, a row for the credential after it").toEqual([2, 2]);
    expect(requested[0]).toMatchObject({ companyId: ORG, details: { repository: "app", kind: "push", grantId: id, count: 1, operationId: w.operation.id } });
    expect(w.h.audit.filter((event) => event.action === "repository_credential.used")).toEqual([]);
    // The grant, its nonce and the credential are in no line and no audit row.
    const raw = JSON.stringify([w.lines, w.h.audit]);
    for (const secret of [TOKEN, grant, grant.split(".")[0]!, grant.split(".")[1]!, w.nonceOf(grant)]) expect(raw).not.toContain(secret);
  });

  it("a replacement machine after a lost one asks again with a new grant: a whole redelivery fits inside the cap; the next exchange is refused with the fixed words and takes no credential", async () => {
    const w = await exchangeWorld();
    const first = w.grantFor(); const second = w.grantFor();
    for (const grant of [first, first, second, second]) expect((await w.post(grant)).status).toBe(200);
    expect(await w.countOf()).toBe(4);
    expect(new Set(w.lines.map((line) => line["grantId"])).size, "two grants, two ids").toBe(2);
    expect(await w.post(second)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.resolve).toHaveBeenCalledTimes(4);
    expect(await w.countOf(), "a refused request does not count").toBe(4);
    expect(w.refusals()[0]).toMatchObject({ outcome: "refused", reason: "limit", grantId: GRANT_ID });
  });

  it("six requests at once take four slots: two cannot both take the last one", async () => {
    const w = await exchangeWorld();
    const grant = w.grantFor();
    const answers = await Promise.all(Array.from({ length: 6 }, () => w.post(grant)));
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(4);
    expect(w.resolve).toHaveBeenCalledTimes(4);
    expect(await w.countOf()).toBe(4);
  });

  it.each(["push", "clone"] as const)("a Stop (or a money stop) has asked the operation to stop: a %s exchange is refused, nothing is minted, and the line names the grant", async (access) => {
    const w = await exchangeWorld();
    const grant = w.grantFor();
    expect((await w.post(grant, access)).status).toBe(200);
    await w.setOperation({ status: "CANCEL_REQUESTED" });
    expect(await w.post(grant, access)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.resolve).toHaveBeenCalledTimes(1);
    expect(w.refusals()).toEqual([expect.objectContaining({ reason: "stopping", kind: access, grantId: GRANT_ID, operationId: w.operation.id })]);
  });

  /** Runs `change` once, just before the transaction that takes the slot (the one that adds to the count), as a person's press or a close would land between the read and the count. */
  function betweenReadAndCount(w: Awaited<ReturnType<typeof exchangeWorld>>, change: () => Promise<unknown>): void {
    const transact = w.h.store.transact.bind(w.h.store);
    let landed = false;
    vi.spyOn(w.h.store, "transact").mockImplementation(async (items) => {
      if (!landed && items.some((item) => item.kind === "update" && item.ops.some((op) => op.path[0] === "repositoryCredentialCount"))) { landed = true; await change(); }
      return transact(items);
    });
  }

  it("a stop that lands between the read and the count takes no slot and mints nothing", async () => {
    const w = await exchangeWorld();
    betweenReadAndCount(w, () => w.setOperation({ status: "CANCEL_REQUESTED" }));
    expect(await w.post(w.grantFor())).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.resolve).not.toHaveBeenCalled();
    expect(await w.countOf()).toBeUndefined();
    expect(w.refusals()[0]).toMatchObject({ reason: "stopping" });
  });

  it.each([["a close accepted", { status: "CLOSING" }], ["a newer fence", { fence: 99 }], ["another active operation", { activeOperationId: "55555555-5555-4555-8555-555555555555" }]] as const)("%s between the read and the count takes no slot and mints nothing (the count's own transaction checks the workspace)", async (_name, changes) => {
    const w = await exchangeWorld();
    betweenReadAndCount(w, () => w.changeWorkspace({ ...changes }));
    expect(await w.post(w.grantFor(), "clone")).toEqual({ status: 409, code: "STALE_FENCE" });
    expect(w.resolve).not.toHaveBeenCalled();
    expect(await w.countOf()).toBeUndefined();
    expect(w.refusals()[0]).toMatchObject({ reason: "stale" });
  });

  it.each(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const)("a %s operation gets nothing", async (status) => {
    const w = await exchangeWorld();
    await w.setOperation({ status });
    expect(await w.post(w.grantFor())).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.resolve).not.toHaveBeenCalled();
    expect(w.refusals()[0]).toMatchObject({ reason: "ended" });
  });

  it.each(["push", "clone"] as const)("a workspace that has moved to a newer fence refuses a %s exchange", async (access) => {
    const w = await exchangeWorld();
    const stored = await w.changeWorkspace({});
    expect(stored["activeOperationId"], "the workspace holds this operation at the operation's fence").toBe(w.operation.id);
    expect(stored["fence"]).toBe(w.operation.fence);
    await w.changeWorkspace({ fence: w.operation.fence + 1 });
    expect(await w.post(w.grantFor(), access)).toEqual({ status: 409, code: "STALE_FENCE" });
    expect(w.resolve).not.toHaveBeenCalled();
    expect(w.refusals()[0]).toMatchObject({ reason: "stale" });
  });

  it.each(["push", "clone"] as const)("a workspace whose active operation is another one refuses a %s exchange", async (access) => {
    const w = await exchangeWorld();
    await w.changeWorkspace({ activeOperationId: "55555555-5555-4555-8555-555555555555" });
    expect(await w.post(w.grantFor(), access)).toEqual({ status: 409, code: "STALE_FENCE" });
    await w.changeWorkspace({ activeOperationId: null });
    expect(await w.post(w.grantFor(), access)).toEqual({ status: 409, code: "STALE_FENCE" });
    expect(w.resolve).not.toHaveBeenCalled();
  });

  it.each(["CLOSING", "CLOSED", "STOPPED"] as const)("a %s workspace refuses the exchange", async (status) => {
    const w = await exchangeWorld();
    await w.changeWorkspace({ status });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "STALE_FENCE" });
    expect(w.resolve).not.toHaveBeenCalled();
  });

  it("a workspace that was closed (closedAt set) refuses the exchange", async () => {
    const w = await exchangeWorld();
    await w.changeWorkspace({ closedAt: at });
    expect(await w.post(w.grantFor(), "clone")).toEqual({ status: 409, code: "STALE_FENCE" });
  });

  it("a push that cannot be audited is refused, mints nothing and gives its slot back; a clone goes on and the line says the record failed", async () => {
    const w = await exchangeWorld();
    w.h.deps.audit = { stage: () => [], record: async () => { throw new Error("audit store down"); } };
    const grant = w.grantFor();
    expect(await w.post(grant, "push")).toEqual({ status: 503, code: "RUNTIME_UNAVAILABLE" });
    expect(w.resolve).not.toHaveBeenCalled();
    expect(w.refusals()[0]).toMatchObject({ reason: "audit" });
    expect(await w.countOf(), "nothing was handed out, so nothing is spent").toBe(0);
    expect(await w.post(grant, "clone")).toEqual({ status: 200, code: undefined });
    expect(w.lines.find((line) => line["event"] === "repository.credential_issued")).toMatchObject({ kind: "clone", auditFailed: true });
    expect(await w.countOf(), "a clone that was given stays counted").toBe(1);
  });

  it("a mint that fails (the host is down) is a refusal of its own, gives its slot back, leaves a request row and no issued row, and a retry can still pass", async () => {
    const w = await exchangeWorld();
    const grant = w.grantFor();
    w.resolve.mockRejectedValueOnce(new Error("GitHub 502 for https://user:HOSTSECRET@host/x"));
    const failed = await w.post(grant, "push");
    expect(failed).toEqual({ status: 503, code: "RUNTIME_UNAVAILABLE" });
    expect(w.refusals()[0]).toMatchObject({ reason: "mint", grantId: GRANT_ID });
    expect(await w.countOf()).toBe(0);
    expect(w.h.audit.map((event) => event.action)).toEqual(["repository_credential.requested"]);
    expect(JSON.stringify([w.lines, w.h.audit]), "the host's error text is in no line").not.toContain("HOSTSECRET");
    expect((await w.post(grant, "push")).status).toBe(200);
    expect(await w.countOf()).toBe(1);
    expect(w.h.audit.map((event) => event.action)).toEqual(["repository_credential.requested", "repository_credential.requested", "repository_credential.issued"]);
  });

  it("the log line names the repository from the verified grant, never from the request: an address with user information, or one the grant does not name, logs no repository", async () => {
    const w = await exchangeWorld();
    const grant = w.grantFor();
    const hostile = "https://user:HOSTILESECRET@evil.example.test";
    expect(await w.post(grant, "push", hostile)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(await w.post(grant, "push", "https://github.com/acme/other")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.refusals()).toHaveLength(2);
    for (const line of w.refusals()) { expect(line).toMatchObject({ reason: "not-covered", grantId: GRANT_ID }); expect(line).not.toHaveProperty("repository"); }
    expect(await w.post(tamperedGrant(grant), "push", hostile)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(JSON.stringify(w.lines)).not.toContain("HOSTILESECRET");
    expect(JSON.stringify(w.lines)).not.toContain("evil.example");
    expect((await w.post(grant, "push")).status).toBe(200);
    expect(w.lines.at(-1)).toMatchObject({ event: "repository.credential_issued", repository: "app" });
  });

  it("a grant that fails verification is refused and logged as such, before anything is read or counted", async () => {
    const w = await exchangeWorld();
    expect((await w.post(tamperedGrant(w.grantFor()))).status).toBe(403);
    expect(await w.countOf()).toBeUndefined();
    expect(w.refusals()[0]).toMatchObject({ reason: "grant" });
    expect(w.refusals()[0]).not.toHaveProperty("grantId");
  });

  // The signature is 43 base64url characters; the last carries 4 bits and 2 unused ones, so a decoder that ignores them reads three OTHER last characters as the same bytes. A grant verifies only as the string it was issued as.
  it("a grant whose signature differs only in the unused bits of its last character is refused: nothing is read, counted or minted, and the refusal is logged as a grant failure", async () => {
    const w = await exchangeWorld();
    const grant = w.grantFor();
    const siblings = siblingSpellings(grant);
    expect(siblings).toHaveLength(3);
    for (const sibling of siblings) {
      const [, issued] = grant.split("."); const [, spelled] = sibling.split(".");
      expect(Buffer.from(spelled!, "base64url").equals(Buffer.from(issued!, "base64url")), "(the premise) the decoder reads it as the same bytes").toBe(true);
    }
    // The route looks the operation up from the path before it reads the grant; what must NOT follow is anything more: a sibling spelling reads exactly what a grant that is plain garbage reads, and writes nothing.
    const reads = vi.spyOn(w.h.store, "get");
    const writes = vi.spyOn(w.h.store, "transact");
    expect((await w.post("garbage.garbage")).status).toBe(403);
    const readsOfGarbage = reads.mock.calls.length;
    reads.mockClear();
    for (const sibling of siblings) expect((await w.post(sibling)).status).toBe(403);
    expect(reads.mock.calls.length).toBe(readsOfGarbage * siblings.length);
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    expect(w.resolve).not.toHaveBeenCalled();
    expect(await w.countOf()).toBeUndefined();
    expect(w.refusals()).toHaveLength(4);
    for (const line of w.refusals()) { expect(line).toMatchObject({ reason: "grant" }); expect(line).not.toHaveProperty("grantId"); }
    reads.mockRestore();
    expect((await w.post(grant)).status).toBe(200);
  });

  it("a request the grant does not name (a push on a clone-only grant, another repository) is refused before it is counted", async () => {
    const w = await exchangeWorld();
    const cloneOnly = w.grants.issue({ ownerKey: "owner", projectName: "web", workspaceId: w.workspace.id, operationId: w.operation.id, repositories: [{ credentialRef: "host-app", repositoryUrl: URL_OF_APP, access: "clone" }] });
    expect(await w.post(cloneOnly, "push")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.resolve).not.toHaveBeenCalled();
    expect(await w.countOf()).toBeUndefined();
    expect(w.refusals()[0]).toMatchObject({ reason: "not-covered", grantId: GRANT_ID });
  });
});
