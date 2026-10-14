import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readWorkflowE2ENotifierProjection, workflowE2EDisplayRef } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { handler as notifierLambdaHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";

const current = { candidateDigest: "a".repeat(64), roundId: "11111111-1111-4111-8111-111111111111",
  groupRunIds: ["22222222-2222-4222-8222-222222222222"], admissionSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) };
const view = { schemaVersion: 1 as const, displaySchemaVersion: 1 as const, ...current,
  setup: { status: "unavailable" as const, selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] },
  e2e: { status: "UNKNOWN" as const, label: "Checks incomplete", executionPlanDigest: "d".repeat(64), expectedGroups: 1, receivedGroups: 1,
    executedCases: 6, qualifiedCriteria: 0, requiredCriteria: 7, unavailableCriteria: 7, optionalUnavailableCriteria: 0,
    mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: "present" as const,
    workflowPhase: "VERIFY", requiredUnexercisedCriteriaIds: ["browser"] }, actions: [] };
const bytes = Buffer.from(JSON.stringify(view));
const ref = { schemaVersion: 1, key: `private/owner/workspace/workflow-e2e-display/${createHash("sha256").update(bytes).digest("hex")}.json`,
  sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, ...current };

describe("notifier E2E display projection", () => {
  it("initializes the actual notifier Lambda entry with its configured environment and no broker GitHub secret", async () => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("STATE_TABLE_NAME", "synthetic-state");
    vi.stubEnv("ARTIFACT_BUCKET_NAME", "synthetic-artifacts");
    vi.stubEnv("NOTICE_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/111122223333/synthetic-notices");
    vi.stubEnv("SLACK_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:111122223333:secret:synthetic-slack");
    vi.stubEnv("AGENTX_METRICS_NAMESPACE", "synthetic-metrics");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_SECRET_ARN", "");
    try {
      await expect(notifierLambdaHandler({ Records: [] })).resolves.toEqual({ batchItemFailures: [] });
    } finally { vi.unstubAllEnvs(); }
  });

  it("reads an exact current content-addressed display object without granting it qualification authority", async () => {
    const loaded = await readWorkflowE2ENotifierProjection({ ref, ownerKey: "owner", workspaceId: "workspace", current,
      readPrivateObject: async (key, max) => key === ref.key && max === bytes.byteLength ? bytes : undefined });
    expect(loaded?.e2e.status).toBe("UNKNOWN");
    expect(loaded?.e2e.executedCases).toBe(6);
    expect(loaded?.e2e.requiredUnexercisedCriteriaIds).toEqual(["browser"]);
  });

  it("rejects a stale round before reading private data", async () => {
    let reads = 0;
    const loaded = await readWorkflowE2ENotifierProjection({ ref, ownerKey: "owner", workspaceId: "workspace", current: { ...current, roundId: "22222222-2222-4222-8222-222222222222" },
      readPrivateObject: async () => { reads += 1; return bytes; } });
    expect(loaded).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("rejects changed object bytes and an out-of-prefix key", async () => {
    const changed = Uint8Array.from([...bytes, 0]);
    expect(await readWorkflowE2ENotifierProjection({ ref, ownerKey: "owner", workspaceId: "workspace", current, readPrivateObject: async () => changed })).toBeUndefined();
    const escaped = await readWorkflowE2ENotifierProjection({ ref: { ...ref, key: "workflow-e2e-evidence/sha256/" + "a".repeat(64) + ".json" }, ownerKey: "owner", workspaceId: "workspace", current,
      readPrivateObject: async () => bytes });
    expect(escaped).toBeUndefined();
  });

  it("creates a bounded ref under the notifier's existing private namespace", () => {
    expect(workflowE2EDisplayRef({ ...current, ownerKey: "owner", workspaceId: "workspace", bytes }).key)
      .toMatch(/^private\/owner\/workspace\/workflow-e2e-display\/[a-f0-9]{64}\.json$/u);
  });
});
