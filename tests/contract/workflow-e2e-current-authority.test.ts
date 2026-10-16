import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, taskGraphDigest, workspaceSessionKey, workflowRequestId, WorkflowSnapshotSchema } from "@agentx/contracts";
import { startTaskWorkflowPublicationFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { resolveWorkflowE2ECanonicalApproval, workflowE2ECurrentAuthorityMatches } from "../../packages/broker/src/aws/workflow-e2e-current-authority.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const authority = () => ({
  admission: { candidateDigest: "a".repeat(64), intent: { scenario: "approved" }, policy: { revision: 4 },
    runtime: { state: "READY", qualifiedAt: "2026-10-13T12:00:00Z", expiresAt: "2026-10-13T13:00:00Z", binding: { subnets: ["a", "b"] } },
    portableApprovalBinding: { digest: "b".repeat(64) }, creatorAuthority: { kind: "direct-membership", grantId: "grant-1" },
    approval: { artifactId: "artifact-1", artifactDigest: "c".repeat(64), graphDigest: "d".repeat(64), runId: "run-1", workflowRevision: 7, actorId: "owner-1" } },
  current: { candidateDigest: "a".repeat(64), intent: { scenario: "approved" }, policy: { revision: 4 },
    runtime: { state: "READY", qualifiedAt: "2026-10-13T12:00:00Z", expiresAt: "2026-10-13T13:00:00Z", binding: { subnets: ["a", "b"] } },
    portableApprovalBinding: { digest: "b".repeat(64) }, creatorAuthority: { kind: "direct-membership", grantId: "grant-1" },
    approval: { artifactId: "artifact-1", artifactDigest: "c".repeat(64), graphDigest: "d".repeat(64), runId: "run-1", workflowRevision: 7, actorId: "owner-1" },
    approvedDecision: true, creatorHasProjectAccess: true, now: Date.parse("2026-10-13T12:30:00Z") },
});

describe("current workflow E2E authority", () => {
  it("resolves graphless and graph-backed authority only from the latest canonical plan and exact owner decision", () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const artifact = { id: "plan-1", type: "plan", sha256: "a".repeat(64) };
    const decision = { decision: "APPROVE", actorId: "owner-1", actorRole: "TASK_OWNER", artifactDigest: artifact.sha256,
      workflowRevision: 7 };
    const graphless = { taskId, workflow: { e2e: { contractDigest: artifact.sha256 }, artifacts: [artifact], decisions: [decision] }, artifact,
      plan: { e2e: { schemaVersion: 1 } } };
    expect(resolveWorkflowE2ECanonicalApproval(graphless)).toEqual({ artifactId: artifact.id, artifactDigest: artifact.sha256,
      graphDigest: null, runId: null, workflowRevision: 7, actorId: "owner-1" });

    const graph = { schemaVersion: 1 as const, taskId, version: 1, items: [{ id: "22222222-2222-4222-8222-222222222222",
      title: "One item", description: "A bounded item", repository: "demo", dependsOn: [] }] };
    const graphDigest = taskGraphDigest(graph);
    const graphArtifact = { ...artifact, sha256: "b".repeat(64) };
    const graphApproval = { ...decision, artifactDigest: graphArtifact.sha256, workBreakdownDigest: graphDigest };
    const graphInput = { taskId, workflow: { e2e: { contractDigest: graphArtifact.sha256 }, artifacts: [graphArtifact], decisions: [graphApproval],
      workflowDependenciesApproval: { artifactDigest: graphArtifact.sha256, graphDigest, runId: "33333333-3333-4333-8333-333333333333",
        workflowRevision: 7, actorId: "owner-1" } }, artifact: graphArtifact, plan: { e2e: { schemaVersion: 1 }, workBreakdown: graph } };
    expect(resolveWorkflowE2ECanonicalApproval(graphInput)).toMatchObject({ graphDigest, runId: "33333333-3333-4333-8333-333333333333" });
    const earlierGraphApproval = { ...graphApproval, actorId: "earlier-owner", workflowRevision: 5 };
    const laterGraphApproval = { ...graphApproval, actorId: "later-owner", workflowRevision: 9 };
    const repeatedGraphInput = { ...graphInput, workflow: { ...graphInput.workflow, decisions: [earlierGraphApproval, laterGraphApproval],
      workflowDependenciesApproval: { ...graphInput.workflow.workflowDependenciesApproval, actorId: "later-owner", workflowRevision: 9 } } };
    expect(resolveWorkflowE2ECanonicalApproval(repeatedGraphInput)).toMatchObject({ actorId: "later-owner", workflowRevision: 9 });

    expect(resolveWorkflowE2ECanonicalApproval({ ...graphless, workflow: { ...graphless.workflow,
      e2e: { contractDigest: "f".repeat(64) } } })).toBeUndefined();
    expect(resolveWorkflowE2ECanonicalApproval({ ...graphless, workflow: { ...graphless.workflow,
      decisions: [{ ...decision, actorRole: "DEVELOPER" }] } })).toBeUndefined();
    expect(resolveWorkflowE2ECanonicalApproval({ ...graphless, workflow: { ...graphless.workflow,
      decisions: [decision, { ...decision, actorId: "other-owner" }] } })).toBeUndefined();
    expect(resolveWorkflowE2ECanonicalApproval({ ...graphless, workflow: { ...graphless.workflow, artifacts: [] } })).toBeUndefined();
    expect(resolveWorkflowE2ECanonicalApproval({ ...graphless, workflow: { ...graphless.workflow,
      decisions: [{ ...decision, decision: "REQUEST_CHANGES" }] } })).toBeUndefined();
    expect(resolveWorkflowE2ECanonicalApproval({ ...graphInput, workflow: { ...graphInput.workflow, workflowDependenciesApproval: undefined } })).toBeUndefined();
    expect(resolveWorkflowE2ECanonicalApproval({ ...graphInput, workflow: { ...graphInput.workflow,
      workflowDependenciesApproval: { ...graphInput.workflow.workflowDependenciesApproval, graphDigest: "c".repeat(64) } } })).toBeUndefined();
  });

  it("accepts only the exact still-current approved runtime snapshot", () => {
    expect(workflowE2ECurrentAuthorityMatches(authority())).toBe(true);
  });

  it("retains a locally bound channel-access proof as a distinct creator authority", () => {
    const input = authority();
    const channelProof = { kind: "channel-access", developerId: "creator-1", project: "orders", teamId: "T123",
      channelIds: ["C123"], bindings: [{ channelId: "C123", updatedAt: "2026-10-13T12:00:00.000Z" }] };
    (input.admission as { creatorAuthority: unknown }).creatorAuthority = channelProof;
    (input.current as { creatorAuthority: unknown }).creatorAuthority = structuredClone(channelProof);
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(true);
    ((((input.current as unknown as { creatorAuthority: typeof channelProof }).creatorAuthority).bindings[0]!).updatedAt) = "2026-10-13T12:01:00.000Z";
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(false);
  });

  it("binds a no-graph admission to the exact canonical owner decision without inventing graph approval", () => {
    const input = authority();
    const noGraphApproval = { artifactId: "artifact-1", artifactDigest: "c".repeat(64), graphDigest: null, runId: null,
      workflowRevision: 7, actorId: "owner-1" };
    (input.admission as { approval: unknown }).approval = noGraphApproval;
    (input.current as { approval: unknown }).approval = structuredClone(noGraphApproval);
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(true);
    (input.current as { approval: { graphDigest: string | null } }).approval.graphDigest = "d".repeat(64);
    expect(workflowE2ECurrentAuthorityMatches(input), "a current graph decision cannot replace an approved graphless plan").toBe(false);
  });

  it.each([
    ["removed canonical approval", (input: ReturnType<typeof authority>) => { input.current.approvedDecision = false; }],
    ["changed runtime binding", (input: ReturnType<typeof authority>) => { (input.current.runtime as { binding: { subnets: string[] } }).binding.subnets.reverse(); }],
    ["expired runtime", (input: ReturnType<typeof authority>) => { input.current.now = Date.parse("2026-10-13T13:00:00Z"); }],
    ["removed creator authority", (input: ReturnType<typeof authority>) => { input.current.creatorHasProjectAccess = false; }],
    ["revoked and regranted creator membership", (input: ReturnType<typeof authority>) => { input.current.creatorAuthority = { kind: "direct-membership", grantId: "grant-2" }; }],
  ])("returns false for %s", (_label, mutate) => {
    const input = authority();
    mutate(input);
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(false);
  });

  it("resolves canonical no-graph approval during recovery before later admission validation", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { e2eFeatureRuntimeCatalogId: "test-feature-catalog", projectSetupRuntimeCatalogId: "test-setup-catalog" } });
    const payments = harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    const policy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["scenario-1"],
      targets: [{ kind: "contract", targetId: "target-1", applicationId: "payments", requestedTargetId: "target-1", adapterProfileId: "synthetic",
        runtimeProfileId: "default", accountProfileId: "synthetic" }], defaultSandboxProfileId: "default", fallback: "mock-unconnected", modelRouteRevision: null,
      capture: { screenshots: false, traces: false, video: false, downloads: false },
      limits: { runTimeoutMs: 600_000, startupTimeoutMs: 30_000, preparationTimeoutMs: 30_000, caseTimeoutMs: 60_000,
        maxActionsPerCase: 1, maxModelRequests: 1, maxInputTokens: 128, maxOutputTokens: 128, maxSpendUsd: null } };
    harness.db.set({ ...payments, setupApproval: { decision: "approve", proposalRef: "test", proposalSha256: "a".repeat(64), candidateDigest: "b".repeat(64), policyDigest: "c".repeat(64) },
      definition: { ...(payments.definition as Record<string, unknown>), e2e: policy } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Exercise the approved feature intent", client: "authority-test", workflow: true, workflowPath: "QUICK",
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const creatorIdentity = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    harness.db.set({ ...creatorIdentity, entityType: "DEVELOPER" });
    const taskKey = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const task = harness.db.get(taskKey.pk, taskKey.sk)!;
    const workspaceId = String(task.workspaceId);
    const prepare = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && row.kind === "prepare")[0]!;
    await harness.finish(workspaceId, String(prepare.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const planning = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && row.workflowMode === "PLAN")[0]!;
    const noGraphIntent = { schemaVersion: 1 as const, requestedTargetIds: ["target-1"], accountContextRefs: [],
      scenarios: [{ scenarioId: "scenario-1", requirementId: "requirement-1", requestedTargetIds: ["target-1"], required: true,
        accountProfileId: "synthetic", minimumEvidence: "source" as const, requiredRealComponentIds: [], steps: [],
        assertions: [{ kind: "state" as const, probeId: "result", equals: true, pollTimeoutMs: 1 }] }], semanticExportDeltas: [] };
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: "Feature intent", claims: [{ id: "1", text: "Exercise the approved feature intent." }], e2e: noGraphIntent })));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const planned = harness.db.get(taskKey.pk, taskKey.sk)!;
    const workflow = planned.workflow as { revision: number; artifacts: Array<{ sha256: string; objectKey: string }>; decisions: unknown[]; [key: string]: unknown };
    expect(workflow.artifacts, JSON.stringify({ workflow, operations: harness.db.find((row) => row.workspaceId === workspaceId && row.entityType === "OPERATION") })).not.toHaveLength(0);
    const canonicalPlan = workflow.artifacts.at(-1)!;
    const artifactDigest = canonicalPlan.sha256;
    const decision = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approve the canonical feature intent.", artifactDigest,
    });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    const approved = harness.db.get(taskKey.pk, taskKey.sk)!;
    const approvedWorkflow = approved.workflow as { revision: number; decisions: Array<{ decision: string; artifactDigest?: string; workBreakdownDigest?: string; actorId: string; workflowRevision: number }>; [key: string]: unknown };
    expect((approvedWorkflow.e2e as { contractDigest?: string } | undefined)?.contractDigest).toBe(artifactDigest);
    expect(approvedWorkflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE", artifactDigest });
    expect(approvedWorkflow.decisions.at(-1)?.workBreakdownDigest).toBeUndefined();

    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const readyOperationId = randomUUID();
    const dispatch = (workflowDispatchItem("state", taskId, approvedWorkflow.revision, "CHECKS", candidate.digest, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item;
    dispatch.readinessOperationId = readyOperationId;
    const workflowWithCandidate = WorkflowSnapshotSchema.parse({ ...approvedWorkflow, revision: approvedWorkflow.revision + 1,
      stage: "VERIFY", state: "WAITING", candidate, e2e: { contractDigest: artifactDigest, policyDigest: "a".repeat(64), bundleDigest: "b".repeat(64),
        executionPlanDigest: "c".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } });
    const currentTask = { ...approved, workflow: workflowWithCandidate };
    harness.db.set(currentTask);
    const dispatchRevision = workflowWithCandidate.revision;
    dispatch.workflowRevision = dispatchRevision;
    dispatch.sk = `${taskId}#${dispatchRevision}`;
    dispatch.dispatchDueSk = `${String(dispatch.nextAttemptAt)}#${String(dispatch.sk)}`;
    harness.db.set(dispatch);
    const readyMarker = { purpose: "workflow-e2e-readiness", taskId, workflowRevision: dispatchRevision, candidateDigest: candidate.digest,
      dispatchSk: dispatch.sk, outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, dispatchRevision, candidate.digest), readyGeneration: 2 };
    harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${readyOperationId}`, entityType: "OPERATION", id: readyOperationId,
      workspaceId, kind: "resume", status: "SUCCEEDED", fence: 2, workflowE2EReadiness: readyMarker });
    harness.db.set({ ...workspaceSessionKey(workspaceId), workspaceId, state: "READY", generation: 2 });
    const planReadsBeforeRecovery = harness.s3.send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key: string } }).input.Key === canonicalPlan.objectKey).length;

    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });

    const planReadsAfterRecovery = harness.s3.send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key: string } }).input.Key === canonicalPlan.objectKey).length;
    expect(planReadsAfterRecovery).toBeGreaterThan(planReadsBeforeRecovery);
    expect(planReadsAfterRecovery, "recovery must resolve the canonical owner-approved no-graph plan before feature admission").toBe(planReadsBeforeRecovery + 1);
    expect(harness.db.get("WORKFLOW_DISPATCH", String(dispatch.sk))?.attempts).toBe(1);
  });

  it("retains current E2E authority conditions in the existing pull-request update acceptance transaction", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const now = "2026-10-14T12:00:00.000Z";
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const priorDigest = "f".repeat(64);
    const contractDigest = "a".repeat(64);
    const policyDigest = "b".repeat(64);
    const bundleDigest = "c".repeat(64);
    const executionPlanDigest = "d".repeat(64);
    const roundId = "33333333-3333-4333-8333-333333333333";
    const groupRunId = "44444444-4444-4444-8444-444444444444";
    const admissionSha256 = "5".repeat(64);
    const evidenceSha256 = "6".repeat(64);
    const qualifiedRound = { candidateDigest: candidate.digest, contractDigest, policyDigest, bundleDigest, executionPlanDigest,
      roundId, groupRunIds: [groupRunId], admissionSha256, evidenceSha256 };
    const workflowResult = WorkflowSnapshotSchema.safeParse({
      ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), revision: 2, stage: "PULL_REQUEST", state: "READY", candidate,
      reviewBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: workspaceId, recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: (["CRITIC", "SECURITY"] as const).map((role, index) => ({ operationId: `66666666-6666-4666-8666-66666666666${index}`, candidateDigest: candidate.digest,
        role, provider: "synthetic", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: [{ repositoryId: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headSha: "7".repeat(40), candidateDigest: priorDigest, required: true, state: "OPEN" }],
      e2e: { contractDigest, policyDigest, bundleDigest, executionPlanDigest, required: true, currentRoundId: roundId, currentGroupRunIds: [groupRunId], resultRefs: [], qualifiedRound },
    });
    if (!workflowResult.success) throw new Error(JSON.stringify(workflowResult.error.issues));
    const workflow = workflowResult.data;
    const task = { taskId, workspaceId, ownerKey: "owner", developerId: "7".repeat(64), provider: "slack", developerName: "Owner", client: "test", workflow };
    const currentAuthorityCheck = { ConditionCheck: { TableName: "state", Key: { pk: "WORKFLOW_E2E#task", sk: "AUTHORITY" },
      ConditionExpression: "grantId = :admittedGrant", ExpressionAttributeValues: { ":admittedGrant": "grant-1" } } };
    let acceptedTransaction: unknown[] | undefined;
    const operationId = "55555555-5555-4555-8555-555555555555";
    const deps = {
      documentClient: { send: async () => ({ Item: task }) }, tableName: "state", now: () => Date.parse(now), issuer: undefined,
      workflowE2EPresentation: async () => ({ shared: { e2e: { status: "PASS" } } }),
      workflowE2EPublicationChecks: async () => [currentAuthorityCheck],
      actions: {
        turnRecordsTableName: "turns", operations: async () => [], workspace: async () => ({ status: "READY" }), failedPublications: async () => 0,
        acceptPullRequestUpdate: async (...args: unknown[]) => {
          const buildTransaction = args[3] as (operation: { id: string }) => unknown[];
          acceptedTransaction = buildTransaction({ id: operationId });
          return { operation: { id: operationId }, duplicate: false };
        },
      },
    };
    await expect(startTaskWorkflowPublicationFromSystem(deps as never, taskId, { workflowRevision: workflow.revision, candidateDigest: candidate.digest },
      { ownerAccess: { peopleRevision: 1 } })).resolves.toBe("STARTED");
    expect(acceptedTransaction).toContainEqual(currentAuthorityCheck);
  });
});
