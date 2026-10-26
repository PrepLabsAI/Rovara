import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, E2EWorkflowAdmissionRefSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, canonicalJson, groundingScenarioIds, type E2EScenario, type E2EWorkflowAdmissionRef } from "@agentx/contracts";
import { executeWorkflowE2EApplicationChecks } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { buildApplicationExecutionAdmission, type ApplicationAdmissionInput } from "../../packages/broker/src/e2e/application-admission.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { e2eAgentRoutePolicyLimits } from "../../packages/broker/src/e2e/model-route-registry.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { binding, csvScenario, ordersContractManifest, planFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// T7a PLANGROUNDING: a grounding round (the proposed plan's must-not-change scenarios on the unchanged code, before the owner is asked) is a kind of its own. Its signed reference names the base
// commit, the attempt and the plan artifact; the worker runs its admission only when that admission is exactly a model-free run of the base commit with neither a baseline nor a replay member.

afterEach(disposeRealCandidates);
const TASK = "11111111-1111-4111-8111-111111111111";
const REACHED = "the runtime was asked for";
const ROUTE = "r1-0123456789ab";
const PLAN_SHA = "9".repeat(64);
const BASE = "a".repeat(40);

describe("the signed reference of a grounding round", () => {
  const base = () => ({ schemaVersion: 1 as const, kind: "application" as const, taskId: TASK, workflowRevision: 7, candidateDigest: "1".repeat(64), roundId: randomUUID(), groupRunIds: [randomUUID()],
    admissionRef: { key: `workflow-e2e-admissions/sha256/${"2".repeat(64)}.json`, sha256: "2".repeat(64), byteLength: 100 } });
  const grounding = (extra: Record<string, unknown> = {}) => ({ ...base(), purpose: "grounding", baseCommitSha: BASE, attempt: 1, planArtifactSha256: PLAN_SHA, ...extra });

  it("accepts a grounding reference with its base commit, attempt and plan artifact, and keeps accepting the other kinds as before (positive controls)", () => {
    expect(E2EWorkflowAdmissionRefSchema.safeParse(grounding()).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse(base()).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), purpose: "baseline", baseCommitSha: BASE, attempt: 2 }).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), purpose: "replay", attempt: 1, sourceRoundId: randomUUID() }).success).toBe(true);
  });

  it.each([
    ["no base commit", { baseCommitSha: undefined }], ["no attempt", { attempt: undefined }], ["no plan artifact", { planArtifactSha256: undefined }],
    ["a source round", { sourceRoundId: randomUUID() }], ["agent steps", { agentSteps: true }], ["a plan artifact that is not a digest", { planArtifactSha256: "nope" }],
    ["no application kind", { kind: undefined }],
  ])("refuses a grounding reference with %s", (_name, extra) => {
    expect(E2EWorkflowAdmissionRefSchema.safeParse(grounding(extra)).success).toBe(false);
  });

  it("refuses the plan artifact on every reference that is not a grounding one", () => {
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), planArtifactSha256: PLAN_SHA }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), purpose: "baseline", baseCommitSha: BASE, attempt: 1, planArtifactSha256: PLAN_SHA }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), purpose: "replay", attempt: 1, sourceRoundId: randomUUID(), planArtifactSha256: PLAN_SHA }).success).toBe(false);
  });

  it("does not let a baseline or a replay borrow a grounding reference's members", () => {
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), purpose: "replay", baseCommitSha: BASE, attempt: 1, sourceRoundId: randomUUID() }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...base(), purpose: "baseline", baseCommitSha: BASE, attempt: 1, sourceRoundId: randomUUID() }).success).toBe(false);
  });
});

describe("the worker feature and the planning flag", () => {
  const planning = (payload: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "Plan", ...payload } });
  const structuredPlan = { workflowMode: "PLAN", workflowPhase: "IMPLEMENTATION_PLAN", planFormat: "structured", workflowE2EPlanVersion: 2 };

  it("lists the feature a worker must have to be asked for a grounding round or the export", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EGroundingChecks.v1");
  });

  it("accepts the export flag only on a structured planning run with the application plan version, and an invocation without it is unchanged", () => {
    expect(planning({ ...structuredPlan, workflowE2EGroundingSource: true }).success).toBe(true);
    expect(planning(structuredPlan).success).toBe(true);
    expect(planning({ workflowMode: "PLAN", workflowPhase: "IMPLEMENTATION_PLAN", workflowE2EGroundingSource: true }).success).toBe(false);
    expect(planning({ ...structuredPlan, planFormat: undefined, workflowE2EGroundingSource: true }).success).toBe(false);
    expect(planning({ workflowMode: "IMPLEMENT", workflowE2EGroundingSource: true }).success).toBe(false);
    expect(planning({ ...structuredPlan, workflowE2EGroundingSource: false }).success).toBe(false);
  });
});

describe("which scenarios a plan grounds", () => {
  const scenario = (scenarioId: string, steps: E2EScenario["steps"] = csvScenario.steps): E2EScenario => ({ ...csvScenario, scenarioId, steps });
  const agent: E2EScenario["steps"] = [{ kind: "agent", goal: "open the orders page", maxActions: 3 }];
  const planOf = (scenarios: E2EScenario[], scenarioProves: Record<string, string[]> | undefined, notChanging = ["The refund flow stays as it is.", "Login stays as it is."]) =>
    ({ e2e: planFixture({}).intent && { ...planFixture({}).intent, scenarios }, notChanging, scenarioProves });

  it("is the scenarios that prove a Not changing entry, in the intent's order, without those that navigate with AI", () => {
    const plan = planOf([scenario("a"), scenario("b", agent), scenario("c"), scenario("d")], { a: ["nc1"], b: ["nc1"], c: ["1", "nc2"], d: ["1"] });
    expect(groundingScenarioIds(plan)).toEqual(["a", "c"]);
  });

  it("is empty for a plan with no scenarioProves, a claim-only mapping, a Not changing entry the plan does not have, or the portable intent", () => {
    expect(groundingScenarioIds(planOf([scenario("a")], undefined))).toEqual([]);
    expect(groundingScenarioIds(planOf([scenario("a")], { a: ["1"] }))).toEqual([]);
    expect(groundingScenarioIds(planOf([scenario("a")], { a: ["nc3"] }))).toEqual([]);
    expect(groundingScenarioIds({ e2e: { schemaVersion: 1 } as never, notChanging: ["x"], scenarioProves: { a: ["nc1"] } })).toEqual([]);
  });
});

async function built(options: { baseline?: boolean; routed?: boolean; plan?: "plain" | "mixed" }) {
  const agentScenario: E2EScenario = { ...csvScenario, scenarioId: "agent-orders", steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] };
  const routed = options.routed === true || options.plan === "mixed";
  const fx = planFixture({ ...(routed ? { modelRouteRevision: ROUTE } : {}), ...(options.plan === "mixed" ? { extraScenarios: [agentScenario] } : {}) });
  const policy = routed ? { ...fx.policy, limits: e2eAgentRoutePolicyLimits(E2E_MODEL_ROUTE_DEFAULT_BUDGETS) } : fx.policy;
  const rows = [webApiRow("web", {}, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] }))];
  const real = await createRealCandidate({ "package.json": ordersContractManifest, "src/orders.js": "export const orders = [];\n" });
  const selection = evaluateApplicationPlanApproval({ intent: fx.intent, taskId: TASK, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
    setupApproval: fx.setup.setupApproval, policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(), accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!selection.ok) throw new Error(selection.reason);
  const input: ApplicationAdmissionInput = { taskId: TASK, operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(), runId: randomUUID, intent: fx.intent,
    artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: real.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy, registeredRuntimes: rows,
    runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: real.buildSource, planDigest: "c".repeat(64), now: Date.now(), accountEntries: fx.registry, recordedSelection: selection.selection,
    ...(options.baseline === true ? { baseline: { baseCommitSha: real.identity.commitSha, attempt: 1 } } : {}) };
  const admission = buildApplicationExecutionAdmission(input);
  const reference = (extra: Record<string, unknown> = {}): E2EWorkflowAdmissionRef => ({ schemaVersion: 1, kind: "application", taskId: TASK, workflowRevision: 7,
    candidateDigest: admission.admission.candidateDigest, roundId: admission.roundId, groupRunIds: admission.groupRunIds,
    admissionRef: { key: `workflow-e2e-admissions/sha256/${admission.sha256}.json`, sha256: admission.sha256, byteLength: admission.bytes.byteLength }, ...extra });
  return { admission, input, real, reference };
}
type Built = Awaited<ReturnType<typeof built>>;
const groundingReference = (round: Built, extra: Record<string, unknown> = {}) =>
  round.reference({ purpose: "grounding", baseCommitSha: round.real.identity.commitSha, attempt: 1, planArtifactSha256: PLAN_SHA, ...extra });

const run = (round: Built, reference: E2EWorkflowAdmissionRef, admissionBytes: Buffer = round.admission.bytes) => executeWorkflowE2EApplicationChecks({
  invocation: { kind: "task", operationId: round.input.operationId, fence: round.input.operationFence, payload: { workflowE2EAdmission: reference } } as never,
  reference, admissionBytes, runtime: () => { throw new Error(REACHED); }, candidateRepositoryRoot: () => undefined,
  saveEvidence: async () => { throw new Error("no evidence"); }, throwIfCancelled: () => undefined });

describe("the worker keeps grounding rounds apart from every other kind", () => {
  it("runs a model-free admission of the base commit under a grounding reference (it reaches the runtime)", async () => {
    const round = await built({});
    await expect(run(round, groundingReference(round))).rejects.toThrow(REACHED);
  });

  it("refuses a baseline admission under a grounding reference", async () => {
    const round = await built({ baseline: true });
    await expect(run(round, groundingReference(round))).rejects.toThrow(/grounding/i);
  });

  it("refuses an admission with a replay member under a grounding reference, whatever else about it is right", async () => {
    const round = await built({});
    const { admissionDigest: _digest, ...body } = JSON.parse(round.admission.bytes.toString("utf8")) as Record<string, unknown>;
    void _digest;
    // A replay member sealed into an otherwise grounding-shaped admission: the validator may or may not accept it, but the worker must never run it as a grounding round.
    const withReplay = { ...body, replay: { purpose: "replay", sourceRoundId: randomUUID(), sourceAdmissionSha256: "3".repeat(64), sourceEvidenceSha256: "4".repeat(64), attempt: 1, sourceCases: [], traces: [] } };
    const tampered = Buffer.from(canonicalJson({ ...withReplay, admissionDigest: createHash("sha256").update(canonicalJson(withReplay)).digest("hex") }), "utf8");
    await expect(run(round, groundingReference(round), tampered)).rejects.not.toThrow(REACHED);
  });

  it("refuses an admission of another commit, and an admission that routes a model, under a grounding reference", async () => {
    const plain = await built({});
    await expect(run(plain, groundingReference(plain, { baseCommitSha: "b".repeat(40) }))).rejects.toThrow(/grounding/i);
    const routedRound = await built({ routed: true });
    await expect(run(routedRound, groundingReference(routedRound))).rejects.toThrow(/grounding/i);
  });

  it("refuses a grounding reference that claims agent steps, and an admission with an AI navigation group whose model route was taken out", async () => {
    const plain = await built({});
    await expect(run(plain, groundingReference(plain, { agentSteps: true }))).rejects.toThrow(/grounding/i);
    // A candidate admission of a mixed plan whose model route has been taken out and whose digest was sealed again still has its AI navigation group; the admission validator refuses it before
    // the worker's own grounding check on AI navigation (kept as a second line) is reached, and it never reaches the runtime.
    const mixed = await built({ plan: "mixed" });
    const { admissionDigest: _digest, ...body } = JSON.parse(mixed.admission.bytes.toString("utf8")) as Record<string, unknown>;
    void _digest;
    const unrouted = { ...body, modelRoute: null };
    const tampered = Buffer.from(canonicalJson({ ...unrouted, admissionDigest: createHash("sha256").update(canonicalJson(unrouted)).digest("hex") }), "utf8");
    await expect(run(mixed, groundingReference(mixed), tampered)).rejects.toThrow(/agent-bearing application group/);
  });

  it("refuses a candidate or baseline admission under no grounding purpose exactly as before, and a candidate reference for a grounding-shaped run", async () => {
    const candidate = await built({});
    await expect(run(candidate, candidate.reference())).rejects.toThrow(REACHED);
    const baseline = await built({ baseline: true });
    await expect(run(baseline, baseline.reference())).rejects.toThrow(/baseline/i);
    await expect(run(baseline, baseline.reference({ purpose: "baseline", baseCommitSha: baseline.real.identity.commitSha, attempt: 1 }))).rejects.toThrow(REACHED);
  });
});
