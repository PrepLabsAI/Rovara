import { describe, expect, it } from "vitest";
import { canonicalJson, createCandidateManifest, createWorkflowSnapshot, E2EApplicationSelectionRecordSchema, E2EExecutionPlanSchema, E2EQualifiedResultSchema, E2ERoundSchema, E2ERunBindingSchema } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import { createApplicationResults, type ApplicationResultsDeps } from "../../packages/broker/src/core/e2e/application-results.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { toDocument, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { failClosedAuthority } from "../../packages/broker/src/core/e2e/authority.js";
import { failedBaseline, fiveScenarios, SHOT, SHOT_SHA, OTHER_SHOT, OTHER_SHOT_SHA } from "../support/e2e-scenario-results.js";

const AT = "2026-11-21T12:00:00.000Z";
const ROUND = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const COMPANY = "org_00000000000000000000";
const d = (char: string) => char.repeat(64);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function task(): ApplicationTask {
  const workflow = createWorkflowSnapshot({ taskId: "44444444-4444-4444-8444-444444444444", ownerId: "a".repeat(64), now: AT });
  return { pk: "DEVTASK#44444444-4444-4444-8444-444444444444", sk: "META", entityType: "DEVELOPER_TASK", taskId: "44444444-4444-4444-8444-444444444444", developerId: "owner", provider: "local", developerName: "Owner", client: "web", project: "demo", companyId: COMPANY, title: "Orders", workspaceId: "workspace", ownerKey: "owner", conversationId: "conversation", startingRevision: 1, charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "org", sk: "counter" } }, shared: false, createdAt: AT, updatedAt: AT,
    workflow: { ...workflow, stage: "VERIFY", state: "RUNNING", candidate: createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]), e2e: { required: true, contractDigest: d("a"), policyDigest: d("b"), bundleDigest: d("c"), executionPlanDigest: d("d"), currentRoundId: ROUND, currentGroupRunIds: [RUN], resultRefs: [], applicationSelection: E2EApplicationSelectionRecordSchema.parse({ schemaVersion: "e2e-application-selection/v1", intentDigest: d("a"), planDigest: d("a"), semanticApproval: { artifactId: "plan", digest: d("a") }, setupApproval: { artifactId: "setup", digest: d("a") }, applicationApprovalBindingDigest: d("a"), applicationExecutionPlanDigest: d("d"), applicationBundleDigest: d("c"), executableTargetIds: ["web-1"], unavailableCriteria: [], runtimeRows: [], accountRefs: [], evaluatedAt: AT }) } } };
}

function projection(t: ApplicationTask, status: "passed" | "failed") {
  const core = { criterionId: "orders", scenarioId: "owner-export", targetId: "web-1", requestedTargetId: "web-1", agentId: "template-v1", repeat: 0, executionDescriptorDigest: d("1"), accountContextId: "owner-context", accountContextDigest: d("2"), accountProfileId: "orders-owner", assertionDigest: hash([d("3")]), assertionDigests: [d("3")], required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [] };
  const item = { ...core, caseId: e2eCaseIdFromIdentity(core) };
  const expectedCase = { ...item, upstreamTestId: e2eUpstreamTestIdFromIdentity(item) };
  const content = { schemaVersion: 1, candidateDigest: t.workflow.candidate!.digest, planDigest: d("4"), criteria: [{ criterionId: "orders", requirementId: "orders", scenarioId: "owner-export", requestedTargetId: "web-1", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: [item.caseId] }], effectiveTargets: [{ targetId: "web-1", applicationId: "orders", runtimeProfileId: "browser-v1", accountProfileId: "orders-owner", kind: "web", browser: "chromium", viewport: { width: 1280, height: 800 } }], groups: [{ groupId: "group-1", targetIds: ["web-1"], runtimeProfileId: "browser-v1", mode: "mock-only", mockManifestDigest: d("5"), expectedCases: [expectedCase] }], mocks: [], unavailableCriteria: [] };
  const plan = E2EExecutionPlanSchema.parse({ ...content, digest: hash(content) });
  const common = { schemaVersion: 1, roundId: ROUND, taskId: t.taskId, operationId: "checks", operationFence: 1, workflowRevision: 1, executionPlanDigest: plan.digest, authorizationRevision: "auth-1", candidateDigest: plan.candidateDigest, planDigest: plan.planDigest, policyDigest: d("b"), bundleDigest: d("c"), modelRouteRevision: null, admittedAt: "2026-11-21T11:59:00.000Z", deadlineAt: "2026-11-21T12:05:00.000Z" };
  const binding = E2ERunBindingSchema.parse({ ...common, runId: RUN, groupId: "group-1", executionMode: "mock-only", appBuildDigest: d("6"), environmentDigest: d("7"), runtimeManifestDigest: d("8"), mockManifestDigest: d("5"), expectedCases: [expectedCase] });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId: ROUND, taskId: t.taskId, operationId: "checks", operationFence: 1, workflowRevision: 1, executionPlanDigest: plan.digest, admittedAt: common.admittedAt, deadlineAt: common.deadlineAt, limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null }, groupBindings: [binding] });
  const result = E2EQualifiedResultSchema.parse({ schemaVersion: 1, binding, producer: "typed-port-fixture", startedAt: "2026-11-21T11:59:01.000Z", finishedAt: "2026-11-21T11:59:02.000Z", receivedAt: "2026-11-21T11:59:03.000Z", status, qualification: "trusted", executionMode: "mock-only", reason: "complete", cases: [{ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, status, reason: status === "passed" ? "assertions-passed" : "assertions-failed", attemptCount: 1, assertionDigest: item.assertionDigest, assertionReceipts: [{ assertionIndex: 0, assertionDigest: d("3"), status, reason: status === "passed" ? "assertions-passed" : "assertions-failed" }], artifacts: [], coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [] } }], rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed" });
  return { plan, round, results: [result] };
}

async function world() {
  const t = task();
  const store = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
  await objects.put(`private/${t.ownerKey}/${t.workspaceId}/workflow-e2e-artifacts/${OTHER_SHOT_SHA}`, OTHER_SHOT, { contentType: "image/jpeg", metadata: {}, retention: "e2e-screenshot" });
  const baseline = failedBaseline();
  delete baseline.scenarios[1]!.screenshotRef;
  await store.put({ item: toDocument({ pk: t.pk, sk: `E2E_BASELINE#${d("a")}`, entityType: "WORKFLOW_E2E_BASELINE", taskId: t.taskId, contractDigest: d("a"), purpose: "baseline", attempt: 1, state: "RECORDED", requestedAt: AT, baseline }) });
  const op: OperationRecord = { pk: "workspace", sk: "OPERATION#checks", entityType: "OPERATION", companyId: COMPANY, id: "checks", workspaceId: t.workspaceId, fence: 1, kind: "task", workflowMode: "CHECKS", status: "RUNNING", createdAt: AT, updatedAt: AT, eventSequence: 0, requestId: "results-fixture", payloadHash: d("0"), dispatch: { kind: "task", projectRevision: 1, payload: {} }, workflowRevision: 1, workflowE2EAdmission: { schemaVersion: 1, taskId: t.taskId, workflowRevision: 1, candidateDigest: t.workflow.candidate!.digest, roundId: ROUND, groupRunIds: [RUN], admissionRef: { key: "admission", sha256: d("e"), byteLength: 10 } }, workflowE2EEvidenceRef: { key: "evidence", sha256: d("f"), byteLength: 10 } };
  const current = fiveScenarios().map((row) => row.status === "FAILED" ? { ...row, failedAssertion: { kind: "http-status" as const, expected: "403", actual: "401" }, reason: "expected 403, received 401" } : row);
  let outcome: "PASS" | "FAILED" | "UNKNOWN" = "FAILED";
  const verify: NonNullable<ApplicationResultsDeps["verify"]> = async (_deps, _op, actual, _candidate, output) => {
    if (output !== undefined) {
      Object.assign(output, projection({ ...t, ...actual, workflow: actual.workflow ?? t.workflow }, outcome === "PASS" ? "passed" : "failed"));
      output.display = { scenarios: current, artifacts: [{ sha256: SHOT_SHA, bytes: SHOT, contentType: "image/jpeg" }] };
      if (outcome === "UNKNOWN") output.results = [];
    }
    return outcome;
  };
  const deps: ApplicationResultsDeps = { state: { store, now: () => new Date(AT) }, objects, authority: failClosedAuthority, readTask: async () => t, operations: async () => [op], verify };
  const service = createApplicationResults(deps);
  return { t, op, store, objects, service, deps, baseline, current, setOutcome(next: typeof outcome) { outcome = next; } };
}

describe("core application results", () => {
  it("captures five current rows and five separate baseline rows with expected/actual and a stored JPEG", async () => {
    const w = await world();
    const before = canonicalJson(w.t.workflow);
    const ref = await w.service.project(w.t, w.op, "FAILED");
    expect(ref).toBeDefined();
    expect(canonicalJson(w.t.workflow)).toBe(before);
    w.t.workflow.e2e!.displayRef = ref!;
    const read = await w.service.read(w.t, "owner");
    expect(read?.scenarioResults?.scenarios).toHaveLength(5);
    expect(read?.scenarioResults?.baseline?.scenarios).toHaveLength(5);
    expect(read?.scenarioResults?.scenarios[1]).toMatchObject({ kind: "web", accountLabel: "orders-viewer", failedAssertion: { expected: "403", actual: "401" } });
    expect(read?.presentation.shared.e2e.status).toBe("FAILED");
    // D1-2: the page API that served the artifact is deleted; a row links to no removed route.
    expect(read?.presentation.pageHtml).not.toContain("/review/");
    expect(await w.service.artifact(w.t, SHOT_SHA)).toEqual({ contentType: "image/jpeg", bytes: new Uint8Array(SHOT) });
    expect(await w.service.artifact(w.t, d("0"))).toBeUndefined();
    expect(read?.scenarioResults?.baseline).toEqual(w.baseline);
  });

  it("shows the baseline before a candidate round without writing or granting a verdict", async () => {
    const w = await world();
    delete w.t.workflow.candidate;
    const read = await w.service.read(w.t, "viewer");
    expect(read?.scenarioResults?.scenarios).toEqual([]);
    expect(read?.scenarioResults?.baseline).toEqual(w.baseline);
    expect(read?.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(w.t.workflow.e2e?.qualifiedRound).toBeUndefined();
    expect(w.t.workflow.e2e?.failedRound).toBeUndefined();
  });

  it("suppresses candidate rows and captured verdicts during coding and after the current round moves", async () => {
    const w = await world();
    w.t.workflow.e2e!.displayRef = (await w.service.project(w.t, w.op, "FAILED"))!;
    w.t.workflow.stage = "IMPLEMENT";
    const coding = await w.service.read(w.t, "owner");
    expect(coding?.scenarioResults?.scenarios).toEqual([]);
    expect(coding?.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(await w.service.notice(w.t)).toBeUndefined();
    expect(await w.service.artifact(w.t, SHOT_SHA)).toBeUndefined();
    w.t.workflow.stage = "VERIFY";
    w.t.workflow.e2e!.currentRoundId = "33333333-3333-4333-8333-333333333333";
    expect((await w.service.read(w.t, "viewer"))?.scenarioResults?.scenarios).toEqual([]);
    expect(await w.service.notice(w.t)).toBeUndefined();
  });

  it("stores no display for baseline, foreign, stale or non-CHECKS operations", async () => {
    const w = await world();
    for (const operation of [
      { ...w.op, workflowMode: "IMPLEMENT" as const },
      { ...w.op, workflowE2EAdmission: { ...w.op.workflowE2EAdmission!, purpose: "baseline" as const } },
      { ...w.op, companyId: "org_11111111111111111111" },
      { ...w.op, workflowE2EAdmission: { ...w.op.workflowE2EAdmission!, taskId: "foreign-task" } },
      { ...w.op, workflowE2EAdmission: { ...w.op.workflowE2EAdmission!, roundId: "33333333-3333-4333-8333-333333333333" } },
    ]) expect(await w.service.project(w.t, operation, "SUCCEEDED")).toBeUndefined();
  });

  it("keeps UNKNOWN distinct from failed assertions even when worker transport succeeded", async () => {
    const w = await world();
    w.setOutcome("UNKNOWN");
    w.current[1] = { ...w.current[1]!, status: "UNKNOWN", reason: "unmocked external call" };
    w.t.workflow.e2e!.displayRef = (await w.service.project(w.t, w.op, "SUCCEEDED"))!;
    const read = await w.service.read(w.t, "viewer");
    expect(read?.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(read?.scenarioResults?.scenarios[1]?.status).toBe("UNKNOWN");
    expect(w.t.workflow.e2e?.qualifiedRound).toBeUndefined();
  });

  it("retains the original baseline when a new candidate passes and never rewrites its display", async () => {
    const w = await world();
    const first = (await w.service.project(w.t, w.op, "FAILED"))!;
    const original = await w.objects.get(first.key, first.byteLength);
    w.setOutcome("PASS");
    w.current.splice(0, w.current.length, ...fiveScenarios().map((row) => ({ ...row, status: "PASSED" as const, failedAssertion: undefined, screenshotRef: undefined })));
    w.t.workflow.candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
    w.op.workflowE2EAdmission!.candidateDigest = w.t.workflow.candidate.digest;
    const next = (await w.service.project(w.t, w.op, "SUCCEEDED"))!;
    w.t.workflow.e2e!.displayRef = next;
    const read = await w.service.read(w.t, "viewer");
    expect(read?.presentation.shared.e2e.status).toBe("PASS");
    expect(read?.scenarioResults?.scenarios.filter((row) => row.status === "PASSED")).toHaveLength(5);
    expect(read?.scenarioResults?.baseline).toEqual(w.baseline);
    expect(await w.objects.get(first.key, first.byteLength)).toEqual(original);
    expect(next.sha256).not.toBe(first.sha256);
    expect((await w.service.artifact(w.t, OTHER_SHOT_SHA))?.bytes).toEqual(new Uint8Array(OTHER_SHOT));
  });
});


describe("closed core result history", () => {
  it("labels a bound capture as historical and suppresses a capture made after close", async () => {
    const w = await world();
    const ref = (await w.service.project(w.t, w.op, "FAILED"))!;
    expect(ref).toBeDefined();
    w.t.workflow.e2e!.displayRef = ref;
    w.t.workflow.e2e!.failedRound = { status: "FAILED", candidateDigest: ref.candidateDigest, roundId: ref.roundId, groupRunIds: ref.groupRunIds, admissionSha256: ref.admissionSha256, evidenceSha256: ref.evidenceSha256 };
    w.t.closedAt = "2026-11-21T12:01:00.000Z";
    const read = await w.service.read(w.t, "owner");
    expect(read?.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(read?.scenarioResults?.scenarios).toHaveLength(5);
    expect(read?.presentation.pageHtml).toContain("Recorded historical E2E result");
    expect(JSON.stringify(read?.presentation.slackBlocks)).toContain("No current run counts");
    w.t.closedAt = "2026-11-21T11:59:00.000Z";
    expect((await w.service.read(w.t, "owner"))?.scenarioResults).toBeUndefined();
  });
});

describe("result projection refusal boundaries", () => {
  it("does not load results for a task without a required obligation", async () => {
    const w = await world(); delete w.t.workflow.e2e;
    w.deps.operations = async () => { throw new Error("ordinary task must not load E2E operations"); };
    expect(await w.service.read(w.t, "viewer")).toBeUndefined();
  });
  for (const missing of ["plan", "round", "plan-digest", "plan-targets"] as const) it(`keeps ${missing} projection unavailable`, async () => {
    const w = await world();
    w.deps.verify = async (_deps, _op, _task, _candidate, output) => {
      if (output) {
        Object.assign(output, projection(w.t, "failed"));
        if (missing === "plan") delete output.plan;
        if (missing === "round") delete output.round;
        if (missing === "plan-digest") output.plan = { ...(output.plan as object), digest: 42 };
        if (missing === "plan-targets") output.plan = { ...(output.plan as object), effectiveTargets: [{ targetId: 42 }] };
      }
      return "UNKNOWN";
    };
    expect((await w.service.read(w.t, "viewer"))?.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(await w.service.project(w.t, w.op, "FAILED")).toBeUndefined();
  });
  it("refuses a malformed candidate before invoking verification", async () => {
    const w = await world(); w.t.workflow.candidate!.digest = "invalid";
    w.op.workflowE2EAdmission!.candidateDigest = "invalid";
    let calls = 0; w.deps.verify = async () => { calls++; return "UNKNOWN"; };
    expect((await w.service.read(w.t, "viewer"))?.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(calls).toBe(0);
  });
  it("does not project an unbound operation or missing evidence", async () => {
    const w = await world(); let calls = 0; w.deps.verify = async () => { calls++; return "UNKNOWN"; };
    w.op.workflowE2EGroupEvidenceRefs = [{ groupRunId: RUN, evidenceRef: w.op.workflowE2EEvidenceRef! }];
    delete w.op.workflowE2EEvidenceRef;
    expect(await w.service.project(w.t, w.op, "FAILED")).toBeUndefined();
    expect(calls).toBe(0);
  });
});
