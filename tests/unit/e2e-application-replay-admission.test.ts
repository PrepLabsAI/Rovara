import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { E2EApplicationPlanIntentSchema, E2E_MODEL_ROUTE_DEFAULT_BUDGETS, canonicalJson, deriveE2EApplicationRuntimeAccountRef, e2eApplicationMetadataSourceRefs, type E2EScenario } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission, e2eApplicationGroupAgentSteps, e2eApplicationGroupUsesModel, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { ApplicationDispatchRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";
import { applicationApprovedPlanDigest, buildApplicationExecutionAdmission, buildApplicationReplayAdmission, type ApplicationAdmissionInput, type ApplicationRoundApproval } from "../../packages/broker/src/e2e/application-admission.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { e2eAgentRoutePolicyLimits } from "../../packages/broker/src/e2e/model-route-registry.js";
import { createWorkflowE2EAdmissionAgentStepsReader } from "../../packages/broker/src/aws/workflow-e2e-admission-schema.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { ordersManifestWith, registryFor } from "../support/e2e-account-registry-fixtures.js";
import { PROFILE, approvedSetup, binding, csvScenario, snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";

afterEach(disposeRealCandidates);

// The audit replay of a verified round must run the cases the round ran: a recording is bound to its case id, and a case id is derived from the round's plan identity. Replays used to be built
// under a plan identity of their own (the round to replay and the attempt were hashed in), so every case id moved and every replay was refused "ran other cases than this candidate would run now".
// The round here mirrors the task that found it: one app, a web group (an owner AI navigation case beside deterministic owner and viewer cases) and an API group (a viewer case).
const TASK = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = { id: "feature-plan", sha256: "1".repeat(64) };
const ROUTE = "r1-0123456789ab";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const APPROVAL: ApplicationRoundApproval = { artifactId: ARTIFACT.id, artifactDigest: ARTIFACT.sha256, graphDigest: "2".repeat(64), runId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, actorId: "owner-1" };

const agentRow = () => webApiRow("web", {}, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] }));

function recording(caseId: string, stepIndex: number) {
  const trace = { actions: [{ name: "tap", summary: "The tap action.", target: { role: "button", name: "Orders", testId: "orders" } }], summary: "The recorded AI navigation concluded.",
    executor: { name: "rovara-e2e-agent", version: "1" }, startPath: "/", endPath: "/" };
  const keyHash = sha(`${caseId}:${stepIndex}`);
  return { caseId, stepIndex, keyHash, traceBase64: Buffer.from(JSON.stringify({ schemaVersion: "rovara-agent-trace-file/v1", keyHash, trace })).toString("base64"),
    binding: { schemaVersion: "rovara-agent-trace/v1" as const, runId: randomUUID(), caseId, stepIndex, traceSha256: sha(canonicalJson(trace)), ledgerSha256: sha("ledger"), actionCount: 1 } };
}

async function round() {
  const manifest = ordersManifestWith((e2e) => { e2e.targetAccounts.push({ baseTargetId: "api-1", profileId: "orders-owner" }, { baseTargetId: "api-1", profileId: "orders-viewer" }); });
  const snapshot = snapshotOf({ "package.json": manifest });
  const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
  const registry = registryFor(snapshot, Date.now());
  const targetOf = (kind: "web" | "api", account: string) => setup.proposal.targets.find((item) => item.kind === kind && item.accountProfileId === account)!;
  const ownerWeb = targetOf("web", "orders-owner");
  const viewerWeb = targetOf("web", "orders-viewer");
  const viewerApi = targetOf("api", "orders-viewer");
  const application = setup.inspection.applications.find((item) => item.applicationId === ownerWeb.applicationId)!;
  const sourceRefs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths);
  const accountRef = (profile: string) => deriveE2EApplicationRuntimeAccountRef(registry.find((entry) => entry.definition.applicationId === application.applicationId && entry.definition.profileId === profile)!.definition);
  const base = { ...csvScenario, minimumEvidence: "runtime" as const, requiredRealComponentIds: [], required: true };
  const scenarios: E2EScenario[] = [
    { ...base, scenarioId: "owner-agent-csv", requestedTargetIds: [ownerWeb.targetId], accountProfileId: "orders-owner", steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }],
      assertions: [{ kind: "visible", testId: "orders", equals: true }] },
    { ...base, scenarioId: "owner-sees-orders", requestedTargetIds: [ownerWeb.targetId], accountProfileId: "orders-owner" },
    { ...base, scenarioId: "viewer-buttons", requestedTargetIds: [viewerWeb.targetId], accountProfileId: "orders-viewer", steps: [{ kind: "navigate", path: "/orders" }],
      assertions: [{ kind: "visible", testId: "export-csv", equals: false }] },
    { ...base, scenarioId: "viewer-api-403", requestedTargetIds: [viewerApi.targetId], accountProfileId: "orders-viewer",
      steps: [{ kind: "request", requestId: "export", path: "/orders/export", method: "GET", body: {} }], assertions: [{ kind: "http-status", path: "/orders/export", method: "GET", equals: 403 }] },
  ];
  const runtimeRef = (target: typeof ownerWeb) => ({ targetId: target.targetId, applicationId: application.applicationId, recipeDigest: application.recipe!.recipeDigest, sourceRefs,
    runtimeProfileId: target.runtimeProfileId, accountProfileId: target.accountProfileId });
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [ownerWeb.targetId, viewerWeb.targetId, viewerApi.targetId], portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: ["orders-owner", "orders-viewer"].map((profileId) => ({ applicationId: application.applicationId, profileId, sourcePath: sourceRefs[0]!.path, sourceSha256: sourceRefs[0]!.sha256 })),
    scenarios, semanticExportDeltas: [], applicationRuntimeRefs: [runtimeRef(ownerWeb), runtimeRef(viewerWeb), runtimeRef(viewerApi)],
    runtimeAccountRefs: [accountRef("orders-owner"), accountRef("orders-viewer")], unavailableTargetRefs: [] });
  const policy = { ...setup.policy, baselineScenarioIds: ["owner-sees-orders", "viewer-buttons", "viewer-api-403"], modelRouteRevision: ROUTE, limits: e2eAgentRoutePolicyLimits(E2E_MODEL_ROUTE_DEFAULT_BUDGETS) };
  const candidate = await createRealCandidate({ "package.json": manifest });
  const approve = (rows: ReturnType<typeof webApiRow>[]) => {
    const approved = evaluateApplicationPlanApproval({ intent, taskId: TASK, artifact: ARTIFACT, snapshot, setupProposal: setup.proposal, setupApproval: setup.setupApproval, policy,
      registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(), accounts: { entries: registry, mode: "approve", pinned: [] } });
    if (!approved.ok) throw new Error(approved.reason);
    return approved.selection;
  };
  const inputFor = (rows: ReturnType<typeof webApiRow>[]): Omit<ApplicationAdmissionInput, "planDigest" | "replay" | "baseline"> => ({ taskId: TASK, operationId: randomUUID(), operationFence: 3, workflowRevision: 7,
    roundId: randomUUID(), runId: randomUUID, intent, artifact: ARTIFACT, snapshot: candidate.snapshot, setupProposal: setup.proposal, setupApproval: setup.setupApproval, policy,
    registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: candidate.buildSource, now: Date.now(), accountEntries: registry, recordedSelection: approve(rows) });
  /** The candidate round, built the way the broker builds it (the approved-plan identity), and what a replay of it is given: the cases it ran and the recording of its AI navigation case. */
  const rows = () => [agentRow(), webApiRow("api")];
  const candidateOf = (approval = APPROVAL, forRows = rows()) => buildApplicationExecutionAdmission({ ...inputFor(forRows), planDigest: applicationApprovedPlanDigest(TASK, approval) });
  const source = candidateOf();
  const cases = source.admission.round.groupBindings.flatMap((group) => group.expectedCases);
  const agentCase = cases.find((item) => item.scenarioId === "owner-agent-csv")!;
  const replayOf = (attempt = 1) => ({ sourceRoundId: randomUUID(), sourceAdmissionSha256: sha("source admission"), sourceEvidenceSha256: sha("source evidence"), attempt,
    sourceCases: cases.map((item) => ({ caseId: item.caseId, assertionOutcomes: item.assertionDigests.map(() => "passed" as const), csvSha256: null })), traces: [recording(agentCase.caseId, 0)] });
  const replayRound = (options: { approval?: ApplicationRoundApproval; rows?: ReturnType<typeof webApiRow>[]; attempt?: number } = {}) => buildApplicationReplayAdmission({
    ...inputFor(options.rows ?? rows()), approval: options.approval ?? APPROVAL, replay: replayOf(options.attempt) });
  return { source, cases, agentCase, candidateOf, replayRound, rows };
}

const casesByGroup = (admission: ReturnType<typeof decodeE2EApplicationExecutionAdmission>) => Object.fromEntries(admission.round.groupBindings
  .map((group) => [`${group.groupId}`, group.expectedCases.map((item) => `${item.scenarioId}=${item.caseId}`).sort()]));

describe("an audit replay of a verified application round runs the cases the round ran", () => {
  it("builds for the round's own approved plan, with the same case ids, group by group, and the same execution plan: a web group mixing an AI navigation case with owner and viewer cases, and an API group", async () => {
    const s = await round();
    const replay = decodeE2EApplicationExecutionAdmission(s.replayRound().bytes);
    const candidate = decodeE2EApplicationExecutionAdmission(s.source.bytes);
    expect(candidate.round.groupBindings).toHaveLength(2);
    expect(candidate.round.groupBindings.some((group) => group.expectedCases.length >= 3 && group.expectedCases.some((item) => item.scenarioId === "owner-agent-csv")
      && group.expectedCases.some((item) => item.scenarioId === "viewer-buttons"))).toBe(true);
    expect(Object.values(casesByGroup(replay)).flat().sort()).toEqual(Object.values(casesByGroup(candidate)).flat().sort());
    expect(replay.round.groupBindings.flatMap((group) => group.expectedCases.map((item) => item.caseId)).sort()).toEqual(s.cases.map((item) => item.caseId).sort());
    expect(replay.executionPlan.digest).toBe(candidate.executionPlan.digest);
    expect(replay.round.executionPlanDigest).toBe(candidate.round.executionPlanDigest);
    expect(replay.round.groupBindings.map((group) => group.planDigest)).toEqual(candidate.round.groupBindings.map((group) => group.planDigest));
    // The replay keeps its own identity where it is needed: the round and operation are fresh, and the admission signs which round it replays and the attempt.
    expect(replay.round.roundId).not.toBe(candidate.round.roundId);
    expect(replay.replay).toMatchObject({ purpose: "replay", attempt: 1 });
    expect(replay.replay?.sourceRoundId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not take the attempt into the case ids: a second attempt of the same round runs the same cases", async () => {
    const s = await round();
    const first = decodeE2EApplicationExecutionAdmission(s.replayRound({ attempt: 1 }).bytes);
    const second = decodeE2EApplicationExecutionAdmission(s.replayRound({ attempt: 2 }).bytes);
    expect(second.replay?.attempt).toBe(2);
    expect(casesByGroup(second)).toEqual(casesByGroup(first));
    expect(second.round.groupBindings.map((group) => group.planDigest)).toEqual(first.round.groupBindings.map((group) => group.planDigest));
  });

  it("makes no model call and sends no model socket: no model route, no group with a model channel, the AI navigation step served from the recording", async () => {
    const s = await round();
    const built = s.replayRound();
    const replay = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(replay.modelRoute).toBeNull();
    const suites = validateE2EApplicationExecutionAdmission(replay).applicationSuites;
    expect(suites).toHaveLength(2);
    expect(suites.map((suite) => e2eApplicationGroupUsesModel(suite))).toEqual([false, false]);
    expect(suites.every((suite) => suite.runtimeAdmissionContext.modelRoute === null)).toBe(true);
    // The AI navigation step is still in the plan (it runs, from its recording): the case and its recording are the round's.
    expect(suites.reduce((count, suite) => count + e2eApplicationGroupAgentSteps(suite).length, 0)).toBe(1);
    expect(replay.replay?.traces.map((trace) => trace.caseId)).toEqual([s.agentCase.caseId]);
    // The dispatcher is told the same: a replay is not a model round.
    const reader = createWorkflowE2EAdmissionAgentStepsReader({ s3: { send: async () => ({ Body: { transformToString: async () => built.bytes.toString("utf8") } }) }, bucket: "b" });
    const ref = (admission: { bytes: Buffer; sha256: string }) => ({ schemaVersion: 1 as const, kind: "application" as const, taskId: TASK, workflowRevision: 7, candidateDigest: "a".repeat(64), roundId: randomUUID(),
      groupRunIds: [randomUUID()], admissionRef: { key: `workflow-e2e-admissions/sha256/${admission.sha256}.json`, sha256: admission.sha256, byteLength: admission.bytes.byteLength } });
    await expect(reader(ref(built))).resolves.toBe(false);
    // Control: the same plan as a candidate round does have a group with the model channel, so the replay's lack of one is the replay's own doing.
    const candidateSuites = validateE2EApplicationExecutionAdmission(decodeE2EApplicationExecutionAdmission(s.source.bytes)).applicationSuites;
    expect(candidateSuites.filter((suite) => e2eApplicationGroupUsesModel(suite))).toHaveLength(1);
    expect(s.source.admission.modelRoute).toEqual({ routeId: "rovara-e2e-default", routeRevision: ROUTE });
  });

  it("still refuses when the approved plan changed since the round (approved again: another graph run or actor), because the recordings are for cases that would no longer run", async () => {
    const s = await round();
    for (const moved of [{ runId: "44444444-4444-4444-8444-444444444444" }, { actorId: "owner-2" }, { workflowRevision: 6 }, { graphDigest: "5".repeat(64) }, { artifactDigest: "6".repeat(64) }]) {
      let message = "";
      try { s.replayRound({ approval: { ...APPROVAL, ...moved } }); } catch (error) { expect(error).toBeInstanceOf(ApplicationDispatchRefusal); message = (error as Error).message; }
      expect(message, JSON.stringify(moved)).toMatch(/replay-source-unavailable.*other cases/);
    }
  });

  it("still refuses when the runtime changed since the round (the row was qualified again), because a case id is bound to the runtime row", async () => {
    const s = await round();
    const requalified = [webApiRow("web", { generation: 5 }, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] })), webApiRow("api", { generation: 5 })];
    // Control: the new row is a row the plan can run, as a candidate round.
    expect(() => s.candidateOf(APPROVAL, requalified)).not.toThrow();
    expect(requalified[1]!.generation).not.toBe(s.rows()[1]!.generation);
    expect(canonicalJson(s.candidateOf(APPROVAL, requalified).admission.round.groupBindings.flatMap((g) => g.expectedCases.map((c) => c.caseId)).sort())).not.toBe(canonicalJson(s.cases.map((c) => c.caseId).sort()));
    expect(() => s.replayRound({ rows: requalified })).toThrow(/replay-source-unavailable.*other cases/);
  });
});

describe("the broker derives a replay's plan identity from the one function the candidate round uses", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const bodyOf = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  it("builds the replay admission through the shared function, without a plan identity of its own", () => {
    const replay = bodyOf("startReplayApplicationRound");
    expect(replay).toContain("buildApplicationReplayAdmission(");
    expect(replay).not.toContain("buildApplicationExecutionAdmission(");
    expect(replay).not.toMatch(/planDigest|e2e-replay-plan/);
    expect(bodyOf("startApplicationE2EChecksDispatch")).toContain("applicationApprovedPlanDigest(task.taskId, approval)");
    expect(source).not.toContain("workflow-application-e2e-replay-plan");
  });
});
