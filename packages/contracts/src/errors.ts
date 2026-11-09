import { z } from "zod";

export const AgentXErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "AUTH_REQUIRED",
  "CSRF_STALE",
  "REAUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PROJECT_REVISION_MISMATCH",
  "WORKSPACE_NOT_READY",
  "WORKSPACE_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "RUNTIME_UNAVAILABLE",
  "SPENDING_APPROVAL_STALE",
  "TASK_STOP_ZERO",
  "TASK_STOP_REVIEW_TOO_LARGE",
  "TASK_STOP_CONFIG_MISSING",
  "TASK_STOP_CONFIG_INVALID",
  "TASK_STOP_APPROVAL_ABOVE_CEILING",
  "OPERATION_INTERRUPTED",
  "CONVERSATION_STATE_LOST",
  "CALLBACK_FORBIDDEN",
  "STALE_FENCE",
  "PROJECT_NOT_FOUND",
  "PROJECT_ACCESS_DENIED",
  "PROJECT_TASKS_DISABLED",
  "TASK_NOT_FOUND",
  "TASK_ACCESS_DENIED",
  "TASK_BUSY",
  "CHANNEL_REQUIRED",
  "WORKSPACE_LIMIT",
  "SLACK_UNAVAILABLE",
  "CHANNEL_AMBIGUOUS",
  "CONFIRMATION_UNAVAILABLE",
  "CONFIRMATION_DECLINED",
  "CONFIRMATION_EXPIRED",
  "CHANGE_STALE",
  "POLICY_STALE",
  "DRAFT_STALE",
  "ALREADY_IN_ORG",
  "INVITE_INVALID",
  // Lane A: fixed terminal outcomes for reviewed invite revocation.
  "INVITE_ALREADY_ACCEPTED",
  "INVITE_ALREADY_REVOKED",
  "INVITE_EXPIRED",
  "INVITE_WRONG_EMAIL",
  "SLACK_TEAM_TAKEN",
  "REMOVED_FROM_ORG",
  "LAST_OWNER",
  // Member removal (v1.1).
  "SUCCESSOR_INVALID",
  "MEMBER_ALREADY_REMOVED",
  "SLACK_TEAM_NOT_BOUND",
  // A Slack account that belongs to no member of the company the workspace is connected to (QA6-15): the person is refused, not the channel.
  "SLACK_ACCOUNT_NOT_LINKED",
  "MODEL_PROXY_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "ORG_BUDGET_EXCEEDED",
  "TRIAL_LOCKED",
  "TRIAL_GITHUB_USED",
  "MACHINE_TIME_EXCEEDED",
  "AGENT_REVISION_CONFLICT",
  "AGENT_UNAVAILABLE",
  "AGENT_NOT_ON_PROJECT",
  "AGENT_TOOL_NOT_GRANTED",
  "MODEL_NOT_ALLOWED",
  "WORKFLOW_MODE_UNMAPPED",
  "PROJECT_BUDGET_EXCEEDED",
  "AGENT_BUDGET_EXCEEDED",
  "AGENT_BUDGET_REQUIRED",
  "TEST_ALLOWANCE_USED",
  "APPROVAL_CLOSED",
  "AUDIT_RANGE_INVALID",
  "AUDIT_REASON_REQUIRED",
  "AUDIT_UNAVAILABLE",
  "AUDIT_FILTER_TOO_WIDE",
  "PROJECT_NAME_TAKEN",
  "PROJECT_ARCHIVED",
  "GITHUB_NOT_CONNECTED",
  "GITHUB_INSTALLATION_TAKEN",
  "TOO_MANY_REQUESTS",
  "CHAIN_REVISION_CONFLICT",
  "CHAIN_UNAVAILABLE",
  "CHAIN_BUDGET_REQUIRED",
  "CHAIN_BUDGET_EXCEEDED",
  "CHAIN_RUN_CLOSED",
  "SESSION_LEVEL_REQUIRED",
  "SESSION_ENDED",
  "SESSION_REVISION_CONFLICT",
  "SESSION_ON_MAC",
  "LOCAL_AGENT_NOT_ALLOWED",
  "INTENT_NOT_WAITING",
  "MERGE_NOT_READY",
  "TRASH_EXPIRED",
  "PROCESS_UNAVAILABLE",
  "PLAYBOOK_STALE",
  "PROCESS_SELF_CONFIRM",
  "PROCESS_IN_USE",
  // v1.2 learning loop (B6): a rule cannot be accepted or removed right now.
  "LEARNING_LAYER_BUSY",
  "LEARNING_RULES_FULL",
  "LEARNING_SOURCES_GONE",
  // The company's master suggestions switch: a stale revision of the switch, and a suggestion decision while it is off.
  "LEARNING_SETTINGS_CHANGED",
  "LEARNING_SUGGESTIONS_OFF",
  // The Sources read of a project whose learning is explicitly Off (a 404, so a client that only looks at the status behaves as before): the page can say learning is off instead of "not set up".
  "LEARNING_OFF",
  // The same read when the company's lock is what keeps learning off for the project.
  "LEARNING_LOCKED",
  // Lessons in production: a lesson change met an unfinished earlier change to the project's lessons that could not be finished just now (409, try again).
  "LESSON_BUSY",
]);

export const CSRF_STALE_MESSAGE = "Your sign-in changed in another tab. Trying again.";

export type AgentXErrorCode = z.infer<typeof AgentXErrorCodeSchema>;

/** What INTENT_NOT_WAITING (409) says: answers arrived for a task that is not waiting for them. */
export const INTENT_NOT_WAITING_MESSAGE = "This task isn't waiting for answers.";

/** What TRASH_EXPIRED (410) says: discarded work past its 7 days. */
export const TRASH_EXPIRED_MESSAGE = "This discarded work was removed after 7 days.";

/** What LAST_OWNER (409) says: the organization's last owner may not step down, leave or be removed. */
export const LAST_OWNER_MESSAGE = "An organization needs at least one owner. Make someone else an owner first.";

/** What PROJECT_NAME_TAKEN (409) says. The name is shown between backticks; the caller has checked it is a project name. */
export const projectNameTakenMessage = (name: string): string => `Your organization already has a project named \`${name}\` (it may be archived). Choose another name.`;

/** What PROJECT_ARCHIVED (409) says, whichever new work or change it refuses. */
export const projectArchivedMessage = (name: string): string => `Project \`${name}\` is archived. Ask a project maintainer to restore it.`;

/** What INVITE_WRONG_EMAIL (409) says: an email-targeted invite was presented by a sign-in whose verified email is another address. */
export const INVITE_WRONG_EMAIL_MESSAGE = "This invite is for a different email address. Sign in with the address it was sent to, or ask for an invite to yours.";

/** What GITHUB_INSTALLATION_TAKEN (409) says: the GitHub account's installation is bound to another Rovara organization. */
export const GITHUB_INSTALLATION_TAKEN_MESSAGE = "This GitHub account is already connected to another Rovara organization.";

/** What PROCESS_SELF_CONFIRM (403) says: the person who asked for a change to a project's process cannot confirm it themselves while someone else could. */
export const PROCESS_SELF_CONFIRM_MESSAGE = "Someone else who can approve changes in this project must confirm this.";

/** What PROCESS_IN_USE (409) says: a project's process layer can't be archived while it is the project's default process. */
export const PROCESS_IN_USE_MESSAGE = "Switch the project to another way of working before archiving this one.";

export class AgentXError extends Error {
  constructor(
    readonly code: AgentXErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentXError";
  }
}

export function errorStatus(code: AgentXErrorCode): number {
  if (code === "TASK_STOP_ZERO" || code === "TASK_STOP_REVIEW_TOO_LARGE") return 409;
  if (code === "SPENDING_APPROVAL_STALE") return 409;
  if (code === "TASK_STOP_CONFIG_MISSING" || code === "TASK_STOP_CONFIG_INVALID" || code === "TASK_STOP_APPROVAL_ABOVE_CEILING") return 409;
  if (code === "AUTH_REQUIRED") return 401;
  // The sign-in is valid but too old, or the wrong kind, for this change: 403, so a client does not treat it as a sign-in that ended.
  if (code === "CSRF_STALE" || code === "REAUTH_REQUIRED" || code === "FORBIDDEN" || code === "SLACK_TEAM_NOT_BOUND" || code === "SLACK_ACCOUNT_NOT_LINKED" || code === "PROJECT_ACCESS_DENIED" || code === "PROJECT_TASKS_DISABLED" || code === "TASK_ACCESS_DENIED" || code === "TRIAL_LOCKED" || code === "AGENT_NOT_ON_PROJECT" || code === "AGENT_TOOL_NOT_GRANTED" || code === "MODEL_NOT_ALLOWED" || code === "REMOVED_FROM_ORG" || code === "GITHUB_NOT_CONNECTED" || code === "SESSION_LEVEL_REQUIRED" || code === "LOCAL_AGENT_NOT_ALLOWED" || code === "PROCESS_SELF_CONFIRM") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "TASK_NOT_FOUND" || code === "LEARNING_OFF" || code === "LEARNING_LOCKED") return 404;
  if (code === "BUDGET_EXCEEDED" || code === "ORG_BUDGET_EXCEEDED" || code === "MACHINE_TIME_EXCEEDED" || code === "PROJECT_BUDGET_EXCEEDED" || code === "AGENT_BUDGET_EXCEEDED" || code === "TEST_ALLOWANCE_USED" || code === "CHAIN_BUDGET_EXCEEDED") return 402;
  if (code === "CONFIG_INVALID" || code === "PROCESS_UNAVAILABLE" || code === "AUDIT_RANGE_INVALID" || code === "AUDIT_REASON_REQUIRED" || code === "AUDIT_FILTER_TOO_WIDE") return 400;
  if (code === "TOO_MANY_REQUESTS") return 429;
  if (code === "TRASH_EXPIRED") return 410;
  if (code === "RUNTIME_UNAVAILABLE" || code === "SLACK_UNAVAILABLE" || code === "MODEL_PROXY_UNAVAILABLE" || code === "AUDIT_UNAVAILABLE") return 503;
  return 409;
}

export function agentXError(code: AgentXErrorCode, message: string): AgentXError {
  return new AgentXError(code, message, errorStatus(code));
}

/** What a refusal to reach a repository through the org's GitHub connection says (GITHUB_NOT_CONNECTED, Plan 2). */
export const githubNotConnectedMessage = (fullName: string) => `Rovara can't reach ${fullName} through your organization's GitHub connection. Connect it with: agentx github connect`;

// ---- chains (Plan 4): the exact texts of the chain error codes. Chain, step and agent names are the caller's own, never another org's.

/** What CHAIN_REVISION_CONFLICT (409) says. */
export const CHAIN_REVISION_CONFLICT_MESSAGE = "Someone else changed this chain's draft. Reload it and make your change again.";

/** What CHAIN_RUN_CLOSED (409) says. */
export const CHAIN_RUN_CLOSED_MESSAGE = "This chain run has already ended.";

/** CHAIN_UNAVAILABLE (409), first text: the chain is archived. */
export const chainArchivedMessage = (chain: string) => `${chain} is archived, so it can't start new runs.`;

/** CHAIN_UNAVAILABLE (409), second text: a step's pinned agent version can't run now. */
export const chainStepUnavailableMessage = (chain: string, step: string, agent: string, version: number, reason: string) =>
  `${chain}'s step "${step}" uses ${agent} version ${version}, which can't run now: ${reason}. Ask ${chain}'s owner to publish a new version.`;

/** What CHAIN_BUDGET_REQUIRED (409) says. */
export const chainBudgetRequiredMessage = (chain: string) => `${chain} has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both.`;

/** What CHAIN_BUDGET_EXCEEDED (402) says; dollars to the cent. */
export const chainBudgetExceededMessage = (chain: string, spentUsd: number, limitUsd: number) =>
  `${chain}'s monthly AI budget is used up ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}). Ask its owner for more.`;
