// Spec 061: a plan is stored the moment the planner answers; the code it cites is read afterwards. This is the
// durable job row that asks for that read, and the step that attaches the finished bundle to the stored plan.
import { createHash } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, type PlanClaim, type PlanDocument, type PlanEvidenceBundle, type WorkflowReviewBase, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey } from "./task-records.js";

export const PLAN_EVIDENCE_PK = "PLAN_EVIDENCE";
/** The most runs a job row gets before its last bundle (unresolved places `unavailable`) is attached. */
export const PLAN_EVIDENCE_MAX_ATTEMPTS = 5;

/** The async-invoke payload that asks the PlanEvidence Lambda to work one job row. */
export const PLAN_EVIDENCE_EVENT_SOURCE = "agentx.plan-evidence";
export interface PlanEvidenceEvent { source: typeof PLAN_EVIDENCE_EVENT_SOURCE; taskId: string; artifactId: string }
export const planEvidenceEvent = (taskId: string, artifactId: string): PlanEvidenceEvent => ({ source: PLAN_EVIDENCE_EVENT_SOURCE, taskId, artifactId });
export function isPlanEvidenceEvent(event: unknown): event is PlanEvidenceEvent {
  if (event === null || typeof event !== "object") return false;
  const { source, taskId, artifactId } = event as Record<string, unknown>;
  return source === PLAN_EVIDENCE_EVENT_SOURCE && typeof taskId === "string" && taskId !== "" && typeof artifactId === "string" && artifactId !== "";
}
/** A job row is kept this long (epoch seconds, as the table's expiry), in case it is somehow never resolved. */
const PLAN_EVIDENCE_RETENTION_SECONDS = 7 * 86_400;

/**
 * The request to read a stored plan's cited code. One row per stored plan that cites code, written in the same
 * transaction as the plan. It also carries the keys of the sparse due-time index the workflow dispatch rows use
 * (`dispatchDuePk` / `dispatchDueSk`, WORKFLOW_DISPATCH_DUE_INDEX), under its own partition value `PLAN_EVIDENCE`, so
 * the sweep reads due rows with `dispatchDuePk = "PLAN_EVIDENCE" AND dispatchDueSk BETWEEN "0" AND "<planEvidenceDueKey(now)>:"`.
 * (Dispatch rows put an ISO time in `dispatchDueSk`; these put fixed-width epoch milliseconds. The partitions differ,
 * so the two never meet; keep each sweep to its own partition value.)
 */
export interface PlanEvidenceJob {
  pk: "PLAN_EVIDENCE";
  /** `${taskId}#${artifactId}` */
  sk: string;
  entityType: "PLAN_EVIDENCE";
  taskId: string;
  artifactId: string;
  artifactSha256: string;
  /** Failed runs so far. */
  attempts: number;
  /** Epoch milliseconds: when the sweep may run the row next. */
  nextAttemptAt: number;
  createdAt: string;
  /** Epoch seconds; the 7-day TTL backstop (also stored as the table's expiry attribute). */
  expiresAt: number;
  dispatchDuePk: "PLAN_EVIDENCE";
  dispatchDueSk: string;
  [INDEX_EXPIRY_ATTRIBUTE]: number;
}

/** A due time as an index sort key: fixed width, so text order is time order. */
export const planEvidenceDueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");

export function planEvidenceJobItem(input: { taskId: string; artifactId: string; artifactSha256: string; now: number }): PlanEvidenceJob {
  const sk = `${input.taskId}#${input.artifactId}`;
  const expiresAt = Math.floor(input.now / 1000) + PLAN_EVIDENCE_RETENTION_SECONDS;
  return {
    pk: PLAN_EVIDENCE_PK, sk, entityType: "PLAN_EVIDENCE",
    taskId: input.taskId, artifactId: input.artifactId, artifactSha256: input.artifactSha256,
    attempts: 0, nextAttemptAt: input.now, createdAt: new Date(input.now).toISOString(), expiresAt,
    dispatchDuePk: PLAN_EVIDENCE_PK, dispatchDueSk: `${planEvidenceDueKey(input.now)}#${sk}`,
    [INDEX_EXPIRY_ATTRIBUTE]: expiresAt,
  };
}

/** Where a task's cited code is read from: the project's repositories and the commit each started at (`reviewBase` once pinned, else the prepared base). */
export const planEvidenceSources = (
  project: { definition: { repositories: ReadonlyArray<{ name: string; path: string; url: string }> } },
  task: { workflow?: { reviewBase?: WorkflowReviewBase | undefined } | undefined; preparedBase?: WorkflowReviewBase | undefined },
) => ({
  repositories: project.definition.repositories.map((repository) => ({ name: repository.name, path: repository.path, url: repository.url })),
  base: task.workflow?.reviewBase ?? task.preparedBase,
});

const flatten = (claims: readonly PlanClaim[]): PlanClaim[] => claims.flatMap((claim) => [claim, ...flatten(claim.children ?? [])]);

/** Whether the plan cites at least one place in the code: only then is there anything to read. */
export const planCitesCode = (plan: PlanDocument): boolean =>
  flatten(plan.claims).some((claim) => (claim.evidence ?? []).some((item) => item.kind === "code"));

/**
 * Where a stored plan's late evidence is recorded. It is its own item beside the task, not part of the workflow map:
 * the workflow is rewritten whole by owner decisions and notices, and a pointer inside it would be lost by any writer
 * that read the task before the attach. Only `attachEvidence` writes this item, and it writes it once.
 */
export interface PlanEvidencePointer {
  pk: string;
  sk: string;
  entityType: "PLAN_EVIDENCE_POINTER";
  artifactId: string;
  artifactSha256: string;
  objectKey: string;
  sha256: string;
  attachedAt: string;
}

export const planEvidencePointerKey = (taskId: string, artifactId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `PLAN_EVIDENCE#${artifactId}` });

export interface AttachEvidenceDependencies {
  documentClient: { send(command: never): Promise<unknown> };
  s3: { send(command: never): Promise<unknown> };
  tableName: string;
  bucketName: string;
  now(): number;
}

/**
 * Saves the cited code beside the plan and records where it is. The record is a separate item (see
 * `PlanEvidencePointer`), put once with `attribute_not_exists(pk)`, so it never touches the workflow (its revision, the
 * document's digest, any decision) and no whole-workflow write can erase it. The bundle's object key carries its own
 * digest, so two runs that hold different bundles write different objects, and the pointer that wins always matches
 * the bytes it names; the loser's object is an unused orphan.
 * "gone": the task or the artifact (or this digest) is not there; "already": evidence was attached before (by an
 * earlier run or one that won the race), or the plan was stored with its evidence.
 */
export async function attachEvidence(
  deps: AttachEvidenceDependencies,
  input: { taskId: string; artifactId: string; artifactSha256: string; bundle: PlanEvidenceBundle; prefix: string },
): Promise<"attached" | "already" | "gone"> {
  const read = async (key: { pk: string; sk: string }) =>
    (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }) as never) as { Item?: Record<string, unknown> }).Item;
  const workflow = (await read(taskKey(input.taskId)))?.workflow as WorkflowSnapshot | undefined;
  const artifact = workflow?.artifacts.find((entry) => entry.id === input.artifactId);
  if (artifact === undefined || artifact.sha256 !== input.artifactSha256 || artifact.format !== "structured") return "gone";
  if (artifact.evidence !== undefined || await read(planEvidencePointerKey(input.taskId, input.artifactId)) !== undefined) return "already";
  const evidenceJson = JSON.stringify(input.bundle);
  const sha256 = createHash("sha256").update(evidenceJson, "utf8").digest("hex");
  const objectKey = `${input.prefix}.evidence.${sha256}.json`;
  await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucketName, Key: objectKey, Body: evidenceJson, ContentType: "application/json" }) as never);
  const pointer: PlanEvidencePointer = {
    ...planEvidencePointerKey(input.taskId, input.artifactId), entityType: "PLAN_EVIDENCE_POINTER",
    artifactId: input.artifactId, artifactSha256: input.artifactSha256, objectKey, sha256, attachedAt: new Date(deps.now()).toISOString(),
  };
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: pointer, ConditionExpression: "attribute_not_exists(pk)" }) as never);
    return "attached";
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return "already";
    throw error;
  }
}
