import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EDisplayBaselineSchema, INDEX_EXPIRY_ATTRIBUTE, PlanQualityFindingSchema, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, indexExpiresAt, type E2EDisplayBaseline, type PlanQualityFinding } from "@agentx/contracts";
import { z } from "zod";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { groundingFindingsOf } from "../developer/plan-grounding-findings.js";
import { baselineOf, scrubScenarioResults, type DisplayArtifact } from "../e2e/application-display.js";
import { ApplicationBaselineSkipped, ApplicationDispatchRefusal } from "../e2e/application-dispatch-check.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "../e2e/application-evidence.js";
import { isConditional } from "./broker-shared.js";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts, type WorkflowE2EArtifactStore } from "./workflow-e2e-artifacts.js";

/**
 * T7b PLANGROUNDING: the grounding round. Before the owner is asked to approve a coding plan, the plan's must-not-change scenarios (the ones that prove a "Not changing" entry and
 * need no AI navigation) run once on the unchanged code, so a plan that assumes something the current app does not do is corrected before approval. It is for information only:
 *
 *  - It is a round of its own kind. Its operation's reference signs `purpose: "grounding"`, the base commit, the attempt and the proposed plan's digest; the admission signs no member,
 *    so the broker binds it by the plan digest (`groundingPlanDigest`) and the candidate's, the baseline's and the replay's verification refuse it.
 *  - Its outcome is one record beside the task, keyed by the proposed plan artifact and the attempt, under a key and an entity type of its own. It is never written into the workflow
 *    snapshot, so it can never be a `qualifiedRound` or a `failedRound`, gate, publish or send back. The baseline reader (which AUTOFIX reads) never sees it.
 *  - The record is written conditionally (the plan, the base commit, the attempt, the operation and the round must all be the record's own), so a late result never overwrites a
 *    newer one. A round that never answers is read as one that could not be run.
 *  - What it records is the broker's own verification of the evidence it accepted, never rows a caller supplies. It expires with the table's time to live, 30 days after it was last written.
 */

export const E2E_GROUNDING_PURPOSE = "grounding" as const;
/** The first grounding round of a plan version; the second (of the corrected plan) is a different artifact and so a different record, but the attempt is signed too. */
export const E2E_GROUNDING_ATTEMPT = 1;
/** How long after its deadline a started grounding round is waited for before it is read as one that could not be run. */
export const E2E_GROUNDING_RUN_GRACE_MS = 5 * 60_000;

export type WorkflowE2EGroundingStore = Readonly<{ documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }>;
export type GroundingState = "REQUESTED" | "STARTED" | "RECORDED" | "UNAVAILABLE";
/**
 * Why a grounding round has no result, as a fixed code. These are the only reasons that are ever stored or shown; free text from a worker, git or an error never is.
 * `worker-too-old` / `not-exported` / `runtime-not-ready` / `accounts-not-ready` / `refused` / `start-failed` / `run-failed` / `unverified` / `timed-out` / `ai-only` / `disabled` are the
 * design's codes; `stopped` is a round someone stopped.
 */
export const GROUNDING_UNAVAILABLE_REASONS = ["worker-too-old", "not-exported", "runtime-not-ready", "accounts-not-ready", "refused", "start-failed", "run-failed", "unverified", "timed-out", "ai-only", "disabled", "stopped"] as const;
export type GroundingUnavailableReason = (typeof GROUNDING_UNAVAILABLE_REASONS)[number];

/** The reason a grounding round could not be started, from what building its admission threw. Only a fixed code comes out; the error's text is never kept. */
export function groundingStartFailureReason(error: unknown): GroundingUnavailableReason {
  if (error instanceof ApplicationBaselineSkipped) return "ai-only";
  if (error instanceof ApplicationDispatchRefusal) {
    // The scope of a refusal is its fixed prefix (the rest of the message is never kept).
    return error.message.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) ? "runtime-not-ready" : error.message.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) ? "accounts-not-ready" : "refused";
  }
  return "start-failed";
}

/** What a grounding record is keyed by: the task, the proposed plan artifact (by digest) and the attempt. */
export type GroundingRef = Readonly<{ taskId: string; planArtifactSha256: string; attempt: number }>;
const keyOf = (ref: GroundingRef) => ({ pk: `DEVTASK#${ref.taskId}`, sk: `E2E_GROUNDING#${ref.planArtifactSha256}#${ref.attempt}` });
const expiryOf = (at: string) => indexExpiresAt(at);
const SCENARIO_IDS = z.array(z.string().min(1).max(120)).min(1).max(32);

export type GroundingRecord = Readonly<{
  taskId: string; planArtifactSha256: string; planArtifactId: string; attempt: number; state: GroundingState; requestedAt: string; scenarioIds: string[];
  baseCommitSha?: string; operationId?: string; roundId?: string; admissionSha256?: string; startedAt?: string; deadlineAt?: string; selectionDigest?: string;
  recordedAt?: string; reason?: GroundingUnavailableReason; results?: E2EDisplayBaseline; findings?: PlanQualityFinding[];
}>;

/** Asks for the grounding round of a held plan, at most once per plan artifact and attempt: the REQUESTED record is written only if there is none. Never changes the task. */
export async function requestWorkflowE2EGroundingRound(store: WorkflowE2EGroundingStore, ref: GroundingRef, input: { scenarioIds: readonly string[]; planArtifactId: string }): Promise<"REQUESTED" | "ALREADY"> {
  const scenarioIds = SCENARIO_IDS.parse([...input.scenarioIds]);
  const requestedAt = new Date().toISOString();
  try {
    await store.documentClient.send(new PutCommand({ TableName: store.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { ...keyOf(ref), entityType: "WORKFLOW_E2E_GROUNDING", schemaVersion: 1, taskId: ref.taskId, planArtifactSha256: ref.planArtifactSha256, purpose: E2E_GROUNDING_PURPOSE,
        attempt: ref.attempt, state: "REQUESTED", requestedAt, scenarioIds, planArtifactId: input.planArtifactId, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) } }));
    return "REQUESTED";
  } catch (error) {
    if (isConditional(error)) return "ALREADY";
    throw error;
  }
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the base commit, the admission and the deadline, as one item of the transaction that accepts the
 * operation. A record that is not this plan's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function groundingStartItem(store: Pick<WorkflowE2EGroundingStore, "tableName">, ref: GroundingRef,
  started: { baseCommitSha: string; operationId: string; roundId: string; admissionSha256: string; selectionDigest: string; startedAt: string; deadlineAt: string }) {
  return { Update: { TableName: store.tableName, Key: keyOf(ref),
    UpdateExpression: "SET #state = :started, baseCommitSha = :base, operationId = :operation, roundId = :round, admissionSha256 = :admission, selectionDigest = :selection, startedAt = :startedAt, deadlineAt = :deadline, #expires = :expires",
    ConditionExpression: "attribute_exists(pk) AND #state = :requested AND attempt = :attempt AND planArtifactSha256 = :plan AND entityType = :entity",
    ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: { ":started": "STARTED", ":requested": "REQUESTED", ":attempt": ref.attempt, ":plan": ref.planArtifactSha256, ":entity": "WORKFLOW_E2E_GROUNDING", ":base": started.baseCommitSha,
      ":operation": started.operationId, ":round": started.roundId, ":admission": started.admissionSha256, ":selection": started.selectionDigest, ":startedAt": started.startedAt,
      ":deadline": started.deadlineAt, ":expires": expiryOf(started.startedAt) } } };
}

/**
 * Marks a grounding round as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A recorded
 * result is never replaced, and neither is a round another operation owns. Returns whether the record was changed. Only a fixed reason code is ever written.
 */
export async function markWorkflowE2EGroundingUnavailable(store: WorkflowE2EGroundingStore, ref: GroundingRef, reason: GroundingUnavailableReason,
  options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  if (!(GROUNDING_UNAVAILABLE_REASONS as readonly string[]).includes(reason)) throw new Error("a grounding round is marked unavailable only with a fixed reason");
  const at = new Date().toISOString();
  const from = options.from.map((_, index) => `:from${index}`);
  try {
    await store.documentClient.send(new UpdateCommand({ TableName: store.tableName, Key: keyOf(ref),
      UpdateExpression: "SET #state = :unavailable, #reason = :reason, recordedAt = :at, #expires = :expires",
      ConditionExpression: `attribute_exists(pk) AND entityType = :entity AND planArtifactSha256 = :plan AND attempt = :attempt AND (${from.map((name) => `#state = ${name}`).join(" OR ")})${options.operationId === undefined ? "" : " AND operationId = :operation"}`,
      ExpressionAttributeNames: { "#state": "state", "#reason": "reason", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":unavailable": "UNAVAILABLE", ":reason": reason, ":at": at, ":expires": expiryOf(at), ":entity": "WORKFLOW_E2E_GROUNDING", ":plan": ref.planArtifactSha256, ":attempt": ref.attempt,
        ...Object.fromEntries(options.from.map((state, index) => [`:from${index}`, state])), ...(options.operationId === undefined ? {} : { ":operation": options.operationId }) } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

const VERIFIED = Symbol("verified-grounding");
/** What the broker made of the evidence of a grounding round; only `verifyGroundingEvidence` makes one. */
export type VerifiedGrounding = Readonly<{ [VERIFIED]: true; roundId: string; admissionSha256: string; results: E2EDisplayBaseline; findings: PlanQualityFinding[]; artifacts: readonly DisplayArtifact[] }>;

/**
 * Verifies the evidence of a grounding round exactly as a candidate round's is verified (the admission the broker stored, the evidence it accepted, recollected and requalified by the
 * broker), for the purpose it was signed with: the plan digest and base commit the caller recomputed from the record. The rows are the verification's own display and nothing a worker
 * says about itself. Undefined when the evidence verifies to no rows at all.
 */
export function verifyGroundingEvidence(input: Omit<ApplicationEvidenceInput, "purpose" | "grounding"> & { grounding: NonNullable<ApplicationEvidenceInput["grounding"]> }): VerifiedGrounding | undefined {
  const verification = verifyApplicationE2EEvidence({ ...input, purpose: E2E_GROUNDING_PURPOSE });
  const display = verification.display;
  if (display === undefined || display.scenarios.length === 0 || verification.round === undefined) return undefined;
  const scrubbed = scrubScenarioResults({ scenarios: [], baseline: baselineOf(display.scenarios) })?.baseline;
  if (scrubbed === undefined) return undefined;
  return { [VERIFIED]: true, roundId: verification.round.roundId, admissionSha256: input.subject.admissionSha256, results: scrubbed, findings: groundingFindingsOf(scrubbed).findings, artifacts: display.artifacts };
}

/**
 * Records the verified result for the round that was started, stores the screenshots behind its rows (a row whose screenshot was not stored loses its link) and writes the record
 * conditionally: only if it still says this plan, this base commit, this attempt, this operation, this round and this admission, and is still STARTED. Returns whether it was written.
 */
export async function recordWorkflowE2EGrounding(deps: WorkflowE2EGroundingStore & WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId">, ref: GroundingRef,
  input: { verified: VerifiedGrounding; expected: { operationId: string; roundId: string; admissionSha256: string; baseCommitSha: string } }): Promise<boolean> {
  const { verified, expected } = input;
  if (verified[VERIFIED] !== true || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) throw new Error("the verification is not of the round that was started");
  const stored = await storeWorkflowE2EArtifacts(deps, task, verified.artifacts);
  const results = resultsWithStoredArtifacts({ scenarios: [], baseline: verified.results }, stored).baseline!;
  const at = new Date().toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: keyOf(ref),
      UpdateExpression: "SET #state = :recorded, results = :results, findings = :findings, recordedAt = :at, #expires = :expires",
      ConditionExpression: "attribute_exists(pk) AND entityType = :entity AND #state = :started AND planArtifactSha256 = :plan AND attempt = :attempt AND baseCommitSha = :base AND operationId = :operation AND roundId = :round AND admissionSha256 = :admission",
      ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":recorded": "RECORDED", ":started": "STARTED", ":results": results, ":findings": verified.findings, ":at": at, ":expires": expiryOf(at), ":entity": "WORKFLOW_E2E_GROUNDING",
        ":plan": ref.planArtifactSha256, ":attempt": ref.attempt, ":base": expected.baseCommitSha, ":operation": expected.operationId, ":round": expected.roundId, ":admission": expected.admissionSha256 } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** The grounding record of a plan artifact and attempt, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EGroundingRecord(store: WorkflowE2EGroundingStore, ref: GroundingRef): Promise<GroundingRecord | undefined> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: keyOf(ref), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined || item.entityType !== "WORKFLOW_E2E_GROUNDING" || item.taskId !== ref.taskId || item.planArtifactSha256 !== ref.planArtifactSha256 || item.attempt !== ref.attempt
    || item.purpose !== E2E_GROUNDING_PURPOSE) return undefined;
  const state = item.state;
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  if (typeof item.requestedAt !== "string" || typeof item.planArtifactId !== "string") return undefined;
  const scenarioIds = SCENARIO_IDS.safeParse(item.scenarioIds);
  if (!scenarioIds.success) return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const results = item.results === undefined ? undefined : E2EDisplayBaselineSchema.safeParse(item.results);
  const findings = item.findings === undefined ? undefined : z.array(PlanQualityFindingSchema).max(64).safeParse(item.findings);
  // A recorded result that cannot be read whole is no result: the round is then read as one that could not be run.
  if (state === "RECORDED" && (results?.success !== true || findings?.success !== true)) return undefined;
  const reason = (GROUNDING_UNAVAILABLE_REASONS as readonly unknown[]).includes(item.reason) ? { reason: item.reason as GroundingUnavailableReason } : {};
  return { taskId: ref.taskId, planArtifactSha256: ref.planArtifactSha256, planArtifactId: item.planArtifactId, attempt: ref.attempt, state, requestedAt: item.requestedAt, scenarioIds: scenarioIds.data,
    ...text("baseCommitSha"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"), ...text("startedAt"), ...text("deadlineAt"), ...text("selectionDigest"), ...text("recordedAt"),
    ...reason, ...(results?.success === true ? { results: results.data } : {}), ...(findings?.success === true ? { findings: findings.data } : {}) };
}

/** Whether a started round has run out of time (its deadline plus the grace); a started record whose deadline cannot be read is late (it fails open). */
export function groundingRoundLapsed(record: GroundingRecord, nowMs: number): boolean {
  if (record.state !== "STARTED") return false;
  const limit = Date.parse(record.deadlineAt ?? "") + E2E_GROUNDING_RUN_GRACE_MS;
  return !Number.isFinite(limit) || nowMs > limit;
}
