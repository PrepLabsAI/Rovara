// Spec 061: the PlanEvidence Lambda. A stored plan that cites code has a PLAN_EVIDENCE row; this reads the cited code from
// GitHub at the task's base commit (with retries over a few minutes) and attaches it to the plan, so a slow or failing
// GitHub never holds up the plan. The broker starts the job right after the plan commits and its recovery sweep starts
// any row that is due; one worker runs a row at a time (a claim on `attempts` and the row's due time).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isConditional } from "./broker-shared.js";
import { getItem } from "./cancellation.js";
import { createGitHubAppCredentials } from "./github-credentials.js";
import { requiredEnvironment } from "./lambda.js";
import { requireProject } from "./project-records.js";
import { loadWorkflowDocument, readObjectText } from "../developer/plan-artifacts.js";
import { resolvePlanEvidence, unavailablePlanEvidence } from "../developer/plan-evidence.js";
import {
  attachEvidence, isPlanEvidenceEvent, planEvidenceDueKey, planEvidencePointerKey, planEvidenceSources, PLAN_EVIDENCE_MAX_ATTEMPTS, PLAN_EVIDENCE_PK,
  type PlanEvidenceEvent, type PlanEvidenceJob,
} from "../developer/plan-evidence-jobs.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { PlanDocument } from "@agentx/contracts";

/** All cited code must be read inside this; the Lambda's own timeout (150 s) leaves room to attach and clean up. */
const RESOLVE_DEADLINE_MS = 120_000;
/** One file read may take this long, or what is left of the resolve deadline when that is less. */
const READ_TIMEOUT_MAX_MS = 30_000;
/** A run holds its row this long (past the Lambda's timeout), so a crashed run is picked up again by the sweep. */
const CLAIM_LEASE_MS = 180_000;
/** Minutes to wait after failed run 1, 2, 3 and 4. (A run killed by the Lambda timeout is tried again when its lease ends instead.) */
const RETRY_MINUTES = [1, 2, 4, 8] as const;
const MS_PER_MINUTE = 60_000;

export interface PlanEvidenceRunDependencies {
  documentClient: DynamoDBDocumentClient;
  s3: { send(command: never): Promise<unknown> };
  tableName: string;
  bucketName: string;
  github: { getFileAtCommit: (url: string, path: string, commit: string, options: { untilLine?: number; timeoutMs?: number }) => Promise<string | undefined> };
  now: () => number;
  /** Operational log line (no model text); defaults to one JSON line on the console. */
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * What a run did: "attached" (the bundle is saved and the row removed), "already" (evidence was there; row removed),
 * "skipped" (the task is closed or the plan is gone or changed; row removed), "retry" (a later run is scheduled), "gave_up"
 * (the last attempt could not even save a bundle of unavailable places; row removed), "busy" (another run holds the row, or it is not due), "no_job" (no such row).
 */
export type PlanEvidenceRunOutcome = "attached" | "already" | "skipped" | "retry" | "gave_up" | "busy" | "no_job";

export async function runPlanEvidenceJob(deps: PlanEvidenceRunDependencies, event: Pick<PlanEvidenceEvent, "taskId" | "artifactId">): Promise<PlanEvidenceRunOutcome> {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify({ component: "plan-evidence", ...entry })));
  const { taskId, artifactId } = event;
  const rowKey = { pk: PLAN_EVIDENCE_PK, sk: `${taskId}#${artifactId}` };
  const row = await getItem<PlanEvidenceJob>(deps, rowKey);
  if (row === undefined) return "no_job";
  const removeRow = () => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: rowKey }));

  // Nothing to do when the task is closed, the plan is gone or was replaced, or its code was attached already.
  const task = await getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  const artifact = workflow?.artifacts.find((entry) => entry.id === artifactId);
  const finished = workflow !== undefined && workflow.state === "COMPLETE" && (workflow.stage === "MERGED" || workflow.stage === "CLOSED");
  const prefix = task === undefined || artifact === undefined ? undefined : `private/${task.ownerKey}/${task.workspaceId}/plan-documents/`;
  const stored = prefix !== undefined && artifact !== undefined && artifact.objectKey.startsWith(prefix) && artifact.objectKey.endsWith(".json");
  if (task === undefined || workflow === undefined || artifact === undefined || task.closedAt != null || finished || !stored
    || artifact.format !== "structured" || artifact.sha256 !== row.artifactSha256) {
    await removeRow();
    log({ event: "plan_evidence.skipped", taskId, artifactId });
    return "skipped";
  }
  if (artifact.evidence !== undefined || await getItem(deps, planEvidencePointerKey(taskId, artifactId)) !== undefined) {
    await removeRow();
    log({ event: "plan_evidence.already_attached", taskId, artifactId });
    return "already";
  }

  // Claim the run: it counts as an attempt (a crash is one too) and holds the row until the lease ends. Only one of
  // two concurrent invocations can change `attempts` from the value both read, and none may run a row that is not due.
  // A row already at the last attempt (its 5th run was cut off by the Lambda timeout) is only finished, never run again.
  const attempt = Math.min(row.attempts + 1, PLAN_EVIDENCE_MAX_ATTEMPTS);
  const startedAt = deps.now();
  const reschedule = async (at: number) => {
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: rowKey,
        UpdateExpression: "SET nextAttemptAt = :at, dispatchDueSk = :sk",
        ConditionExpression: "attempts = :attempt",
        ExpressionAttributeValues: { ":at": at, ":sk": `${planEvidenceDueKey(at)}#${rowKey.sk}`, ":attempt": attempt },
      }));
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  };
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: rowKey,
      UpdateExpression: "SET attempts = :attempt, nextAttemptAt = :lease, dispatchDueSk = :sk",
      ConditionExpression: "attempts = :expected AND nextAttemptAt <= :now",
      ExpressionAttributeValues: { ":attempt": attempt, ":expected": row.attempts, ":now": startedAt, ":lease": startedAt + CLAIM_LEASE_MS, ":sk": `${planEvidenceDueKey(startedAt + CLAIM_LEASE_MS)}#${rowKey.sk}` },
    }));
  } catch (error) {
    if (isConditional(error)) return "busy";
    throw error;
  }

  const prefixOfBundle = artifact.objectKey.replace(/\.json$/u, "");
  const loadPlan = async (): Promise<PlanDocument> => {
    const loaded = await loadWorkflowDocument((key, maxBytes) => readObjectText(deps.s3, deps.bucketName, key, maxBytes), artifact, {});
    if (loaded?.format !== "structured") throw new Error("the stored plan could not be read");
    return loaded.plan;
  };
  // After the last attempt: save a bundle in which every cited place is `unavailable` (best effort; the plan is read again
  // when this run has not got it) and remove the row, so no run ever follows the fifth.
  const finish = async (reason: string, known?: PlanDocument): Promise<PlanEvidenceRunOutcome> => {
    let outcome: PlanEvidenceRunOutcome = "gave_up";
    try {
      const attached = await attachEvidence(deps, { taskId, artifactId, artifactSha256: row.artifactSha256, bundle: unavailablePlanEvidence(known ?? await loadPlan()), prefix: prefixOfBundle });
      outcome = attached === "attached" ? "attached" : attached === "already" ? "already" : "skipped";
    } catch {
      // The page then says it could not load the code.
    }
    await removeRow().catch(() => undefined);
    log({ event: `plan_evidence.final_${outcome}`, taskId, artifactId, attempt, reason });
    return outcome;
  };
  if (row.attempts >= PLAN_EVIDENCE_MAX_ATTEMPTS) return finish("interrupted");

  let plan: PlanDocument | undefined;
  try {
    plan = await loadPlan();
    const project = await requireProject(deps, task.project, task.startingRevision);
    const deadline = deps.now() + RESOLVE_DEADLINE_MS;
    const bundle = await resolvePlanEvidence(plan, {
      ...planEvidenceSources(project, task),
      readFile: (url, path, commit, options) => deps.github.getFileAtCommit(url, path, commit, { ...options, timeoutMs: Math.max(1, Math.min(READ_TIMEOUT_MAX_MS, deadline - deps.now())) }),
      deadlineMs: RESOLVE_DEADLINE_MS,
      now: deps.now,
    });
    if (bundle.excerpts.some((excerpt) => excerpt.status === "unavailable") && attempt < PLAN_EVIDENCE_MAX_ATTEMPTS) {
      await reschedule(deps.now() + RETRY_MINUTES[attempt - 1]! * MS_PER_MINUTE);
      log({ event: "plan_evidence.retry", taskId, artifactId, attempt, reason: "unavailable" });
      return "retry";
    }
    // The last attempt attaches what it has: places still unread say `unavailable`.
    const attached = await attachEvidence(deps, { taskId, artifactId, artifactSha256: row.artifactSha256, bundle, prefix: prefixOfBundle });
    await removeRow();
    log({ event: `plan_evidence.${attached}`, taskId, artifactId, attempt });
    return attached === "attached" ? "attached" : attached === "already" ? "already" : "skipped";
  } catch (error) {
    // A thrown error is the attempt it happened in: no model text is logged, only the error's name.
    const reason = error instanceof Error ? error.name : "unknown";
    if (attempt >= PLAN_EVIDENCE_MAX_ATTEMPTS) return finish(reason, plan);
    await reschedule(deps.now() + RETRY_MINUTES[attempt - 1]! * MS_PER_MINUTE).catch(() => undefined);
    log({ event: "plan_evidence.retry", taskId, artifactId, attempt, reason });
    return "retry";
  }
}

let production: PlanEvidenceRunDependencies | undefined;

/** The job's dependencies from this Lambda's environment; the GitHub App is read the way the broker reads it. */
function productionDependencies(): PlanEvidenceRunDependencies {
  if (production !== undefined) return production;
  const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  production = {
    documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } }),
    s3: new S3Client(awsClientConfiguration),
    tableName: requiredEnvironment("STATE_TABLE_NAME"),
    bucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
    github: createGitHubAppCredentials(new SecretsManagerClient(awsClientConfiguration)).provider,
    now: Date.now,
  };
  return production;
}

export async function handler(event: unknown): Promise<{ outcome: PlanEvidenceRunOutcome | "ignored" }> {
  if (!isPlanEvidenceEvent(event)) return { outcome: "ignored" };
  return { outcome: await runPlanEvidenceJob(productionDependencies(), event) };
}
