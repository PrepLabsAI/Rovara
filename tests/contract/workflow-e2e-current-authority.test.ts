import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema } from "@agentx/contracts";
import { startTaskWorkflowPublicationFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { workflowE2ECurrentAuthorityMatches } from "../../packages/broker/src/aws/workflow-e2e-current-authority.js";

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
