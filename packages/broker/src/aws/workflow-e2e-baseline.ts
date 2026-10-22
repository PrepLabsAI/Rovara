import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EDisplayBaselineSchema, INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt, type E2EDisplayBaseline } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { UNAVAILABLE_BASELINE, baselineOf, scrubScenarioResults, type DisplayArtifact } from "../e2e/application-display.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "../e2e/application-evidence.js";
import { isConditional } from "./broker-shared.js";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts, type WorkflowE2EArtifactStore } from "./workflow-e2e-artifacts.js";

/**
 * M1.3 Task 3.7b, owner decision D2: the baseline round. When a plan with browser and API scenarios is approved, the approved scenarios run once on the unchanged code (the task's
 * base commit), so a reader can see what the change fixed. It is for information only and never gates (Review Focus 6):
 *
 *  - It is a round of its own kind: its admission and its operation sign `purpose: "baseline"`, the base commit and the attempt, and the candidate's verification refuses it.
 *  - Its outcome is one record beside the task, keyed by the approved plan, and nowhere in the workflow snapshot: it can never be a `qualifiedRound` or a `failedRound`, satisfy or
 *    block publication, or trigger send-back.
 *  - The record says when the round started and by when it must have ended, and is written conditionally (the plan, the base commit, the attempt, the operation and the round must
 *    all be the record's own), so a late or older result never overwrites a newer one. A round that never answers is shown as one that could not be run.
 *  - What it records is the broker's own verification of the evidence it accepted (`verifyBaselineEvidence`), never rows a caller supplies.
 *  - The record expires with the table's time to live, 30 days after it was last written (owner decision D4).
 *
 * If the round cannot be asked for, started or run, the display says "Couldn't run the checks on the unchanged code" and nothing else changes: not APPROVE, not the candidate's CHECKS.
 */

export const E2E_BASELINE_PURPOSE = "baseline" as const;
/** A plan's baseline is asked for once; the attempt is part of what the record, the admission and the operation sign, so a later retry can tell its own round from this one. */
export const E2E_BASELINE_ATTEMPT = 1;
/** How long after its deadline a started round is waited for before it is shown as one that could not be run. */
export const E2E_BASELINE_RUN_GRACE_MS = 5 * 60_000;

export type WorkflowE2EBaselineStore = Readonly<{ documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }>;
export type BaselineState = "REQUESTED" | "STARTED" | "RECORDED" | "UNAVAILABLE";
/** Why a baseline has no result, as a code for the record and the log; the owner reads one fixed sentence. */
export type BaselineUnavailableReason = "not-exported" | "refused" | "start-failed" | "run-failed" | "unverified" | "timed-out" | "stopped" | "cancel-unconfirmed";

export type BaselineRecord = Readonly<{
  taskId: string; contractDigest: string; attempt: number; state: BaselineState; requestedAt: string;
  baseCommitSha?: string; operationId?: string; roundId?: string; admissionSha256?: string; startedAt?: string; deadlineAt?: string;
  recordedAt?: string; reason?: string; baseline?: E2EDisplayBaseline;
}>;

const keyOf = (taskId: string, contractDigest: string) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_BASELINE#${contractDigest}` });
const expiryOf = (at: string) => indexExpiresAt(at);

/** The approved plan a baseline stands for; absent when the task has no approved application plan. */
export const baselinePlanDigestOf = (task: Pick<DeveloperTaskRecord, "workflow">): string | undefined =>
  task.workflow?.e2e?.required === true && task.workflow.e2e.applicationSelection !== undefined ? task.workflow.e2e.contractDigest : undefined;

/** Whether the project wants the baseline round: on unless its developer-task policy says `e2eBaselineRound: false`. */
export function projectE2EBaselineWanted(project: { definition: { developerTasks?: unknown } }): boolean {
  const policy = project.definition.developerTasks;
  return !(typeof policy === "object" && policy !== null && (policy as { e2eBaselineRound?: unknown }).e2eBaselineRound === false);
}

/**
 * Asks for the baseline round of a just-approved application plan, at most once per approved plan: the REQUESTED record is written only if there is none. Never changes the task. A
 * project that switched the baseline off, or a plan that is not an application plan, is asked for nothing and leaves nothing.
 */
export async function requestWorkflowE2EBaselineRound(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, options: { enabled: boolean }):
  Promise<"NOT_REQUESTED" | "REQUESTED" | "ALREADY"> {
  const contractDigest = baselinePlanDigestOf(task);
  if (!options.enabled || contractDigest === undefined) return "NOT_REQUESTED";
  const requestedAt = new Date().toISOString();
  try {
    await store.documentClient.send(new PutCommand({ TableName: store.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { ...keyOf(task.taskId, contractDigest), entityType: "WORKFLOW_E2E_BASELINE", schemaVersion: 2, taskId: task.taskId, contractDigest, purpose: E2E_BASELINE_PURPOSE,
        attempt: E2E_BASELINE_ATTEMPT, state: "REQUESTED", requestedAt, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) } }));
    return "REQUESTED";
  } catch (error) {
    if (isConditional(error)) return "ALREADY";
    throw error;
  }
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the base commit, the admission and the deadline, as one item of the transaction that
 * accepts the operation. A record that is not this plan's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function baselineStartItem(store: Pick<WorkflowE2EBaselineStore, "tableName">, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">,
  started: { baseCommitSha: string; operationId: string; roundId: string; admissionSha256: string; startedAt: string; deadlineAt: string }) {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) throw new Error("the task has no approved application plan for a baseline to belong to");
  return { Update: { TableName: store.tableName, Key: keyOf(task.taskId, contractDigest),
    UpdateExpression: "SET #state = :started, baseCommitSha = :base, operationId = :operation, roundId = :round, admissionSha256 = :admission, startedAt = :startedAt, deadlineAt = :deadline, #expires = :expires",
    ConditionExpression: "attribute_exists(pk) AND #state = :requested AND attempt = :attempt AND contractDigest = :digest",
    ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: { ":started": "STARTED", ":requested": "REQUESTED", ":attempt": E2E_BASELINE_ATTEMPT, ":digest": contractDigest, ":base": started.baseCommitSha,
      ":operation": started.operationId, ":round": started.roundId, ":admission": started.admissionSha256, ":startedAt": started.startedAt, ":deadline": started.deadlineAt,
      ":expires": expiryOf(started.startedAt) } } };
}

/**
 * Marks the plan's baseline as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A
 * recorded result is never replaced, and neither is a round another operation owns. Returns whether the record was changed.
 */
export async function markWorkflowE2EBaselineUnavailable(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, reason: BaselineUnavailableReason,
  options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) return false;
  const at = new Date().toISOString();
  const from = options.from.map((_, index) => `:from${index}`);
  try {
    await store.documentClient.send(new UpdateCommand({ TableName: store.tableName, Key: keyOf(task.taskId, contractDigest),
      UpdateExpression: "SET #state = :unavailable, #reason = :reason, recordedAt = :at, #expires = :expires",
      ConditionExpression: `attribute_exists(pk) AND contractDigest = :digest AND (${from.map((name) => `#state = ${name}`).join(" OR ")})${options.operationId === undefined ? "" : " AND operationId = :operation"}`,
      ExpressionAttributeNames: { "#state": "state", "#reason": "reason", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":unavailable": "UNAVAILABLE", ":reason": reason, ":at": at, ":expires": expiryOf(at), ":digest": contractDigest,
        ...Object.fromEntries(options.from.map((state, index) => [`:from${index}`, state])), ...(options.operationId === undefined ? {} : { ":operation": options.operationId }) } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

const VERIFIED = Symbol("verified-baseline");
/** What the broker made of the evidence of a baseline round; only `verifyBaselineEvidence` makes one. */
export type VerifiedBaseline = Readonly<{ [VERIFIED]: true; roundId: string; admissionSha256: string; baseline: E2EDisplayBaseline; artifacts: readonly DisplayArtifact[] }>;

/**
 * Verifies the evidence of a baseline round exactly as a candidate round's is verified (the admission the broker stored, the evidence it accepted, recollected and requalified by the
 * broker), for the purpose it was signed with. The rows are the verification's own display and nothing a worker says about itself. Undefined when the evidence verifies to no rows
 * at all (a refused admission, evidence that could not be read): the baseline is then one that could not be checked.
 */
export function verifyBaselineEvidence(input: Omit<ApplicationEvidenceInput, "purpose">): VerifiedBaseline | undefined {
  const verification = verifyApplicationE2EEvidence({ ...input, purpose: E2E_BASELINE_PURPOSE });
  const display = verification.display;
  if (display === undefined || display.scenarios.length === 0 || verification.round === undefined) return undefined;
  const scrubbed = scrubScenarioResults({ scenarios: [], baseline: baselineOf(display.scenarios) })?.baseline;
  if (scrubbed === undefined) return undefined;
  return { [VERIFIED]: true, roundId: verification.round.roundId, admissionSha256: input.subject.admissionSha256, baseline: scrubbed, artifacts: display.artifacts };
}

/**
 * Records the verified baseline for the round that was started, stores the screenshots behind its rows (a row whose screenshot was not stored loses its link) and writes the
 * record conditionally: only if the record still says this plan, this base commit, this attempt, this operation, this round and this admission, and is still STARTED. Returns
 * whether it was written; a record that moved on (timed out, another attempt) is left as it is.
 */
export async function recordWorkflowE2EBaseline(deps: WorkflowE2EBaselineStore & WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "taskId" | "ownerKey" | "workspaceId" | "workflow">,
  input: { verified: VerifiedBaseline; expected: { operationId: string; roundId: string; admissionSha256: string; baseCommitSha: string; attempt: number } }): Promise<boolean> {
  const contractDigest = baselinePlanDigestOf(task);
  const { verified, expected } = input;
  if (contractDigest === undefined) throw new Error("the task has no approved application plan for a baseline to belong to");
  if (verified[VERIFIED] !== true || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) throw new Error("the verification is not of the round that was started");
  const stored = await storeWorkflowE2EArtifacts(deps, task, verified.artifacts);
  const baseline = resultsWithStoredArtifacts({ scenarios: [], baseline: verified.baseline }, stored).baseline!;
  const at = new Date().toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: keyOf(task.taskId, contractDigest),
      UpdateExpression: "SET #state = :recorded, baseline = :baseline, recordedAt = :at, #expires = :expires",
      ConditionExpression: "attribute_exists(pk) AND #state = :started AND contractDigest = :digest AND attempt = :attempt AND baseCommitSha = :base AND operationId = :operation AND roundId = :round AND admissionSha256 = :admission",
      ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":recorded": "RECORDED", ":started": "STARTED", ":baseline": baseline, ":at": at, ":expires": expiryOf(at), ":digest": contractDigest, ":attempt": expected.attempt,
        ":base": expected.baseCommitSha, ":operation": expected.operationId, ":round": expected.roundId, ":admission": expected.admissionSha256 } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** The record of the task's approved plan, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EBaselineRecord(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">): Promise<BaselineRecord | undefined> {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) return undefined;
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: keyOf(task.taskId, contractDigest), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined || item.entityType !== "WORKFLOW_E2E_BASELINE" || item.taskId !== task.taskId || item.contractDigest !== contractDigest || item.purpose !== E2E_BASELINE_PURPOSE) return undefined;
  const state = item.state;
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  if (typeof item.attempt !== "number" || typeof item.requestedAt !== "string") return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const baseline = item.baseline === undefined ? undefined : E2EDisplayBaselineSchema.safeParse(item.baseline);
  if (state === "RECORDED" && baseline?.success !== true) return undefined;
  return { taskId: task.taskId, contractDigest, attempt: item.attempt, state, requestedAt: item.requestedAt, ...text("baseCommitSha"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"),
    ...text("startedAt"), ...text("deadlineAt"), ...text("recordedAt"), ...text("reason"), ...(baseline?.success === true ? { baseline: baseline.data } : {}) };
}

/**
 * What the page shows of a record: the recorded rows; the sentence for a baseline that could not be run, whether it was marked so or its round never answered (past its deadline and
 * the grace); nothing while it is only asked for or still running.
 */
export function workflowE2EBaselineView(record: BaselineRecord, nowMs: number): E2EDisplayBaseline | undefined {
  if (record.state === "RECORDED") return record.baseline === undefined ? undefined : scrubScenarioResults({ scenarios: [], baseline: record.baseline })?.baseline;
  if (record.state === "UNAVAILABLE") return UNAVAILABLE_BASELINE;
  if (record.state === "STARTED" && record.deadlineAt !== undefined && nowMs > Date.parse(record.deadlineAt) + E2E_BASELINE_RUN_GRACE_MS) return UNAVAILABLE_BASELINE;
  return undefined;
}

/** The baseline the task's page and Slack show for its approved plan, or undefined when there is nothing to show (yet). */
export async function readWorkflowE2EBaseline(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, nowMs: number = Date.now()): Promise<E2EDisplayBaseline | undefined> {
  const record = await readWorkflowE2EBaselineRecord(store, task);
  return record === undefined ? undefined : workflowE2EBaselineView(record, nowMs);
}
