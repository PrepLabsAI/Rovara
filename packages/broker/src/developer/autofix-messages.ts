import { z } from "zod";
import { AUTO_FIX_ASK_REASONS, AUTO_FIX_CODES, workflowAutoFixCounts, type AutoFixAskReason, type AutoFixCode, type WorkflowSnapshot } from "@agentx/contracts";
import { E2E_OWNER_SENTENCES } from "../e2e/owner-sentences.js";

/**
 * AUTOFIX (next milestone, T8): every sentence Rovara says about fixing a blocked task by itself, and the record of why it asked. Fixed sentences only: each is chosen by a fixed code
 * from the policy (`AUTO_FIX_CODES`, `AUTO_FIX_ASK_REASONS`). Nothing a worker, a model, a check or a reviewer printed is repeated here (a check's label and a finding's text are on the card
 * already, under their own rules), and the only values put into a sentence are counts, the cap in dollars and plan-derived scenario IDs.
 */

/** The original-code result of one UNKNOWN group, as the ask record keeps it (the policy's `GroupOriginalResult`). */
export const AUTO_FIX_GROUP_RESULTS = ["passed", "failed", "cannot-run", "skipped", "pending", "not-run"] as const;
export type AutoFixGroupResult = (typeof AUTO_FIX_GROUP_RESULTS)[number];

/** Every UNKNOWN group of the round is listed on the ask card and kept on its record: a round has at most this many scenarios (the display's limit), so none is left out. */
export const AUTOFIX_ASK_GROUPS_MAX = 64;
/** How long the blocked card waits for the automatic-fix look at it to finish, so the card can carry the ask; after it the card is posted as it is and a follow-up carries the ask. */
export const AUTOFIX_CARD_HOLD_MS = 10 * 60_000;

/**
 * Why Rovara asked instead of acting, kept on the task beside the blocked revision it is for so the Slack card and the page can say it. `capUsd` is the cap that was hit (spend-cap).
 * `groups` is EVERY UNKNOWN group of the round (not only the first) with its own result on the original code, when the fault was unclear.
 */
export const AutoFixAskSchema = z.object({
  workflowRevision: z.number().int().positive(),
  reason: z.enum(AUTO_FIX_ASK_REASONS),
  codes: z.array(z.enum(AUTO_FIX_CODES)).max(30),
  capUsd: z.number().nonnegative().finite().optional(),
  groups: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), original: z.enum(AUTO_FIX_GROUP_RESULTS) }).strict()).max(AUTOFIX_ASK_GROUPS_MAX).optional(),
  groupCount: z.number().int().nonnegative().optional(),
  at: z.string().datetime(),
}).strict();
export type AutoFixAsk = z.infer<typeof AutoFixAskSchema>;

const usd = (value: number): string => `$${Number.isInteger(value) ? String(value) : value.toFixed(2)}`;
const times = (count: number): string => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

/** What each failure code means, in the card's words. Group codes use the owner's RUN-2 sentences; the rest are fixed here. */
const CODE_SENTENCES: Readonly<Record<AutoFixCode, string>> = Object.freeze({
  "build-failed": "The app didn't install or build with this change.",
  "app-exited": "The app stopped right after it started.",
  "app-unhealthy": "The app didn't answer its health check in time.",
  "seed-failed": "The app couldn't load its test data.",
  "e2e-assertion-failed": "A browser or API check ran and its result was not the one the plan expects.",
  "check-failed": "A check failed on this code.",
  "review-findings": "The reviews found problems in this code.",
  "regression-found": "A test that passed before this change fails now.",
  "round-refused": "The browser and API checks could not be started for this code.",
  "deadline-exceeded": "The checks ran out of time.",
  "executor-failed": "The browser runner stopped before it finished.",
  "executor-result-mismatch": "The browser runner's report didn't match what was run.",
  "mock-unavailable": "A stand-in for an outside service couldn't start.",
  "model-channel-unavailable": "The AI navigation connection couldn't be set up.",
  cancelled: "The checks were stopped before they finished.",
  "evidence too large": "The checks produced more evidence than can be kept.",
  "check-runner-failed": "The checks could not run on Rovara's side.",
  "check-not-started": "A check could not start on the worker.",
  "review-not-run": "The reviews did not run.",
  "review-run-failed": "A review stopped before it finished.",
  "provider-outage": "The AI provider was unavailable.",
  "runner-busy": "The runner was busy.",
  "runtime-renewed": "The test machine was renewed, so the approved browser and API checks were approved again against it.",
  "runtime-expired": "The browser and API runtime's qualification expired.",
  "runtime-environment-drifted": "The test machine changed since it was qualified.",
  "model-environment-unsafe": "The runner's setup could let AI model calls be redirected.",
  "login-failed": "The test account couldn't sign in.",
  "model-route-changed-reapprove": "The AI navigation settings changed after setup was approved.",
  "agent-route-not-approved": "AI navigation isn't approved for this project yet.",
  "model-route-not-tested": "AI navigation has not passed its driving test yet.",
  "runtime-unusable": "The browser and API runtime cannot be used right now.",
  "selection-changed": "The approved browser and API setup changed.",
  "accounts-changed": "The test accounts changed since the plan was approved.",
  "plan-not-approvable": "The approved plan can no longer run as written.",
  "history-rewritten": "The branch history was rewritten.",
  "cancelled-by-owner": "The checks were stopped by the owner.",
  "check-broken": "A check could not run because the check itself is broken.",
  "fails-on-original-code": "A check fails on the original code too.",
  "review-unusable": "A review could not be used.",
  "pull-request-open": "A pull request is already open for part of this change.",
  "unknown-group-code": "A check group ended in a way Rovara has no wording for.",
  unreadable: "The block could not be read.",
  "e2e-evidence-unknown": "Some checks ended without a result, and nothing says whether the code or the setup is at fault.",
  "check-result-unknown": "A check ended without a result.",
  "check-failed-cause-unknown": "A check failed and nothing says yet whether the code or the setup is at fault.",
});

/** One failure code as a sentence for the card. */
export function autoFixCodeSentence(code: AutoFixCode): string {
  return E2E_OWNER_SENTENCES.groupSentence(code) ?? CODE_SENTENCES[code];
}

/** Why Rovara asked, in a sentence that names the limit, the cap or the budget it hit. */
export function autoFixAskReasonSentence(reason: AutoFixAskReason, capUsd?: number, failedOnOriginal = true): string {
  switch (reason) {
    case "needs-a-person": return "Only a person can fix this; new code or a retry would not.";
    case "original-code-also-fails": return failedOnOriginal ? "The same checks also fail on the original code, so new code may not fix it." : "The original code could not be checked, so I can't tell whether new code would fix it.";
    case "unclear-fault": return "I could not tell whether the code or the setup is at fault.";
    case "send-back-limit": return "I already sent this back to coding twice for this plan, which is my limit.";
    case "retry-limit": return "I already retried this once for this code, which is my limit.";
    case "total-limit": return "I reached my limit of 6 automatic actions on this task.";
    case "spend-cap": return capUsd === undefined ? "Another automatic round would go over the per-task spending cap." : `Another automatic round would go over the ${usd(capUsd)} per-task cap on automatic fixing.`;
    case "day-budget": return "The project's daily AI budget has no room for another automatic round today.";
    case "history-full": return "This task's decision history is full.";
    case "inputs-missing": return "I could not read what this task has spent so far, so I did not act.";
  }
}

const ORIGINAL_SENTENCES: Readonly<Record<AutoFixGroupResult, string>> = Object.freeze({
  passed: "passed on the original code",
  failed: "failed on the original code too",
  "cannot-run": "could not run on the original code",
  skipped: "was not run on the original code",
  pending: "is still running on the original code",
  "not-run": "was not tried on the original code",
});

/** What Rovara already did by itself on this task, from the decisions it recorded; undefined when it did nothing. */
export function autoFixTriedSentence(workflow: Pick<WorkflowSnapshot, "decisions">): string | undefined {
  // A stored workflow always has its decisions; a card built from a partial one (an old record) simply has nothing to add.
  const decisions = workflow.decisions ?? [];
  const counts = workflowAutoFixCounts(decisions);
  const retries = decisions.filter((decision) => decision.source === "AUTO_RETRY");
  const parts: string[] = [];
  const sentBack = decisions.filter((decision) => decision.source === "AUTO_FIX").length;
  if (sentBack > 0) parts.push(`Sent back to coding ${times(sentBack)}${counts.sendBacksSincePlanApproval === sentBack ? "" : ` (${times(counts.sendBacksSincePlanApproval)} for this plan)`}`);
  const checks = retries.filter((decision) => decision.auto?.stage === "VERIFY").length;
  const reviews = retries.filter((decision) => decision.auto?.stage === "REVIEW").length;
  if (checks > 0) parts.push(`Retried the checks ${times(checks)}`);
  if (reviews > 0) parts.push(`Retried the reviews ${times(reviews)}`);
  return parts.length === 0 ? undefined : `${parts.join("; ")}.`;
}

/**
 * The lines the blocked card adds when Rovara handled this task by itself or asks because of a limit: what it already tried, why it is asking, and every UNKNOWN group with its own result
 * on the original code. Empty when there is nothing to add (so the card reads as it did before). The options are the card's own buttons.
 */
export function autoFixCardLines(workflow: Pick<WorkflowSnapshot, "decisions" | "revision">, ask: AutoFixAsk | undefined, options: { plain?: boolean } = {}): string[] {
  const bold = (text: string): string => (options.plain === true ? text : `*${text}*`);
  const current = ask !== undefined && ask.workflowRevision === workflow.revision ? ask : undefined;
  const tried = autoFixTriedSentence(workflow);
  if (tried === undefined && current === undefined) return [];
  const lines: string[] = [];
  if (tried !== undefined) lines.push(`${bold("What Rovara already tried:")} ${tried}`);
  if (current !== undefined) {
    const groups = current.groups ?? [];
    // "Also fails on the original code" is said only when a scenario really failed there; a round that could not run says so instead.
    lines.push(`${bold("Why I'm asking you:")} ${autoFixAskReasonSentence(current.reason, current.capUsd, groups.length === 0 || groups.some((group) => group.original === "failed"))}`);
    if (groups.length > 0) {
      lines.push(bold("Not decided yet:"));
      for (const group of groups) lines.push(`• ${group.id} ${ORIGINAL_SENTENCES[group.original]}`);
      const more = (current.groupCount ?? groups.length) - groups.length;
      if (more > 0) lines.push(`• And ${more} more.`);
    }
  }
  return lines;
}

/** The reason an automatic send back records (at most 500 characters): fixed words and the failure sentences, nothing the output said. */
export function autoFixSendBackReason(codes: readonly AutoFixCode[]): string {
  const shown = codes.slice(0, 3).map((code) => CODE_SENTENCES[code]).join(" ");
  const more = codes.length - 3;
  const text = `Rovara sent this back to coding by itself. ${shown}${more > 0 ? ` And ${more} more.` : ""}`;
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}

/** The reason an automatic retry records: what was retried, and why in the failure sentences. */
export function autoFixRetryReason(stage: "VERIFY" | "REVIEW", codes: readonly AutoFixCode[]): string {
  const shown = codes.slice(0, 3).map((code) => CODE_SENTENCES[code]).join(" ");
  const text = `Rovara retried the ${stage === "REVIEW" ? "reviews" : "checks"} by itself. ${shown}`;
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}
