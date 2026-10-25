import { E2E_PROJECT_CHECK_ID } from "./e2e.js";
import {
  E2E_APPLICATION_SEND_BACK_CODES, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX,
  WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_AUTO_ACTION_LIMIT,
  WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_AUTO_RETRY_LIMIT, WORKFLOW_AUTO_SEND_BACK_LIMIT, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE,
  WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, blockingFindings, workflowApplicationEvidenceCodes, workflowAutoFixCounts, workflowCheckResultBroken,
  type WorkflowSnapshot,
} from "./task-workflow.js";

/**
 * AUTOFIX policy (next milestone, T3): what Rovara does by itself when checks or reviews block, and when it asks a person.
 *
 * The owner's rule (2026-10-23): Rovara handles code-caused failures (automatic send back to the coding agent, at most 2 per approved plan, then ask) and one-off infrastructure hiccups
 * (one automatic retry); it asks when the fault is unclear after looking at the original code, when a person must act, and when a limit is reached. Approvals, choosing optional checks,
 * publishing, closing and Request changes always stay with a person: this module can only ever answer "send back", "retry", "request/wait for the original-code check", "ask" or "nothing".
 *
 * `autoFixDecision` is pure. It reads only fields the workflow already stores, plus the facts and the budget the caller passes in, and it never reads or returns text a worker, a model or a
 * check printed: everything it returns is a member of a fixed list (`AUTO_FIX_CODES`, `AUTO_FIX_ASK_REASONS`). Anything it cannot read is a person's decision (fail closed).
 */

/** What kind of fault a signal is, from the point of view of who can fix it. */
export type AutoFixClass = "code" | "transient" | "person" | "unclear";

/**
 * The fixed codes of what failed, in the order found. The ask card (T8) words each one; none of them is built from output. The E2E group codes are the ones RUN-2 words
 * (`E2E_OWNER_SENTENCES.groupSentence`); the others name a check, a review or a block.
 */
export const AUTO_FIX_CODES = [
  // Code: a group the candidate broke (E2E_APPLICATION_SEND_BACK_CODES), and the rest of what new code fixes.
  "build-failed", "app-exited", "app-unhealthy", "seed-failed",
  "e2e-assertion-failed", "check-failed", "review-findings", "regression-found", "round-refused",
  // Transient: Rovara's side or the environment's, which a retry may fix.
  "deadline-exceeded", "executor-failed", "executor-result-mismatch", "mock-unavailable", "model-channel-unavailable", "cancelled", "evidence too large",
  "check-runner-failed", "check-not-started", "review-not-run", "review-run-failed", "provider-outage", "runner-busy",
  // A person must act.
  "runtime-expired", "runtime-environment-drifted", "model-environment-unsafe", "login-failed", "model-route-changed-reapprove", "agent-route-not-approved", "model-route-not-tested",
  "runtime-unusable", "selection-changed", "accounts-changed", "plan-not-approvable", "history-rewritten", "cancelled-by-owner", "check-broken", "fails-on-original-code",
  "review-unusable", "pull-request-open", "unknown-group-code", "unreadable",
  // Unclear fault.
  "e2e-evidence-unknown", "check-result-unknown", "check-failed-cause-unknown",
] as const;
export type AutoFixCode = (typeof AUTO_FIX_CODES)[number];

/** Group codes that are Rovara's or the environment's, and that a retry may fix. `cancelled` is only transient when the owner did not cancel (facts). */
export const AUTO_FIX_TRANSIENT_GROUP_CODES = ["deadline-exceeded", "executor-failed", "executor-result-mismatch", "mock-unavailable", "model-channel-unavailable", "cancelled", "evidence too large"] as const;
/** Group codes only a person (an administrator, the project's setup) can fix. */
export const AUTO_FIX_PERSON_GROUP_CODES = ["runtime-expired", "runtime-environment-drifted", "model-environment-unsafe", "login-failed", "model-route-changed-reapprove", "agent-route-not-approved", "model-route-not-tested"] as const;

/** Why Rovara asks instead of acting. The limit reasons name the limit the ask card tells the person about. */
export const AUTO_FIX_ASK_REASONS = [
  "needs-a-person", "original-code-also-fails", "unclear-fault",
  "send-back-limit", "retry-limit", "total-limit", "spend-cap", "day-budget", "history-full",
] as const;
export type AutoFixAskReason = (typeof AUTO_FIX_ASK_REASONS)[number];

/** How a check or the E2E checks behaved on the original code (the code the task started from). */
export type OriginalCodeResult = "passed" | "failed" | "cannot-run";

/** What the caller knows that the workflow does not store. Every member is optional: what is missing is unknown, and unknown never counts as a pass. */
export interface AutoFixFacts {
  /** The original-code result of a check, by check ID (a proposed check's dry-run class, or a project check's baseline). */
  checkOriginal?: Readonly<Record<string, OriginalCodeResult>> | undefined;
  /** Proposed checks that declared `expectOnBase: pass`: with no original-code result yet they are still expected to pass on the original code. */
  checkExpectsPass?: readonly string[] | undefined;
  /** The E2E baseline round for the approved plan: absent when it was not requested, `pending` while requested and not recorded yet. */
  e2eOriginal?: OriginalCodeResult | "pending" | undefined;
  /** The blocked run ended RUNTIME_UNAVAILABLE with a provider-outage class. */
  providerOutage?: boolean | undefined;
  /** The runner was busy. */
  runnerBusy?: boolean | undefined;
  /** The owner stopped the checks (a `cancelled` group is then the owner's doing, not an infrastructure fault). */
  ownerCancelled?: boolean | undefined;
}

/** The money and quota room for one more automatic round. The caller reads them (the task's spend, the project's day budgets); this module only compares. */
export interface AutoFixBudget {
  /** The installation kill switch (`AUTOFIX_ENABLED`, default on). Off: nothing is automatic and the answer is `NONE`. */
  enabled: boolean;
  /** Model spend of the task so far, in US dollars. */
  spentUsd: number;
  /** The estimate of one more round, in US dollars. */
  roundEstimateUsd: number;
  /** The most automatic fixing may spend on one task (default 15). */
  capUsd: number;
  /** Whether the project's day budgets (the E2E model day budget, the per-day call caps) have room for one more round. */
  dayBudgetHasRoom: boolean;
  /** How many original-code (baseline) rounds were already requested for the approved plan. At most one is. */
  baselineRequests: number;
}

/** The default per-task cap for automatic fixing, in US dollars (owner decision 6). */
export const AUTO_FIX_DEFAULT_CAP_USD = 15;
/** At most this many original-code rounds are requested per approved plan. */
export const AUTO_FIX_BASELINE_REQUEST_LIMIT = 1;

export type AutoFixDecision =
  /** Not a blocked VERIFY or REVIEW, or automatic fixing is off: nothing for this module to do. */
  | { action: "NONE" }
  /** Send back to coding by the AGENTX actor (`returnWorkflowToImplementationAutomatically`). */
  | { action: "SEND_BACK"; codes: AutoFixCode[] }
  /** Retry the blocked stage once. */
  | { action: "RETRY"; stage: "VERIFY" | "REVIEW"; codes: AutoFixCode[] }
  /** The fault is unclear and the original-code round was not requested yet: request it (existing route, attempt 1), then decide when its record is in. */
  | { action: "REQUEST_BASELINE"; codes: AutoFixCode[] }
  /** The original-code round was requested and has no record yet: wait for it (its existing deadline). */
  | { action: "WAIT_FOR_BASELINE"; codes: AutoFixCode[] }
  /** Show the ask card: `reason` says why; `codes` are what failed. */
  | { action: "ASK"; reason: AutoFixAskReason; codes: AutoFixCode[] };

interface Signal {
  readonly class: AutoFixClass;
  readonly code: AutoFixCode;
  /** An unclear signal of the E2E round, which the original-code E2E round can settle. */
  readonly e2e?: true;
}

const code = (value: AutoFixCode): Signal => ({ class: "code", code: value });
const transient = (value: AutoFixCode): Signal => ({ class: "transient", code: value });
const person = (value: AutoFixCode): Signal => ({ class: "person", code: value });
const unclear = (value: AutoFixCode, e2e = false): Signal => ({ class: "unclear", code: value, ...(e2e ? { e2e: true as const } : {}) });

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** The signal of one group code in an incomplete round's reason. A code nobody classified is a person's decision. */
function groupSignal(groupCode: string, facts: AutoFixFacts): Signal {
  if (isOneOf(E2E_APPLICATION_SEND_BACK_CODES, groupCode)) return code(groupCode);
  if (groupCode === "cancelled") return facts.ownerCancelled === true ? person("cancelled-by-owner") : transient("cancelled");
  if (isOneOf(AUTO_FIX_TRANSIENT_GROUP_CODES, groupCode)) return transient(groupCode);
  if (isOneOf(AUTO_FIX_PERSON_GROUP_CODES, groupCode)) return person(groupCode);
  return person("unknown-group-code");
}

/** What the original-code result of a failed check says. `undefined`: nothing is known about the original code. */
function failedCheckSignal(checkId: string, facts: AutoFixFacts): Signal {
  const original = facts.checkOriginal?.[checkId];
  if (original === "passed") return code("check-failed");
  if (original === "failed" || original === "cannot-run") return person("fails-on-original-code");
  return facts.checkExpectsPass?.includes(checkId) === true ? code("check-failed") : unclear("check-failed-cause-unknown");
}

function verifySignals(workflow: WorkflowSnapshot, facts: AutoFixFacts): Signal[] {
  const signals: Signal[] = [];
  const reason = workflow.blockReason;
  const current = workflow.candidate?.digest;
  if (reason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE) signals.push(person("history-rewritten"));
  else if (reason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) === true) signals.push(person("runtime-unusable"));
  else if (reason?.startsWith(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX) === true) signals.push(person("selection-changed"));
  else if (reason?.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) === true) signals.push(person("accounts-changed"));
  else if (reason?.startsWith(WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX) === true) signals.push(person("plan-not-approvable"));
  else if (reason?.startsWith(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX) === true) signals.push(workflow.e2e?.required === true ? code("round-refused") : person("unreadable"));
  else if (reason === WORKFLOW_BLOCK_REASONS.regressionFound) signals.push(code("regression-found"));
  else if (reason === WORKFLOW_BLOCK_REASONS.checkRunnerFailed) signals.push(transient("check-runner-failed"));
  else if (reason?.startsWith(WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX) === true) {
    const groupCodes = workflow.e2e?.required === true ? workflowApplicationEvidenceCodes(reason) : undefined;
    if (workflow.e2e?.required !== true) signals.push(person("unreadable"));
    // A reason that is not exactly `group: code` entries (the evidence floor, an unmocked call): some group is UNKNOWN and says nothing about who is at fault.
    else if (groupCodes === undefined || groupCodes.length === 0) signals.push(unclear("e2e-evidence-unknown", true));
    else for (const groupCode of new Set(groupCodes)) signals.push(groupSignal(groupCode, facts));
  }
  // An assertion of the current round FAILED (a verdict, not UNKNOWN): the change does not do what the plan said.
  const failure = workflow.e2e?.failedRound;
  if (workflow.e2e?.required === true && current !== undefined && failure?.status === "FAILED" && failure.candidateDigest === current && failure.roundId === workflow.e2e.currentRoundId
    && failure.groupRunIds.length > 0 && failure.groupRunIds.length === workflow.e2e.currentGroupRunIds.length
    && failure.groupRunIds.every((runId, index) => runId === workflow.e2e?.currentGroupRunIds[index])) signals.push(code("e2e-assertion-failed"));
  // Check results of the current code only; the trusted E2E aggregate has its own signals above.
  if (current !== undefined && workflow.verification?.candidateDigest === current) {
    for (const result of workflow.verification.results) {
      if (result.status === "PASS" || result.checkId === E2E_PROJECT_CHECK_ID) continue;
      if (result.neverStarted === true) signals.push(transient("check-not-started"));
      else if (workflowCheckResultBroken(result)) signals.push(person("check-broken"));
      else if (result.status === "FAILED") signals.push(failedCheckSignal(result.checkId, facts));
      else signals.push(unclear("check-result-unknown"));
    }
  }
  return signals;
}

/** Why a review did not qualify, as a retry can fix it: a run that stopped, timed out or returned nothing. Any other reason (a changed candidate, a missing diff) needs a person. */
const TRANSIENT_REVIEW_FAILURES: readonly string[] = ["TIMEOUT", "SESSION_FAILED", "INTERRUPTED", "RESPONSE_MISSING"];

function reviewSignals(workflow: WorkflowSnapshot): Signal[] {
  const signals: Signal[] = [];
  const current = workflow.candidate?.digest;
  if (workflow.blockReason === WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE || workflow.blockReason === WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE) signals.push(transient("review-not-run"));
  if (current === undefined) return signals;
  for (const review of (workflow.reviews ?? []).filter((entry) => entry.candidateDigest === current)) {
    if (blockingFindings(review, workflow.acceptedFindings).length > 0) signals.push(code("review-findings"));
    else if (review.status === "FAILED" || review.status === "INTERRUPTED" || review.status === "UNKNOWN") {
      signals.push(review.failureReason !== undefined && TRANSIENT_REVIEW_FAILURES.includes(review.failureReason) ? transient("review-run-failed") : person("review-unusable"));
    }
  }
  return signals;
}

function blockSignals(workflow: WorkflowSnapshot, facts: AutoFixFacts): Signal[] {
  const signals = workflow.stage === "REVIEW" ? reviewSignals(workflow) : workflow.stage === "VERIFY" ? verifySignals(workflow, facts) : [];
  if (facts.providerOutage === true) signals.push(transient("provider-outage"));
  if (facts.runnerBusy === true) signals.push(transient("runner-busy"));
  if ((workflow.pullRequests?.length ?? 0) > 0) signals.push(person("pull-request-open"));
  // A blocked workflow with nothing readable is a person's: nothing is ever read as a pass.
  if (signals.length === 0) signals.push(person("unreadable"));
  return signals;
}

/** The fixed codes and classes of what blocked this workflow, in the order found, from the fields it stores and the caller's facts. The ask card words the same codes. */
export function classifyBlockedWorkflow(workflow: WorkflowSnapshot, facts: AutoFixFacts = {}): ReadonlyArray<{ class: AutoFixClass; code: AutoFixCode }> {
  return blockSignals(workflow, facts).map((signal) => ({ class: signal.class, code: signal.code }));
}

const uniqueCodes = (signals: readonly Signal[]): AutoFixCode[] => [...new Set(signals.map((signal) => signal.code))];

/** Whether one more automatic round fits the money and quota. A number that is not a finite, non-negative one fails closed. */
function budgetRefusal(budget: AutoFixBudget): AutoFixAskReason | undefined {
  const numbers = [budget.spentUsd, budget.roundEstimateUsd, budget.capUsd];
  if (numbers.some((value) => !Number.isFinite(value) || value < 0) || budget.spentUsd + budget.roundEstimateUsd > budget.capUsd) return "spend-cap";
  return budget.dayBudgetHasRoom ? undefined : "day-budget";
}

/**
 * What to do about a blocked VERIFY or REVIEW of the current candidate.
 *
 * Order: a fault only a person can fix asks; then code-caused faults send back (alone or mixed with transient ones: the next round re-runs everything); then transient ones retry once;
 * then an unclear E2E fault is settled by the original-code round (passes there: the candidate is the cause, send back; fails or cannot run there: ask; not requested: request it; requested:
 * wait), and any other unclear fault asks. Limits (from the workflow's decisions): 2 automatic send backs per approved plan, 1 automatic retry per stage per candidate, 6 automatic
 * actions per task, the decision history, the per-task spend cap and the day budgets; over any of them the answer is an ask that names it.
 */
export function autoFixDecision(workflow: WorkflowSnapshot, facts: AutoFixFacts, budget: AutoFixBudget): AutoFixDecision {
  if (!budget.enabled) return { action: "NONE" };
  if (workflow.state !== "BLOCKED" || (workflow.stage !== "VERIFY" && workflow.stage !== "REVIEW")) return { action: "NONE" };
  const stage = workflow.stage;
  const signals = blockSignals(workflow, facts);
  const codes = uniqueCodes(signals);
  const ask = (reason: AutoFixAskReason): AutoFixDecision => ({ action: "ASK", reason, codes });
  const of = (kind: AutoFixClass): Signal[] => signals.filter((signal) => signal.class === kind);

  const people = of("person");
  if (people.length > 0) return ask(people[0]?.code === "fails-on-original-code" ? "original-code-also-fails" : "needs-a-person");

  const counts = workflowAutoFixCounts(workflow.decisions);
  const limitRefusal = (kind: "send-back" | "retry"): AutoFixAskReason | undefined => {
    if (workflow.decisions.length >= 100) return "history-full";
    if (kind === "send-back" && counts.sendBacksSincePlanApproval >= WORKFLOW_AUTO_SEND_BACK_LIMIT) return "send-back-limit";
    if (kind === "retry" && counts.retriesFor(stage, workflow.candidate?.digest) >= WORKFLOW_AUTO_RETRY_LIMIT) return "retry-limit";
    if (counts.actions >= WORKFLOW_AUTO_ACTION_LIMIT) return "total-limit";
    return budgetRefusal(budget);
  };
  const sendBack = (): AutoFixDecision => {
    const refusal = limitRefusal("send-back");
    return refusal === undefined ? { action: "SEND_BACK", codes } : ask(refusal);
  };

  if (of("code").length > 0) return sendBack();

  if (of("transient").length > 0) {
    const refusal = limitRefusal("retry");
    return refusal === undefined ? { action: "RETRY", stage, codes } : ask(refusal);
  }

  // Only unclear faults are left. The original-code E2E round settles the E2E ones; the others have no original-code round to wait for.
  if (of("unclear").some((signal) => signal.e2e !== true)) return ask("unclear-fault");
  if (facts.e2eOriginal === "passed") return sendBack();
  if (facts.e2eOriginal === "failed" || facts.e2eOriginal === "cannot-run") return ask("original-code-also-fails");
  if (facts.e2eOriginal === "pending") return { action: "WAIT_FOR_BASELINE", codes };
  return budget.baselineRequests < AUTO_FIX_BASELINE_REQUEST_LIMIT ? { action: "REQUEST_BASELINE", codes } : ask("unclear-fault");
}
