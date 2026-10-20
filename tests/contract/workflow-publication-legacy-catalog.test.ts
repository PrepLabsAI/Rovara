import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateManifest, WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/contracts";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { startTaskWorkflowPublicationFromSystem, taskPageUrl } from "../../packages/broker/src/aws/developer-tasks.js";
import type { workflowE2ECurrentAuthorityIsValid as AuthorityIsValid, WorkflowE2EVerificationDiagnostic } from "../../packages/broker/src/aws/broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { DEV_ISSUER, MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown, planAnswer, planDocument } from "../support/plan-documents.js";

// A project registered before the catalog carried `latestRevision` (the live TEST project the-mentor-test) has a
// catalog row without it. Publication authority guards that row with `latestRevision = :latest`, so it repairs the
// pointer from the revision history first and keeps the guard strict.

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const CATALOG = { pk: "PROJECT_CATALOG", sk: "PROJECT#payments" };
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const publications = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.kind === "publish");
const taskWorkflow = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const pullRequestGateway = (tree: string) => ({
  reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
  getCommitTree: vi.fn(async () => tree), getBranchHead: vi.fn(async () => "d".repeat(40)),
  getCommitParents: vi.fn(async () => ["e".repeat(40)]),
  getPullRequest: vi.fn(async (_url: string, number: number) => ({ number, url: "https://github.com/example/demo/pull/42", state: "open" as const, headBranch: "x", baseBranch: "main", headCommit: "d".repeat(40), title: "t", body: "" })),
  updatePullRequest: vi.fn(),
  verifyWebhookRepository: vi.fn(async () => true),
});
const passReviews = async (harness: Harness, workspaceId: string, candidate: ReturnType<typeof createCandidateManifest>) => {
  const id = String(operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!.id);
  const now = new Date().toISOString();
  await harness.finish(workspaceId, id, "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
    workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
};
async function workflowAtVerification(harness: Harness) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), plan);
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: taskWorkflow(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
  const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const finishImplementation = () => harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
  return { taskId, workspaceId, candidate, finishImplementation };
}
/** The catalog row as it was written before `latestRevision` existed. */
const makeLegacyCatalog = (harness: Harness) => {
  const row = harness.db.get(CATALOG.pk, CATALOG.sk)!;
  harness.db.set(Object.fromEntries(Object.entries(row).filter(([name]) => name !== "latestRevision")));
  expect(harness.db.get(CATALOG.pk, CATALOG.sk)).not.toHaveProperty("latestRevision");
};
const catalogRevision = (harness: Harness) => harness.db.get(CATALOG.pk, CATALOG.sk)?.latestRevision;
/**
 * The task is ready to publish and its first automatic start failed (a busy workspace's cancellation without reasons),
 * so nothing was published yet and the dispatch row waits. The caller then breaks the catalog and starts it itself.
 */
async function readyToPublish(harness: Harness) {
  const flow = await workflowAtVerification(harness);
  await flow.finishImplementation();
  harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"kind":"publish"'), error: { name: "TransactionCanceledException" } });
  await passReviews(harness, flow.workspaceId, flow.candidate);
  expect(publications(harness, flow.workspaceId)).toHaveLength(0);
  expect(taskWorkflow(harness, flow.taskId)).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions, now: () => Date.now() };
  const expected = { workflowRevision: taskWorkflow(harness, flow.taskId).revision, candidateDigest: flow.candidate.digest };
  const origin = { taskPageUrl: taskPageUrl(DEV_ISSUER, flow.taskId) };
  const start = () => startTaskWorkflowPublicationFromSystem(routeDeps as never, flow.taskId, expected, origin);
  return { ...flow, start };
}
const brokerLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flatMap(([line]) => {
  try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; }
});

afterEach(() => { vi.restoreAllMocks(); });

describe("publication of a project whose catalog row predates latestRevision", () => {
  it("starts the automatic publication, repairing the pointer from the revision history", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
    const { taskId, workspaceId, candidate, finishImplementation } = await workflowAtVerification(harness);
    await finishImplementation();
    makeLegacyCatalog(harness);
    await passReviews(harness, workspaceId, candidate);
    expect(publications(harness, workspaceId)).toHaveLength(1);
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
    expect(catalogRevision(harness)).toBe(1);
    expect(harness.db.get(CATALOG.pk, CATALOG.sk)).toMatchObject({ entityType: "PROJECT_CATALOG", name: "payments", firstRegisteredAt: expect.any(String) as unknown });
  });

  it("starts the owner's Retry opening the pull request", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
    const { taskId, workspaceId, candidate, finishImplementation } = await workflowAtVerification(harness);
    await finishImplementation();
    await passReviews(harness, workspaceId, candidate);
    const first = publications(harness, workspaceId)[0]!;
    await harness.finish(workspaceId, String(first.id), "FAILED", { error: "push refused" });
    const revision = taskWorkflow(harness, taskId).revision;
    makeLegacyCatalog(harness);
    const retried = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/publish-retry`, { requestId: randomUUID(), expectedRevision: revision });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(publications(harness, workspaceId)).toHaveLength(2);
    expect(taskWorkflow(harness, taskId).revision).toBe(revision + 1);
    expect(catalogRevision(harness)).toBe(1);
  });

  it("keeps a project that already has its pointer exactly as before: no repair write", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
    const { workspaceId, candidate, finishImplementation } = await workflowAtVerification(harness);
    await finishImplementation();
    const before = harness.db.get(CATALOG.pk, CATALOG.sk);
    await passReviews(harness, workspaceId, candidate);
    expect(publications(harness, workspaceId)).toHaveLength(1);
    expect(harness.db.get(CATALOG.pk, CATALOG.sk)).toEqual(before);
  });

  it("stays correct when two publications repair the pointer at the same time", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
    const { workspaceId, start } = await readyToPublish(harness);
    makeLegacyCatalog(harness);
    const firstRegisteredAt = harness.db.get(CATALOG.pk, CATALOG.sk)?.firstRegisteredAt;
    const outcomes = await Promise.all([start(), start()]);
    expect([...outcomes].sort()).toEqual(["DUPLICATE", "STARTED"]);
    expect(publications(harness, workspaceId)).toHaveLength(1);
    expect(catalogRevision(harness)).toBe(1);
    expect(harness.db.get(CATALOG.pk, CATALOG.sk)?.firstRegisteredAt).toBe(firstRegisteredAt);
    // The repair itself, raced directly, converges on the same single pointer.
    makeLegacyCatalog(harness);
    await Promise.all([harness.actions.ensureProjectCatalogPointer("payments"), harness.actions.ensureProjectCatalogPointer("payments"), harness.actions.ensureProjectCatalogPointer("payments")]);
    expect(catalogRevision(harness)).toBe(1);
  });

  it("refuses a project with no revision history by name as CONFIG_INVALID, never as a busy workspace", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
    const { workspaceId, start } = await readyToPublish(harness);
    makeLegacyCatalog(harness);
    for (const project of harness.db.find((item) => item.entityType === "PROJECT" && (item.definition as { name?: string } | undefined)?.name === "payments")) {
      harness.db.delete(String(project.pk), String(project.sk));
    }
    const refusal = await start().then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID" });
    expect(refusal?.message).toContain("project payments");
    expect(refusal?.message).toContain("cannot be repaired");
    expect(refusal?.message).not.toContain("WORKSPACE_BUSY");
    expect(catalogRevision(harness)).toBeUndefined();
    expect(publications(harness, workspaceId)).toHaveLength(0);
  });

  it("refuses an ambiguous catalog row by name as CONFIG_INVALID and leaves it untouched", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
    const { start } = await readyToPublish(harness);
    // A catalog row that names another project is not this project's index: it is never rewritten.
    const ambiguous = { pk: CATALOG.pk, sk: CATALOG.sk, entityType: "PROJECT_CATALOG", name: "someone-else", firstRegisteredAt: "2026-10-08T20:03:16.000Z" };
    harness.db.set(ambiguous);
    await expect(start()).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("project payments") as unknown });
    expect(harness.db.get(CATALOG.pk, CATALOG.sk)).toEqual(ambiguous);
  });

  describe("a cancelled publication acceptance", () => {
    it("names the extra item that failed, logs every item's reason, and is not WORKSPACE_BUSY when the workspace was free", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
      const { workspaceId, start } = await readyToPublish(harness);
      // The pointer exists but is not the newest revision: the catalog guard fails, nothing else does.
      harness.db.set({ ...harness.db.get(CATALOG.pk, CATALOG.sk)!, latestRevision: 99 });
      log.mockClear();
      const refusal = await start().then(() => undefined, (error: unknown) => error as Error & { code?: string });
      expect(refusal).toMatchObject({ code: "CONFIG_INVALID" });
      expect(refusal?.message).toContain("project payments's catalog pointer");
      expect(refusal?.message).not.toContain("busy");
      const [entry] = brokerLogs(log).filter((line) => line.event === "pull_request.acceptance_cancelled");
      expect(entry).toMatchObject({ component: "broker", action: "publish", workspaceId });
      expect(entry?.items).toEqual([
        { item: "workspace", code: "None" }, { item: "operation", code: "None" }, { item: "outbox", code: "None" }, { item: "idempotency", code: "None" },
        { item: "extra-0", code: "None" }, { item: "extra-1", code: "ConditionalCheckFailed" }, { item: "extra-2", code: "None" },
      ]);
      expect(publications(harness, workspaceId)).toHaveLength(0);
    });

    it("stays WORKSPACE_BUSY when the workspace's own item was the conflict", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
      const { start } = await readyToPublish(harness);
      const reasons = [{ Code: "ConditionalCheckFailed" }, ...Array.from({ length: 6 }, () => ({ Code: "None" }))];
      log.mockClear();
      harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"kind":"publish"'),
        error: { name: "TransactionCanceledException", cancellationReasons: reasons } });
      await expect(start()).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      expect(brokerLogs(log).find((line) => line.event === "pull_request.acceptance_cancelled")?.items).toEqual(expect.arrayContaining([{ item: "workspace", code: "ConditionalCheckFailed" }]));
    });

    it("is still answered as stale when the task moved on, whichever kind of item cancelled", async () => {
      const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
      const { taskId, start } = await readyToPublish(harness);
      const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
      // The task read inside the start is the one before the move; the transaction then meets the moved task.
      const get = harness.db.send;
      let moved = false;
      harness.db.send = async (command: Parameters<typeof get>[0]) => {
        if (!moved && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as unknown as { input: unknown }).input).includes('"kind":"publish"')) {
          moved = true;
          harness.db.set({ ...task, workflow: { ...task.workflow, revision: task.workflow.revision + 1 } });
        }
        return get(command);
      };
      await expect(start()).resolves.toBe("STALE");
    });

    it("pull-request updates (acceptPullRequestUpdate) log reasons per item and answer extra-item failures as CONFIG_INVALID", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway("b".repeat(40)) } });
      const { taskId, workspaceId, candidate } = await readyToPublish(harness);
      const task = harness.db.get(`DEVTASK#${taskId}`, "META") as never;
      log.mockClear();
      const repositoryUrl = "https://github.com/example/demo.git";
      harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `PULL_REQUEST#demo#${"42".padStart(12, "0")}`, entityType: "PULL_REQUEST", workspaceId, repository: "demo",
        repositoryUrl, number: 42, url: "https://github.com/example/demo/pull/42", state: "open", headBranch: "x", baseBranch: "main",
        expectedHeadCommit: "d".repeat(40), title: "t", body: "", createdByOperationId: randomUUID(), updatedAt: new Date().toISOString() });
      const update = (extra: unknown[]) => harness.actions.acceptPullRequestUpdate(developerTaskIdentity(task), workspaceId,
        { requestId: randomUUID(), repository: "demo", pullRequestNumber: 42, action: "append" }, () => extra as never,
        { candidateDigest: candidate.digest, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40), expectedHeadCommit: "d".repeat(40) });
      const failing = { ConditionCheck: { TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConditionExpression: "attribute_exists(noSuchAttribute)" } };

      await expect(update([failing])).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("extra item 0") as unknown });
      expect(brokerLogs(log).find((line) => line.event === "pull_request.acceptance_cancelled")).toMatchObject({ action: "append", workspaceId,
        items: [{ item: "workspace", code: "None" }, { item: "operation", code: "None" }, { item: "outbox", code: "None" }, { item: "idempotency", code: "None" },
          { item: "extra-0", code: "ConditionalCheckFailed" }] });

      harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"kind":"maintain"'),
        error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] } });
      await expect(update([failing])).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    });
  });
});

describe("required-E2E publication authority of a project whose catalog row predates latestRevision", () => {
  const policy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["scenario-1"],
    targets: [{ kind: "contract", targetId: "target-1", applicationId: "payments", requestedTargetId: "target-1", adapterProfileId: "synthetic",
      runtimeProfileId: "default", accountProfileId: "synthetic" }], defaultSandboxProfileId: "default", fallback: "mock-unconnected", modelRouteRevision: null,
    capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 600_000, startupTimeoutMs: 30_000, preparationTimeoutMs: 30_000, caseTimeoutMs: 60_000,
      maxActionsPerCase: 1, maxModelRequests: 1, maxInputTokens: 128, maxOutputTokens: 128, maxSpendUsd: null } };
  /** A required-E2E task whose feature intent the owner approved, with a candidate recorded, ready for its current-authority check. */
  async function approvedE2ETask() {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { e2eFeatureRuntimeCatalogId: "test-feature-catalog", projectSetupRuntimeCatalogId: "test-setup-catalog" } });
    const payments = harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    harness.db.set({ ...payments, setupApproval: { decision: "approve", proposalRef: "test", proposalSha256: "a".repeat(64), candidateDigest: "b".repeat(64), policyDigest: "c".repeat(64) },
      definition: { ...(payments.definition as Record<string, unknown>), e2e: policy } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Exercise the approved feature intent", client: "authority-test", workflow: true, workflowPath: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    harness.db.set({ ...harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META"), entityType: "DEVELOPER" });
    const workspaceId = String(harness.db.get(`DEVTASK#${taskId}`, "META")!.workspaceId);
    await harness.finish(workspaceId, String(operations(harness, workspaceId).find((row) => row.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const planning = operations(harness, workspaceId).find((row) => row.workflowMode === "PLAN")!;
    const operationId = "payments-render-orders";
    const intent = { schemaVersion: 1 as const, requestedTargetIds: ["target-1"], accountContextRefs: [],
      portableOperationRefs: [{ operationId, applicationId: "payments", requestedTargetIds: ["target-1"],
        packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named" as const, exportName: "renderOrders" } }],
      scenarios: [{ scenarioId: "scenario-1", requirementId: "requirement-1", requestedTargetIds: ["target-1"], required: true,
        accountProfileId: "synthetic", minimumEvidence: "source" as const, requiredRealComponentIds: [],
        steps: [{ kind: "invoke-contract" as const, operationId, input: {} }],
        assertions: [{ kind: "state" as const, probeId: "result", equals: true, pollTimeoutMs: 1 }] }], semanticExportDeltas: [] };
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: "Feature intent", claims: [{ id: "1", text: "Exercise the approved feature intent." }], e2e: intent })));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflow = WorkflowSnapshotSchema.parse(harness.db.get(`DEVTASK#${taskId}`, "META")!.workflow);
    const decision = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision,
      decision: "APPROVE", reason: "Approve the feature intent.", artifactDigest: workflow.artifacts.at(-1)!.sha256 });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const approved = harness.db.get(`DEVTASK#${taskId}`, "META")!;
    const withCandidate = { ...approved, workflow: { ...WorkflowSnapshotSchema.parse(approved.workflow), candidate } };
    harness.db.set(withCandidate);
    expect(withCandidate.workflow.e2e).toMatchObject({ required: true });
    const check = async () => {
      const diagnostic: WorkflowE2EVerificationDiagnostic = {};
      const { workflowE2ECurrentAuthorityIsValid } = await loadSlackBroker() as unknown as { workflowE2ECurrentAuthorityIsValid: typeof AuthorityIsValid };
      const valid = await workflowE2ECurrentAuthorityIsValid(harness.brokerInput as never, withCandidate as never, candidate, {}, {} as never, diagnostic);
      return { valid, reason: diagnostic.reason };
    };
    return { harness, check };
  }

  it("repairs the pointer and goes on to the later authority checks instead of refusing on the catalog", async () => {
    const { harness, check } = await approvedE2ETask();
    expect(await check()).toMatchObject({ reason: expect.not.stringContaining("catalog") as unknown });
    makeLegacyCatalog(harness);
    const outcome = await check();
    expect(outcome.reason).not.toBe("current-project-latest-revision-unavailable");
    expect(outcome.reason).not.toContain("catalog-pointer");
    // It was refused (the admission is empty), but by a check after the catalog's, with the pointer repaired.
    expect(outcome.valid).toBe(false);
    expect(catalogRevision(harness)).toBe(1);
  });

  it("refuses an unrepairable catalog row with a specific reason naming the project", async () => {
    const { harness, check } = await approvedE2ETask();
    const ambiguous = { pk: CATALOG.pk, sk: CATALOG.sk, entityType: "PROJECT_CATALOG", name: "someone-else", firstRegisteredAt: "2026-10-08T20:03:16.000Z" };
    harness.db.set(ambiguous);
    expect(await check()).toEqual({ valid: false, reason: "config-invalid-project-catalog-pointer-unrepairable:payments" });
    expect(harness.db.get(CATALOG.pk, CATALOG.sk)).toEqual(ambiguous);
  });

  it("keeps the strict check: a pointer that is not the newest revision is still refused", async () => {
    const { harness, check } = await approvedE2ETask();
    harness.db.set({ ...harness.db.get(CATALOG.pk, CATALOG.sk)!, latestRevision: 99 });
    expect(await check()).toEqual({ valid: false, reason: "current-project-latest-revision-unavailable" });
    expect(catalogRevision(harness)).toBe(99);
  });
});
