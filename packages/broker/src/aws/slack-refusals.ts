import { FEEDBACK_CHANGED_SINCE_CARD, FEEDBACK_REVIEW_RETRY_BUSY, FEEDBACK_REVIEW_RETRY_CHANGED } from "./developer-tasks.js";
import { PROJECT_RECORD_NEEDS_ADMIN } from "./broker-shared.js";
import { WORKFLOW_ACTIONABLE_REFUSALS } from "../developer/workflow-actions.js";

/**
 * Refusals that are not about a press being out of date, by their exact text (never a prefix), in the words the presser
 * hears: the press was current, and the presser can fix what it asked for.
 */
const SLACK_PLAIN_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["select at least one check before retrying verification", "Select at least one check, then try again."],
  ["choose checks that are approved for this project", "Choose from this project's checks, then try again."],
  [FEEDBACK_REVIEW_RETRY_BUSY, FEEDBACK_REVIEW_RETRY_BUSY],
  [FEEDBACK_REVIEW_RETRY_CHANGED, FEEDBACK_REVIEW_RETRY_CHANGED],
  [FEEDBACK_CHANGED_SINCE_CARD, FEEDBACK_CHANGED_SINCE_CARD],
  [PROJECT_RECORD_NEEDS_ADMIN, PROJECT_RECORD_NEEDS_ADMIN],
]);
/** The refusals of an approval or a retry that name what to do next (Ruling AU), said as sentences, never as "out of date". */
const SLACK_ACTIONABLE_REASONS: ReadonlySet<string> = new Set(Object.values(WORKFLOW_ACTIONABLE_REFUSALS));
/**
 * Task 19: the broker refusals a Slack press can meet in the normal course of things, by what the presser hears. A
 * task is not found for a Slack caller when it was started from an AI tool (its owner is that tool's sign-in) or is
 * gone, so the words fit both.
 */
/** The decision's lost-race sentences (FR-035), which Slack says as they are. */
const LOST_RACE = /^(Already approved by|Changes were already requested by) [^\n]{1,200}\.$/u;
/** The lost-race sentence for Slack: Slack's markup characters escaped, and the winner named with a mention when their Slack ID is known. */
function slackLostRace(reason: string, decidedBy: unknown): string {
  const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const escaped = escape(reason);
  const { name, slackUserId } = (decidedBy ?? {}) as { name?: unknown; slackUserId?: unknown };
  if (typeof name !== "string" || typeof slackUserId !== "string" || !/^[UW][A-Z0-9]{2,}$/u.test(slackUserId)) return escaped;
  const plain = ` by ${escape(name)} `;
  const at = escaped.indexOf(plain);
  return at < 0 ? escaped : `${escaped.slice(0, at)} by <@${slackUserId}> ${escaped.slice(at + plain.length)}`;
}

/**
 * The reasons the plan-approval check gives when a plan cannot be approved (or approved again) against the approved setup and the
 * runtimes that are ready now, by their opening words (validateWorkflowE2EApplicationPlan, decideTaskWorkflow and retryTaskWorkflow).
 * They name what to do next, so the presser hears them as a sentence; the rest of a reason is data and is never said. The exact reasons in
 * WORKFLOW_ACTIONABLE_REFUSALS (the plan-correction and retry-selection refusals) are said the same way.
 */
const SLACK_PLAN_APPROVAL_REASONS = /^(the application E2E plan cannot be approved: |the application E2E plan could not be checked for approval \(|the plan cannot be approved again here: |the approved plan no longer carries the application intent )/u;
function slackPlanApprovalRefusal(reason: string): string | undefined {
  if (!SLACK_PLAN_APPROVAL_REASONS.test(reason) && !SLACK_ACTIONABLE_REASONS.has(reason)) return undefined;
  const escaped = reason.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").slice(0, 400);
  const sentence = `${escaped.charAt(0).toUpperCase()}${escaped.slice(1)}`;
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}

export function slackRefusalMessage(code: string, outOfDate: string, reason = "", decidedBy?: unknown): string | undefined {
  switch (code) {
    // A refusal the presser can act on is said as it is; any other means the press no longer fits the task.
    case "CONFIG_INVALID": return SLACK_PLAIN_REFUSALS.get(reason) ?? slackPlanApprovalRefusal(reason) ?? outOfDate;
    // A plan that could not be checked for approval: the reason says to keep the plan and try again, so the presser hears it. Any other is unexpected.
    case "RUNTIME_UNAVAILABLE": return slackPlanApprovalRefusal(reason);
    // A lost race says who decided and when (the owner's name is redacted; Slack's markup characters are escaped).
    case "IDEMPOTENCY_CONFLICT": return LOST_RACE.test(reason) ? slackLostRace(reason, decidedBy) : outOfDate;
    case "WORKSPACE_BUSY":
    case "TASK_BUSY": return "AgentX is still working on the previous step. Try again when it posts.";
    case "FORBIDDEN": return "Only the task owner can do that.";
    case "TASK_NOT_FOUND": return "This task can't be changed from Slack. Continue it where it was started, or start a new request.";
    default: return undefined;
  }
}
