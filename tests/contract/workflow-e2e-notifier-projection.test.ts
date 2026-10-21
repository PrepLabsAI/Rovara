import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowE2EDisplayObject, readWorkflowE2ENotifierProjection, workflowE2EDisplayRef } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { handler as notifierLambdaHandler, workflowE2ENotifierBlocks } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { renderE2ENotifierSlackBlocks } from "../../packages/broker/src/e2e-presentation.js";
import { failedBaseline, failedViewerRow, results, row } from "../support/e2e-scenario-results.js";

const current = { candidateDigest: "a".repeat(64), roundId: "11111111-1111-4111-8111-111111111111",
  groupRunIds: ["22222222-2222-4222-8222-222222222222"], admissionSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) };
const view = { schemaVersion: 1 as const, displaySchemaVersion: 1 as const, ...current,
  setup: { status: "unavailable" as const, selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] },
  e2e: { status: "UNKNOWN" as const, label: "Checks incomplete", executionPlanDigest: "d".repeat(64), expectedGroups: 1, receivedGroups: 1,
    executedCases: 6, qualifiedCriteria: 0, requiredCriteria: 7, unavailableCriteria: 7, optionalUnavailableCriteria: 0,
    mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: "present" as const,
    workflowPhase: "VERIFY", requiredUnexercisedCriteriaIds: ["browser"] }, actions: [] };
const capturedAt = "2026-10-14T12:00:00.000Z";
const bytes = Buffer.from(JSON.stringify({ ...view, capturedAt }));
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
    expect(loaded?.view.e2e.status).toBe("UNKNOWN");
    expect(loaded?.view.e2e.executedCases).toBe(6);
    expect(loaded?.view.e2e.requiredUnexercisedCriteriaIds).toEqual(["browser"]);
    expect(loaded?.capturedAt).toBe(capturedAt);
  });

  it("labels a retained PASS as a captured observation and current readiness as unknown", () => {
    const passView = { ...view, e2e: { ...view.e2e, status: "PASS" as const, label: "Portable checks passed" } };
    const blocks = renderE2ENotifierSlackBlocks(passView, { candidateDigest: current.candidateDigest, roundId: current.roundId, capturedAt }, "https://agentx.test/tasks/task-1");
    const text = blocks.map((block) => block.text.text).join("\n");
    expect(text).toContain("Captured portable source/mock observations: PASS");
    expect(text).toContain(current.candidateDigest);
    expect(text).toContain(current.roundId);
    expect(text).toContain(capturedAt);
    expect(text).toContain("Current readiness is UNKNOWN");
    expect(text).toContain("was not rechecked in this notification");
    expect(text).toContain("Open the task for current status");
    expect(text).toContain("Portable source and mock checks are scoped evidence");
    expect(text).toContain("unmet required browser");
    expect(text).not.toContain("advisory owner proposals");
    expect(text).not.toMatch(/\*E2E PASS:/u);
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

  it("rejects legacy display bytes without their captured time", async () => {
    const legacy = Buffer.from(JSON.stringify(view));
    const loaded = await readWorkflowE2ENotifierProjection({ ref: { ...ref, sha256: createHash("sha256").update(legacy).digest("hex"),
      key: `private/owner/workspace/workflow-e2e-display/${createHash("sha256").update(legacy).digest("hex")}.json`, byteLength: legacy.byteLength },
    ownerKey: "owner", workspaceId: "workspace", current, readPrivateObject: async () => legacy });
    expect(loaded).toBeUndefined();
  });

  it("creates a bounded ref under the notifier's existing private namespace", () => {
    expect(workflowE2EDisplayRef({ ...current, ownerKey: "owner", workspaceId: "workspace", bytes }).key)
      .toMatch(/^private\/owner\/workspace\/workflow-e2e-display\/[a-f0-9]{64}\.json$/u);
  });

  describe("display schema v2 (M1.3 Task 3.7: one row per scenario)", () => {
    const owner = { ownerKey: "owner", workspaceId: "workspace" };
    const shared = { schemaVersion: 1 as const, setup: view.setup, e2e: view.e2e, actions: view.actions };
    const capturedAtV2 = "2026-10-21T12:00:00.000Z";
    const readerOf = (bytes: Uint8Array) => async (key: string, max: number) => (key.startsWith("private/owner/workspace/workflow-e2e-display/") && bytes.byteLength <= max ? bytes : undefined);
    const make = (scenarioResults = results({ baseline: failedBaseline() })) => {
      const object = createWorkflowE2EDisplayObject({ ...owner, view: shared, capturedAt: capturedAtV2, current, scenarioResults })!;
      return { ...object, parsed: JSON.parse(Buffer.from(object.bytes).toString("utf8")) as Record<string, unknown> };
    };

    it("writes displaySchemaVersion 2 with the rows and the baseline, and the current reader reads them back", async () => {
      const made = make();
      expect(made.parsed.displaySchemaVersion).toBe(2);
      const loaded = await readWorkflowE2ENotifierProjection({ ref: made.ref, ...owner, current, readPrivateObject: readerOf(made.bytes) });
      expect(loaded?.scenarioResults?.scenarios.map((item) => item.scenarioId)).toEqual(results().scenarios.map((item) => item.scenarioId));
      expect(loaded?.scenarioResults?.baseline?.status).toBe("FAILED");
      expect(loaded?.view.e2e.status).toBe("UNKNOWN");
    });

    it("still writes displaySchemaVersion 1 for a round with no scenario rows, which any reader reads", async () => {
      const object = createWorkflowE2EDisplayObject({ ...owner, view: shared, capturedAt: capturedAtV2, current })!;
      expect((JSON.parse(Buffer.from(object.bytes).toString("utf8")) as { displaySchemaVersion: number }).displaySchemaVersion).toBe(1);
      const stale = await readWorkflowE2ENotifierProjection({ ref: object.ref, ...owner, current, maxDisplaySchemaVersion: 1, readPrivateObject: readerOf(object.bytes) });
      expect(stale?.view.e2e.status).toBe("UNKNOWN");
      expect(stale?.scenarioResults).toBeUndefined();
    });

    it("is not read at all by a reader that knows only version 1: it gets nothing, never a verdict", async () => {
      const made = make();
      expect(await readWorkflowE2ENotifierProjection({ ref: made.ref, ...owner, current, maxDisplaySchemaVersion: 1, readPrivateObject: readerOf(made.bytes) })).toBeUndefined();
    });

    it("the notifier built for v2 shows the failure in the words of the row, with the counts, what was mocked, the baseline and the page", async () => {
      const made = make();
      const task = { taskId: "11111111-1111-4111-8111-111111111111", ...owner, workflow: { candidate: { digest: current.candidateDigest }, e2e: { currentRoundId: current.roundId,
        currentGroupRunIds: current.groupRunIds, displayRef: made.ref } } };
      const blocks = (await workflowE2ENotifierBlocks({ task: task as never, readPrivateObject: readerOf(made.bytes), taskPageUrl: "https://agentx.test/review/11111111-1111-4111-8111-111111111111/task" }))!;
      const text = blocks.map((block) => JSON.stringify(block)).join("\n");
      expect(text).toContain("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
      expect(text).toContain("Viewer can't export — failed: expected hidden, was visible (orders-viewer)");
      expect(text).toContain("Mocked: inventory-v1");
      expect(text).toContain("Before the change: 2 of 5 failed, as expected for new behaviour.");
      expect(text).toContain("https://agentx.test/review/11111111-1111-4111-8111-111111111111/task");
      expect(text).not.toContain("Captured portable source/mock observations");
    });

    it("the extra-order defect reads 'Owner export — failed: expected 2 rows, received 3'", async () => {
      const made = make({ scenarios: [row({ status: "FAILED", reason: "expected 2 rows, received 3", failedAssertion: { kind: "csv", expected: "2 rows", actual: "3 rows; row 3: a3,Lin,99,ready" } })] });
      const task = { taskId: "11111111-1111-4111-8111-111111111111", ...owner, workflow: { candidate: { digest: current.candidateDigest }, e2e: { currentRoundId: current.roundId,
        currentGroupRunIds: current.groupRunIds, displayRef: made.ref } } };
      const text = JSON.stringify(await workflowE2ENotifierBlocks({ task: task as never, readPrivateObject: readerOf(made.bytes) }));
      expect(text).toContain("Owner export — failed: expected 2 rows, received 3 (orders-owner)");
    });

    it("falls back to 'Open the task page' (no blocks at all from the reader) for a display it cannot use: a different round, tampered bytes, or a row an older release wrote", async () => {
      const made = make();
      const task = { taskId: "11111111-1111-4111-8111-111111111111", ...owner, workflow: { candidate: { digest: current.candidateDigest }, e2e: { currentRoundId: current.roundId,
        currentGroupRunIds: current.groupRunIds, displayRef: made.ref } } };
      const stale = { ...task, workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, currentRoundId: "33333333-3333-4333-8333-333333333333" } } };
      expect(await workflowE2ENotifierBlocks({ task: stale as never, readPrivateObject: readerOf(made.bytes) })).toBeUndefined();
      expect(await workflowE2ENotifierBlocks({ task: task as never, readPrivateObject: readerOf(Uint8Array.from([...made.bytes, 0])) })).toBeUndefined();
      // A v2 object with a field this reader does not know is refused whole, not read for the part it understands.
      const extra = Buffer.from(JSON.stringify({ ...made.parsed, scenarios: [{ ...(made.parsed.scenarios as unknown[])[0] as object, verdict: "PASS" }] }), "utf8");
      const ref = workflowE2EDisplayRef({ ...current, ...owner, bytes: extra });
      expect(await readWorkflowE2ENotifierProjection({ ref, ...owner, current, readPrivateObject: readerOf(extra) })).toBeUndefined();
    });

    it("never writes an email or a credential into the stored rows, even if one reaches a free-text field", () => {
      const dirty = results({ scenarios: [row({ status: "FAILED", title: "Export for ops@tenant-a.example", reason: "received password=hunter2-secret and ops@tenant-a.example",
        failedAssertion: { kind: "text", expected: "ops@tenant-a.example", actual: "token=abc123secretvalue9999 ops@tenant-a.example" } }), failedViewerRow()] });
      const stored = Buffer.from(make(dirty).bytes).toString("utf8");
      for (const secret of ["ops@tenant-a.example", "hunter2-secret", "abc123secretvalue9999"]) expect(stored).not.toContain(secret);
    });

    it("refuses to write a display that no longer fits its bound, rather than a partial one", () => {
      const huge = results({ scenarios: Array.from({ length: 64 }, (_, index) => row({ scenarioId: `s-${index}`, mockedOrigins: Array.from({ length: 32 }, (_, origin) => `${"o".repeat(190)}-${origin}`) })),
        baseline: { status: "PASSED", scenarios: Array.from({ length: 64 }, (_, index) => row({ scenarioId: `b-${index}`, mockedOrigins: Array.from({ length: 32 }, (_, origin) => `${"o".repeat(190)}-${origin}`) })) } });
      expect(createWorkflowE2EDisplayObject({ ...owner, view: shared, capturedAt: capturedAtV2, current, scenarioResults: huge })).toBeUndefined();
    });
  });
});
