import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, PlanQualityFindingSchema, planQualityFinding, workflowSendBackOffered, type E2EDisplayBaseline, type E2EScenario } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { FakeDynamoDb, assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { disposeRealCandidates, createRealCandidate } from "../support/e2e-application-candidate.js";
import { startApplicationRound, type RoundCore } from "../support/e2e-application-round-harness.js";
import { binding, csvScenario, ordersContractManifest, planFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { aggregateEvidenceEnvelope, createApplicationEvidenceFixture, groupEvidenceEnvelope } from "../support/e2e-application-evidence-fixture.js";
import { MAYA } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import type { DurableOutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { readWorkflowE2EBaselineRecord } from "../../packages/broker/src/aws/workflow-e2e-baseline.js";
import {
  GROUNDING_UNAVAILABLE_REASONS, groundingRoundLapsed, groundingStartFailureReason, groundingStartItem, markWorkflowE2EGroundingUnavailable, readWorkflowE2EGroundingRecord,
  recordWorkflowE2EGrounding, requestWorkflowE2EGroundingRound, verifyGroundingEvidence,
} from "../../packages/broker/src/aws/workflow-e2e-grounding.js";
import { applicationApprovedPlanDigest, buildApplicationExecutionAdmission, buildApplicationGroundingAdmission, groundingPlanDigest } from "../../packages/broker/src/e2e/application-admission.js";
import { ApplicationBaselineSkipped, ApplicationDispatchRefusal, applicationAccountsRefusal, applicationRuntimeRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";
import { verifyApplicationE2EEvidence } from "../../packages/broker/src/e2e/application-evidence.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { e2eAgentRoutePolicyLimits } from "../../packages/broker/src/e2e/model-route-registry.js";
import { escapedPlanText, groundingFindingsOf, plannedExpectation } from "../../packages/broker/src/developer/plan-grounding-findings.js";
import { stopBlocksWorkflowStep, strandedPlanningRun, type StoppedRunOperation } from "../../packages/broker/src/aws/workflow-cancel-reconcile.js";

// The gate itself is tested in e2e-driving-test-gate.test.ts; here every digest counts as driven (Task 4.10C).
assumeDrivingTestsPassed();

// T7b PLANGROUNDING, the broker's side of the grounding round: the proposed plan's must-not-change scenarios on the unchanged code, before the owner is asked. It is a round of its own kind
// (a plan digest binds its purpose, no signed member), has a record of its own, can never gate, and every broker site that branches on a round's purpose treats it as a non-candidate round.

afterEach(() => { vi.useRealTimers(); return disposeRealCandidates(); });
const TASK = "11111111-1111-4111-8111-111111111111";
const PLAN_SHA = "9".repeat(64);
const ARTIFACT = { id: "feature-plan", sha256: "1".repeat(64) };
const ROUTE = "r1-0123456789ab";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The admission
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function built(options: { mixed?: boolean; grounding?: { scenarioIds: string[]; baseCommitSha?: string }; baseline?: boolean }) {
  const agentScenario: E2EScenario = { ...csvScenario, scenarioId: "agent-orders", steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] };
  const fx = planFixture({ ...(options.mixed === true ? { modelRouteRevision: ROUTE, extraScenarios: [agentScenario] } : {}) });
  const policy = options.mixed === true ? { ...fx.policy, limits: e2eAgentRoutePolicyLimits(E2E_MODEL_ROUTE_DEFAULT_BUDGETS) } : fx.policy;
  const rows = [webApiRow("web", {}, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] }))];
  const real = await createRealCandidate({ "package.json": ordersContractManifest, "src/orders.js": "export const orders = [];\n" });
  const selection = evaluateApplicationPlanApproval({ intent: fx.intent, taskId: TASK, artifact: ARTIFACT, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
    setupApproval: fx.setup.setupApproval, policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(), accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!selection.ok) throw new Error(selection.reason);
  const common = { taskId: TASK, operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(), runId: randomUUID, intent: fx.intent, artifact: ARTIFACT, snapshot: real.snapshot,
    setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: real.buildSource,
    now: Date.now(), accountEntries: fx.registry, recordedSelection: selection.selection };
  const base = real.identity.commitSha;
  const admission = options.grounding !== undefined
    ? buildApplicationGroundingAdmission({ ...common, planArtifactId: ARTIFACT.id, grounding: { baseCommitSha: options.grounding.baseCommitSha ?? base, attempt: 1, scenarioIds: options.grounding.scenarioIds } })
    : buildApplicationExecutionAdmission({ ...common, planDigest: "c".repeat(64), ...(options.baseline === true ? { baseline: { baseCommitSha: base, attempt: 1 } } : {}) });
  const subject = { taskId: TASK, operationId: common.operationId, operationFence: 3, workflowRevision: 7, candidateDigest: admission.admission.candidateDigest, roundId: admission.roundId,
    groupRunIds: admission.groupRunIds, admissionSha256: admission.sha256 };
  return { admission, common, real, base, subject, grounding: { planDigest: groundingPlanDigest({ taskId: TASK, artifactId: ARTIFACT.id, artifactSha256: ARTIFACT.sha256, workflowRevision: 7, baseCommitSha: base, attempt: 1 }), baseCommitSha: base } };
}

describe("a grounding round's admission", () => {
  it("is a model-free run of the base commit with no signed member, bound to the proposed plan by a digest of a domain of its own", async () => {
    const round = await built({ mixed: true, grounding: { scenarioIds: ["export-csv"] } });
    const admission = round.admission.admission;
    expect(admission.baseline).toBeUndefined();
    expect(admission.replay).toBeUndefined();
    expect(admission.modelRoute).toBeNull();
    expect(admission.candidateCommitSha).toBe(round.base);
    expect(round.admission.skippedAiScenarios).toEqual([]);
    expect(admission.groups.flatMap((group) => group.outerBinding.expectedCases.map((expected) => expected.scenarioId))).toEqual(["export-csv"]);
    expect(admission.groups.every((group) => group.outerBinding.modelRouteRevision === null)).toBe(true);
    // The plan digest every part of the admission carries is the grounding one, and no candidate, baseline or replay round computes it.
    expect(admission.applicationApprovalBinding?.planDigest).toBe(round.grounding.planDigest);
    expect(admission.bundle.planDigest).toBe(round.grounding.planDigest);
    expect(admission.groups.every((group) => group.outerBinding.planDigest === round.grounding.planDigest)).toBe(true);
    const approvedDigest = applicationApprovedPlanDigest(TASK, { artifactId: ARTIFACT.id, artifactDigest: ARTIFACT.sha256, graphDigest: null, runId: null, workflowRevision: 7, actorId: "a" });
    expect(round.grounding.planDigest).not.toBe(approvedDigest);
    expect(decodeE2EApplicationExecutionAdmission(round.admission.bytes).admissionDigest).toBe(admission.admissionDigest);
  });

  it("binds the proposed artifact, the revision, the base commit and the attempt: any other value is another digest", () => {
    const one = { taskId: TASK, artifactId: ARTIFACT.id, artifactSha256: ARTIFACT.sha256, workflowRevision: 7, baseCommitSha: "a".repeat(40), attempt: 1 };
    const digest = groundingPlanDigest(one);
    for (const other of [{ taskId: randomUUID() }, { artifactId: "other" }, { artifactSha256: "2".repeat(64) }, { workflowRevision: 8 }, { baseCommitSha: "b".repeat(40) }, { attempt: 2 }]) {
      expect(groundingPlanDigest({ ...one, ...other })).not.toBe(digest);
    }
  });

  it("refuses to run a scenario with an AI navigation step, a scenario the plan does not have, no scenario, and a base commit that is not the source's", async () => {
    await expect(built({ mixed: true, grounding: { scenarioIds: ["export-csv", "agent-orders"] } })).rejects.toThrow(/no AI navigation/);
    await expect(built({ grounding: { scenarioIds: ["not-in-the-plan"] } })).rejects.toThrow(/does not have/);
    await expect(built({ grounding: { scenarioIds: [] } })).rejects.toThrow(/names no scenario/);
    await expect(built({ grounding: { scenarioIds: ["export-csv"], baseCommitSha: "b".repeat(40) } })).rejects.toThrow(/base commit of the grounding round/);
  });

  it("is refused alongside a baseline or a replay member", async () => {
    const round = await built({ grounding: { scenarioIds: ["export-csv"] } });
    expect(() => buildApplicationExecutionAdmission({ ...round.common, planDigest: "c".repeat(64), grounding: { baseCommitSha: round.base, attempt: 1, scenarioIds: ["export-csv"] },
      baseline: { baseCommitSha: round.base, attempt: 1 } })).toThrow(/neither a baseline nor a replay/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const PASSING = { probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 503 } } as const;
const SECRET = "tok-9f3a-SECRET-planted-value";
async function groundedEvidence(options: Parameters<typeof createApplicationEvidenceFixture>[0]) {
  const fixture = await createApplicationEvidenceFixture(options);
  const { encodeE2EApplicationExecutionAdmission } = await import("../../packages/verifier/src/application-scenarios.js");
  const admission = fixture.admission;
  const bytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
  const admissionSha256 = sha(bytes);
  const subject = { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
    candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId), admissionSha256 };
  const receivedAt = ((fixture.groupRun.actual as { collection: { receivedAt: string } }).collection.receivedAt);
  const input = { admissionBytes: bytes, subject, aggregate: aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: [fixture.groupRun] }),
    groupEvidence: new Map([[fixture.runId, groupEvidenceEnvelope({ admission, admissionSha256, groupRun: fixture.groupRun })]]), receivedAt: new Map([[fixture.runId, receivedAt]]), terminalStatus: "SUCCEEDED" as const };
  const grounding = { planDigest: admission.bundle.planDigest, baseCommitSha: admission.candidateCommitSha };
  return { fixture, admission, input, grounding };
}

describe("the verifier reads a grounding round only as one", () => {
  it("verifies genuine evidence of a model-free run of the base commit under its plan digest, and labels the rows as a grounding round's (positive control)", async () => {
    const round = await groundedEvidence(PASSING);
    const result = verifyApplicationE2EEvidence({ ...round.input, purpose: "grounding", grounding: round.grounding });
    expect(result).toMatchObject({ verdict: "PASS", purpose: "grounding" });
    expect(result.display?.scenarios.length).toBeGreaterThan(0);
  });

  it("refuses an admission that is not bound to the plan digest, the base commit or the model-free run the caller recomputed, each with its own reason", async () => {
    const round = await groundedEvidence(PASSING);
    const reasonOf = (input: Parameters<typeof verifyApplicationE2EEvidence>[0]) => verifyApplicationE2EEvidence(input).reason;
    expect(reasonOf({ ...round.input, purpose: "grounding", grounding: { ...round.grounding, planDigest: "d".repeat(64) } })).toMatch(/not bound to the plan the grounding round checks/);
    expect(reasonOf({ ...round.input, purpose: "grounding", grounding: { ...round.grounding, baseCommitSha: "e".repeat(40) } })).toMatch(/base commit of the grounding round/);
    expect(reasonOf({ ...round.input, purpose: "grounding" })).toMatch(/needs the plan digest and base commit/);
    expect(verifyApplicationE2EEvidence({ ...round.input, purpose: "grounding", grounding: { ...round.grounding, planDigest: "d".repeat(64) } }).verdict).toBe("UNKNOWN");
  });

  it("refuses a baseline round's admission as a grounding round, and a grounding round's admission as a baseline or a replay (the matrix)", async () => {
    const baseline = await built({ baseline: true });
    const grounding = await built({ grounding: { scenarioIds: ["export-csv"] } });
    const run = (round: Awaited<ReturnType<typeof built>>, purpose: "baseline" | "replay" | "grounding" | "candidate") => verifyApplicationE2EEvidence({ admissionBytes: round.admission.bytes, subject: round.subject,
      aggregate: undefined, groupEvidence: new Map(), receivedAt: new Map(), terminalStatus: undefined, purpose, ...(purpose === "grounding" ? { grounding: round.grounding } : {}) });
    expect(run(baseline, "grounding").reason).toMatch(/baseline round, not a grounding round/);
    expect(run(grounding, "baseline").reason).toMatch(/candidate round, not a baseline or replay round/);
    expect(run(grounding, "replay").reason).toMatch(/candidate round, not a baseline or replay round/);
    // An admission that routes a model and has an AI navigation group, sealed under the grounding plan digest, is not a grounding round either.
    const routed = await built({ mixed: true });
    const routedBound = buildApplicationExecutionAdmission({ ...routed.common, planDigest: routed.grounding.planDigest });
    const routedSubject = { ...routed.subject, candidateDigest: routedBound.admission.candidateDigest, roundId: routedBound.roundId, groupRunIds: routedBound.groupRunIds, admissionSha256: routedBound.sha256 };
    expect(verifyApplicationE2EEvidence({ admissionBytes: routedBound.bytes, subject: routedSubject, aggregate: undefined, groupEvidence: new Map(), receivedAt: new Map(), terminalStatus: undefined,
      purpose: "grounding", grounding: routed.grounding }).reason).toMatch(/runs no AI navigation/);
    // Control: the grounding admission under its own purpose gets past the purpose, plan, commit and model checks (it stops for want of evidence).
    expect(run(grounding, "grounding").reason).toMatch(/aggregate evidence has not been accepted/);
    // A grounding admission under another plan's digest does not.
    expect(verifyApplicationE2EEvidence({ admissionBytes: grounding.admission.bytes, subject: grounding.subject, aggregate: undefined, groupEvidence: new Map(), receivedAt: new Map(), terminalStatus: undefined,
      purpose: "grounding", grounding: { ...grounding.grounding, planDigest: groundingPlanDigest({ taskId: TASK, artifactId: ARTIFACT.id, artifactSha256: "2".repeat(64), workflowRevision: 7, baseCommitSha: grounding.base, attempt: 1 }) } }).reason)
      .toMatch(/not bound to the plan/);
  });
});

describe("what a grounding round says about the plan", () => {
  it("records a mismatch as one scenario-base-mismatch finding with the scenario and the assertion kind, and nothing the app showed (a planted value is in the row, never in a finding)", async () => {
    const round = await groundedEvidence({ probe: "api-state-positive-v1", observed: { kind: "state", finalValue: { orders: SECRET, version: 1 }, disposition: "timed-out" } });
    const verified = verifyGroundingEvidence({ ...round.input, grounding: round.grounding });
    expect(verified).toBeDefined();
    const rows = verified!.results.scenarios;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", failedAssertion: { kind: "state" } });
    // Positive control: the observed value really is in the row the broker kept (the page shows rows after scrubbing)...
    expect(JSON.stringify(verified!.results)).toContain(SECRET);
    // ... and it is in no finding, whatever the finding's sentences say.
    expect(verified!.findings).toHaveLength(1);
    expect(verified!.findings[0]).toMatchObject({ code: "scenario-base-mismatch", revisable: true, scenarioIds: [rows[0]!.scenarioId], steps: [{ scenarioId: rows[0]!.scenarioId, assertionKind: "state" }] });
    expect(PlanQualityFindingSchema.safeParse(verified!.findings[0]).success).toBe(true);
    expect(JSON.stringify(verified!.findings)).not.toContain(SECRET);
    expect(verified!.findings[0]!.ownerSentence).toMatch(/\(the state check\)/);
    expect(verified!.findings[0]!.ownerSentence).not.toContain(SECRET);
    // A round that behaves as the plan says finds nothing.
    const passing = await groundedEvidence(PASSING);
    expect(verifyGroundingEvidence({ ...passing.input, grounding: passing.grounding })).toMatchObject({ findings: [], results: { status: "PASSED" } });
  });

  it("finds nothing for rows that passed, and notes (not findings) the rows it could not decide", () => {
    const row = (scenarioId: string, status: "PASSED" | "FAILED" | "UNKNOWN", extra: Record<string, unknown> = {}) => ({ scenarioId, title: scenarioId, kind: "api" as const, accountLabel: "owner", status, mockedOrigins: [], ...extra });
    const results = { status: "FAILED", scenarios: [row("a", "PASSED"), row("b", "UNKNOWN"), row("c", "FAILED", { failedAssertion: { kind: "http-status", expected: "200", actual: "503" } }), row("d", "FAILED")] } as E2EDisplayBaseline;
    const mapped = groundingFindingsOf(results);
    expect(mapped.passedScenarioIds).toEqual(["a"]);
    expect(mapped.undecidedScenarioIds).toEqual(["b"]);
    expect(mapped.findings.map((finding) => finding.scenarioIds)).toEqual([["c"], ["d"]]);
    expect(mapped.findings[0]!.steps).toEqual([{ scenarioId: "c", assertionKind: "http-status" }]);
    expect(mapped.findings[1]!.steps).toBeUndefined();
    expect(JSON.stringify(mapped)).not.toContain("503");
  });

  it("shows the plan's own expected value (escaped, 80 characters), never the observed one", () => {
    const plan = { e2e: { schemaVersion: 2, scenarios: [{ scenarioId: "s", assertions: [{ kind: "text", testId: "t", equals: `<b>Refund</b> \`done\`\n${"x".repeat(200)}` }, { kind: "http-status", path: "/a", method: "GET", equals: 200 }] }] } } as never;
    const shown = plannedExpectation(plan, "s", "text")!;
    expect(shown.length).toBeLessThanOrEqual(80);
    expect(shown).not.toMatch(/[<>`\n]/);
    expect(shown.startsWith("bRefund/b done")).toBe(true);
    expect(plannedExpectation(plan, "s", "http-status")).toBe("200");
    expect(plannedExpectation(plan, "s", "csv")).toBeUndefined();
    expect(plannedExpectation(plan, "missing", "text")).toBeUndefined();
    expect(escapedPlanText("a\u0000b  c")).toBe("a b c");
  });

  it("the steps member is bounded and strict, and a finding without it still parses (an older writer's)", () => {
    const bare = planQualityFinding({ code: "scenario-base-mismatch", scenarioIds: ["s"] });
    expect(bare.steps).toBeUndefined();
    expect(PlanQualityFindingSchema.safeParse(bare).success).toBe(true);
    expect(PlanQualityFindingSchema.safeParse({ ...bare, steps: [{ scenarioId: "s", assertionKind: "text", extra: 1 }] }).success).toBe(false);
    expect(PlanQualityFindingSchema.safeParse({ ...bare, steps: [{ scenarioId: "s", assertionKind: "free text from the app" }] }).success).toBe(false);
    expect(PlanQualityFindingSchema.safeParse({ ...bare, steps: Array.from({ length: 33 }, () => ({ scenarioId: "s", assertionKind: "text" })) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the grounding record", () => {
  const ref = { taskId: TASK, planArtifactSha256: PLAN_SHA, attempt: 1 };
  const key = { pk: `DEVTASK#${TASK}`, sk: `E2E_GROUNDING#${PLAN_SHA}#1` };
  const store = () => { const db = new FakeDynamoDb(); return { db, documentClient: db as never, tableName: "state" }; };
  const started = (overrides: Record<string, unknown> = {}) => ({ baseCommitSha: "b".repeat(40), operationId: "op-1", roundId: "round-1", admissionSha256: "c".repeat(64), selectionDigest: "d".repeat(64),
    startedAt: "2026-10-25T10:00:00.000Z", deadlineAt: "2026-10-25T10:25:00.000Z", ...overrides });
  const start = (s: ReturnType<typeof store>, overrides: Record<string, unknown> = {}) => s.db.send(new TransactWriteCommand({ TransactItems: [groundingStartItem(s, ref, started(overrides))] }));
  const request = (s: ReturnType<typeof store>) => requestWorkflowE2EGroundingRound(s, ref, { scenarioIds: ["a", "b"], planArtifactId: "plan-1" });

  it("is asked for once per plan artifact and attempt, under a key and an entity type of its own, and expires", async () => {
    const s = store();
    expect(await request(s)).toBe("REQUESTED");
    expect(s.db.get(key.pk, key.sk)).toMatchObject({ entityType: "WORKFLOW_E2E_GROUNDING", purpose: "grounding", state: "REQUESTED", attempt: 1, scenarioIds: ["a", "b"], planArtifactId: "plan-1" });
    expect(typeof s.db.get(key.pk, key.sk)!.indexExpiresAt).toBe("number");
    expect(await request(s)).toBe("ALREADY");
    expect(await requestWorkflowE2EGroundingRound(s, { ...ref, attempt: 2 }, { scenarioIds: ["a"], planArtifactId: "plan-1" })).toBe("REQUESTED");
    expect(await requestWorkflowE2EGroundingRound(s, { ...ref, planArtifactSha256: "8".repeat(64) }, { scenarioIds: ["a"], planArtifactId: "plan-2" })).toBe("REQUESTED");
    await expect(requestWorkflowE2EGroundingRound(s, { ...ref, attempt: 3 }, { scenarioIds: [], planArtifactId: "plan-1" })).rejects.toThrow();
  });

  it("starts at most once, with the operation, the round and the admission, and writes the start only with the transaction that accepts the operation", async () => {
    const s = store();
    await request(s);
    await start(s);
    expect(s.db.get(key.pk, key.sk)).toMatchObject({ state: "STARTED", operationId: "op-1", roundId: "round-1", baseCommitSha: "b".repeat(40), admissionSha256: "c".repeat(64), deadlineAt: "2026-10-25T10:25:00.000Z" });
    await expect(start(s, { operationId: "op-2" })).rejects.toThrow();
    expect(s.db.get(key.pk, key.sk)).toMatchObject({ operationId: "op-1" });
    await expect(start(store())).rejects.toThrow();
  });

  it("is marked unavailable only with a fixed reason, only from the states named, and only by the operation that owns it", async () => {
    const s = store();
    await request(s);
    await expect(markWorkflowE2EGroundingUnavailable(s, ref, "git said: fatal: /home/ci/secret/path not found" as never, { from: ["REQUESTED"] })).rejects.toThrow(/fixed reason/);
    await start(s);
    expect(await markWorkflowE2EGroundingUnavailable(s, ref, "run-failed", { from: ["STARTED"], operationId: "someone-else" })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(s, ref, "run-failed", { from: ["REQUESTED"] })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(s, ref, "run-failed", { from: ["STARTED"], operationId: "op-1" })).toBe(true);
    expect(await readWorkflowE2EGroundingRecord(s, ref)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    for (const reason of GROUNDING_UNAVAILABLE_REASONS) expect(typeof reason).toBe("string");
  });

  it("records a verified result only for the round that was started, and never replaces a record that moved on", async () => {
    const s = store();
    await request(s);
    await start(s);
    const round = await groundedEvidence({ probe: "api-state-positive-v1", observed: { kind: "state", finalValue: { orders: SECRET, version: 1 }, disposition: "timed-out" } });
    const verified = verifyGroundingEvidence({ ...round.input, grounding: round.grounding })!;
    const deps = { ...s, s3: { send: vi.fn(async () => ({})) } as never, artifactBucketName: "bucket" };
    const expected = { operationId: "op-1", roundId: verified.roundId, admissionSha256: verified.admissionSha256, baseCommitSha: "b".repeat(40) };
    // The record started a different round (round-1): this verification is not of it.
    expect(await recordWorkflowE2EGrounding(deps, { ownerKey: "o", workspaceId: "w" }, ref, { verified, expected })).toBe(false);
    s.db.set({ ...s.db.get(key.pk, key.sk)!, roundId: verified.roundId, admissionSha256: verified.admissionSha256 });
    expect(await recordWorkflowE2EGrounding(deps, { ownerKey: "o", workspaceId: "w" }, ref, { verified: { ...verified, roundId: "other" }, expected }).catch((error: Error) => error.message)).toMatch(/not of the round/);
    expect(await recordWorkflowE2EGrounding(deps, { ownerKey: "o", workspaceId: "w" }, ref, { verified, expected })).toBe(true);
    const record = await readWorkflowE2EGroundingRecord(s, ref);
    expect(record).toMatchObject({ state: "RECORDED", findings: [{ code: "scenario-base-mismatch" }] });
    expect(record!.results!.status).toBe("FAILED");
    expect(JSON.stringify(record!.findings)).not.toContain(SECRET);
    // Recorded once: a second write (a late duplicate) finds it no longer STARTED.
    expect(await recordWorkflowE2EGrounding(deps, { ownerKey: "o", workspaceId: "w" }, ref, { verified, expected })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(s, ref, "timed-out", { from: ["STARTED", "REQUESTED"] })).toBe(false);
  });

  it("is invisible to the baseline reader (and so to AUTOFIX), and reads nothing that is not a grounding record under its key", async () => {
    const s = store();
    const contractDigest = "a".repeat(64);
    const task = { taskId: TASK, workflow: { e2e: { required: true, contractDigest, applicationSelection: {} } } } as never;
    // A grounding item planted under the baseline's key is not a baseline.
    s.db.set({ pk: `DEVTASK#${TASK}`, sk: `E2E_BASELINE#${contractDigest}`, entityType: "WORKFLOW_E2E_GROUNDING", taskId: TASK, contractDigest, purpose: "grounding", attempt: 1, state: "REQUESTED", requestedAt: "2026-10-25T10:00:00.000Z" });
    expect(await readWorkflowE2EBaselineRecord(s, task)).toBeUndefined();
    // And a real grounding record does not sit under any baseline key.
    await request(s);
    expect(s.db.find((item) => String(item.sk).startsWith("E2E_BASELINE#") && item.entityType === "WORKFLOW_E2E_GROUNDING")).toHaveLength(1);
    // A baseline-shaped item under the grounding key is not a grounding record.
    s.db.set({ ...s.db.get(key.pk, key.sk)!, entityType: "WORKFLOW_E2E_BASELINE" });
    expect(await readWorkflowE2EGroundingRecord(s, ref)).toBeUndefined();
    s.db.set({ ...s.db.get(key.pk, key.sk)!, entityType: "WORKFLOW_E2E_GROUNDING", purpose: "baseline" });
    expect(await readWorkflowE2EGroundingRecord(s, ref)).toBeUndefined();
  });

  it("reads a RECORDED item whose rows cannot be read whole as no record, and a started round past its deadline and grace as lapsed (an unreadable deadline is lapsed too)", async () => {
    const s = store();
    await request(s);
    await start(s);
    s.db.set({ ...s.db.get(key.pk, key.sk)!, state: "RECORDED", results: { status: "FAILED", scenarios: [{ junk: true }] }, findings: [] });
    expect(await readWorkflowE2EGroundingRecord(s, ref)).toBeUndefined();
    const startedRecord = { ...(await (async () => { const t = store(); await request(t); await start(t); return readWorkflowE2EGroundingRecord(t, ref); })())! };
    const deadline = Date.parse("2026-10-25T10:25:00.000Z");
    expect(groundingRoundLapsed(startedRecord, deadline + 4 * 60_000)).toBe(false);
    expect(groundingRoundLapsed(startedRecord, deadline + 6 * 60_000)).toBe(true);
    expect(groundingRoundLapsed({ ...startedRecord, deadlineAt: "garbage" }, 0)).toBe(true);
    expect(groundingRoundLapsed({ ...startedRecord, state: "REQUESTED" }, deadline + 6 * 60_000)).toBe(false);
  });

  it("gives a start failure a fixed reason and nothing else: the error's own text is never kept", () => {
    expect(groundingStartFailureReason(new ApplicationBaselineSkipped())).toBe("ai-only");
    expect(groundingStartFailureReason(applicationRuntimeRefusal("the web runtime of /home/ci/x expired"))).toBe("runtime-not-ready");
    expect(groundingStartFailureReason(applicationAccountsRefusal("account maya@example.test changed"))).toBe("accounts-not-ready");
    expect(groundingStartFailureReason(new ApplicationDispatchRefusal("anything else"))).toBe("refused");
    expect(groundingStartFailureReason(new Error("ENOENT /private/tmp/secret"))).toBe("start-failed");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The broker's sites, on the real broker
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const e2eOf = (round: RoundCore) => round.workflowNow().e2e as { qualifiedRound?: Record<string, unknown>; failedRound?: Record<string, unknown>; currentRoundId?: string };
const recordKey = (round: RoundCore) => ({ pk: `DEVTASK#${round.taskId}`, sk: `E2E_GROUNDING#${PLAN_SHA}#1` });
const snapshot = (round: RoundCore) => JSON.stringify(round.workflowNow());

/**
 * A running grounding operation on a round of the API fixture. The task holds a plan card back (`planGrounding` names the proposed plan), and the workflow is made to look as hostile as it can:
 * with `looksCurrent` it is running its checks with the grounding round as the current round. `signedAs: "candidate"` is the control: the same operation signed as a candidate's CHECKS.
 */
async function groundingOperation(options: { looksCurrent?: boolean; signedAs?: "grounding" | "candidate" } = {}) {
  const round = await startApplicationRound({ baseline: "off" });
  const checks = round.operationNow();
  const operationId = randomUUID();
  const roundId = randomUUID();
  const base = checks.workflowE2EAdmission as Record<string, unknown> & { admissionRef: Record<string, unknown>; groupRunIds: string[] };
  const ref = options.signedAs === "candidate" ? { ...base, roundId } : { ...base, roundId, purpose: "grounding", baseCommitSha: "b".repeat(40), attempt: 1, planArtifactSha256: PLAN_SHA };
  const workspace = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, "META")!;
  const { activeOperationId: _active, ...rest } = workspace; void _active;
  round.harness.db.set({ ...rest, status: "BUSY", activeOperationId: operationId, fence: Number(checks.fence) + 1 });
  round.harness.db.set({ ...checks, id: operationId, sk: `OPERATION#${operationId}`, status: "RUNNING", fence: Number(checks.fence) + 1, workflowE2EAdmission: ref,
    workflowE2EEvidenceRef: undefined, workflowE2EGroupEvidenceRefs: undefined, workflowE2EGroupRunIds: undefined });
  const outbox = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === round.operationId)[0]!;
  const outboxId = randomUUID();
  const fence = Number(checks.fence) + 1;
  const callbackCapability = issueCapability(round.harness.brokerInput as { callbackSigningKey: string }, round.workspaceId, operationId, fence, false, false, false, false, false, true, false);
  round.harness.db.set({ ...outbox, pk: `OUTBOX#${outboxId}`, id: outboxId, operationId, invocation: { ...(outbox.invocation as object), operationId, fence, callbackCapability } });
  round.harness.db.set({ pk: recordKey(round).pk, sk: recordKey(round).sk, entityType: "WORKFLOW_E2E_GROUNDING", schemaVersion: 1, taskId: round.taskId, planArtifactSha256: PLAN_SHA, planArtifactId: "plan-1",
    purpose: "grounding", attempt: 1, state: "STARTED", requestedAt: new Date().toISOString(), scenarioIds: ["orders-health-0"], baseCommitSha: "b".repeat(40), operationId, roundId,
    admissionSha256: String(ref.admissionRef.sha256), startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 600_000).toISOString() });
  // The task holds its plan card back, naming the proposed plan.
  const task = round.taskNow() as { workflow: Record<string, unknown> & { e2e: Record<string, unknown> } };
  round.harness.db.set({ ...task, planGrounding: { artifactSha256: PLAN_SHA },
    ...(options.looksCurrent === true ? { workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, currentRoundId: roundId, currentGroupRunIds: base.groupRunIds } } } : {}) });
  return { round, operationId, roundId };
}
const recordOf = (round: RoundCore) => round.harness.db.get(recordKey(round).pk, recordKey(round).sk);

describe("a grounding round never gates", () => {
  it("records only its own state when it ends FAILED, CANCELLED, or SUCCEEDED with nothing to verify, and leaves the workflow, send-back and publication as they were", async () => {
    for (const [status, reason] of [["FAILED", "run-failed"], ["CANCELLED", "stopped"], ["SUCCEEDED", "unverified"]] as const) {
      const { round, operationId } = await groundingOperation();
      const before = snapshot(round);
      await round.harness.finish(round.workspaceId, operationId, status, status === "FAILED" ? { error: "the runner died" } : undefined);
      expect(recordOf(round), status).toMatchObject({ state: "UNAVAILABLE", reason });
      expect(snapshot(round), status).toBe(before);
      expect(e2eOf(round).failedRound, status).toBeUndefined();
      expect(workflowSendBackOffered(round.workflowNow() as never), status).toBe(false);
    }
  });

  it("cannot be mistaken for the candidate's round even when the workflow looks as if it were running it: no qualification, no failure, no block", async () => {
    for (const status of ["FAILED", "SUCCEEDED"] as const) {
      const { round, operationId, roundId } = await groundingOperation({ looksCurrent: true });
      const before = snapshot(round);
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
      await round.harness.finish(round.workspaceId, operationId, status, status === "FAILED" ? { error: "the runner died" } : undefined);
      expect(snapshot(round), status).toBe(before);
      expect(e2eOf(round).currentRoundId).toBe(roundId);
      expect(e2eOf(round).failedRound, status).toBeUndefined();
      expect(recordOf(round), status).toMatchObject({ state: "UNAVAILABLE" });
    }
  });

  it("control: the same hostile setup signed as a candidate's CHECKS does move the workflow (so the refusals above are the purpose, not the setup)", async () => {
    const { round, operationId } = await groundingOperation({ looksCurrent: true, signedAs: "candidate" });
    const before = snapshot(round);
    await round.harness.finish(round.workspaceId, operationId, "FAILED", { error: "the runner died" });
    expect(snapshot(round)).not.toBe(before);
    expect(round.workflowNow().state).toBe("BLOCKED");
  });

  it("a grounding round lost before it reached the worker (the outbox gave up) blocks nothing and marks its record run-failed; a lost candidate CHECKS does block (control)", async () => {
    for (const signedAs of ["grounding", "candidate"] as const) {
      const { round, operationId } = await groundingOperation({ looksCurrent: true, signedAs });
      const op = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!;
      round.harness.db.set({ ...op, status: "ACCEPTED" });
      const lost = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as unknown as DurableOutboxRecord;
      const before = snapshot(round);
      await failOutboxOperation(round.harness.db as never, "state", lost, "delivery gave up");
      expect(round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "FAILED" });
      if (signedAs === "candidate") { expect(snapshot(round)).not.toBe(before); continue; }
      expect(snapshot(round)).toBe(before);
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
      expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    }
  });

  it("the owner's Stop of a running grounding round stops it and nothing else: the record says it was stopped and the workflow is as it was", async () => {
    const { round, operationId } = await groundingOperation({ looksCurrent: true });
    const before = snapshot(round);
    const stopped = await round.harness.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/cancel`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!.status).toBe("CANCEL_REQUESTED");
    const cancels = round.operationRows((row) => row.kind === "cancel");
    expect(cancels).toHaveLength(1);
    await round.harness.finish(round.workspaceId, String(cancels[0]!.id), "SUCCEEDED");
    expect(round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!.status).toBe("CANCELLED");
    expect(snapshot(round)).toBe(before);
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "stopped" });
  });
});

describe("a grounding round's admission is served on its own record, not on the workflow's round", () => {
  it("serves the admission to its running operation, and refuses it once the record, the task or the held plan no longer say this operation is the started round", async () => {
    const { round, operationId, roundId } = await groundingOperation();
    const capability = String((round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string }).callbackCapability);
    const ref = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!.workflowE2EAdmission as { admissionRef: { sha256: string } };
    const read = () => call(round.harness.handler, { method: "POST", path: `/v1/internal/workspaces/${round.workspaceId}/operations/${operationId}/e2e-admission`,
      headers: { "x-agentx-callback-capability": capability }, body: { stage: "read", offset: 0, sha256: ref.admissionRef.sha256 } });
    const served = await read();
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const stored = recordOf(round)!;
    for (const edit of [{ state: "UNAVAILABLE", reason: "timed-out" }, { operationId: "someone-else" }, { admissionSha256: "9".repeat(64) }, { roundId: randomUUID() }, { baseCommitSha: "c".repeat(40) },
      { attempt: 2 }, { planArtifactSha256: "8".repeat(64) }]) {
      round.harness.db.set({ ...stored, ...edit });
      expect((await read()).status, JSON.stringify(edit)).toBe(409);
    }
    round.harness.db.set(stored);
    expect((await read()).status).toBe(200);
    // The task is no longer holding this plan (another plan, or none), or is closed.
    const task = round.taskNow();
    round.harness.db.set({ ...task, planGrounding: { artifactSha256: "8".repeat(64) } });
    expect((await read()).status).toBe(409);
    const { planGrounding: _held, ...unheld } = task as Record<string, unknown>; void _held;
    round.harness.db.set(unheld);
    expect((await read()).status).toBe(409);
    round.harness.db.set({ ...task, closedAt: new Date().toISOString() });
    expect((await read()).status).toBe(409);
    void roundId;
  });
});

describe("the other sites that branch on a round's purpose", () => {
  it("the model budget refuses a grounding round, even one that says agentSteps, and writes nothing", async () => {
    const { handleE2EModelBudgetCallback } = await import("../../packages/broker/src/e2e/model-budget-endpoint.js");
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", workspaceId: "ws-1", project: "payments" });
    const dependencies = { documentClient: { send: db.send }, tableName: "state", now: () => Date.now() };
    const operation = { id: "op-1", workspaceId: "ws-1", kind: "task" as const, workflowMode: "CHECKS", status: "RUNNING" as const,
      workflowE2EAdmission: { taskId: TASK, groupRunIds: [randomUUID()], agentSteps: true as const, purpose: "grounding" } };
    await expect(handleE2EModelBudgetCallback(dependencies as never, operation as never, { schemaVersion: "rovara-e2e-model-budget/v1", reservationId: randomUUID(), stage: "reserve",
      groupRunId: operation.workflowE2EAdmission.groupRunIds[0], inputTokens: 100 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(db.find((item) => String(item.pk).startsWith("PROJECT#"))).toEqual([]);
  });

  it("a stop never blocks the plan step for a grounding run, and a held plan whose newest planning run succeeded is not a stranded planning run", () => {
    const workflow = (stage: string, state = "RUNNING") => ({ stage, state, revision: 3 }) as never;
    const task = (stage: string) => ({ workspaceId: "w1", workflow: workflow(stage) });
    const run = (extra: Record<string, unknown> = {}) => ({ id: "o1", workspaceId: "w1", kind: "task", status: "RUNNING", fence: 1, createdAt: "2026-10-25T00:00:00.000Z", workflowMode: "CHECKS", ...extra }) as never;
    for (const stage of ["PLAN", "VERIFY"]) expect(stopBlocksWorkflowStep(task(stage), run({ workflowE2EAdmission: { purpose: "grounding" } })), stage).toBe(false);
    const free = { id: "w1", status: "READY", fence: 3, activeOperationId: null };
    const planRun = (status: string) => ({ id: "p1", workspaceId: "w1", kind: "task", status, fence: 1, createdAt: "2026-10-25T00:00:00.000Z", workflowMode: "PLAN" }) as StoppedRunOperation;
    const grounding = { id: "g1", workspaceId: "w1", kind: "task", status: "FAILED", fence: 2, createdAt: "2026-10-25T00:05:00.000Z", workflowMode: "CHECKS", workflowE2EAdmission: { purpose: "grounding" } } as StoppedRunOperation;
    expect(strandedPlanningRun(task("PLAN") as never, free, [planRun("SUCCEEDED"), grounding])).toBeUndefined();
    // Control: a planning run that ended FAILED is stranded, with or without the grounding run beside it.
    expect(strandedPlanningRun(task("PLAN") as never, free, [planRun("FAILED"), grounding])?.id).toBe("p1");
  });
});
