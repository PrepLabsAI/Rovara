import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AUTO_FIX_DEFAULT_CAP_USD, autoFixDecision, classifyBlockedWorkflow, wholeTaskSpendUsd,
  type AutoFixAskReason, type AutoFixCode, type AutoFixDecision, type AutoFixFacts, type E2EScenarioResults, type GroupOriginalResult, type OriginalCodeResult, type WorkflowAutoSpend,
} from "@agentx/contracts";
import { AUTOFIX_ASK_GROUPS_MAX, AutoFixAskSchema, autoFixRetryReason, autoFixSendBackReason, type AutoFixAsk } from "../developer/autofix-messages.js";
import { loadPlanSelfCheck } from "../developer/plan-self-check.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { readWorkflowE2EBaselineRecord, workflowE2EBaselineView, type WorkflowE2EBaselineStore } from "./workflow-e2e-baseline.js";
import { autoRetryChecksFromSystem, autoRetryReviewsFromSystem, autoSendBackToCodingFromSystem, type DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import { isConditional } from "./broker-shared.js";

/**
 * AUTOFIX (next milestone, T8): what Rovara does by itself when a task blocks in VERIFY or REVIEW. The decision is T3's pure policy (`autoFixDecision`); this module reads the facts and the
 * money it needs from records, acts through the system routes of developer-tasks.ts (an AGENTX decision, in the same write as the move), or records why it asks.
 *
 * It never approves, skips, rejects, publishes, chooses optional checks or acts in a plan review or a pull request: the only moves it can make are `autoSendBackToCodingFromSystem`,
 * `autoRetryChecksFromSystem` and `autoRetryReviewsFromSystem`, and each holds the policy's limits and the spending cap again itself.
 */

/** Rovara's installation switch and numbers for automatic fixing. Absent from the broker's dependencies: off (the harnesses). The deployed Lambda reads it from its environment: on unless `AUTOFIX_ENABLED=false`. */
export interface AutofixConfig {
  enabled: boolean;
  /** The deploy time: blocks older than this are never handled (an old blocked task is not sent back by surprise). Absent: no cut-off (rows exist only for blocks committed since the feature shipped). */
  since?: string | undefined;
  /** The most automatic fixing may spend on one task, in US dollars. */
  capUsd: number;
  /** What one more automatic round is expected to cost, in US dollars (planning excluded: a send back is one coding run, checks and reviews). */
  roundEstimateUsd: number;
}

/** One more automatic round: a coding run, the checks and two reviews. A deliberately high figure; the cap is checked against spend plus this. */
export const AUTOFIX_ROUND_ESTIMATE_USD = 3;
/** How long a task waits for the original-code round before Rovara stops waiting and asks. */
export const AUTOFIX_BASELINE_WAIT_MS = 45 * 60_000;

export function autofixConfigFromEnvironment(env: Readonly<Record<string, string | undefined>>): AutofixConfig {
  const cap = env.AUTOFIX_CAP_USD === undefined ? AUTO_FIX_DEFAULT_CAP_USD : Number(env.AUTOFIX_CAP_USD);
  const since = env.AUTOFIX_SINCE !== undefined && Number.isFinite(Date.parse(env.AUTOFIX_SINCE)) ? new Date(env.AUTOFIX_SINCE).toISOString() : undefined;
  return {
    enabled: env.AUTOFIX_ENABLED?.trim().toLowerCase() !== "false",
    ...(since === undefined ? {} : { since }),
    // A cap that is not a number is no cap at all: the policy then asks (inputs-missing) instead of acting.
    capUsd: Number.isFinite(cap) && cap >= 0 ? cap : Number.NaN,
    roundEstimateUsd: AUTOFIX_ROUND_ESTIMATE_USD,
  };
}

export interface AutofixDependencies {
  config: AutofixConfig;
  /** The route dependencies the system moves use (the same wiring as the dispatcher's). */
  route: DeveloperTaskRouteDependencies;
  store: WorkflowE2EBaselineStore;
  /** The WHOLE task's recorded model spend in US dollars (planning, coding, checks, reviews); undefined when it cannot be read. */
  taskSpendUsd(task: DeveloperTaskRecord): Promise<number | undefined>;
  /** Whether the project's day budgets have room for one more round; undefined when they cannot be read. */
  dayBudgetHasRoom(task: DeveloperTaskRecord): Promise<boolean | undefined>;
  /** The task's current browser and API rows, and the baseline's. */
  scenarioResults(task: DeveloperTaskRecord): Promise<E2EScenarioResults | undefined>;
  /** Whether the owner stopped the task's latest checks. */
  ownerCancelledChecks(task: DeveloperTaskRecord): Promise<boolean>;
  /** The text at an object key (a plan's stored self-check record), or undefined. */
  readArtifactText(objectKey: string): Promise<string | undefined>;
  now(): number;
  log(entry: Record<string, unknown>): void;
}

export type AutofixOutcome = "DISABLED" | "STALE" | "NONE" | "SENT_BACK" | "RETRIED" | "DUPLICATE" | "WAITING" | "ASKED";

/** The original-code result of an UNKNOWN row of the current round, from the baseline record of the approved plan. */
async function unknownGroupResults(deps: AutofixDependencies, task: DeveloperTaskRecord): Promise<{ groups: Record<string, GroupOriginalResult>; baselineRequests: number }> {
  const [results, record] = await Promise.all([deps.scenarioResults(task), readWorkflowE2EBaselineRecord(deps.store, task)]);
  const unknown = (results?.scenarios ?? []).filter((row) => row.status === "UNKNOWN");
  const baselineRequests = record === undefined ? 0 : 1;
  const view = record === undefined ? undefined : workflowE2EBaselineView(record, deps.now());
  const groups: Record<string, GroupOriginalResult> = {};
  for (const row of unknown) {
    let original: GroupOriginalResult;
    if (record === undefined) original = "not-run";
    else if (view?.status === "UNAVAILABLE") original = "cannot-run";
    else if (view === undefined) original = "pending";
    else {
      const baselineRow = view.scenarios.find((entry) => entry.scenarioId === row.scenarioId);
      // A scenario the original-code round did not run (an AI-navigated one, or one it has no row for) says nothing about the original code.
      original = baselineRow === undefined ? "skipped" : baselineRow.status === "PASSED" ? "passed" : baselineRow.status === "FAILED" ? "failed" : "cannot-run";
    }
    groups[row.scenarioId] = original;
  }
  return { groups, baselineRequests };
}

/** What a proposed check did on the original code, from the dry run recorded beside its plan. */
async function proposedCheckOriginals(deps: AutofixDependencies, task: DeveloperTaskRecord): Promise<Record<string, OriginalCodeResult>> {
  const workflow = task.workflow;
  const plan = workflow?.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  if (plan === undefined) return {};
  const view = await loadPlanSelfCheck((key) => deps.readArtifactText(key), plan);
  return Object.fromEntries(Object.entries(view.tried).map(([checkId, result]) => [checkId, result === "passed" ? "passed" as const : result === "failed" ? "failed" as const : "cannot-run" as const]));
}

async function writeAsk(deps: AutofixDependencies, task: DeveloperTaskRecord, ask: AutoFixAsk): Promise<void> {
  const parsed = AutoFixAskSchema.parse(ask);
  try {
    await deps.store.documentClient.send(new UpdateCommand({
      TableName: deps.store.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET autofixAsk = :ask",
      ConditionExpression: "workflow.revision = :revision AND workflow.#state = :blocked AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":ask": parsed, ":revision": parsed.workflowRevision, ":blocked": "BLOCKED" },
    }));
  } catch (error) {
    // The task moved on (the owner acted first): there is nothing left to ask about.
    if (!isConditional(error)) throw error;
  }
}

/**
 * Looks at one blocked VERIFY or REVIEW once and acts or asks. `expectedRevision` is the blocked revision the trigger was made for; `startedAt` is when the trigger's row was written
 * (the wait for the original-code round is bounded from it). Returns what happened; WAITING means the original-code round is not in yet and the caller should look again soon.
 * Never throws for a task that moved on; an error from a system move is rethrown when the task is still at the same blocked revision (the caller's bounded retry).
 */
export async function runWorkflowAutofix(deps: AutofixDependencies, task: DeveloperTaskRecord, input: { expectedRevision: number; startedAt: string }): Promise<AutofixOutcome> {
  const { config } = deps;
  if (!config.enabled) return "DISABLED";
  const workflow = task.workflow;
  if (workflow === undefined || task.closedAt !== undefined || workflow.state !== "BLOCKED" || (workflow.stage !== "VERIFY" && workflow.stage !== "REVIEW") || workflow.revision !== input.expectedRevision) return "STALE";
  // Only blocks committed after the feature shipped: an older blocked task waits for its owner as it always did.
  if (config.since !== undefined && !(Date.parse(workflow.updatedAt) >= Date.parse(config.since))) return "STALE";

  // What the policy needs, read only where the classification says it matters.
  const classes = classifyBlockedWorkflow(workflow);
  const codes = new Set<AutoFixCode>(classes.map((entry) => entry.code));
  const facts: AutoFixFacts = {};
  let baselineRequests = 0;
  let groups: Record<string, GroupOriginalResult> = {};
  if (codes.has("e2e-evidence-unknown")) {
    const found = await unknownGroupResults(deps, task);
    groups = found.groups;
    baselineRequests = found.baselineRequests;
    facts.e2eUnknownGroups = groups;
  } else if (workflow.e2e?.required === true) {
    baselineRequests = (await readWorkflowE2EBaselineRecord(deps.store, task)) === undefined ? 0 : 1;
  }
  if (codes.has("check-failed-cause-unknown")) facts.checkOriginal = await proposedCheckOriginals(deps, task);
  if (codes.has("cancelled") || classes.some((entry) => entry.code === "cancelled-by-owner")) facts.ownerCancelled = await deps.ownerCancelledChecks(task);
  // A `cancelled` group is the owner's doing when the owner stopped the checks.
  if (facts.ownerCancelled === undefined && workflow.e2e?.required === true) facts.ownerCancelled = await deps.ownerCancelledChecks(task);

  const [spent, room] = await Promise.all([deps.taskSpendUsd(task), deps.dayBudgetHasRoom(task)]);
  const spend: WorkflowAutoSpend = { spentUsd: wholeTaskSpendUsd(spent ?? Number.NaN), roundEstimateUsd: config.roundEstimateUsd, capUsd: config.capUsd };
  const first = autoFixDecision(workflow, facts, { enabled: true, spend, dayBudgetHasRoom: room as boolean, baselineRequests });
  // The wait for the original-code round is bounded: after it, the owner is asked. The original-code round is requested once, when the plan is approved, and started with the first checks;
  // asking for it now cannot start it, so an unclear fault with no such round is the owner's to settle.
  const decision: AutoFixDecision = first.action === "WAIT_FOR_BASELINE" && deps.now() - Date.parse(input.startedAt) > AUTOFIX_BASELINE_WAIT_MS ? { action: "ASK", reason: "unclear-fault", codes: first.codes }
    : first.action === "REQUEST_BASELINE" ? { action: "ASK", reason: "unclear-fault", codes: first.codes } : first;

  const log = (action: string, extra: Record<string, unknown> = {}) => deps.log({ event: "autofix.decided", taskId: task.taskId, stage: workflow.stage, revision: workflow.revision, action, ...extra });
  const ask = async (reason: AutoFixAskReason, askCodes: readonly AutoFixCode[]): Promise<AutofixOutcome> => {
    const entries = Object.entries(groups);
    await writeAsk(deps, task, {
      workflowRevision: workflow.revision, reason, codes: [...askCodes].slice(0, 30),
      ...(reason === "spend-cap" ? { capUsd: config.capUsd } : {}),
      ...(entries.length === 0 ? {} : { groups: entries.slice(0, AUTOFIX_ASK_GROUPS_MAX).map(([id, original]) => ({ id, original })), groupCount: entries.length }),
      at: new Date(deps.now()).toISOString(),
    });
    log("ASK", { reason, codes: [...askCodes] });
    return "ASKED";
  };
  const moved = async (error: unknown): Promise<AutofixOutcome> => {
    // The owner pressed first (the revision moved): theirs stands and nothing else is done. Any other failure is the caller's to retry.
    const fresh = await deps.store.documentClient.send(new GetCommand({ TableName: deps.store.tableName, Key: taskKey(task.taskId), ConsistentRead: true })) as unknown as { Item?: DeveloperTaskRecord };
    if (fresh.Item?.workflow?.revision !== workflow.revision) {
      log("RACE_LOST");
      return "STALE";
    }
    throw error;
  };

  switch (decision.action) {
    case "NONE": return "NONE";
    case "ASK": return ask(decision.reason, decision.codes);
    case "WAIT_FOR_BASELINE": log("WAIT_FOR_BASELINE"); return "WAITING";
    case "SEND_BACK": {
      let outcome: Awaited<ReturnType<typeof autoSendBackToCodingFromSystem>>;
      try {
        outcome = await autoSendBackToCodingFromSystem(deps.route, task.taskId, { expectedRevision: workflow.revision, reason: autoFixSendBackReason(decision.codes), spend });
      } catch (error) { return moved(error); }
      log("SEND_BACK", { result: outcome, codes: decision.codes });
      return outcome === "STARTED" ? "SENT_BACK" : outcome === "DUPLICATE" ? "DUPLICATE" : "STALE";
    }
    case "RETRY": {
      const input2 = { expectedRevision: workflow.revision, spend, reason: autoFixRetryReason(decision.stage, decision.codes) };
      let outcome: Awaited<ReturnType<typeof autoRetryChecksFromSystem>>;
      try {
        outcome = decision.stage === "VERIFY" ? await autoRetryChecksFromSystem(deps.route, task.taskId, input2) : await autoRetryReviewsFromSystem(deps.route, task.taskId, input2);
      } catch (error) { return moved(error); }
      log("RETRY", { result: outcome, retryStage: decision.stage, codes: decision.codes });
      return outcome === "STARTED" ? "RETRIED" : outcome === "DUPLICATE" ? "DUPLICATE" : "STALE";
    }
  }
}
