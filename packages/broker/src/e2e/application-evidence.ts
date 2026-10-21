import { createHash } from "node:crypto";
import { E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, canonicalJson, e2ePlanHasCompleteRequiredCriteria, type E2EApplicationExecutionAdmission, type E2EDisplayScenario,
  type E2EExecutionPlan, type E2ERound, type E2EQualifiedResult } from "@agentx/contracts";
import { createE2EApplicationCollectionOracleFromCompiledSuite, decodeE2EApplicationExecutionAdmission, dockerOwnedCleanupReceipt, dockerOwnedResourceInventoryDigest,
  e2eApplicationAggregateRunUsage, e2eApplicationHostedMockOrigins, e2eApplicationPrivateTransferMaxBytes, installedE2EApplicationStateProbeAsset, parseE2EApplicationReport, qualifyE2EApplicationCollection, validateE2EApplicationExecutionAdmission,
  type E2ECompiledApplicationSuite } from "@agentx/verifier";
import { buildScenarioRows, readCaptureScreenshots, type DisplayArtifact, type DisplayGroupInput } from "./application-display.js";
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
  purpose?: "candidate" | "baseline";
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

export type ApplicationGroupVerification = Readonly<{ runId: string; groupId: string; verdict: E2EVerdict; reason: string }>;
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
      const verified = requalifyGroup({ suite, groupRun, binding, round: admission.round, receivedAt: input.receivedAt.get(binding.runId) });
      groups.push({ runId: binding.runId, groupId: binding.groupId, verdict: verified.verdict, reason: verified.reason });
      if (verified.result !== undefined) results.push(verified.result);
      displayGroups.push({ runId: binding.runId, group: { ...displayBase, verdict: verified.verdict, reason: verified.reason, observed: verified.observed ?? new Map(),
        screenshots: readCaptureScreenshots(groupRun.operatorEvidence, new Set(binding.expectedCases.map((item) => item.caseId))) } });
    }
    if (aggregateRuns !== undefined && !same([...aggregateRuns.keys()].sort(), [...runIds].sort())) refuse("the aggregate does not cover the admitted groups exactly once");

    const combined = combineE2EVerdicts(groups.map((group) => group.verdict));
    // What is shown of the groups is held to the same rule as the verdict: without the round's aggregate and a successful end of the operation, no group's result is
    // authoritative, so none is shown as passed or failed (a group's result with nothing but its own upload behind it is a claim in flight).
    const authoritative = aggregateRuns !== undefined && input.terminalStatus === "SUCCEEDED";
    const shown = authoritative ? results : results.map((result): E2EQualifiedResult => ({ ...result, status: "unavailable", reason: "application-round-not-complete" }));
    const reasonOf = (verdict: E2EVerdict) => groups.filter((group) => group.verdict === verdict).map((group) => `${group.groupId}: ${group.reason}`).join("; ");
    // The rows are held to the same rule as the verdict: shown only for a round the broker accepted whole, and never able to change what the verdict decided.
    const display = displayOf({ plan, authoritative, purpose: input.purpose ?? "candidate", groups: displayGroups, shown });
    if (aggregateRuns === undefined) {
      return { verdict: "UNKNOWN", reason: "the round's aggregate evidence has not been accepted, so no group result is authoritative", plan, round, groups, results: shown, ...display };
    }
    if (combined === "FAILED") return { verdict: "FAILED", reason: reasonOf("FAILED"), plan, round, groups, results: shown, ...display };
    if (combined !== "PASS") return { verdict: "UNKNOWN", reason: reasonOf("UNKNOWN"), plan, round, groups, results: shown, ...display };
    if (input.terminalStatus !== "SUCCEEDED") {
      return { verdict: "UNKNOWN", reason: input.terminalStatus === undefined ? "the CHECKS operation has not ended" : "the CHECKS operation did not end successfully", plan, round, groups, results: shown, ...display };
    }
    if (!e2ePlanHasCompleteRequiredCriteria(plan)) return { verdict: "UNKNOWN", reason: "a required criterion has no executable scenario", plan, round, groups, results: shown, ...display };
    return { verdict: "PASS", reason: "every admitted application group was independently re-collected as passing", plan, round, groups, results: shown, ...display };
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

type Requalified = { verdict: E2EVerdict; reason: string; result?: E2EQualifiedResult; observed?: ReadonlyMap<string, ObservedAssertion[]> };
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
function requalifyGroup(input: { suite: E2ECompiledApplicationSuite; groupRun: Json; binding: ApplicationEvidenceBinding; round: E2ERound; receivedAt: string | undefined }): Requalified {
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
    const runtime = suite.runtimeBindings.get(suite.group.runtimeProfileId);
    if (runtime === undefined || !same(inputs.environment, runtime.runnerEnvironment)) return unknown("the runner's environment is not the admitted runtime's environment");
    if (!same(inputs.limits, APPLICATION_RUNNER_LIMITS)) return unknown("the runner's limits are not the configured limits");
    if (!Array.isArray(inputs.governedModelReceipts) || inputs.governedModelReceipts.length !== 0) return unknown("a run with no model route cannot carry model receipts");
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
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite({ compiled: suite, binding, round, environment: runtime.runnerEnvironment, usage, limits: APPLICATION_RUNNER_LIMITS,
      expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: inventoryDigest, observationBindings: inputs.observationBindings as never,
      assertionAssets: inputs.assertionAssets as never, governedModelReceipts: [], ownedClosedAt: inputs.ownedClosedAt });
    const qualification = qualifyE2EApplicationCollection(oracle, { ...collection, receivedAt: new Date(receivedAt).toISOString() } as never);
    const promoted = qualification.result === null ? undefined : { ...qualification.result, producer: "broker-independent-e2e-verifier", qualification: "trusted" as const };
    // What the assertions observed is read only from a collection the qualifier carried through to a result: it checked every captured value against the raw observation bytes
    // it re-derived the value from, and refuses the whole group on any difference. A group without a result shows no observed value.
    const observed = promoted === undefined ? undefined : observedAssertions(collection);
    if (qualification.status !== "PASS") return { verdict: qualification.status, reason: qualification.reason.slice(0, OWNER_REASON_MAX_CHARS), ...(promoted === undefined ? {} : { result: promoted }), ...(observed === undefined ? {} : { observed }) };
    // A pass also needs the host's own lifecycle to say the run ended cleanly: confirmed cleanup, no timeout or abort, a zero exit code, and no unavailable reason.
    const lifecycle = isObject(groupRun.lifecycle) ? groupRun.lifecycle : undefined;
    const processResult = isObject(lifecycle?.process) ? lifecycle.process : undefined;
    if (lifecycle?.cleanup !== "confirmed" || processResult?.exitCode !== 0 || processResult.timedOut !== false || processResult.aborted !== false || groupRun.unavailableReason !== null) {
      return { verdict: "UNKNOWN", reason: "the group's lifecycle does not confirm a clean, successful run",
        ...(promoted === undefined ? {} : { result: { ...promoted, status: "unavailable", reason: "application-lifecycle-unconfirmed" } }), ...(observed === undefined ? {} : { observed }) };
    }
    return { verdict: "PASS", reason: qualification.reason, ...(promoted === undefined ? {} : { result: promoted }), ...(observed === undefined ? {} : { observed }) };
  } catch (error) {
    return unknown(error instanceof Error && error.message !== "" ? error.message.slice(0, OWNER_REASON_MAX_CHARS) : "the group's evidence could not be requalified");
  }
}
type ApplicationEvidenceBinding = Parameters<typeof createE2EApplicationCollectionOracleFromCompiledSuite>[0]["binding"];
