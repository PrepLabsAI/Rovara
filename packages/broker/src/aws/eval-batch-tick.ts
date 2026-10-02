// Spec 052 FR-006, FR-010, FR-011: the eval batch tick, an EventBridge schedule every 2 minutes.
// While no batch is active it reads the active list, the slot counter and at most one slot item, and
// reconciles the slots only if one is held (Ruling 10). Otherwise it records the run
// ends the broker missed, reconciles the slot counter, fills every free slot (the run-ended callback
// starts at most one run), and writes the results of each batch that has ended.
//
// The schedule is always on rather than switched on with a batch: an idle tick costs three small
// DynamoDB reads, nothing has to remember to switch it off, and a leaked slot is repaired even
// when no batch runs.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  activeBatchIds,
  finalizeBatch,
  recordMissedRunEnds,
  topUpBatches,
  withEvalBatches,
  type EvalBatchDependencies,
} from "./eval-batch.js";
import { requiredEnvironment } from "./lambda.js";
import { reconcileSwebenchSlots, swebenchSlotsNeedReconcile, type SwebenchSlotCorrection } from "./swebench.js";
import { swebenchDeploymentFromParameters } from "./swebench-settings.js";

export interface EvalBatchTickReport {
  /** Batches on the active list when the tick began, ended ones awaiting their results included. */
  active: number;
  endsRecorded: number;
  slotCorrections: SwebenchSlotCorrection[];
  rowsRebuilt: number;
  /** Batches whose results this tick wrote. */
  finalized: string[];
}

/**
 * One tick. Each step's failure is logged and the remaining steps still run; the tick then fails,
 * so the Lambda's error metric (and its alarm) sees it. Every step is idempotent, so the next tick
 * repeats whatever this one did not finish.
 */
export async function runEvalBatchTick(dependencies: EvalBatchDependencies): Promise<EvalBatchTickReport> {
  const report: EvalBatchTickReport = { active: 0, endsRecorded: 0, slotCorrections: [], rowsRebuilt: 0, finalized: [] };
  const batchIds = await activeBatchIds(dependencies);
  report.active = batchIds.length;
  if (batchIds.length === 0) {
    // Ruling 10: a leaked slot must not block single runs while no batch runs. The idle tick reads
    // the counter and at most one slot item, and reconciles only when either shows a slot held.
    if (await swebenchSlotsNeedReconcile(dependencies)) report.slotCorrections = await reconcileSwebenchSlots(dependencies);
    return report;
  }
  const failures: string[] = [];
  const step = async (name: string, fields: Record<string, unknown>, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(name);
      log("eval_batch_tick.step_failed", { step: name, ...fields, error: error instanceof Error ? error.message : String(error) });
    }
  };
  for (const batchId of batchIds) {
    await step("record_missed_ends", { batchId }, async () => { report.endsRecorded += await recordMissedRunEnds(dependencies, batchId); });
  }
  // Before the top-up, so a slot freed here is filled in this tick.
  await step("reconcile_slots", {}, async () => { report.slotCorrections = await reconcileSwebenchSlots(dependencies); });
  // No start cap: the tick fills every free slot.
  await step("top_up", {}, () => topUpBatches(dependencies));
  for (const batchId of batchIds) {
    await step("finalize", { batchId }, async () => {
      const result = await finalizeBatch(dependencies, batchId);
      report.rowsRebuilt += result.rowsRebuilt;
      if (result.finalized) report.finalized.push(batchId);
    });
  }
  log("eval_batch_tick.done", { ...report, slotCorrections: report.slotCorrections.length, failures });
  if (failures.length > 0) throw new Error(`${failures.length} step${failures.length === 1 ? "" : "s"} of the eval batch tick failed: ${failures.join(", ")}`);
  return report;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "eval-batch-tick", event, ...fields }));
}

let production: EvalBatchDependencies | undefined;

/** The broker's eval dependencies, as broker.ts builds them, from this Lambda's environment. */
function productionDependencies(): EvalBatchDependencies {
  if (production !== undefined) return production;
  const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const ssm = new SSMClient(awsClientConfiguration);
  const stepFunctions = new SFNClient(awsClientConfiguration);
  const settingsPrefix = requiredEnvironment("SWEBENCH_SETTINGS_PREFIX");
  production = withEvalBatches({
    documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } }),
    s3: new S3Client(awsClientConfiguration),
    tableName: requiredEnvironment("STATE_TABLE_NAME"),
    artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
    callbackSigningKey: requiredEnvironment("CALLBACK_SIGNING_KEY"),
    deployment: () => swebenchDeploymentFromParameters(settingsPrefix, async (names) => {
      const response = await ssm.send(new GetParametersCommand({ Names: [...names] }));
      return new Map((response.Parameters ?? []).flatMap((parameter) => parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []));
    }),
    async startExecution(input) {
      await stepFunctions.send(new StartExecutionCommand(input));
    },
  });
  return production;
}

export async function handler(): Promise<EvalBatchTickReport> {
  return runEvalBatchTick(productionDependencies());
}
