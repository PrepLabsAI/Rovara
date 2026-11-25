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
  // The same read when the install's lessons switch (`ll`) is off: nothing is loaded or recorded here, so the task page says so plainly (a 404, as before).
  "LESSONS_SWITCHED_OFF",
  // Lessons in production: a lesson change met an unfinished earlier change to the project's lessons that could not be finished just now (409, try again).
  "LESSON_BUSY",
  // The feature is not on this install (Rovara on a laptop does not have it yet). A 404, so an older client that does not know the code treats it as an answer it has no words for. Appended: no code changes meaning.
  "NOT_AVAILABLE_HERE",
  // Guided onboarding PR 3: a company's GitHub connection can't be disconnected while its projects use repositories on it (409; the message names those projects, only the company's own). Appended: no code changes meaning.
  "GITHUB_IN_USE",
  // Guided onboarding PR 4 (409): the Slack workspace is another Rovara company's; this company already holds a different Slack workspace.
  "SLACK_WORKSPACE_TAKEN",
  "SLACK_COMPANY_HAS_WORKSPACE",
  // Guided onboarding PR 5 (409): the company has no connected Slack workspace (or Rovara holds no token for it); the channel is another project's; the channel can't be
  // linked (shared with another organization, or archived).
  "SLACK_NOT_CONNECTED",
  "SLACK_CHANNEL_TAKEN",
  "SLACK_CHANNEL_REFUSED",
  // Guided onboarding PR 7: the Linear workspace is already connected to another Rovara company (409), and the company's Linear connection is missing or needs reconnecting (409). Appended: no code changes meaning.
  "LINEAR_WORKSPACE_TAKEN",
  "LINEAR_NOT_CONNECTED",
  // L4-GH (409): the GitHub account a person tries to connect to themselves is another member's of the company; the person already has a different GitHub account connected. Appended: no code changes meaning.
  "GITHUB_ACCOUNT_TAKEN",
  "GITHUB_ACCOUNT_LINK_EXISTS",
  // R1 + L1: a member links their own outside account (Linear first). LINK_START_AGAIN (403): the one answer for a link flow that did not check out. EXTERNAL_ACCOUNT_TAKEN (409): the account is another member's of
  // the company. EXTERNAL_ACCOUNT_OTHER_WORKSPACE (409): the account is in another workspace than the one the company is connected to. EXTERNAL_ACCOUNT_LINK_EXISTS (409): the person already has a different account
  // linked. Appended: no code changes meaning.
  "LINK_START_AGAIN",
  "EXTERNAL_ACCOUNT_TAKEN",
  "EXTERNAL_ACCOUNT_OTHER_WORKSPACE",
  "EXTERNAL_ACCOUNT_LINK_EXISTS",
  // Confirmed owner move, but its response could not be read. A 409 for older clients: re-read; never resend blindly.
  "COMMITTED_REFRESH_NEEDED",
  // S1 (Slack offers every task action): a task action the person pressed is no longer offered (the task moved on), was pressed on an out-of-date card or digest, still needs a value or the confirm, or is the website's. Appended: no code changes meaning.
  "TASK_ACTION_NOT_OFFERED",
  "TASK_ACTION_STALE",
  "TASK_ACTION_NEEDS_INPUT",
  "TASK_ACTION_NEEDS_WEB",
  // R1 + L1 6.2b (409, the default status): the Linear team picked for a project is already another project of the company's (a ticket would start work in both). Appended at the end: no code changes meaning or moves.
  "LINEAR_TEAM_TAKEN",
  // RD-2.0 (404): a route the table lists whose read is not built yet (the task page's spec, checks, changes and timeline reads answer it until their lanes fill them). A client shows its "not available yet" words, never a raw 404. Appended: no code changes meaning.
  "ROUTE_NOT_SERVED",
]);

/** A confirmed write whose current task view could not be read; never a pre-commit refusal. */
export const COMMITTED_REFRESH_NEEDED_MESSAGE = "The change was applied. Refresh to read the current task before acting again.";

export const CSRF_STALE_MESSAGE = "Your sign-in changed in another tab. Trying again.";

export type AgentXErrorCode = z.infer<typeof AgentXErrorCodeSchema>;

/** What INTENT_NOT_WAITING (409) says: answers arrived for a task that is not waiting for them. */
export const INTENT_NOT_WAITING_MESSAGE = "This task isn't waiting for answers.";

/** What ROUTE_NOT_SERVED (404) says: the route has a row in the table but Code does not serve its read yet. Fixed words, the same for every task. */
export const ROUTE_NOT_SERVED_MESSAGE = "This information is not available yet.";

/** What TRASH_EXPIRED (410) says: discarded work past its 7 days. */
export const TRASH_EXPIRED_MESSAGE = "This discarded work was removed after 7 days.";

/**
 * Owner DEC 254zzz91: what a company's most sensitive changes say (403 FORBIDDEN) when they come from anything but the Rovara website's own sign-in client (the operator-marked
 * `webApp` client): the command line, an AI tool, or another full-access client. There is no extra confirm step; the website's own client is the whole rule.
 */
export const ON_THE_WEBSITE_MESSAGE = "Do this on the Rovara website: the command line and AI tools cannot make this change.";

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

/**
 * S1: why a task action was refused, as a stable word beside the code (a surface picks its words by it and never reads the sentence). The F3 package moves this list with the codes (`packages/code-api/src/errors.ts`).
 * `not_linked` (no Rovara person for the chat account), `not_found` (the task is not this person's to see), `not_yours` (a reader who may not act), `not_offered` (the task moved on), `stale` (the card or the digest is old),
 * `busy` (a step holds the workspace), `over_limit` (the task's cap has no room), `needs_web` (the Rovara website's own), `needs_input` (a value or the confirm is missing), `closed`, `unavailable` (a fault: check before pressing again).
 */
export const TASK_ACTION_REFUSAL_REASONS = ["not_linked", "not_found", "not_yours", "not_offered", "stale", "busy", "over_limit", "needs_web", "needs_input", "closed", "unavailable"] as const;
export type TaskActionRefusalReason = (typeof TASK_ACTION_REFUSAL_REASONS)[number];

/**
 * S1: whether a refused move may have written something, set at the throw site by its position (before or after the round was admitted or the change committed), never mapped from a code or a sentence.
 * `none`: nothing was written. `maybe`: check the task before pressing again. `done`: it is already committed. An error that names none is `maybe` (fail safe).
 */
export type TaskActionWrites = "none" | "maybe" | "done";
export interface AgentXErrorDetail { reason?: TaskActionRefusalReason; writes?: TaskActionWrites }

export class AgentXError extends Error {
  constructor(
    readonly code: AgentXErrorCode,
    message: string,
    readonly statusCode: number,
    /** S1: the stable reason and the runtime `writes` of a refused task action (absent on every older throw). */
    readonly detail: AgentXErrorDetail = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentXError";
  }
}

/**
 * The HTTP status of each code that is not a 409, in groups. Every code not named here is a 409, as before (that includes TASK_STOP_ZERO, TASK_STOP_REVIEW_TOO_LARGE, SPENDING_APPROVAL_STALE and
 * the TASK_STOP_CONFIG_* and TASK_STOP_APPROVAL_ABOVE_CEILING codes). The groups are disjoint (tests/contract/code-api-errors.test.ts pins every code's status).
 */
const STATUS_GROUPS: readonly (readonly [number, readonly AgentXErrorCode[]])[] = [
  [401, ["AUTH_REQUIRED"]],
  // The sign-in is valid but too old, or the wrong kind, for this change: 403, so a client does not treat it as a sign-in that ended.
  [403, ["CSRF_STALE", "REAUTH_REQUIRED", "FORBIDDEN", "SLACK_TEAM_NOT_BOUND", "SLACK_ACCOUNT_NOT_LINKED", "PROJECT_ACCESS_DENIED", "PROJECT_TASKS_DISABLED", "TASK_ACCESS_DENIED", "TRIAL_LOCKED", "AGENT_NOT_ON_PROJECT", "AGENT_TOOL_NOT_GRANTED", "MODEL_NOT_ALLOWED", "REMOVED_FROM_ORG", "GITHUB_NOT_CONNECTED", "SESSION_LEVEL_REQUIRED", "LOCAL_AGENT_NOT_ALLOWED", "PROCESS_SELF_CONFIRM", "LINK_START_AGAIN", "TASK_ACTION_NEEDS_WEB"]],
  [404, ["NOT_FOUND", "PROJECT_NOT_FOUND", "TASK_NOT_FOUND", "LEARNING_OFF", "LEARNING_LOCKED", "LESSONS_SWITCHED_OFF", "NOT_AVAILABLE_HERE", "ROUTE_NOT_SERVED"]],
  [402, ["BUDGET_EXCEEDED", "ORG_BUDGET_EXCEEDED", "MACHINE_TIME_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "TEST_ALLOWANCE_USED", "CHAIN_BUDGET_EXCEEDED"]],
  [400, ["CONFIG_INVALID", "PROCESS_UNAVAILABLE", "AUDIT_RANGE_INVALID", "AUDIT_REASON_REQUIRED", "AUDIT_FILTER_TOO_WIDE", "TASK_ACTION_NEEDS_INPUT"]],
  [429, ["TOO_MANY_REQUESTS"]],
  [410, ["TRASH_EXPIRED"]],
  [503, ["RUNTIME_UNAVAILABLE", "SLACK_UNAVAILABLE", "MODEL_PROXY_UNAVAILABLE", "AUDIT_UNAVAILABLE"]],
];
const STATUS_OF: ReadonlyMap<AgentXErrorCode, number> = new Map(STATUS_GROUPS.flatMap(([status, codes]) => codes.map((code) => [code, status] as const)));

export function errorStatus(code: AgentXErrorCode): number {
  return STATUS_OF.get(code) ?? 409;
}

export function agentXError(code: AgentXErrorCode, message: string, detail?: AgentXErrorDetail): AgentXError {
  return new AgentXError(code, message, errorStatus(code), detail);
}

/**
 * Guided onboarding PR 3: what GITHUB_NOT_CONNECTED (403) says when the company's own GitHub App installation was uninstalled or suspended on GitHub, or a token for it is asked
 * for after that (design section 3a). Said only to the company that installation is bound to; anyone else gets the ordinary refusal.
 */
export const GITHUB_DISCONNECTED_MESSAGE = "GitHub disconnected. Reconnect it in Company settings, Connections.";

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

// ---- What a client reads (F3 cut 1): the envelope, and a code it may not know ----

/**
 * Did anything happen? `none`: nothing was written, so a retry is safe. `done`: the change was committed. `maybe`: unknown, and what a refusal without it reads as (a timeout or a transport failure too).
 * Set at the throw site by its position (before or after the write), never mapped from a code or a sentence. Nothing sets it yet; the cuts that convert a route do.
 */
export const ErrorWritesSchema = z.enum(["none", "maybe", "done"]);
export type ErrorWrites = z.infer<typeof ErrorWritesSchema>;

/**
 * The body of every refusal. `code` is a plain string on read: a code from a newer Code is a value, not a parse failure (`isKnownCode` narrows it). `message` is display text and no handler
 * branches on it. `reason` tells apart two causes of one code; `writes` says whether anything happened. Both are optional and read tolerantly, so a Code that sends neither is still read.
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    reason: z.string().optional(),
    writes: ErrorWritesSchema.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Whether a code read off the wire is one this build knows. */
export function isKnownCode(code: string): code is AgentXErrorCode {
  return AgentXErrorCodeSchema.safeParse(code).success;
}
