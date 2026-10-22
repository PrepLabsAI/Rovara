import { z } from "zod";
import { types } from "node:util";
import { canonicalJson } from "./canonical-json.js";
import { copyBoundedE2EJsonArrayItems, copyBoundedE2EJsonData } from "./e2e-safe-data.js";
import { aggregateE2EVerification, projectE2EVerification, E2EExecutionPlanSchema, E2EQualifiedResultSchema, E2ERoundSchema, type E2EExecutionPlan, type E2EQualifiedResult } from "./e2e.js";

export const E2ESharedSetupViewSchema = z.object({ status: z.enum(["unavailable", "proposed", "needs-input", "mock-ready", "mixed", "runtime-ready"]), selectedTargetIds: z.array(z.string()).max(12), executionPlanDigest: z.string().nullable(), blockingInputIds: z.array(z.string()).max(128), mockSubstitutableInputIds: z.array(z.string()).max(128) }).strict();
const E2ESharedViewControlSchema = z.object({ policyPresent: z.boolean(), workflowPhase: z.string().max(120).nullable(), ownerActionProposals: z.array(z.enum(["review-setup", "retry-run", "connect-runtime"])).max(32) }).strict();
const MAX_E2E_SHARED_VIEW_RESULT_ROWS = 256;
const MAX_E2E_SHARED_VIEW_CARRIER_BYTES = (MAX_E2E_SHARED_VIEW_RESULT_ROWS + 3) * 262_144 + 12_288;
export const E2ESharedViewSchema = z.object({ schemaVersion: z.literal(1), setup: E2ESharedSetupViewSchema, e2e: z.object({ status: z.enum(["UNKNOWN", "FAILED", "PASS"]), label: z.string(), executionPlanDigest: z.string().nullable(), expectedGroups: z.number().int().nonnegative(), receivedGroups: z.number().int().nonnegative(), executedCases: z.number().int().nonnegative(), qualifiedCriteria: z.number().int().nonnegative(), requiredCriteria: z.number().int().nonnegative(), unavailableCriteria: z.number().int().nonnegative(), optionalUnavailableCriteria: z.number().int().nonnegative(), mockedComponentIds: z.array(z.string()).max(200), observedMockedComponentIds: z.array(z.string()).max(200), unexercisedBehaviors: z.array(z.string()).max(256), policyPresence: z.enum(["present", "absent"]), workflowPhase: z.string().max(120).nullable(), requiredUnexercisedCriteriaIds: z.array(z.string()).max(64) }).strict(), actions: z.array(z.enum(["review-setup", "retry-run", "connect-runtime"])).max(3) }).strict();
export type E2ESharedView = z.infer<typeof E2ESharedViewSchema>;

// ---------------------------------------------------------------------------------------------
// Display schema v2 (M1.3 Task 3.7) and v3 (M1.4 Tasks 4.4b and 4.4c): one row per scenario of a browser and API round, derived by the broker from the evidence it verified itself.
// v3 adds `agentNavigation` to a row and `reason` and `skippedAiScenarios` to the baseline. Every v2 schema stays strict, so a reader that only knows v2 refuses a v3 display and falls back.
// ---------------------------------------------------------------------------------------------

const displaySha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** The account a row ran as: its profile id, never an email. */
const displayAccountLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/);
/** The kinds of approved assertion a row can say it failed on. */
export const E2E_DISPLAY_ASSERTION_KINDS = ["text", "visible", "csv", "http-status", "json", "state", "file"] as const;
/** A kept screenshot is at most this large (the executor's own bound), so a row can never point at a bigger object. */
export const E2E_DISPLAY_SCREENSHOT_MAX_BYTES = 524_288;

/**
 * How long a stored screenshot lives (M1.3 Task 3.7b, owner decision D4: 30 days). The artifact bucket expires the object that carries this tag; S3 lifecycle filters match the
 * start of a key, and a screenshot's key starts like every other private object's, so the tag is what tells it apart. The broker puts the tag on a screenshot and on nothing else.
 */
export const E2E_ARTIFACT_RETENTION_DAYS = 30;
export const E2E_ARTIFACT_RETENTION_TAG_KEY = "rovara-retention";
export const E2E_ARTIFACT_RETENTION_TAG_VALUE = "e2e-screenshot";
/** The `x-amz-tagging` form of the tag. */
export const E2E_ARTIFACT_RETENTION_TAG = `${E2E_ARTIFACT_RETENTION_TAG_KEY}=${E2E_ARTIFACT_RETENTION_TAG_VALUE}`;

/** How an AI-navigated step ended, as the executor's ledger recorded it. */
export const E2E_DISPLAY_AGENT_STOPS = ["concluded", "cut-short", "failed"] as const;
/** What the model did to an element (the ledger's tool): the badge picks its verb from it. Absent in a block written before the kinds were recorded. */
export const E2E_DISPLAY_AGENT_ACTIONS = ["tap", "type", "press", "select", "scroll", "navigate"] as const;

/**
 * Display schema v3 (M1.4 Task 4.4b): what the AI did in an AI-navigated scenario, derived by the broker from the verified action ledger and from nothing the worker says about
 * itself. It holds the approved goal, the role and name of the page elements the model acted on (never a typed value, a key, an option label or anything the model wrote), how
 * each step ended, the number of model calls and the route that served them. `decidedBy` names the kinds of approved assertion that decided the row, so the page can say which check did.
 */
export const E2EDisplayAgentNavigationSchema = z.object({
  steps: z.array(z.object({
    goal: z.string().min(1).max(120),
    actedOn: z.array(z.object({ role: z.string().regex(/^[a-z]{1,32}$/), name: z.string().max(60), did: z.enum(E2E_DISPLAY_AGENT_ACTIONS).optional() }).strict()).max(8),
    stop: z.enum(E2E_DISPLAY_AGENT_STOPS),
  }).strict()).max(3),
  modelCalls: z.number().int().min(0).max(1000),
  routeId: z.string().min(1).max(120),
  decidedBy: z.array(z.enum(E2E_DISPLAY_ASSERTION_KINDS)).max(E2E_DISPLAY_ASSERTION_KINDS.length).optional(),
}).strict();
export type E2EDisplayAgentNavigation = z.infer<typeof E2EDisplayAgentNavigationSchema>;

const displayScenarioFields = {
  scenarioId: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  kind: z.enum(["web", "api"]),
  accountLabel: displayAccountLabel,
  status: z.enum(["PASSED", "FAILED", "UNKNOWN"]),
  reason: z.string().min(1).max(300).optional(),
  failedAssertion: z.object({ kind: z.enum(E2E_DISPLAY_ASSERTION_KINDS), expected: z.string().max(200), actual: z.string().max(200) }).strict().optional(),
  /** A screenshot is the only artifact kept: traces are not captured (Ruling CJ), so there is no `traceRef`. */
  screenshotRef: z.object({ sha256: displaySha256, bytes: z.number().int().positive().max(E2E_DISPLAY_SCREENSHOT_MAX_BYTES), contentType: z.literal("image/jpeg") }).strict().optional(),
  mockedOrigins: z.array(z.string().min(1).max(200)).max(32),
};
const onlyAFailedRowHasAFailedAssertion = (row: { failedAssertion?: unknown; status: string }, context: z.RefinementCtx) => {
  if (row.failedAssertion !== undefined && row.status !== "FAILED") context.addIssue({ code: "custom", path: ["failedAssertion"], message: "only a failed row has a failed assertion" });
};

/** A row as display schema v2 (M1.3) wrote it. Strict: a v2 reader refuses anything a later version adds. Kept so stored v2 displays parse exactly as before. */
export const E2EDisplayScenarioV2Schema = z.object(displayScenarioFields).strict().superRefine(onlyAFailedRowHasAFailedAssertion);
/** A row as display schema v3 writes it: a v2 row, and for an AI-navigated scenario how the AI navigated. */
export const E2EDisplayScenarioSchema = z.object({ ...displayScenarioFields, agentNavigation: E2EDisplayAgentNavigationSchema.optional() }).strict().superRefine(onlyAFailedRowHasAFailedAssertion);
export type E2EDisplayScenario = z.infer<typeof E2EDisplayScenarioSchema>;

const baselineStatus = z.enum(["PASSED", "FAILED", "UNKNOWN", "UNAVAILABLE"]);
const aBaselineThatCouldNotRunHasNoRows = (baseline: { status: string; scenarios: readonly unknown[] }, context: z.RefinementCtx) => {
  if (baseline.status === "UNAVAILABLE" && baseline.scenarios.length > 0) context.addIssue({ code: "custom", path: ["scenarios"], message: "a baseline that could not run has no rows" });
};

/** The baseline as display schema v2 (M1.3) wrote it: `UNAVAILABLE` is "it could not be run" and holds no rows. It is never a candidate round and never gates anything. */
export const E2EDisplayBaselineV2Schema = z.object({
  status: baselineStatus,
  scenarios: z.array(E2EDisplayScenarioV2Schema).max(64),
}).strict().superRefine(aBaselineThatCouldNotRunHasNoRows);

/** The reasons a baseline has no rows that the display puts into words. `agent-steps-only`: every scenario of the plan uses AI navigation, which runs only on the change. */
export const E2E_DISPLAY_BASELINE_REASONS = ["agent-steps-only"] as const;
/**
 * The informational round on the unchanged code, as display schema v3 writes it. `reason` says why a baseline that could not run did not (BASEREASON); `skippedAiScenarios` lists,
 * by id and title only, the AI-navigated scenarios a baseline that did run left out, because a baseline never runs the model. They are never result rows.
 */
export const E2EDisplayBaselineSchema = z.object({
  status: baselineStatus,
  scenarios: z.array(E2EDisplayScenarioSchema).max(64),
  reason: z.enum(E2E_DISPLAY_BASELINE_REASONS).optional(),
  skippedAiScenarios: z.array(z.object({ scenarioId: z.string().min(1).max(120), title: z.string().min(1).max(120) }).strict()).max(64).optional(),
}).strict().superRefine((baseline, context) => {
  aBaselineThatCouldNotRunHasNoRows(baseline, context);
  if (baseline.reason !== undefined && baseline.status !== "UNAVAILABLE") context.addIssue({ code: "custom", path: ["reason"], message: "only a baseline that could not run has a reason" });
  if (baseline.skippedAiScenarios !== undefined && baseline.status === "UNAVAILABLE") context.addIssue({ code: "custom", path: ["skippedAiScenarios"], message: "a baseline that could not run skipped nothing in particular" });
});
export type E2EDisplayBaseline = z.infer<typeof E2EDisplayBaselineSchema>;

export const E2EScenarioResultsSchema = z.object({
  scenarios: z.array(E2EDisplayScenarioSchema).max(64),
  baseline: E2EDisplayBaselineSchema.optional(),
}).strict();
export type E2EScenarioResults = z.infer<typeof E2EScenarioResultsSchema>;

/** Pure read projection. It consumes the entire plan, authoritative current round, and accepted group results. */
export function buildE2ESharedView(input: { plan: unknown; currentRound: unknown; results: readonly unknown[]; setup: unknown; actor: "owner" | "viewer"; control?: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] } }): E2ESharedView {
  const fallbackSetup = { status: "unavailable" as const, selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] };
  let raw: Record<string, unknown>;
  try { raw = ownInputRecord(input); }
  catch {
    const recoveredPlan = recoverOwnPlan(input);
    return recoveredPlan ? planUnknown(fallbackSetup, recoveredPlan) : empty(fallbackSetup);
  }
  const actor: "owner" | "viewer" = raw.actor === "owner" ? "owner" : "viewer";
  let control: NonNullable<typeof input.control> = { policyPresent: false, workflowPhase: null, ownerActionProposals: [] };
  let carrierBytes = 12_288;
  let planInput: unknown = null;
  let currentRoundInput: unknown = null;
  let setupInput: unknown = fallbackSetup;
  try { setupInput = copyBoundedE2EJsonData(raw.setup, { maxBytes: 262_144, maxDepth: 64 }); carrierBytes += Buffer.byteLength(canonicalJson(setupInput), "utf8"); }
  catch { /* malformed setup remains unavailable */ }
  try { if (raw.plan !== null) { planInput = copyBoundedE2EJsonData(raw.plan, { maxBytes: 262_144, maxDepth: 64 }); carrierBytes += Buffer.byteLength(canonicalJson(planInput), "utf8"); } }
  catch { /* retain no untrusted plan */ }
  try { if (raw.currentRound !== null) { currentRoundInput = copyBoundedE2EJsonData(raw.currentRound, { maxBytes: 262_144, maxDepth: 64 }); carrierBytes += Buffer.byteLength(canonicalJson(currentRoundInput), "utf8"); } }
  catch { /* no current round */ }
  try {
    if (raw.control) {
      const copied = copyBoundedE2EJsonData(raw.control, { maxBytes: 4096, maxDepth: 8 });
      const parsedControl = E2ESharedViewControlSchema.safeParse(copied);
      if (parsedControl.success) control = { ...parsedControl.data, ownerActionProposals: [...new Set(parsedControl.data.ownerActionProposals)].slice(0, 3) };
      carrierBytes += Buffer.byteLength(canonicalJson(copied), "utf8");
    }
  } catch { /* absent policy and proposals are the safe projection */ }
  let setup: E2ESharedView["setup"] = fallbackSetup;
  try { setup = E2ESharedSetupViewSchema.parse(setupInput); } catch { /* malformed projection inputs stay unavailable */ }
  let planParsed: ReturnType<typeof E2EExecutionPlanSchema.safeParse> | null = null;
  let roundParsed: ReturnType<typeof E2ERoundSchema.safeParse> | null = null;
  if (raw.plan !== null && planInput !== null) planParsed = E2EExecutionPlanSchema.safeParse(planInput);
  if (raw.currentRound !== null && currentRoundInput !== null) roundParsed = E2ERoundSchema.safeParse(currentRoundInput);
  const plan = planParsed?.success ? planParsed.data : null;
  const round = roundParsed?.success ? roundParsed.data : null;
  if (plan && (setup.executionPlanDigest !== plan.digest || canonicalJson([...setup.selectedTargetIds].sort()) !== canonicalJson(plan.effectiveTargets.map((target) => target.targetId).sort()))) setup = fallbackSetup;
  const parsedResults: E2EQualifiedResult[] = [];
  let resultsValid = true;
  try {
    const results = copyBoundedE2EJsonArrayItems(raw.results, MAX_E2E_SHARED_VIEW_RESULT_ROWS, { maxBytes: 262_144, maxDepth: 64 });
    for (const result of results) {
      carrierBytes += Buffer.byteLength(canonicalJson(result), "utf8");
      const parsed = E2EQualifiedResultSchema.safeParse(result);
      if (!parsed.success) { resultsValid = false; break; }
      parsedResults.push(parsed.data);
    }
  } catch { resultsValid = false; }
  if (carrierBytes > MAX_E2E_SHARED_VIEW_CARRIER_BYTES) resultsValid = false;
  if (!plan) return empty(setup, actor, control);
  if (!resultsValid) return planUnknown(setup, plan);
  const requiredCriteria = plan.criteria.filter((criterion) => criterion.required).length;
  const unavailableIds = new Set(plan.unavailableCriteria.map((item) => item.criterionId));
  if (!round || round.executionPlanDigest !== plan.digest) return partialEmpty(plan, setup, actor, control);
  const currentBindings = new Map(round.groupBindings.map((binding) => [binding.groupId, binding]));
  const selected: E2EQualifiedResult[] = [];
  const seen = new Map<string, E2EQualifiedResult>();
  const conflicts = new Set<string>();
  for (const result of parsedResults) {
    const binding = currentBindings.get(result.binding.groupId);
    if (!binding || canonicalJson(binding) !== canonicalJson(result.binding)) continue;
    const previous = seen.get(result.binding.runId);
    if (previous && canonicalJson(previous) !== canonicalJson(result)) { conflicts.add(result.binding.runId); continue; }
    seen.set(result.binding.runId, result);
  }
  for (const [runId, result] of seen) if (!conflicts.has(runId)) selected.push(result);
  const aggregate = aggregateE2EVerification(plan, selected, round);
  const aggregateStatus = aggregate.results.find((result) => result.checkId === "project-e2e")?.status ?? "UNKNOWN";
  const groups = new Set(selected.map((result) => result.binding.groupId));
  const executedCaseIds = new Set(selected.flatMap((result) => result.cases.filter((item) => item.status === "passed" || item.status === "failed" || item.status === "unstable" || item.status === "unavailable").map((item) => item.caseId)));
  const executedCases = executedCaseIds.size;
  const qualifiedCaseIds = new Set<string>();
  const observedMockedComponentIds = new Set<string>();
  const unexercisedBehaviors = new Set<string>();
  for (const result of selected) {
    const projected = projectE2EVerification(result).results.find((item) => item.checkId === "project-e2e")?.status;
    for (const observed of result.cases) {
      const expected = result.binding.expectedCases.find((item) => item.caseId === observed.caseId);
      const ranks = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 } as const;
      const admissionTime = Date.parse(result.binding.admittedAt);
      const deadline = Date.parse(result.binding.deadlineAt);
      const startedAt = Date.parse(result.startedAt);
      const finishedAt = Date.parse(result.finishedAt);
      const receivedAt = Date.parse(result.receivedAt);
      const resultFresh = [admissionTime, deadline, startedAt, finishedAt, receivedAt].every(Number.isFinite) && startedAt >= admissionTime && finishedAt >= startedAt && finishedAt <= deadline && receivedAt >= finishedAt && receivedAt <= deadline;
      const caseQualified = resultFresh && result.status === "passed" && result.qualification === "trusted" && result.cleanup === "confirmed" && observed.status === "passed" && expected !== undefined && observed.attemptCount === 1 && observed.executionDescriptorDigest === expected.executionDescriptorDigest && observed.accountContextId === expected.accountContextId && observed.accountContextDigest === expected.accountContextDigest && observed.assertionDigest === expected.assertionDigest && observed.assertionReceipts.length === expected.assertionDigests.length && observed.assertionReceipts.every((receipt, index) => receipt.assertionIndex === index && receipt.assertionDigest === expected.assertionDigests[index] && receipt.status === "passed") && observed.coverage.subject === "candidate" && ranks[observed.coverage.observedScope] >= ranks[expected.minimumEvidence] && expected.requiredRealComponentIds.every((id) => observed.coverage.realComponentIds.includes(id)) && observed.coverage.unexercisedBehaviors.length === 0;
      if ((projected === "PASS" || caseQualified) && expected) qualifiedCaseIds.add(expected.caseId);
      for (const componentId of observed.coverage.observedMockedComponentIds) observedMockedComponentIds.add(componentId);
      for (const behavior of observed.coverage.unexercisedBehaviors) unexercisedBehaviors.add(behavior);
    }
  }
  const qualifiedCriteriaIds = new Set(plan.criteria.filter((criterion) => criterion.expectedCaseIds.length > 0 && criterion.expectedCaseIds.every((caseId) => qualifiedCaseIds.has(caseId))).map((criterion) => criterion.criterionId));
  const requiredUnexercisedCriteriaIds = plan.criteria.filter((criterion) => criterion.required && (unavailableIds.has(criterion.criterionId) || !criterion.expectedCaseIds.length)).map((criterion) => criterion.criterionId);
  const qualifiedCriteria = [...qualifiedCriteriaIds].filter((id) => plan.criteria.find((item) => item.criterionId === id)?.required).length;
  const mode = new Set(plan.groups.map((group) => group.mode));
  const label = aggregateStatus === "FAILED" ? "Checks failed" : aggregateStatus !== "PASS" ? "Checks incomplete" : mode.size > 1 ? "Mixed runtime and mock checks" : mode.has("mock-only") ? "Checks passed with mocks" : "Runtime checks passed";
  const actions: E2ESharedView["actions"] = actor === "owner" && control.policyPresent ? control.ownerActionProposals.filter((action) => action === "review-setup" ? control.workflowPhase === "setup" && setup.status === "needs-input" : action === "retry-run" ? control.workflowPhase === "e2e" && aggregateStatus === "UNKNOWN" && plan.groups.length > 0 : control.workflowPhase === "setup" && setup.status === "mock-ready") : [];
  const projected = E2ESharedViewSchema.safeParse({ schemaVersion: 1, setup, e2e: { status: aggregateStatus, label, executionPlanDigest: plan.digest, expectedGroups: plan.groups.length, receivedGroups: groups.size, executedCases, qualifiedCriteria, requiredCriteria, unavailableCriteria: requiredCriteria - qualifiedCriteria, optionalUnavailableCriteria: plan.criteria.filter((criterion) => !criterion.required && unavailableIds.has(criterion.criterionId)).length, mockedComponentIds: [...new Set(plan.mocks.map((mock) => mock.componentId))].sort(), observedMockedComponentIds: [...observedMockedComponentIds].sort(), unexercisedBehaviors: [...unexercisedBehaviors].sort().slice(0, 256), policyPresence: control.policyPresent ? "present" : "absent", workflowPhase: control.workflowPhase, requiredUnexercisedCriteriaIds: [...new Set([...requiredUnexercisedCriteriaIds, ...plan.criteria.filter((item) => item.required && !qualifiedCriteriaIds.has(item.criterionId)).map((item) => item.criterionId)])].slice(0, 64) }, actions });
  return projected.success ? projected.data : planUnknown(setup, plan);
}
function recoverOwnPlan(value: unknown): E2EExecutionPlan | null {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "plan");
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
    const copied = copyBoundedE2EJsonData(descriptor.value, { maxBytes: 262_144, maxDepth: 64 });
    const parsed = E2EExecutionPlanSchema.safeParse(copied);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
function ownInputRecord(value: unknown): Record<string, unknown> {
  const allowed = ["plan", "currentRound", "results", "setup", "actor", "control"] as const;
  const required = ["plan", "currentRound", "results", "setup", "actor"] as const;
  if (typeof value !== "object" || value === null || types.isProxy(value)) throw new TypeError("shared view input must be an ordinary data record");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("shared view input has an unsupported prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key as typeof allowed[number])) || required.some((key) => !Object.hasOwn(descriptors, key))) throw new TypeError("shared view input fields are incomplete or unexpected");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("shared view input fields must be own data");
    output[key] = descriptor.value;
  }
  return output;
}
function partialEmpty(plan: E2EExecutionPlan, setup: E2ESharedView["setup"], actor: "owner" | "viewer", control: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] }): E2ESharedView {
  const required = plan.criteria.filter((item) => item.required);
  const projected = E2ESharedViewSchema.safeParse({ schemaVersion: 1, setup, e2e: { status: "UNKNOWN", label: "Checks incomplete", executionPlanDigest: plan.digest, expectedGroups: plan.groups.length, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: required.length, unavailableCriteria: required.length, optionalUnavailableCriteria: plan.criteria.filter((item) => !item.required).length, mockedComponentIds: [...new Set(plan.mocks.map((item) => item.componentId))].sort(), observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: control.policyPresent ? "present" : "absent", workflowPhase: control.workflowPhase, requiredUnexercisedCriteriaIds: required.map((item) => item.criterionId).slice(0, 64) }, actions: actionProposals(actor, setup, control, "UNKNOWN", plan.groups.length) });
  return projected.success ? projected.data : planUnknown(setup, plan);
}
function empty(setup: E2ESharedView["setup"], actor: "owner" | "viewer" = "viewer", control: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] } = { policyPresent: false, workflowPhase: null, ownerActionProposals: [] }): E2ESharedView {
  return { schemaVersion: 1, setup, e2e: { status: "UNKNOWN", label: "Checks incomplete", executionPlanDigest: null, expectedGroups: 0, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: 0, unavailableCriteria: 0, optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: control.policyPresent ? "present" : "absent", workflowPhase: control.workflowPhase, requiredUnexercisedCriteriaIds: [] }, actions: actionProposals(actor, setup, control, "UNKNOWN", 0) };
}
function actionProposals(actor: "owner" | "viewer", setup: E2ESharedView["setup"], control: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] }, status: "UNKNOWN" | "FAILED" | "PASS", groups: number): E2ESharedView["actions"] {
  if (actor !== "owner" || !control.policyPresent) return [];
  return control.ownerActionProposals.filter((action) => action === "review-setup" ? control.workflowPhase === "setup" && setup.status === "needs-input" : action === "retry-run" ? control.workflowPhase === "e2e" && status === "UNKNOWN" && groups > 0 : control.workflowPhase === "setup" && setup.status === "mock-ready");
}
function planUnknown(setup: E2ESharedView["setup"], plan: E2EExecutionPlan): E2ESharedView {
  const fallback = E2ESharedViewSchema.safeParse({ schemaVersion: 1, setup, e2e: { status: "UNKNOWN", label: "Checks incomplete", executionPlanDigest: plan.digest, expectedGroups: plan.groups.length, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: plan.criteria.filter((item) => item.required).length, unavailableCriteria: plan.criteria.filter((item) => item.required).length, optionalUnavailableCriteria: plan.criteria.filter((item) => !item.required).length, mockedComponentIds: [...new Set(plan.mocks.map((item) => item.componentId))].sort().slice(0, 200), observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: "absent", workflowPhase: null, requiredUnexercisedCriteriaIds: plan.criteria.filter((item) => item.required).map((item) => item.criterionId).slice(0, 64) }, actions: [] });
  return fallback.success ? fallback.data : empty(setup);
}
