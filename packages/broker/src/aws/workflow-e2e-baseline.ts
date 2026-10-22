import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EDisplayBaselineSchema, type E2EDisplayBaseline } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { UNAVAILABLE_BASELINE, scrubScenarioResults } from "../e2e/application-display.js";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts, type WorkflowE2EArtifact, type WorkflowE2EArtifactStore } from "./workflow-e2e-artifacts.js";

/**
 * M1.3 Task 3.7, owner decision D2: the baseline round. When a plan with browser and API scenarios is approved, the broker asks for one extra round of the approved scenarios
 * on the unchanged code, so a reader can see what the change fixed. It is for information only and never gates (Review Focus 6):
 *
 *  - Its result is kept in a record of its own beside the task, keyed by the approved plan, and nowhere in the workflow snapshot: it can never be a `qualifiedRound` or a
 *    `failedRound`, satisfy or block publication, or trigger send-back.
 *  - If it cannot be asked for or cannot run, the display says "Couldn't run the checks on the unchanged code" and nothing else changes: not APPROVE, not the candidate's CHECKS.
 *
 * Running the round is the baseline runner's work (the broker's `e2eBaselineRound` dependency); this module asks for it, and records and reads its outcome.
 */

export const E2E_BASELINE_PURPOSE = "baseline" as const;

export type WorkflowE2EBaselineStore = Readonly<{ documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }>;
/** Starts a baseline round for an approved task. A runner that throws, or cannot be reached, is a baseline that could not run. */
export type WorkflowE2EBaselineRunner = (input: { purpose: typeof E2E_BASELINE_PURPOSE; task: DeveloperTaskRecord }) => Promise<void>;

const keyOf = (taskId: string, contractDigest: string) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_BASELINE#${contractDigest}` });

/** The approved plan a baseline stands for; absent when the task has no approved application plan. */
const planDigestOf = (task: Pick<DeveloperTaskRecord, "workflow">): string | undefined =>
  task.workflow?.e2e?.required === true && task.workflow.e2e.applicationSelection !== undefined ? task.workflow.e2e.contractDigest : undefined;

/**
 * Asks for the baseline round of a just-approved application plan, at most once per approved plan. Never throws and never changes the task: a baseline that cannot be
 * asked for is recorded as unavailable and that is all.
 */
export async function requestWorkflowE2EBaselineRound(deps: WorkflowE2EBaselineStore & { startBaseline?: WorkflowE2EBaselineRunner }, task: DeveloperTaskRecord):
  Promise<"NOT_REQUESTED" | "STARTED" | "UNAVAILABLE"> {
  const contractDigest = planDigestOf(task);
  if (deps.startBaseline === undefined || contractDigest === undefined) return "NOT_REQUESTED";
  try {
    await deps.startBaseline({ purpose: E2E_BASELINE_PURPOSE, task });
    return "STARTED";
  } catch {
    try {
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
        Item: { ...keyOf(task.taskId, contractDigest), entityType: "WORKFLOW_E2E_BASELINE", schemaVersion: 1, taskId: task.taskId, contractDigest, purpose: E2E_BASELINE_PURPOSE,
          recordedAt: new Date().toISOString(), baseline: UNAVAILABLE_BASELINE } }));
    } catch { /* a row that is already there (a recorded result) is kept; nothing else is changed */ }
    return "UNAVAILABLE";
  }
}

/**
 * Records the baseline round's outcome for the task's approved plan: the rows (scrubbed again, held to their schema) and the screenshots behind them, which are stored as
 * private objects; a row whose screenshot was not stored loses its link. Throws for a baseline that is not a valid baseline; changes nothing else of the task.
 */
export async function recordWorkflowE2EBaseline(deps: WorkflowE2EBaselineStore & WorkflowE2EArtifactStore, task: DeveloperTaskRecord,
  input: { baseline: E2EDisplayBaseline; artifacts: readonly WorkflowE2EArtifact[] }): Promise<void> {
  const contractDigest = planDigestOf(task);
  if (contractDigest === undefined) throw new Error("the task has no approved application plan for a baseline to belong to");
  const parsed = E2EDisplayBaselineSchema.parse(input.baseline);
  const scrubbed = scrubScenarioResults({ scenarios: [], baseline: parsed });
  if (scrubbed?.baseline === undefined) throw new Error("the baseline is not a valid set of rows");
  const stored = await storeWorkflowE2EArtifacts(deps, task, input.artifacts);
  const baseline = resultsWithStoredArtifacts({ scenarios: [], baseline: scrubbed.baseline }, stored).baseline!;
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName,
    Item: { ...keyOf(task.taskId, contractDigest), entityType: "WORKFLOW_E2E_BASELINE", schemaVersion: 1, taskId: task.taskId, contractDigest, purpose: E2E_BASELINE_PURPOSE,
      recordedAt: new Date().toISOString(), baseline } }));
}

/** The baseline recorded for the task's approved plan, or undefined when there is none (or the record is not what it should be). */
export async function readWorkflowE2EBaseline(deps: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">): Promise<E2EDisplayBaseline | undefined> {
  const contractDigest = planDigestOf(task);
  if (contractDigest === undefined) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(task.taskId, contractDigest), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined || item.entityType !== "WORKFLOW_E2E_BASELINE" || item.taskId !== task.taskId || item.contractDigest !== contractDigest || item.purpose !== E2E_BASELINE_PURPOSE) return undefined;
  const parsed = E2EDisplayBaselineSchema.safeParse(item.baseline);
  if (!parsed.success) return undefined;
  return scrubScenarioResults({ scenarios: [], baseline: parsed.data })?.baseline;
}
