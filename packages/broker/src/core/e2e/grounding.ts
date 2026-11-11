// The grounding round, on the document store. Before the owner is asked to approve a coding plan, the plan's must-not-change scenarios (the ones that prove a "Not changing" entry and
// need no AI navigation) run once on the unchanged code, so a plan that assumes something the current app does not do is corrected before approval. It is for information only:
//
//  - It is a round of its own kind. Its operation's reference signs `purpose: "grounding"`, the base commit, the attempt and the proposed plan's digest, and the candidate's, the baseline's
//    and the replay's verification refuse it.
//  - Its outcome is one record beside the task, keyed by the proposed plan artifact and the attempt, under a key and an entity type of its own. It is never written into the workflow
//    snapshot, so it can never be a qualified or a failed round, gate, publish or send back. The baseline reader never sees it.
//  - The record is written conditionally (the plan, the base commit, the attempt, the operation and the round must all be the record's own), so a late result never overwrites a newer
//    one. A round that never answers is read as one that could not be run.
//  - What it records is the broker's own verification of the evidence it accepted, never rows a caller supplies. It expires 30 days after it was last written.
//
// The key (`DEVTASK#<task>` / `E2E_GROUNDING#<plan digest>#<attempt>`) and every attribute are Cloud's: no stored-key difference. The pure parts are the ones in `aws/workflow-e2e-grounding.ts`.
import { E2EDisplayBaselineSchema, INDEX_EXPIRY_ATTRIBUTE, PlanQualityFindingSchema, change, indexExpiresAt, when, type TransactItem } from "@agentx/contracts";
import { z } from "zod";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import {
  E2E_GROUNDING_PURPOSE, GROUNDING_UNAVAILABLE_REASONS, type GroundingRecord, type GroundingRef, type GroundingUnavailableReason, type VerifiedGrounding,
} from "../../e2e/grounding-round.js";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts, type WorkflowE2EArtifactStore } from "./artifacts.js";
import { asDocument, isVerifiedBy, stampOf, type E2EStateStore } from "./state.js";

export {
  E2E_GROUNDING_ATTEMPT, E2E_GROUNDING_PURPOSE, E2E_GROUNDING_RUN_GRACE_MS, GROUNDING_UNAVAILABLE_REASONS, groundingRoundLapsed, groundingStartFailureReason, verifyGroundingEvidence,
  type GroundingRecord, type GroundingRef, type GroundingState, type GroundingUnavailableReason, type VerifiedGrounding,
} from "../../e2e/grounding-round.js";

export type WorkflowE2EGroundingStore = E2EStateStore;

const keyOf = (ref: GroundingRef) => ({ pk: `DEVTASK#${ref.taskId}`, sk: `E2E_GROUNDING#${ref.planArtifactSha256}#${ref.attempt}` });
const expiryOf = (at: string) => indexExpiresAt(at);
const SCENARIO_IDS = z.array(z.string().min(1).max(120)).min(1).max(32);

/** Asks for the grounding round of a held plan, at most once per plan artifact and attempt: the REQUESTED record is written only if there is none. Never changes the task. */
export async function requestWorkflowE2EGroundingRound(store: WorkflowE2EGroundingStore, ref: GroundingRef, input: { scenarioIds: readonly string[]; planArtifactId: string }): Promise<"REQUESTED" | "ALREADY"> {
  const scenarioIds = SCENARIO_IDS.parse([...input.scenarioIds]);
  const requestedAt = stampOf(store);
  const written = await store.store.put({ condition: when.absent(),
    item: asDocument({ ...keyOf(ref), entityType: "WORKFLOW_E2E_GROUNDING", schemaVersion: 1, taskId: ref.taskId, planArtifactSha256: ref.planArtifactSha256, purpose: E2E_GROUNDING_PURPOSE,
      attempt: ref.attempt, state: "REQUESTED", requestedAt, scenarioIds, planArtifactId: input.planArtifactId, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) }) });
  return written.applied ? "REQUESTED" : "ALREADY";
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the base commit, the admission and the deadline, as one item of the transaction that accepts the
 * operation. A record that is not this plan's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function groundingStartItem(ref: GroundingRef,
  started: { baseCommitSha: string; operationId: string; roundId: string; admissionSha256: string; selectionDigest: string; startedAt: string; deadlineAt: string }): TransactItem {
  return { kind: "update", key: keyOf(ref),
    ops: [change.set("state", "STARTED"), change.set("baseCommitSha", started.baseCommitSha), change.set("operationId", started.operationId), change.set("roundId", started.roundId),
      change.set("admissionSha256", started.admissionSha256), change.set("selectionDigest", started.selectionDigest), change.set("startedAt", started.startedAt),
      change.set("deadlineAt", started.deadlineAt), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(started.startedAt))],
    condition: when.and(when.present(), when.eq("state", "REQUESTED"), when.eq("attempt", ref.attempt), when.eq("planArtifactSha256", ref.planArtifactSha256), when.eq("entityType", "WORKFLOW_E2E_GROUNDING")) };
}

/**
 * Marks a grounding round as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A recorded
 * result is never replaced, and neither is a round another operation owns. Returns whether the record was changed. Only a fixed reason code is ever written.
 */
export async function markWorkflowE2EGroundingUnavailable(store: WorkflowE2EGroundingStore, ref: GroundingRef, reason: GroundingUnavailableReason,
  options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  if (!(GROUNDING_UNAVAILABLE_REASONS as readonly string[]).includes(reason)) throw new Error("a grounding round is marked unavailable only with a fixed reason");
  const at = stampOf(store);
  const written = await store.store.update({ key: keyOf(ref),
    ops: [change.set("state", "UNAVAILABLE"), change.set("reason", reason), change.set("recordedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(at))],
    condition: when.and(when.present(), when.eq("entityType", "WORKFLOW_E2E_GROUNDING"), when.eq("planArtifactSha256", ref.planArtifactSha256), when.eq("attempt", ref.attempt),
      when.or(...options.from.map((state) => when.eq("state", state))), ...(options.operationId === undefined ? [] : [when.eq("operationId", options.operationId)])) });
  return written.applied;
}

/**
 * Records the verified result for the round that was started, stores the screenshots behind its rows (a row whose screenshot was not stored loses its link) and writes the record
 * conditionally: only if it still says this plan, this base commit, this attempt, this operation, this round and this admission, and is still STARTED. Returns whether it was written.
 */
export async function recordWorkflowE2EGrounding(deps: WorkflowE2EGroundingStore & WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "ownerKey" | "workspaceId">, ref: GroundingRef,
  input: { verified: VerifiedGrounding; expected: { operationId: string; roundId: string; admissionSha256: string; baseCommitSha: string } }): Promise<boolean> {
  const { verified, expected } = input;
  if (!isVerifiedBy(verified, "verified-grounding") || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) throw new Error("the verification is not of the round that was started");
  const stored = await storeWorkflowE2EArtifacts(deps, task, verified.artifacts);
  const results = resultsWithStoredArtifacts({ scenarios: [], baseline: verified.results }, stored).baseline!;
  const at = stampOf(deps);
  const written = await deps.store.update({ key: keyOf(ref),
    ops: [change.set("state", "RECORDED"), change.set("results", results as never), change.set("findings", verified.findings as never), change.set("recordedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(at))],
    condition: when.and(when.present(), when.eq("entityType", "WORKFLOW_E2E_GROUNDING"), when.eq("state", "STARTED"), when.eq("planArtifactSha256", ref.planArtifactSha256), when.eq("attempt", ref.attempt),
      when.eq("baseCommitSha", expected.baseCommitSha), when.eq("operationId", expected.operationId), when.eq("roundId", expected.roundId), when.eq("admissionSha256", expected.admissionSha256)) });
  return written.applied;
}

/** The grounding record of a plan artifact and attempt, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EGroundingRecord(store: WorkflowE2EGroundingStore, ref: GroundingRef): Promise<GroundingRecord | undefined> {
  const item = await store.store.get(keyOf(ref));
  if (item === undefined || item["entityType"] !== "WORKFLOW_E2E_GROUNDING" || item["taskId"] !== ref.taskId || item["planArtifactSha256"] !== ref.planArtifactSha256 || item["attempt"] !== ref.attempt
    || item["purpose"] !== E2E_GROUNDING_PURPOSE) return undefined;
  const state = item["state"];
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  const requestedAt = item["requestedAt"];
  const planArtifactId = item["planArtifactId"];
  if (typeof requestedAt !== "string" || typeof planArtifactId !== "string") return undefined;
  const scenarioIds = SCENARIO_IDS.safeParse(item["scenarioIds"]);
  if (!scenarioIds.success) return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const results = item["results"] === undefined ? undefined : E2EDisplayBaselineSchema.safeParse(item["results"]);
  const findings = item["findings"] === undefined ? undefined : z.array(PlanQualityFindingSchema).max(64).safeParse(item["findings"]);
  // A recorded result that cannot be read whole is no result: the round is then read as one that could not be run.
  if (state === "RECORDED" && (results?.success !== true || findings?.success !== true)) return undefined;
  const reason = (GROUNDING_UNAVAILABLE_REASONS as readonly unknown[]).includes(item["reason"]) ? { reason: item["reason"] as GroundingUnavailableReason } : {};
  return { taskId: ref.taskId, planArtifactSha256: ref.planArtifactSha256, planArtifactId, attempt: ref.attempt, state, requestedAt, scenarioIds: scenarioIds.data,
    ...text("baseCommitSha"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"), ...text("startedAt"), ...text("deadlineAt"), ...text("selectionDigest"), ...text("recordedAt"),
    ...reason, ...(results?.success === true ? { results: results.data } : {}), ...(findings?.success === true ? { findings: findings.data } : {}) };
}
