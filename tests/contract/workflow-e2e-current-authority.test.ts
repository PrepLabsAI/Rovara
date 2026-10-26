import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalPlanJson, createCandidateManifest, createWorkflowSnapshot, DeveloperTaskViewSchema, E2ESharedViewSchema, portableOperationId, taskGraphDigest, workspaceSessionKey, workflowRequestId, WorkflowSnapshotSchema } from "@agentx/contracts";
import { getTaskDocumentView, startTaskWorkflowPublicationFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { e2eFeatureVerifierKey, E2E_FEATURE_PROCESS_RESPONSE_SCOPE } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { projectSetupBindingDigest } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";
import { createWorkflowE2EDisplayObject } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { resolveWorkflowE2ECanonicalApproval, workflowE2ECurrentAuthorityMatches } from "../../packages/broker/src/aws/workflow-e2e-current-authority.js";
import { createSingleAnswerPlanBroker, MAYA, OMAR } from "../support/developer-task-broker.js";
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
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { e2eFeatureRuntimeCatalogId: "test-feature-catalog", projectSetupRuntimeCatalogId: "test-setup-catalog" } });
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
    const badOperationId = portableOperationId(".", "invented-payments-app");
    const noGraphIntent = { schemaVersion: 1 as const, requestedTargetIds: ["target-1"], accountContextRefs: [],
      portableOperationRefs: [{ operationId: badOperationId, applicationId: "payments", requestedTargetIds: ["target-1"],
        packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named" as const, exportName: "renderOrders" } }],
      scenarios: [{ scenarioId: "scenario-1", requirementId: "requirement-1", requestedTargetIds: ["target-1"], required: true,
        accountProfileId: "synthetic", minimumEvidence: "source" as const, requiredRealComponentIds: [],
        steps: [{ kind: "invoke-contract" as const, operationId: badOperationId, input: {} }],
        assertions: [{ kind: "state" as const, probeId: "result", equals: true, pollTimeoutMs: 1 }] }], semanticExportDeltas: [] };
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: "Feature intent", claims: [{ id: "1", text: "Exercise the approved feature intent." }], e2e: noGraphIntent })));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const planned = harness.db.get(taskKey.pk, taskKey.sk)!;
    const workflow = WorkflowSnapshotSchema.parse(planned.workflow);
    expect(workflow.artifacts, JSON.stringify({ workflow, operations: harness.db.find((row) => row.workspaceId === workspaceId && row.entityType === "OPERATION") })).not.toHaveLength(0);
    const canonicalPlan = workflow.artifacts.at(-1)!;
    const artifactDigest = canonicalPlan.sha256;
    const decision = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approve the canonical feature intent.", artifactDigest,
    });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    const approved = harness.db.get(taskKey.pk, taskKey.sk)!;
    const approvedWorkflow = WorkflowSnapshotSchema.parse(approved.workflow);
    expect(approvedWorkflow.e2e?.contractDigest).toBe(artifactDigest);
    expect(approvedWorkflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE", artifactDigest });
    expect(approvedWorkflow.decisions.at(-1)?.workBreakdownDigest).toBeUndefined();

    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const manifest = Buffer.from(JSON.stringify({ name: "payments", type: "module", exports: { ".": "./src/index.mjs" } }));
    const moduleBytes = Buffer.from("export function renderOrders(input) { return input; }\n");
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const treePaths = ["package.json", "src/index.mjs"];
    const sourceExport = Buffer.from(JSON.stringify({ schemaVersion: "workflow-candidate-source/v1", candidate, repositories: [{
      repositoryId: "demo", commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha,
      baseCommitSha: candidate.repositories[0]!.baseCommitSha, treeComplete: true, treePaths,
      sources: [{ path: "package.json", sha256: sha(manifest), bytesBase64: manifest.toString("base64"), kind: "blob" },
        { path: "src/index.mjs", sha256: sha(moduleBytes), bytesBase64: moduleBytes.toString("base64"), kind: "blob" }],
    }] }));
    const sourceKey = `workflow-candidate-sources/sha256/${sha(sourceExport)}.json`;
    harness.s3.objects.set(sourceKey, sourceExport.toString("utf8"));
    const implementation = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && row.workflowMode === "IMPLEMENT")[0]!;
    harness.db.set({ ...implementation,
      candidateSourceRef: { key: sourceKey, sha256: sha(sourceExport), byteLength: sourceExport.byteLength, candidateDigest: candidate.digest } });
    await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
      workflowCheckCandidateRepositories: candidate.repositories,
      checks: { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [
        { id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }],
        extraTry: "not_needed", agentClaim: "success" } } });
    const readinessOperation = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId
      && row.workflowE2EReadiness !== undefined).at(-1);
    if (readinessOperation === undefined) throw new Error("the implementation callback did not enqueue E2E readiness");
    await harness.finish(workspaceId, String(readinessOperation.id), "SUCCEEDED", { result: {} });
    const readyWorkspace = harness.db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(readyWorkspace).toMatchObject({ status: "READY" });
    expect(readyWorkspace?.activeOperationId).toBeUndefined();
    const completedImplementation = harness.db.get(taskKey.pk, taskKey.sk)!;
    const completedWorkflow = WorkflowSnapshotSchema.parse(completedImplementation.workflow);
    expect(completedWorkflow).toMatchObject({ stage: "VERIFY", state: "WAITING", candidate: { digest: candidate.digest } });
    const projectRuntimeBinding = (harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0] as { runtimeBinding: Record<string, unknown> }).runtimeBinding;
    const runtimeCatalogId = "test-feature-catalog";
    const runtimeProfileId = "default";
    const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
    const runnerToolchain = { execPath: process.execPath, version: "v22.23.2", platform: process.platform, arch: process.arch };
    const runtimeKey = e2eFeatureVerifierKey(runtimeCatalogId, runtimeProfileId);
    harness.db.set({ ...runtimeKey, schemaVersion: 1, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId, catalogRevision: 1, profileId: runtimeProfileId,
      bindingDigest: projectSetupBindingDigest(projectRuntimeBinding as never), binding: projectRuntimeBinding, manifestDigest: "f".repeat(64),
      runnerEnvironment, runnerEnvironmentDigest: sha(Buffer.from(canonicalJson(runnerEnvironment))), runnerToolchain,
      runnerToolchainDigest: sha(Buffer.from(canonicalJson(runnerToolchain))), endpoint: "http://127.0.0.1:8080", generation: 1,
      transportCorrelationId: randomUUID(), supportedFeatureScopes: [E2E_FEATURE_PROCESS_RESPONSE_SCOPE], state: "READY",
      qualifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    const readyOperationId = randomUUID();
    const dispatch = (workflowDispatchItem("state", taskId, completedWorkflow.revision, "CHECKS", candidate.digest, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item;
    dispatch.readinessOperationId = readyOperationId;
    const workflowWithCandidate = WorkflowSnapshotSchema.parse({ ...completedWorkflow, revision: completedWorkflow.revision + 1,
      stage: "VERIFY", state: "WAITING", candidate, e2e: { contractDigest: artifactDigest, policyDigest: "a".repeat(64), bundleDigest: "b".repeat(64),
        executionPlanDigest: "c".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } });
    const currentTask = { ...completedImplementation, workflow: workflowWithCandidate };
    harness.db.set(currentTask);
    const dispatchRevision = workflowWithCandidate.revision;
    dispatch.workflowRevision = dispatchRevision;
    dispatch.sk = `${taskId}#${dispatchRevision}`;
    dispatch.dispatchDueSk = `${String(dispatch.nextAttemptAt)}#${String(dispatch.sk)}`;
    harness.db.set(dispatch);
    const readyMarker = { purpose: "workflow-e2e-readiness", taskId, workflowRevision: dispatchRevision, candidateDigest: candidate.digest,
      dispatchSk: dispatch.sk, outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, dispatchRevision, candidate.digest), readyGeneration: 2 };
    harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${readyOperationId}`, entityType: "OPERATION", id: readyOperationId,
      workspaceId, kind: "resume", status: "SUCCEEDED", fence: 2, requestId: readyOperationId, payloadHash: "a".repeat(64),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workflowE2EReadiness: readyMarker });
    harness.db.set({ ...workspaceSessionKey(workspaceId), workspaceId, state: "READY", generation: 2 });
    const planReadsBeforeRecovery = harness.s3.send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key: string } }).input.Key === canonicalPlan.objectKey).length;

    const sourceBytes = harness.s3.objects.get(sourceKey)!;
    harness.s3.objects.delete(sourceKey);
    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    const retriedDispatch = harness.db.get("WORKFLOW_DISPATCH", String(dispatch.sk));
    expect(retriedDispatch).toMatchObject({ attempts: 1, kind: "CHECKS" });
    expect(harness.db.get(taskKey.pk, taskKey.sk)!.workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    harness.s3.objects.set(sourceKey, sourceBytes);
    const dueAgain = new Date(Date.now() - 1_000).toISOString();
    harness.db.set({ ...retriedDispatch, nextAttemptAt: dueAgain, dispatchDueSk: `${dueAgain}#${String(dispatch.sk)}` });
    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });

    const planReadsAfterRecovery = harness.s3.send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key: string } }).input.Key === canonicalPlan.objectKey).length;
    expect(planReadsAfterRecovery).toBeGreaterThan(planReadsBeforeRecovery);
    expect(planReadsAfterRecovery, "each recovery attempt resolves the canonical owner-approved plan before admission").toBe(planReadsBeforeRecovery + 2);
    expect(harness.s3.send.mock.calls.some(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key: string } }).input.Key === sourceKey), "recovery must verify the protected candidate source export before resolving its operation references").toBe(true);
    const recoveredTask = harness.db.get(taskKey.pk, taskKey.sk)!;
    const recoveredWorkflow = WorkflowSnapshotSchema.parse(recoveredTask.workflow);
    expect(recoveredWorkflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(recoveredWorkflow.e2e).toBeUndefined();
    expect(recoveredWorkflow.blockReason).toContain("protected candidate");
    const correctionMarker = recoveredTask.e2ePlanCorrection as { artifactId: string; artifactSha256: string; candidateDigest: string; requiredE2E: true };
    expect(correctionMarker.artifactId).toBe(canonicalPlan.id);
    expect(correctionMarker.artifactSha256).toBe(artifactDigest);
    expect(correctionMarker.candidateDigest).toBe(candidate.digest);
    expect(correctionMarker.requiredE2E).toBe(true);
    expect(recoveredWorkflow.decisions).toHaveLength(1);
    expect(harness.db.get("WORKFLOW_DISPATCH", String(dispatch.sk))).toBeUndefined();
    const correctionMessage = workflowMessage({ taskId, workflow: recoveredWorkflow, taskPageUrl: "https://agentx.invalid/task" });
    expect(correctionMessage?.text).toContain("needs changes before approval");
    expect(correctionMessage?.text).toContain("protected candidate");
    expect(JSON.stringify(correctionMessage?.blocks)).toContain("Request changes");
    expect(JSON.stringify(correctionMessage?.blocks)).not.toContain("Approve plan");
    const revisedPlanMessage = workflowMessage({ taskId, workflow: { ...recoveredWorkflow, blockReason: undefined } });
    expect(revisedPlanMessage?.text).toContain("existing candidate is retained");
    expect(revisedPlanMessage?.text).not.toContain("No code has changed yet");

    const refused = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: recoveredWorkflow.revision, decision: "APPROVE", reason: "Approve unchanged plan.", artifactDigest,
    });
    expect(refused.status).toBe(400);
    expect(WorkflowSnapshotSchema.parse(harness.db.get(taskKey.pk, taskKey.sk)?.workflow).revision).toBe(recoveredWorkflow.revision);
    expect((refused.body as { error?: { message?: string } }).error?.message).toContain("request changes and submit a corrected plan");
    const sameDigestNewArtifact = { ...recoveredTask, workflow: { ...recoveredWorkflow,
      artifacts: recoveredWorkflow.artifacts.map((item) => item.id === canonicalPlan.id ? { ...item, id: randomUUID() } : item) } };
    harness.db.set(sameDigestNewArtifact);
    const sameDigestApproval = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: recoveredWorkflow.revision, decision: "APPROVE", reason: "Approve altered artifact identity.", artifactDigest,
    });
    expect(sameDigestApproval.status).toBe(400);
    expect((sameDigestApproval.body as { error?: { message?: string } }).error?.message).toContain("source reference failed protected-candidate validation");
    const noE2EPlanId = randomUUID();
    const noE2EPlanBytes = Buffer.from(canonicalPlanJson(planDocument({ title: "Dropped E2E intent", claims: [{ id: "1", text: "Try to drop the required intent." }] })));
    const noE2EPlanSha = createHash("sha256").update(noE2EPlanBytes).digest("hex");
    const noE2EPlanKey = `private/${String(recoveredTask.ownerKey)}/${workspaceId}/plan-documents/${noE2EPlanId}.json`;
    harness.s3.objects.set(noE2EPlanKey, noE2EPlanBytes.toString("utf8"));
    const noE2EArtifact = { id: noE2EPlanId, type: "plan" as const, version: 2, sha256: noE2EPlanSha,
      producer: "agentx-worker-untrusted" as const, objectKey: noE2EPlanKey, createdAt: new Date().toISOString(), format: "structured" as const };
    const noE2EPlanTask = { ...sameDigestNewArtifact, workflow: { ...sameDigestNewArtifact.workflow,
      artifacts: [...sameDigestNewArtifact.workflow.artifacts, noE2EArtifact] } };
    harness.db.set(noE2EPlanTask);
    const droppedE2EApproval = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: recoveredWorkflow.revision, decision: "APPROVE", reason: "Drop required E2E.", artifactDigest: noE2EPlanSha,
    });
    expect(droppedE2EApproval.status).toBe(400);
    expect((droppedE2EApproval.body as { error?: { message?: string } }).error?.message).toContain("must retain the required feature E2E intent");

    harness.db.set(recoveredTask);
    const planPage = await getTaskDocumentView({ documentClient: harness.db, tableName: "state", actions: harness.actions, log: () => undefined,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }),
      projectChannelIds: async () => [], now: () => Date.now() }, { developerId: MAYA.developerId } as never, taskId);
    expect(planPage).toMatchObject({ status: "The E2E plan needs correction", nextStep: expect.stringContaining("Request changes") as unknown });
    expect(planPage.nextStep).not.toContain("Approve");
    const requestedChanges = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: recoveredWorkflow.revision, decision: "REQUEST_CHANGES",
      reason: "Use the operation exported by the protected candidate.", artifactDigest,
    });
    expect(requestedChanges.status, JSON.stringify(requestedChanges.body)).toBe(200);
    const correctionPlanning = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId
      && row.workflowMode === "PLAN").at(-1)!;
    expect(harness.db.get(taskKey.pk, taskKey.sk)!.e2ePlanCorrection).toBeDefined();
    const validOperationId = portableOperationId(".", "payments");
    const correctedIntent = { ...noGraphIntent,
      portableOperationRefs: noGraphIntent.portableOperationRefs.map((reference) => ({ ...reference, operationId: validOperationId })),
      scenarios: noGraphIntent.scenarios.map((scenario) => ({ ...scenario,
        steps: scenario.steps.map((step) => step.kind === "invoke-contract" ? { ...step, operationId: validOperationId } : step) })) };
    const correctedPlan = planDocument({ title: "Corrected feature intent", claims: [{ id: "1", text: "Use the protected exported operation." }], e2e: correctedIntent });
    await harness.artifact(workspaceId, String(correctionPlanning.id), "plan.md", planAnswer(correctedPlan));
    await harness.finish(workspaceId, String(correctionPlanning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const readyCorrectedTask = harness.db.get(taskKey.pk, taskKey.sk)!;
    const readyCorrectedWorkflow = WorkflowSnapshotSchema.parse(readyCorrectedTask.workflow);
    expect(readyCorrectedWorkflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(readyCorrectedTask.e2ePlanCorrection).toBeDefined();
    expect(readyCorrectedWorkflow.blockReason).toBeUndefined();
    const correctedArtifact = readyCorrectedWorkflow.artifacts.filter((item) => item.type === "plan").at(-1)!;
    const freshApproval = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: readyCorrectedWorkflow.revision, decision: "APPROVE",
      reason: "Approve the corrected source-bound E2E plan.", artifactDigest: correctedArtifact.sha256,
    });
    expect(freshApproval.status, JSON.stringify(freshApproval.body)).toBe(200);
    const freshlyApprovedTask = harness.db.get(taskKey.pk, taskKey.sk)!;
    expect(freshlyApprovedTask.e2ePlanCorrection).toBeUndefined();
    expect(WorkflowSnapshotSchema.parse(freshlyApprovedTask.workflow)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", e2e: { required: true } });

    const historyIdentity = { candidateDigest: candidate.digest, roundId: randomUUID(), groupRunIds: [randomUUID()],
      admissionSha256: "7".repeat(64), evidenceSha256: "8".repeat(64) };
    const recordedView = E2ESharedViewSchema.parse({ schemaVersion: 1,
      setup: { status: "unavailable", selectedTargetIds: [], executionPlanDigest: "c".repeat(64), blockingInputIds: [], mockSubstitutableInputIds: [] },
      e2e: { status: "FAILED", label: "Recorded result failed", executionPlanDigest: "c".repeat(64), expectedGroups: 1,
        receivedGroups: 1, executedCases: 3, qualifiedCriteria: 0, requiredCriteria: 1, unavailableCriteria: 0,
        optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [],
        policyPresence: "present", workflowPhase: "e2e", requiredUnexercisedCriteriaIds: ["criterion-1"] }, actions: [] });
    const display = createWorkflowE2EDisplayObject({ ownerKey: String(recoveredTask.ownerKey), workspaceId, view: recordedView,
      capturedAt: "2026-10-17T13:00:00.000Z", current: historyIdentity });
    expect(display).toBeDefined();
    harness.s3.objects.set(display!.ref.key, Buffer.from(display!.bytes).toString("utf8"));
    const closedWorkflow = { ...workflowWithCandidate, stage: "IMPLEMENT" as const, state: "BLOCKED" as const,
      e2e: { ...workflowWithCandidate.e2e!, currentRoundId: historyIdentity.roundId, currentGroupRunIds: historyIdentity.groupRunIds,
        failedRound: { status: "FAILED" as const, ...historyIdentity }, displayRef: display!.ref } };
    harness.db.set({ ...recoveredTask, closedAt: "2026-10-17T13:01:00.000Z", workflow: closedWorkflow });
    const privateReadsBeforeUnauthorized = harness.s3.send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key?: string } }).input.Key?.includes("workflow-e2e-display")).length;
    const unauthorized = await harness.dev(OMAR, "GET", `/v1/dev/tasks/${taskId}`);
    expect(unauthorized.status).toBe(404);
    expect(harness.s3.send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand"
      && (command as unknown as { input: { Key?: string } }).input.Key?.includes("workflow-e2e-display")).length).toBe(privateReadsBeforeUnauthorized);
    const closedViewResponse = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(closedViewResponse.status, JSON.stringify(closedViewResponse.body)).toBe(200);
    const closedView = DeveloperTaskViewSchema.parse(closedViewResponse.body.task);
    expect(closedView.e2ePresentation?.shared.e2e).toMatchObject({ status: "UNKNOWN", label: "Current eligibility unavailable: task closed." });
    expect(closedView.e2ePresentation?.shared.actions).toEqual([]);
    expect(closedView.e2ePresentation?.mcp.view.e2e.status).toBe("UNKNOWN");
    expect(closedView.e2ePresentation?.mcp.scope).toContain("historical FAILED");
    expect(closedView.e2ePresentation?.pageHtml).toContain("Recorded historical E2E result");
    expect(closedView.e2ePresentation?.pageHtml).toContain("Cases executed</dt><dd>3</dd>");
    expect(JSON.stringify(closedView.e2ePresentation?.slackBlocks)).toContain("Captured groups 1/1 · cases 3");

    const passIdentity = { ...historyIdentity, roundId: randomUUID(), groupRunIds: [randomUUID()] };
    const recordedPass = E2ESharedViewSchema.parse({ ...recordedView, e2e: { ...recordedView.e2e, status: "PASS", label: "Recorded result passed",
      qualifiedCriteria: 1, requiredUnexercisedCriteriaIds: [] } });
    const passDisplay = createWorkflowE2EDisplayObject({ ownerKey: String(recoveredTask.ownerKey), workspaceId, view: recordedPass,
      capturedAt: "2026-10-17T13:00:00.000Z", current: passIdentity });
    expect(passDisplay).toBeDefined();
    harness.s3.objects.set(passDisplay!.ref.key, Buffer.from(passDisplay!.bytes).toString("utf8"));
    const passProgress = workflowWithCandidate.e2e!;
    const qualifiedWorkflow = { ...workflowWithCandidate, verification: { candidateDigest: candidate.digest, producer: "test", environmentId: "test",
      recordedAt: "2026-10-17T12:59:00.000Z", results: [{ checkId: "required-1", status: "PASS" as const }] },
      e2e: { ...passProgress, currentRoundId: passIdentity.roundId, currentGroupRunIds: passIdentity.groupRunIds, qualifiedRound: {
        contractDigest: passProgress.contractDigest, policyDigest: passProgress.policyDigest,
        bundleDigest: passProgress.bundleDigest, executionPlanDigest: passProgress.executionPlanDigest, ...passIdentity }, displayRef: passDisplay!.ref } };
    harness.db.set({ ...recoveredTask, closedAt: "2026-10-17T13:01:00.000Z", workflow: qualifiedWorkflow });
    const qualifiedClosedResponse = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    const qualifiedClosed = DeveloperTaskViewSchema.parse(qualifiedClosedResponse.body.task);
    expect(qualifiedClosed.e2ePresentation?.shared.e2e.status).toBe("UNKNOWN");
    expect(qualifiedClosed.e2ePresentation?.mcp.scope).toContain("historical PASS");
    expect(qualifiedClosed.e2ePresentation?.mcp.scope).toContain("cases 3");

    harness.s3.objects.set(passDisplay!.ref.key, "corrupt bytes");
    const corruptHistory = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    const corruptPresentation = DeveloperTaskViewSchema.parse(corruptHistory.body.task).e2ePresentation!;
    expect(corruptPresentation.shared.e2e.status).toBe("UNKNOWN");
    expect(corruptPresentation.mcp.scope).toContain("No verified historical E2E display is available");
    expect(corruptPresentation.pageHtml).not.toContain("Recorded historical E2E result");
    harness.s3.objects.delete(passDisplay!.ref.key);
    const missingHistory = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(DeveloperTaskViewSchema.parse(missingHistory.body.task).e2ePresentation?.mcp.scope).toContain("No verified historical E2E display is available");
    harness.s3.objects.set(passDisplay!.ref.key, Buffer.from(passDisplay!.bytes).toString("utf8"));
    const mismatchedRef = { ...passDisplay!.ref, candidateDigest: "f".repeat(64) };
    harness.db.set({ ...recoveredTask, closedAt: "2026-10-17T13:01:00.000Z",
      workflow: { ...qualifiedWorkflow, e2e: { ...qualifiedWorkflow.e2e, displayRef: mismatchedRef } } });
    const mismatchedHistory = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(DeveloperTaskViewSchema.parse(mismatchedHistory.body.task).e2ePresentation?.mcp.scope).toContain("No verified historical E2E display is available");
    const unknownDisplay = createWorkflowE2EDisplayObject({ ownerKey: String(recoveredTask.ownerKey), workspaceId,
      view: E2ESharedViewSchema.parse({ ...recordedPass, e2e: { ...recordedPass.e2e, status: "UNKNOWN", label: "Recorded eligibility unknown" } }),
      capturedAt: "2026-10-17T13:00:00.000Z", current: passIdentity });
    expect(unknownDisplay).toBeDefined();
    harness.s3.objects.set(unknownDisplay!.ref.key, Buffer.from(unknownDisplay!.bytes).toString("utf8"));
    harness.db.set({ ...recoveredTask, closedAt: "2026-10-17T13:01:00.000Z",
      workflow: { ...qualifiedWorkflow, e2e: { ...qualifiedWorkflow.e2e, displayRef: unknownDisplay!.ref } } });
    const unknownHistory = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(DeveloperTaskViewSchema.parse(unknownHistory.body.task).e2ePresentation?.mcp.scope).toContain("No verified historical E2E display is available");
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
