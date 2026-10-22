import { createHash } from "node:crypto";
import { E2E_AGENT_TRACE_FILE_MAX_BYTES, E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, E2E_DISPLAY_ASSERTION_KINDS, canonicalJson, e2eModelRouteRevision, e2ePlanHasCompleteRequiredCriteria,
  type E2EAgentTraceBinding, type E2EApplicationExecutionAdmission, type E2EDisplayAgentNavigation, type E2EDisplayScenario, type E2EExecutionPlan, type E2EModelRouteDefinition, type E2ERound, type E2ERoundScope, type E2EQualifiedResult } from "@agentx/contracts";
import { E2EAgentModelEvidenceSchema, E2E_AGENT_TRACE_BASE64_MAX, createE2EApplicationCollectionOracleFromCompiledSuite, decodeE2EApplicationExecutionAdmission, dockerOwnedCleanupReceipt, dockerOwnedResourceInventoryDigest,
  E2E_AGENT_CONFIG_MAX_INPUT_TOKENS, e2eApplicationAggregateRunUsage, e2eApplicationGroupUsesModel, e2eCompiledRuntime, e2eApplicationHostedMockOrigins, e2eApplicationPrivateTransferMaxBytes, e2eApplicationSchemaReason, installedE2EApplicationStateProbeAsset, parseE2EApplicationReport, qualifyE2EApplicationCollection, validateE2EApplicationExecutionAdmission,
  reviewAgentTraceFile, verifiedAgentCaseLedger, type E2EAgentModelEvidence, type E2EAgentTraceCase, type E2EApplicationCaseFacts, type E2ECompiledApplicationSuite } from "@agentx/verifier";
import { readAdmittedE2EModelRoute } from "./model-route-registry.js";
import { buildScenarioRows, readCaptureScreenshots, type DisplayArtifact, type DisplayGroupInput } from "./application-display.js";
import { agentCaseDirectory, agentNavigationOf } from "./application-agent-display.js";
import { combineE2EVerdicts, type E2EVerdict } from "./verdict.js";

/** What the broker itself knows about the CHECKS operation and the admission it signed. None of it comes from the worker. */
export type ApplicationEvidenceSubject = Readonly<{
  taskId: string; operationId: string; operationFence: number; workflowRevision: number; candidateDigest: string; roundId: string;
  groupRunIds: readonly string[]; admissionSha256: string;
}>;

export type ApplicationEvidenceInput = Readonly<{
  /** The immutable admission the broker stored. */
  admissionBytes: Uint8Array;
  subject: ApplicationEvidenceSubject;
  /** The parsed aggregate `workflow-e2e-evidence/v1`, uploaded last; absent while the round is still running. */
  aggregate: unknown;
  /** The parsed per-group `workflow-e2e-group-evidence/v1` envelopes the broker accepted, by group run id (their content addresses already checked). */
  groupEvidence: ReadonlyMap<string, unknown>;
  /**
   * The broker's own receipt time of each group's accepted evidence, by group run id (for example when its upload was started and accepted). The collector
   * judges the post-close harvest window against it, never against the receipt time the worker wrote into its own collection, which is ignored.
   */
  receivedAt: ReadonlyMap<string, string>;
  /** How the CHECKS operation ended, as recorded or as it is being recorded. Only a SUCCEEDED operation can be PASS. */
  terminalStatus: "SUCCEEDED" | "FAILED" | undefined;
  /**
   * What the round is for. A `baseline` round (the unchanged code, for information only) shows a screenshot on every row; its display is the same derivation, and it is
   * never read as a verdict by anything that gates.
   */
  purpose?: "candidate" | "baseline" | "replay";
  /**
   * The definition the model route registry stores for the route revision the admission names (Task 4.4a, ruling DJ), read by the async caller with one GetItem; absent when the
   * caller had no route to read (the admission names none, or no group uses the model). The route a group's receipts are judged against is this one and nothing a worker uploads;
   * a group with an AI navigation step is UNKNOWN when the admission names a route and this is null (not in the registry) or absent.
   */
  modelRouteDefinition?: E2EModelRouteDefinition | null;
  /**
   * The scope of the round (Task FU2, AGENTSCOPE). Absent means `standard`, which is every customer round: a scripted-model receipt is not admissible in it, whatever the registry's route
   * row says about its own scope. Only a test harness that drives the scripted double through this verifier names `qualification`; no production caller does.
   */
  roundScope?: E2ERoundScope;
}>;

/**
 * What a group's evidence, and the round's aggregate, may weigh (Ruling BV): the worker's own ceilings, so the broker accepts and reads exactly what the worker may send.
 * A group's is bounded by the group ceiling and by the application transfer bound of its cases and shards; the aggregate holds every group's run once, so it is their sum,
 * and all of a round's evidence together stays within the aggregate ceiling.
 */
export function applicationEvidenceLimits(admission: Pick<E2EApplicationExecutionAdmission, "groups">): { byGroup: ReadonlyMap<string, number>; aggregate: number } {
  const byGroup = new Map<string, number>();
  for (const group of admission.groups) {
    byGroup.set(group.outerBinding.runId, Math.min(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES,
      e2eApplicationPrivateTransferMaxBytes(group.outerBinding.expectedCases.length, group.protocol === "trusted-e2e-application/v1" ? group.shards.length : 1)));
  }
  return { byGroup, aggregate: Math.min(E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, [...byGroup.values()].reduce((total, limit) => total + limit, 0)) };
}

/** Whether any case of the admission runs a scenario with an `agent` step: the one question that decides whether the model route registry is asked about the round. */
function admissionHasAgentSteps(admission: E2EApplicationExecutionAdmission): boolean {
  const agentScenarios = new Set(admission.bundle.scenarios.filter((scenario) => scenario.steps.some((step) => step.kind === "agent")).map((scenario) => scenario.scenarioId));
  return admission.groups.some((group) => group.outerBinding.expectedCases.some((expected) => agentScenarios.has(expected.scenarioId)));
}

/**
 * The registry's definition of the route revision an admission names, for a round that has an AI navigation step (Task 4.4a, ruling DJ): one keyed read, retried only for a fault it can
 * get past. `definition` is undefined when the round needs none (it names no route, or no case has an agent step) and null when the registry does not hold the revision;
 * `unavailable` when the registry could not be asked, which leaves the round unverifiable rather than judged without it.
 */
export async function modelRouteForAdmission(read: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>, admission: E2EApplicationExecutionAdmission):
  Promise<{ definition: E2EModelRouteDefinition | null | undefined } | { unavailable: string }> {
  if (admission.modelRoute === null || !admissionHasAgentSteps(admission)) return { definition: undefined };
  try { return { definition: await readAdmittedE2EModelRoute(read, admission.modelRoute) }; }
  catch { return { unavailable: "model-route-registry-unavailable" }; }
}

/**
 * A recording of a passed AI navigation step that the broker reviewed again against the ledger it verified (Task 4.6a, CAPTURE46): the step it is for, its binding and the file's bytes.
 * Present only on a round the broker decided is PASS, so a replay (Task 4.6b) can use it only then.
 */
export type VerifiedAgentTrace = Readonly<{ runId: string; caseId: string; stepIndex: number; keyHash: string; binding: E2EAgentTraceBinding; bytes: Uint8Array }>;

export type ApplicationGroupVerification = Readonly<{ runId: string; groupId: string; verdict: E2EVerdict; reason: string;
  /** What the collector saw of each case beyond its verdict (the CSV bytes' hash, and for a replay how each AI navigation step ended); absent when the group did not requalify far enough. */
  caseFacts?: ReadonlyArray<E2EApplicationCaseFacts> }>;
export type ApplicationEvidenceVerification = Readonly<{
  verdict: E2EVerdict; reason: string;
  /** Present once the admission itself verified: what the round was meant to cover. */
  plan?: E2EExecutionPlan; round?: E2ERound;
  groups: readonly ApplicationGroupVerification[];
  /** The broker's own projection of every group it re-collected, for display; never read as a verdict. */
  results: readonly E2EQualifiedResult[];
  /**
   * The per-scenario rows and the screenshots behind them, derived from the verification above and from nothing the worker says about itself (see application-display.ts).
   * Present once the admission verified. Display only: it is never read as a verdict.
   */
  display?: Readonly<{ scenarios: readonly E2EDisplayScenario[]; artifacts: readonly DisplayArtifact[] }>;
  /**
   * The recordings of the round's AI navigation steps that the broker's own review kept, in a fixed order. Present only when the round's verdict is PASS (empty for a round with no
   * recording); a recording that fails review is left out and changes nothing else about the verdict.
   */
  agentTraces?: readonly VerifiedAgentTrace[];
}>;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class Unverifiable extends Error {}
function refuse(reason: string): never { throw new Unverifiable(reason); }

/**
 * Independently decides what the evidence of an application round proves. The worker's own verdicts are never read: the broker decodes and validates
 * the admission it stored, recompiles every group from it, recollects each group from the uploaded raw evidence against that compilation, and
 * qualifies it with the application adapter, exactly as P0 does for portable rounds.
 *
 * Fails closed everywhere. A structural mismatch anywhere makes the whole round UNKNOWN. A group with no usable result, or whose raw evidence does
 * not requalify, is UNKNOWN. Evidence without the round's aggregate is non-authoritative: UNKNOWN at most, whatever its groups hold. A group's FAILED
 * stands even if a sibling is UNKNOWN (any FAILED, else any UNKNOWN, else PASS), but PASS needs every group PASS, the aggregate, a successful
 * terminal operation and a plan whose required criteria are all executable.
 */
export function verifyApplicationE2EEvidence(input: ApplicationEvidenceInput): ApplicationEvidenceVerification {
  let plan: E2EExecutionPlan | undefined;
  let round: E2ERound | undefined;
  try {
    if (sha256(input.admissionBytes) !== input.subject.admissionSha256) refuse("the stored admission does not match its content address");
    const admission = decodeE2EApplicationExecutionAdmission(input.admissionBytes);
    // M1.3 Task 3.7b: a baseline round is signed as one. It is read only as a baseline and a candidate round only as a candidate's, so evidence of the unchanged code can never become
    // a verdict on the candidate, whatever else about the operation is true.
    // M1.4 Task 4.6b: an audit replay is signed as one too, and is read only as one.
    const signedPurpose = admission.baseline !== undefined ? "baseline" : admission.replay !== undefined ? "replay" : "candidate";
    if (signedPurpose !== (input.purpose ?? "candidate")) {
      refuse(signedPurpose === "baseline" ? "the admission is a baseline round (the unchanged code), not a candidate round"
        : signedPurpose === "replay" ? "the admission is an audit replay, not a candidate round" : "the admission is a candidate round, not a baseline or replay round (the purpose differs)");
    }
    const subject = input.subject;
    // A repeated outer run id is refused by validateE2EApplicationExecutionAdmission, which ties each outer binding to the round's own bindings (whose run ids
    // the round schema keeps unique), so equal sets of run ids are equal lists.
    const runIds = admission.groups.map((group) => group.outerBinding.runId);
    if (admission.taskId !== subject.taskId || admission.operationId !== subject.operationId || admission.operationFence !== subject.operationFence
      || admission.workflowRevision !== subject.workflowRevision || admission.candidateDigest !== subject.candidateDigest
      || admission.round.roundId !== subject.roundId || admission.round.groupBindings.length !== admission.groups.length
      || !same([...runIds].sort(), [...subject.groupRunIds].sort())) {
      refuse("the admission does not match the signed CHECKS operation, candidate, round or group runs");
    }
    const validated = validateE2EApplicationExecutionAdmission(admission);
    // Portable groups of a mixed plan are verified from their own admission (Ruling BA); no second authority is read here.
    if (admission.portableProjection !== null || admission.groups.some((group) => group.protocol !== "trusted-e2e-application/v1")
      || validated.applicationSuites.length !== admission.groups.length || validated.executionPlan.groups.length !== admission.groups.length
      || validated.applicationSuites.length === 0) refuse("the admission carries groups that are not application groups, or does not cover its plan");
    plan = validated.executionPlan;
    round = admission.round;

    const aggregateRuns = readAggregate(input.aggregate, admission, subject);
    for (const runId of input.groupEvidence.keys()) if (!runIds.includes(runId)) refuse("group evidence names a run outside the admission");

    const groups: ApplicationGroupVerification[] = [];
    const agentTraces: VerifiedAgentTrace[] = [];
    const results: E2EQualifiedResult[] = [];
    const displayGroups: Array<{ runId: string; group: Omit<DisplayGroupInput, "result"> }> = [];
    for (const suite of validated.applicationSuites) {
      const groupAdmission = admission.groups.find((group) => group.outerBinding.groupId === suite.group.groupId);
      if (groupAdmission === undefined || groupAdmission.protocol !== "trusted-e2e-application/v1") refuse("an application group is not admitted");
      const binding = groupAdmission.outerBinding;
      const roundBinding = admission.round.groupBindings.find((item) => item.groupId === binding.groupId);
      const planGroup = plan.groups.find((group) => group.groupId === binding.groupId);
      if (!same(roundBinding, binding) || planGroup === undefined) refuse("a group binding differs from the admitted round or plan");
      const envelope = input.groupEvidence.get(binding.runId);
      // The group's cases and approved scenarios, which the rows of the display are built over (application-display.ts).
      const displayBase = { cases: binding.expectedCases.map((item) => ({ caseId: item.caseId, scenarioId: item.scenarioId, targetId: item.targetId, accountProfileId: item.accountProfileId })),
        scenarios: new Map(suite.bundle.scenarios.map((scenario) => [scenario.scenarioId, { assertions: scenario.assertions }] as const)) };
      if (envelope === undefined) {
        groups.push({ runId: binding.runId, groupId: binding.groupId, verdict: "UNKNOWN", reason: "no result was accepted for this group" });
        displayGroups.push({ runId: binding.runId, group: { ...displayBase, verdict: "UNKNOWN", reason: "no result was accepted for this group", observed: new Map(), screenshots: new Map() } });
        continue;
      }
      const groupRun = readGroupEnvelope(envelope, admission, subject, planGroup, binding);
      if (aggregateRuns !== undefined && !same(aggregateRuns.get(binding.runId), groupRun)) refuse("the aggregate differs from a group result accepted on its own");
      const verified = requalifyGroup({ suite, groupRun, binding, round: admission.round, receivedAt: input.receivedAt.get(binding.runId), modelRouteDefinition: input.modelRouteDefinition, ...(input.roundScope === undefined ? {} : { roundScope: input.roundScope }) });
      groups.push({ runId: binding.runId, groupId: binding.groupId, verdict: verified.verdict, reason: verified.reason, ...(verified.caseFacts === undefined ? {} : { caseFacts: verified.caseFacts }) });
      if (verified.result !== undefined) results.push(verified.result);
      if (verified.verdict === "PASS" && verified.agentTraces !== undefined) agentTraces.push(...verified.agentTraces);
      displayGroups.push({ runId: binding.runId, group: { ...displayBase, verdict: verified.verdict, reason: verified.reason, observed: verified.observed ?? new Map(),
        screenshots: readCaptureScreenshots(groupRun.operatorEvidence, new Set(binding.expectedCases.map((item) => item.caseId))), agentNavigation: verified.agentNavigation } });
    }
    if (aggregateRuns !== undefined && !same([...aggregateRuns.keys()].sort(), [...runIds].sort())) refuse("the aggregate does not cover the admitted groups exactly once");

    const combined = combineE2EVerdicts(groups.map((group) => group.verdict));
    // What is shown of the groups is held to the same rule as the verdict: without the round's aggregate and a successful end of the operation, no group's result is
    // authoritative, so none is shown as passed or failed (a group's result with nothing but its own upload behind it is a claim in flight).
    const authoritative = aggregateRuns !== undefined && input.terminalStatus === "SUCCEEDED";
    const shown = authoritative ? results : results.map((result): E2EQualifiedResult => ({ ...result, status: "unavailable", reason: "application-round-not-complete" }));
    const reasonOf = (verdict: E2EVerdict) => groups.filter((group) => group.verdict === verdict).map((group) => `${group.groupId}: ${group.reason}`).join("; ");
    // The rows are held to the same rule as the verdict: shown only for a round the broker accepted whole, and never able to change what the verdict decided.
    const display = displayOf({ plan, authoritative, purpose: input.purpose === "baseline" ? "baseline" : "candidate", groups: displayGroups, shown });
    if (aggregateRuns === undefined) {
      return { verdict: "UNKNOWN", reason: "the round's aggregate evidence has not been accepted, so no group result is authoritative", plan, round, groups, results: shown, ...display };
    }
    if (combined === "FAILED") return { verdict: "FAILED", reason: reasonOf("FAILED"), plan, round, groups, results: shown, ...display };
    if (combined !== "PASS") return { verdict: "UNKNOWN", reason: reasonOf("UNKNOWN"), plan, round, groups, results: shown, ...display };
    if (input.terminalStatus !== "SUCCEEDED") {
      return { verdict: "UNKNOWN", reason: input.terminalStatus === undefined ? "the CHECKS operation has not ended" : "the CHECKS operation did not end successfully", plan, round, groups, results: shown, ...display };
    }
    if (!e2ePlanHasCompleteRequiredCriteria(plan)) return { verdict: "UNKNOWN", reason: "a required criterion has no executable scenario", plan, round, groups, results: shown, ...display };
    return { verdict: "PASS", reason: "every admitted application group was independently re-collected as passing", plan, round, groups, results: shown, ...display, agentTraces };
  } catch (error) {
    const reason = error instanceof Unverifiable ? error.message : `the evidence could not be verified (${error instanceof Error ? error.name : "unknown"})`;
    return { verdict: "UNKNOWN", reason, ...(plan === undefined ? {} : { plan }), ...(round === undefined ? {} : { round }), groups: [], results: [] };
  }
}

/** The display of a verified round, or nothing: a failure to build rows never changes the verdict they sit beside. */
function displayOf(input: { plan: E2EExecutionPlan; authoritative: boolean; purpose: "candidate" | "baseline"; shown: readonly E2EQualifiedResult[];
  groups: ReadonlyArray<{ runId: string; group: Omit<DisplayGroupInput, "result"> }> }): { display: NonNullable<ApplicationEvidenceVerification["display"]> } | Record<string, never> {
  try {
    const targetKinds = new Map(input.plan.effectiveTargets.flatMap((target) => (target.kind === "web" || target.kind === "api" ? [[target.targetId, target.kind] as const] : [])));
    const built = buildScenarioRows({ authoritative: input.authoritative, attach: input.purpose === "baseline" ? "all" : "failed-or-incomplete", targetKinds,
      groups: input.groups.map(({ runId, group }) => ({ ...group, result: input.shown.find((result) => result.binding.runId === runId) })) });
    return { display: built };
  } catch { return {}; }
}

function readAggregate(aggregate: unknown, admission: ReturnType<typeof decodeE2EApplicationExecutionAdmission>, subject: ApplicationEvidenceSubject): Map<string, Json> | undefined {
  if (aggregate === undefined) return undefined;
  if (!isObject(aggregate) || aggregate.schemaVersion !== "workflow-e2e-evidence/v1" || aggregate.admissionSha256 !== subject.admissionSha256
    || aggregate.taskId !== subject.taskId || aggregate.operationId !== subject.operationId || aggregate.operationFence !== subject.operationFence
    || aggregate.workflowRevision !== subject.workflowRevision || aggregate.candidateDigest !== subject.candidateDigest || !same(aggregate.round, admission.round)
    || aggregate.groupRuns !== undefined || !isObject(aggregate.payload) || aggregate.payload.kind !== "application") refuse("the aggregate evidence is not bound to this admission, operation and candidate");
  const runs = (aggregate.payload).groupRuns;
  if (!Array.isArray(runs) || runs.length !== admission.groups.length) refuse("the aggregate does not hold one result per admitted group");
  const byRun = new Map<string, Json>();
  for (const raw of runs as unknown[]) {
    const binding = isObject(raw) && isObject(raw.binding) ? raw.binding : undefined;
    if (!isObject(raw) || typeof binding?.runId !== "string" || byRun.has(binding.runId)) refuse("the aggregate group results are malformed or repeated");
    byRun.set(binding.runId, raw);
  }
  return byRun;
}

function readGroupEnvelope(envelope: unknown, admission: ReturnType<typeof decodeE2EApplicationExecutionAdmission>, subject: ApplicationEvidenceSubject,
  planGroup: unknown, binding: unknown): Json {
  if (!isObject(envelope) || envelope.schemaVersion !== "workflow-e2e-group-evidence/v1" || envelope.admissionSha256 !== subject.admissionSha256
    || envelope.taskId !== subject.taskId || envelope.operationId !== subject.operationId || envelope.operationFence !== subject.operationFence
    || envelope.workflowRevision !== subject.workflowRevision || envelope.candidateDigest !== subject.candidateDigest || !same(envelope.round, admission.round)
    || !isObject(envelope.groupRun)) refuse("group evidence is not bound to this admission, operation and candidate");
  const groupRun = (envelope).groupRun;
  if (groupRun.kind !== "application" || !same(groupRun.binding, binding) || !same(groupRun.group, planGroup)) refuse("group evidence is not the admitted application group run");
  return groupRun;
}

type Requalified = { verdict: E2EVerdict; reason: string; result?: E2EQualifiedResult; agentTraces?: readonly VerifiedAgentTrace[]; observed?: ReadonlyMap<string, ObservedAssertion[]>;
  caseFacts?: ReadonlyArray<E2EApplicationCaseFacts>;
  /** How the AI navigated each case the broker decided on its assertions, from the verified action ledger (Task 4.4b); absent for a group with no AI navigation step. */
  agentNavigation?: ReadonlyMap<string, E2EDisplayAgentNavigation> };
type ObservedAssertion = { assertionIndex: number; outcome: string; value: unknown };

/** The value and outcome each case's assertions had, from the group's collection (see the note where it is read: only a collection the qualifier accepted may be read). */
function observedAssertions(collection: Json): Map<string, ObservedAssertion[]> {
  const observed = new Map<string, ObservedAssertion[]>();
  for (const capture of Array.isArray(collection.applicationCaptures) ? collection.applicationCaptures as unknown[] : []) {
    if (!isObject(capture) || typeof capture.caseId !== "string" || !Array.isArray(capture.assertions)) continue;
    observed.set(capture.caseId, (capture.assertions as unknown[]).flatMap((assertion) => isObject(assertion) && Number.isInteger(assertion.index) && typeof assertion.outcome === "string"
      ? [{ assertionIndex: assertion.index as number, outcome: assertion.outcome, value: assertion.value }] : []));
  }
  return observed;
}

/**
 * The navigation block of each case that ran AI navigation steps and that the broker decided on its assertions (passed or failed), read from the executor's action ledger. The ledger
 * is held to this run, this case, the run's value key, the approved goals and the worker's receipts for the case by `agentNavigationOf`; one that is not gives no block. The
 * receipts and the key are the group's `agentModel` evidence the broker has already judged against the registry's route, so this adds a view of what that judgement accepted and
 * decides nothing.
 */
function agentNavigations(input: { suite: E2ECompiledApplicationSuite; binding: ApplicationEvidenceBinding; evidence: E2EAgentModelEvidence; result: E2EQualifiedResult }): Map<string, E2EDisplayAgentNavigation> {
  const navigations = new Map<string, E2EDisplayAgentNavigation>();
  const route = input.evidence.route;
  if (route === null) return navigations;
  for (const expected of input.binding.expectedCases) {
    const decided = input.result.cases.find((item) => item.caseId === expected.caseId);
    if (decided === undefined || (decided.status !== "passed" && decided.status !== "failed")) continue;
    const scenario = input.suite.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
    const agentSteps = scenario === undefined ? [] : scenario.steps.flatMap((step, index) => (step.kind === "agent" ? [{ declaredStepIndex: index, goal: step.goal }] : []));
    if (scenario === undefined || agentSteps.length === 0) continue;
    const entry = input.evidence.ledgers.find((item) => item.caseDirectory === agentCaseDirectory(expected.caseId));
    const decoded = entry === undefined ? undefined : Buffer.from(entry.bytesBase64, "base64");
    const ledgerBytes = entry === undefined || decoded === undefined || decoded.toString("base64") !== entry.bytesBase64 || sha256(decoded) !== entry.sha256 ? null : new Uint8Array(decoded);
    const navigation = agentNavigationOf({ ledgerBytes, valueKey: input.evidence.valueKey, runId: input.binding.runId, caseId: expected.caseId, agentSteps,
      receipts: input.evidence.receipts.filter((receipt) => receipt.caseId === expected.caseId), routeId: route.routeId,
      decidedBy: scenario.assertions.map((assertion) => assertion.kind).filter((kind): kind is (typeof E2E_DISPLAY_ASSERTION_KINDS)[number] => (E2E_DISPLAY_ASSERTION_KINDS as readonly string[]).includes(kind)) });
    if (navigation !== undefined) navigations.set(expected.caseId, navigation);
  }
  return navigations;
}

/**
 * `agentNavigations` for the verdict's path: the block is display data and decides nothing, so a fault while deriving it drops the blocks (the rows are still shown, without a badge) and
 * leaves what the verifier decided as it is. The operator's log line has the error's name only.
 */
function safeAgentNavigations(input: Parameters<typeof agentNavigations>[0]): Map<string, E2EDisplayAgentNavigation> | undefined {
  try { return agentNavigations(input); }
  catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_agent_navigation_dropped", errorName: error instanceof Error ? error.name : "unknown" }));
    return undefined;
  }
}

/**
 * The recordings a group uploaded that pass the broker's own review (Task 4.6a): each one is a file of the contract's shape and size, for a step of a case whose ledger the broker
 * verified (held to this run, the case, the approved goals and the run's key), mapped to that step by its own provenance, matching the ledger one action at a time, and bound by the
 * very binding the upload claims. Everything else is left out. Only a group the broker decided is PASS is asked, and what this returns never changes that.
 */
function reviewedAgentTraces(input: { suite: E2ECompiledApplicationSuite; binding: ApplicationEvidenceBinding; evidence: E2EAgentModelEvidence }): VerifiedAgentTrace[] {
  const uploads = input.evidence.traces ?? [];
  if (uploads.length === 0) return [];
  const cases: E2EAgentTraceCase[] = [];
  for (const expected of input.binding.expectedCases) {
    const scenario = input.suite.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
    const steps = scenario === undefined ? [] : scenario.steps.flatMap((step, stepIndex) => (step.kind === "agent" ? [{ stepIndex, goal: step.goal }] : []));
    if (steps.length === 0) continue;
    const entry = input.evidence.ledgers.find((item) => item.caseDirectory === agentCaseDirectory(expected.caseId));
    const decoded = entry === undefined ? undefined : Buffer.from(entry.bytesBase64, "base64");
    const ledgerBytes = entry === undefined || decoded === undefined || decoded.toString("base64") !== entry.bytesBase64 || sha256(decoded) !== entry.sha256 ? null : new Uint8Array(decoded);
    cases.push({ caseId: expected.caseId, steps, ledger: verifiedAgentCaseLedger({ ledgerBytes, valueKey: input.evidence.valueKey, runId: input.binding.runId, caseId: expected.caseId, steps }) });
  }
  const kept = new Map<string, VerifiedAgentTrace>();
  const twice = new Set<string>();
  for (const upload of uploads) {
    if (upload.traceBase64.length > E2E_AGENT_TRACE_BASE64_MAX) continue;
    const bytes = Buffer.from(upload.traceBase64, "base64");
    if (bytes.toString("base64") !== upload.traceBase64 || bytes.byteLength > E2E_AGENT_TRACE_FILE_MAX_BYTES) continue;
    const review = reviewAgentTraceFile({ bytes: new Uint8Array(bytes), cases, valueKey: input.evidence.valueKey, expect: { caseDirectory: upload.caseDirectory, stepIndex: upload.stepIndex, keyHash: upload.keyHash } });
    if (!review.keep || !same(review.binding, upload.binding) || review.binding.runId !== input.binding.runId) continue;
    const key = `${review.caseId}:${review.stepIndex}`;
    if (kept.has(key)) { twice.add(key); continue; }
    kept.set(key, { runId: input.binding.runId, caseId: review.caseId, stepIndex: review.stepIndex, keyHash: review.keyHash, binding: review.binding, bytes: new Uint8Array(bytes) });
  }
  return [...kept.entries()].filter(([key]) => !twice.has(key)).map(([, trace]) => trace)
    .sort((left, right) => (left.caseId === right.caseId ? left.stepIndex - right.stepIndex : left.caseId.localeCompare(right.caseId)));
}

/** `reviewedAgentTraces` for the verdict's path: a fault while reviewing drops the recordings and leaves what the verifier decided exactly as it is. */
function safeReviewedAgentTraces(input: Parameters<typeof reviewedAgentTraces>[0]): VerifiedAgentTrace[] {
  try { return reviewedAgentTraces(input); }
  catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_agent_traces_dropped", errorName: error instanceof Error ? error.name : "unknown" }));
    return [];
  }
}

export type ExpectedAssertionAsset = Readonly<{ caseId: string; assertionIndex: number; kind: "state-probe"; id: string; manifestDigest: string; sha256: string; byteLength: number }>;
type SuiteAssertions = Readonly<{ expectedCases: readonly { caseId: string; scenarioId: string }[];
  bundle: Readonly<{ scenarios: readonly { scenarioId: string; assertions: readonly { kind: string; probeId?: string }[] }[] }> }>;

/**
 * The approved assertion assets a group's cases need, derived from the admitted scenarios and the installed fixed inventory (the executor's own state probes).
 * The documents a sample is judged against are expected values, not observations, so the broker holds them: a worker may not supply a looser schema or another
 * manifest digest. A JSON schema, a fixture root or a probe that is not installed has no installed asset, so a case that needs one is refused.
 */
export function expectedApplicationAssertionAssets(suite: SuiteAssertions): { ok: true; assets: ExpectedAssertionAsset[] } | { ok: false; reason: string } {
  const assets: ExpectedAssertionAsset[] = [];
  for (const expected of suite.expectedCases) {
    const scenario = suite.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
    if (scenario === undefined) return { ok: false, reason: "an admitted case has no scenario" };
    for (const [index, assertion] of scenario.assertions.entries()) {
      if (assertion.kind === "state") {
        const installed = typeof assertion.probeId === "string" ? installedE2EApplicationStateProbeAsset(assertion.probeId) : undefined;
        if (installed === undefined) return { ok: false, reason: "a state assertion names a probe that is not installed" };
        assets.push({ caseId: expected.caseId, assertionIndex: index, kind: "state-probe", id: assertion.probeId!, manifestDigest: installed.manifestDigest,
          sha256: installed.sha256, byteLength: installed.byteLength });
      } else if (assertion.kind === "json" || assertion.kind === "file") {
        return { ok: false, reason: `a ${assertion.kind} assertion needs an approved asset that is not installed in the executor` };
      }
    }
  }
  return { ok: true, assets };
}

/** The limits every application run's runner is configured with (the pinned runner's own, as the broker pins them for portable runs too). */
const APPLICATION_RUNNER_LIMITS = Object.freeze({ maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 });
/**
 * The limits the group's runner is configured with. A group with an agent step runs with the model ceiling its config pins (`maxInputTokens`, Task 4.3b: the route's 32000 per call),
 * which the runner reports as its own `maxModelTokensPerCall`; every other group keeps the runner's default. (The plan thought the runner limit stayed 64000: it does for a group with
 * no agent step.)
 */
const runnerLimitsFor = (suite: E2ECompiledApplicationSuite) => (e2eApplicationGroupUsesModel(suite) ? Object.freeze({ ...APPLICATION_RUNNER_LIMITS, maxModelTokensPerCall: E2E_AGENT_CONFIG_MAX_INPUT_TOKENS }) : APPLICATION_RUNNER_LIMITS);
const OWNER_REASON_MAX_CHARS = 300;

/**
 * Recollects one group from its uploaded raw evidence. The group run's own `collection` and `unavailableReason` are claims and are never read as a verdict.
 *
 * Everything the qualifier compares the worker's report against is the broker's own: the runner environment is the admitted runtime's, the limits are the
 * runner's configured ones, usage is aggregated from the raw reports, the supervisor receipt is derived from the run id and the close time, no model receipt
 * can exist, and the receipt time is the broker's. The worker's readback supplies only what the broker cannot know (the observation bindings and assertion
 * assets, which the oracle checks against the admitted account, artifact, origin and assertions, and the close time, which is bounded and tied to its receipt);
 * anything it supplies that should equal an expected value must equal it, or the group is UNKNOWN.
 */
function requalifyGroup(input: { suite: E2ECompiledApplicationSuite; groupRun: Json; binding: ApplicationEvidenceBinding; round: E2ERound; receivedAt: string | undefined;
  modelRouteDefinition: E2EModelRouteDefinition | null | undefined; roundScope?: E2ERoundScope }): Requalified {
  const { suite, groupRun, binding, round } = input;
  const actual = groupRun.actual;
  if (actual === null || actual === undefined) {
    return { verdict: "UNKNOWN", reason: typeof groupRun.unavailableReason === "string" && groupRun.unavailableReason !== "" ? groupRun.unavailableReason.slice(0, OWNER_REASON_MAX_CHARS) : "the group produced no readback" };
  }
  const unknown = (reason: string): Requalified => ({ verdict: "UNKNOWN", reason });
  try {
    if (!isObject(actual) || !isObject(actual.collectionInputs) || !isObject(actual.collection)) return unknown("the group's uploaded readback is malformed");
    const inputs = actual.collectionInputs;
    const collection = actual.collection;
    const receivedAt = input.receivedAt === undefined ? Number.NaN : Date.parse(input.receivedAt);
    if (!Number.isFinite(receivedAt)) return unknown("the broker has no receipt time for this group's evidence");
    if (receivedAt < Date.parse(round.admittedAt)) return unknown("the group's evidence was not received between the round's admission and the broker's receipt");
    // The inventory digest is a pure function of the run id and the mocked origins of the admitted plan.
    const mockOrigins = e2eApplicationHostedMockOrigins(suite).map((origin) => origin.originRef);
    const inventoryDigest = dockerOwnedResourceInventoryDigest(binding.runId, mockOrigins);
    if (inputs.ownedResourceInventoryDigest !== inventoryDigest) return unknown("the group's owned-resource inventory is not the one its run id derives");
    const runtime = e2eCompiledRuntime(suite);
    if (runtime === undefined || !same(inputs.environment, runtime.runnerEnvironment)) return unknown("the runner's environment is not the admitted runtime's environment");
    const runnerLimits = runnerLimitsFor(suite);
    if (!same(inputs.limits, runnerLimits)) return unknown("the runner's limits are not the configured limits");
    if (!Array.isArray(inputs.governedModelReceipts) || inputs.governedModelReceipts.length !== 0) return unknown("model-receipts-mismatch: M1-era model receipt rows are not how an AI navigation step is read");
    // Task 4.4a: what the worker says about its AI navigation steps is accepted exactly when the admission names a route and the group has such a step, and it is judged against the
    // registry's definition of the admitted revision (ruling DJ), never a definition the worker sends.
    const agentModel = (() => {
      const supplied = inputs.agentModel;
      const present = supplied !== undefined && supplied !== null;
      // An audit replay (Task 4.6b) has no model channel, so model evidence of any kind with it means a model was in the run.
      if (suite.runtimeAdmissionContext.replay !== undefined) return present ? ({ refuse: "replay-model-called: model evidence came with an audit replay" } as const) : ({ evidence: undefined } as const);
      if (!e2eApplicationGroupUsesModel(suite)) return present ? ({ refuse: "model-receipts-mismatch: model evidence came with a group that has no AI navigation step" } as const) : ({ evidence: undefined } as const);
      const admitted = suite.runtimeAdmissionContext.modelRoute;
      if (admitted === null) return { refuse: "agent-route-not-approved: the group has AI navigation steps and the admission pins no model route" } as const;
      if (!present) return { refuse: "model-receipts-mismatch: no model receipts or action ledgers came with the group's AI navigation steps" } as const;
      const parsed = E2EAgentModelEvidenceSchema.safeParse(supplied);
      if (!parsed.success) return { refuse: "model-receipts-mismatch: the group's model evidence is malformed" } as const;
      // The route the worker says it served must be the admitted revision (it is then ignored: the registry's definition below is what the receipts are judged against).
      if (parsed.data.route !== null && (parsed.data.route.routeId !== admitted.routeId || e2eModelRouteRevision(parsed.data.route) !== admitted.routeRevision)) {
        return { refuse: "model-receipts-mismatch: the route the worker served is not the admitted route revision" } as const;
      }
      const definition = input.modelRouteDefinition;
      if (definition === undefined || definition === null) return { refuse: "agent-route-not-approved: the admitted route revision is not in the model route registry" } as const;
      if (definition.routeId !== admitted.routeId || e2eModelRouteRevision(definition) !== admitted.routeRevision) return { refuse: "agent-route-not-approved: the registry's definition is not the admitted route revision" } as const;
      return { evidence: { ...parsed.data, route: definition } } as const;
    })();
    if ("refuse" in agentModel) return unknown(agentModel.refuse);
    const shards = Array.isArray(collection.shards) ? collection.shards as unknown[] : [];
    const usageRows = shards.map((shard) => {
      const rawReport = isObject(shard) && isObject(shard.rawReport) && typeof shard.rawReport.bytesBase64 === "string" ? shard.rawReport.bytesBase64 : undefined;
      const parsed = rawReport === undefined ? undefined : parseE2EApplicationReport(Buffer.from(rawReport, "base64"));
      return parsed?.kind === "parsed" ? parsed.report.run.usage as Readonly<Record<string, number>> : undefined;
    });
    const usage = usageRows.length === 0 || usageRows.some((row) => row === undefined) ? null : e2eApplicationAggregateRunUsage(usageRows as Readonly<Record<string, number>>[]);
    if (usage === null) return unknown("the runner's usage cannot be derived from its raw reports");
    if (!same(inputs.usage, usage)) return unknown("the readback's usage is not the usage of the runner's raw reports");
    const closedAt = typeof inputs.ownedClosedAt === "string" ? Date.parse(inputs.ownedClosedAt) : Number.NaN;
    if (!Number.isFinite(closedAt) || new Date(closedAt).toISOString() !== inputs.ownedClosedAt || closedAt < Date.parse(round.admittedAt) || closedAt > receivedAt) {
      return unknown("the group's close time is not between the round's admission and the broker's receipt");
    }
    // The one supervisor receipt the host attests is derived from the run id and the close time.
    const expectedSupervisorReceiptRefs = [dockerOwnedCleanupReceipt(binding.runId, inputs.ownedClosedAt, mockOrigins).ref];
    if (!same(inputs.expectedSupervisorReceiptRefs, expectedSupervisorReceiptRefs)) return unknown("the supervisor receipt is not the one derived from the run id and the close time");
    // The approved probe documents are the installed ones, byte for byte, with their manifest digests; only their retained references are the worker's.
    const expectedAssets = expectedApplicationAssertionAssets(suite);
    if (!expectedAssets.ok) return unknown(expectedAssets.reason);
    const order = (row: { caseId: string; assertionIndex: number }) => `${row.caseId}\u0000${String(row.assertionIndex).padStart(4, "0")}`;
    const suppliedAssets = (Array.isArray(inputs.assertionAssets) ? inputs.assertionAssets as unknown[] : []).map((raw) => {
      const row = isObject(raw) ? raw : {};
      const ref = isObject(row.ref) ? row.ref : {};
      return { caseId: row.caseId, assertionIndex: row.assertionIndex, kind: row.kind, id: row.id, manifestDigest: row.manifestDigest, sha256: ref.sha256, byteLength: ref.byteLength,
        mediaType: ref.mediaType, hasHandle: typeof ref.artifactId === "string" && ref.artifactId !== "" };
    }).sort((left, right) => order({ caseId: String(left.caseId), assertionIndex: Number(left.assertionIndex) }).localeCompare(order({ caseId: String(right.caseId), assertionIndex: Number(right.assertionIndex) })));
    const wanted = expectedAssets.assets.map((asset) => ({ ...asset, mediaType: "application/json", hasHandle: true })).sort((left, right) => order(left).localeCompare(order(right)));
    if (!same(suppliedAssets, wanted)) return unknown("the group's assertion assets are not the installed assertion assets");
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite({ compiled: suite, binding, round, environment: runtime.runnerEnvironment, usage, limits: runnerLimits,
      expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: inventoryDigest, observationBindings: inputs.observationBindings as never,
      assertionAssets: inputs.assertionAssets as never, governedModelReceipts: [], ...(agentModel.evidence === undefined ? {} : { agentModel: agentModel.evidence }), ...(input.roundScope === undefined ? {} : { roundScope: input.roundScope }), ownedClosedAt: inputs.ownedClosedAt });
    const qualification = qualifyE2EApplicationCollection(oracle, { ...collection, receivedAt: new Date(receivedAt).toISOString() } as never);
    const promoted = qualification.result === null ? undefined : { ...qualification.result, producer: "broker-independent-e2e-verifier", qualification: "trusted" as const };
    // What the assertions observed is read only from a collection the qualifier carried through to a result: it checked every captured value against the raw observation bytes
    // it re-derived the value from, and refuses the whole group on any difference. A group without a result shows no observed value.
    const observed = promoted === undefined ? undefined : observedAssertions(collection);
    // How the AI navigated, for the cases the broker decided, from the ledger verified against the registry-bound receipts (never shown for a group the qualifier did not carry to a result).
    const navigation = promoted === undefined || agentModel.evidence === undefined ? undefined : safeAgentNavigations({ suite, binding, evidence: agentModel.evidence, result: promoted });
    const shownNavigation = navigation === undefined || navigation.size === 0 ? {} : { agentNavigation: navigation };
    const caseFacts = qualification.caseFacts === undefined ? {} : { caseFacts: qualification.caseFacts };
    if (qualification.status !== "PASS") return { verdict: qualification.status, reason: qualification.reason.slice(0, OWNER_REASON_MAX_CHARS), ...(promoted === undefined ? {} : { result: promoted }), ...(observed === undefined ? {} : { observed }), ...shownNavigation, ...caseFacts };
    // A pass also needs the host's own lifecycle to say the run ended cleanly: confirmed cleanup, no timeout or abort, a zero exit code, and no unavailable reason.
    const lifecycle = isObject(groupRun.lifecycle) ? groupRun.lifecycle : undefined;
    const processResult = isObject(lifecycle?.process) ? lifecycle.process : undefined;
    if (lifecycle?.cleanup !== "confirmed" || processResult?.exitCode !== 0 || processResult.timedOut !== false || processResult.aborted !== false || groupRun.unavailableReason !== null) {
      return { verdict: "UNKNOWN", reason: "the group's lifecycle does not confirm a clean, successful run",
        ...(promoted === undefined ? {} : { result: { ...promoted, status: "unavailable", reason: "application-lifecycle-unconfirmed" } }), ...(observed === undefined ? {} : { observed }) };
    }
    const traces = agentModel.evidence === undefined ? [] : safeReviewedAgentTraces({ suite, binding, evidence: agentModel.evidence });
    return { verdict: "PASS", reason: qualification.reason, ...(promoted === undefined ? {} : { result: promoted }), ...(observed === undefined ? {} : { observed }), ...shownNavigation, ...caseFacts, agentTraces: traces };
  } catch (error) {
    // A schema refusal says what it refused as a fixed code and a path of our own schema's keys (never a key the sender chose, and never the whole issue list).
    const said = error instanceof Error && error.name === "ZodError" ? e2eApplicationSchemaReason(error as never) : error instanceof Error ? error.message : undefined;
    return unknown(said !== undefined && said !== "" ? said.slice(0, OWNER_REASON_MAX_CHARS) : "the group's evidence could not be requalified");
  }
}
type ApplicationEvidenceBinding = Parameters<typeof createE2EApplicationCollectionOracleFromCompiledSuite>[0]["binding"];
