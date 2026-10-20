import { createHash } from "node:crypto";
import { canonicalJson, e2ePlanHasCompleteRequiredCriteria, type E2EExecutionPlan, type E2ERound, type E2EQualifiedResult } from "@agentx/contracts";
import { createE2EApplicationCollectionOracleFromCompiledSuite, decodeE2EApplicationExecutionAdmission, dockerOwnedCleanupReceipt, dockerOwnedResourceInventoryDigest,
  e2eApplicationAggregateRunUsage, parseE2EApplicationReport, qualifyE2EApplicationCollection, validateE2EApplicationExecutionAdmission,
  type E2ECompiledApplicationSuite } from "@agentx/verifier";
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
}>;

export type ApplicationGroupVerification = Readonly<{ runId: string; groupId: string; verdict: E2EVerdict; reason: string }>;
export type ApplicationEvidenceVerification = Readonly<{
  verdict: E2EVerdict; reason: string;
  /** Present once the admission itself verified: what the round was meant to cover. */
  plan?: E2EExecutionPlan; round?: E2ERound;
  groups: readonly ApplicationGroupVerification[];
  /** The broker's own projection of every group it re-collected, for display; never read as a verdict. */
  results: readonly E2EQualifiedResult[];
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
    // Run ids are unique within a round (the round schema refuses a repeat when the admission decodes), so equal sets are equal lists.
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
    for (const suite of validated.applicationSuites) {
      const groupAdmission = admission.groups.find((group) => group.outerBinding.groupId === suite.group.groupId);
      if (groupAdmission === undefined || groupAdmission.protocol !== "trusted-e2e-application/v1") refuse("an application group is not admitted");
      const binding = groupAdmission.outerBinding;
      const roundBinding = admission.round.groupBindings.find((item) => item.groupId === binding.groupId);
      const planGroup = plan.groups.find((group) => group.groupId === binding.groupId);
      if (!same(roundBinding, binding) || planGroup === undefined) refuse("a group binding differs from the admitted round or plan");
      const envelope = input.groupEvidence.get(binding.runId);
      if (envelope === undefined) {
        groups.push({ runId: binding.runId, groupId: binding.groupId, verdict: "UNKNOWN", reason: "no result was accepted for this group" });
        continue;
      }
      const groupRun = readGroupEnvelope(envelope, admission, subject, planGroup, binding);
      if (aggregateRuns !== undefined && !same(aggregateRuns.get(binding.runId), groupRun)) refuse("the aggregate differs from a group result accepted on its own");
      const verified = requalifyGroup({ suite, groupRun, binding, round: admission.round, receivedAt: input.receivedAt.get(binding.runId) });
      groups.push({ runId: binding.runId, groupId: binding.groupId, verdict: verified.verdict, reason: verified.reason });
      if (verified.result !== undefined) results.push(verified.result);
    }
    if (aggregateRuns !== undefined && !same([...aggregateRuns.keys()].sort(), [...runIds].sort())) refuse("the aggregate does not cover the admitted groups exactly once");

    const combined = combineE2EVerdicts(groups.map((group) => group.verdict));
    const reasonOf = (verdict: E2EVerdict) => groups.filter((group) => group.verdict === verdict).map((group) => `${group.groupId}: ${group.reason}`).join("; ");
    if (aggregateRuns === undefined) {
      return { verdict: "UNKNOWN", reason: "the round's aggregate evidence has not been accepted, so no group result is authoritative", plan, round, groups, results };
    }
    if (combined === "FAILED") return { verdict: "FAILED", reason: reasonOf("FAILED"), plan, round, groups, results };
    if (combined !== "PASS") return { verdict: "UNKNOWN", reason: reasonOf("UNKNOWN"), plan, round, groups, results };
    if (input.terminalStatus !== "SUCCEEDED") {
      return { verdict: "UNKNOWN", reason: input.terminalStatus === undefined ? "the CHECKS operation has not ended" : "the CHECKS operation did not end successfully", plan, round, groups, results };
    }
    if (!e2ePlanHasCompleteRequiredCriteria(plan)) return { verdict: "UNKNOWN", reason: "a required criterion has no executable scenario", plan, round, groups, results };
    return { verdict: "PASS", reason: "every admitted application group was independently re-collected as passing", plan, round, groups, results };
  } catch (error) {
    const reason = error instanceof Unverifiable ? error.message : `the evidence could not be verified (${error instanceof Error ? error.name : "unknown"})`;
    return { verdict: "UNKNOWN", reason, ...(plan === undefined ? {} : { plan }), ...(round === undefined ? {} : { round }), groups: [], results: [] };
  }
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

type Requalified = { verdict: E2EVerdict; reason: string; result?: E2EQualifiedResult };

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
    // The inventory digest is a pure function of the run id.
    const inventoryDigest = dockerOwnedResourceInventoryDigest(binding.runId);
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
    const expectedSupervisorReceiptRefs = [dockerOwnedCleanupReceipt(binding.runId, inputs.ownedClosedAt).ref];
    if (!same(inputs.expectedSupervisorReceiptRefs, expectedSupervisorReceiptRefs)) return unknown("the supervisor receipt is not the one derived from the run id and the close time");
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite({ compiled: suite, binding, round, environment: runtime.runnerEnvironment, usage, limits: APPLICATION_RUNNER_LIMITS,
      expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: inventoryDigest, observationBindings: inputs.observationBindings as never,
      assertionAssets: inputs.assertionAssets as never, governedModelReceipts: [], ownedClosedAt: inputs.ownedClosedAt });
    const qualification = qualifyE2EApplicationCollection(oracle, { ...collection, receivedAt: new Date(receivedAt).toISOString() } as never);
    const promoted = qualification.result === null ? undefined : { ...qualification.result, producer: "broker-independent-e2e-verifier", qualification: "trusted" as const };
    if (qualification.status !== "PASS") return { verdict: qualification.status, reason: qualification.reason.slice(0, OWNER_REASON_MAX_CHARS), ...(promoted === undefined ? {} : { result: promoted }) };
    // A pass also needs the host's own lifecycle to say the run ended cleanly: confirmed cleanup, no timeout or abort, a zero exit code, and no unavailable reason.
    const lifecycle = isObject(groupRun.lifecycle) ? groupRun.lifecycle : undefined;
    const processResult = isObject(lifecycle?.process) ? lifecycle.process : undefined;
    if (lifecycle?.cleanup !== "confirmed" || processResult?.exitCode !== 0 || processResult.timedOut !== false || processResult.aborted !== false || groupRun.unavailableReason !== null) {
      return { verdict: "UNKNOWN", reason: "the group's lifecycle does not confirm a clean, successful run",
        ...(promoted === undefined ? {} : { result: { ...promoted, status: "unavailable", reason: "application-lifecycle-unconfirmed" } }) };
    }
    return { verdict: "PASS", reason: qualification.reason, ...(promoted === undefined ? {} : { result: promoted }) };
  } catch (error) {
    return unknown(error instanceof Error && error.message !== "" ? error.message.slice(0, OWNER_REASON_MAX_CHARS) : "the group's evidence could not be requalified");
  }
}
type ApplicationEvidenceBinding = Parameters<typeof createE2EApplicationCollectionOracleFromCompiledSuite>[0]["binding"];
