// Spec 025 FR-049: every tool error has a stable code, a plain message and a next step.
import { CHANNEL_PRIVACY_NOT_SET_UP, CHANNEL_PRIVACY_NOT_SET_UP_STEP, PRIVATE_CHANNEL_NOT_A_MEMBER, PRIVATE_CHANNEL_NOT_A_MEMBER_STEP, redactText } from "@agentx/contracts";

export const TOOL_ERROR_CODES = [
  "SIGN_IN_REQUIRED", "SIGN_IN_REJECTED", "ADMIN_REQUIRED", "PROJECT_NOT_FOUND", "PROJECT_ACCESS_DENIED",
  "PROJECT_TASKS_DISABLED", "TASK_NOT_FOUND", "CHANNEL_REQUIRED", "CHANNEL_AMBIGUOUS", "WORKSPACE_LIMIT", "TASK_BUSY",
  "SLACK_UNAVAILABLE", "CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE",
  "UPGRADE_REQUIRED", "CONTROL_PLANE_UNAVAILABLE", "INVALID_REQUEST",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const NEXT_STEPS: Record<ToolErrorCode, string> = {
  SIGN_IN_REQUIRED: "run npx @charterarc/agentx login <your AgentX URL>",
  SIGN_IN_REJECTED: "contact an AgentX admin; the message says why the sign-in was refused",
  ADMIN_REQUIRED: "run npx @charterarc/agentx login --admin",
  PROJECT_NOT_FOUND: "run agentx_list_projects to see the projects you can use",
  PROJECT_ACCESS_DENIED: "join one of the project's Slack channels, or ask an admin for access",
  PROJECT_TASKS_DISABLED: "use the project's Slack channel, or ask an admin",
  TASK_NOT_FOUND: "run agentx_list_tasks to see your tasks",
  // Ruling F22: fits a project with no bound channel, and a named channel that is not bound (C3).
  CHANNEL_REQUIRED: "send channel with one of the bound channels the message names, or ask an AgentX admin to bind one",
  CHANNEL_AMBIGUOUS: "send channel with one of the channels the message names",
  WORKSPACE_LIMIT: "close a task you no longer need with agentx_close_task",
  TASK_BUSY: "wait with agentx_wait_for_task, or stop the task with agentx_cancel_task",
  SLACK_UNAVAILABLE: "try again in a few minutes; projects an admin granted you still work",
  CONFIRMATION_UNAVAILABLE: "use a client that supports elicitation, link a Slack user, or use the agentx CLI",
  CONFIRMATION_DECLINED: "ask for the change again",
  CONFIRMATION_EXPIRED: "ask for the change again",
  CHANGE_STALE: "ask for the change again",
  UPGRADE_REQUIRED: "run npx -y @charterarc/agentx@latest mcp install --client <claude-code, codex or cursor>",
  CONTROL_PLANE_UNAVAILABLE: "check your connection and try again",
  INVALID_REQUEST: "fix the input the message names and try again",
};

/**
 * Ruling S1: UPGRADE_REQUIRED's next step when the control plane, not this CLI, is too old
 * (older than DEVELOPER_API_VERSION's minor, so it has no task routes).
 */
export const UPGRADE_AGENTX_STEP = "ask your AgentX admin to upgrade AgentX, or use an older CLI";

/** CONTROL_PLANE_UNAVAILABLE's next step for a 4xx this CLI does not know: not a connection problem. */
export const UNEXPECTED_ANSWER_STEP = "ask your AgentX admin, or try again later";

/**
 * Final review M1: TASK_BUSY's next step when a start or a close, not a running task, met a busy
 * answer (the start's or close's own transaction failed): the action is tried again, not waited on.
 */
export const START_BUSY_STEP = "try again with the same request_id";
export const CLOSE_BUSY_STEP = "try agentx_close_task again in a moment, and ask an admin if it keeps failing";
/** Spec 025 C21: a share that met a task changing under it is tried again, not waited on. */
export const SHARE_BUSY_STEP = "try agentx_share_task again with the same request_id";

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string, readonly nextStep: string = NEXT_STEPS[code]) {
    super(message);
    this.name = "ToolError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Server text made safe to show: the secrets named removed first (before the cap could cut one in
 * two), credentials redacted, no control characters, at most 1,000 characters.
 */
export function plainText(value: unknown, fallback: string, secrets: readonly string[] = []): string {
  if (typeof value !== "string") return fallback;
  const hidden = secrets.reduce((text, secret) => (secret === "" ? text : text.split(secret).join("[REDACTED]")), value);
  const clean = redactText(hidden.replace(CONTROL, " ")).trim().slice(0, 1_000);
  return clean === "" ? fallback : clean;
}

/** Broker codes whose meaning, words and next step are the tool's too (P6, C21: exactly these nine). */
const PASSED_THROUGH = new Set<string>(["PROJECT_NOT_FOUND", "PROJECT_ACCESS_DENIED", "PROJECT_TASKS_DISABLED", "TASK_NOT_FOUND", "TASK_BUSY", "CHANNEL_REQUIRED", "WORKSPACE_LIMIT", "SLACK_UNAVAILABLE", "CHANNEL_AMBIGUOUS"]);
/**
 * A task that moved on under an action: the busy answers of the existing handlers, and a cancel
 * that raced the task's own result (Task 11 passes both through with words naming the tool).
 */
const BUSY = new Set<string>(["WORKSPACE_BUSY", "WORKSPACE_NOT_READY", "STALE_FENCE"]);
/** Owner decision 4 (P6): input the control plane refuses. */
const INVALID = new Set<string>(["CONFIG_INVALID", "IDEMPOTENCY_CONFLICT"]);

/** True when a control-plane error code is an answer to show, not an outage to try again. */
export function isMeaningfulCode(code: string | undefined): boolean {
  return code !== undefined && (PASSED_THROUGH.has(code) || BUSY.has(code) || INVALID.has(code) || code === "AUTH_REQUIRED");
}

// Ruling F16: the placeholder "<your AgentX URL>" is kept whole.
const SIGN_IN = /\brun (npx @charterarc\/agentx login (?:<[^>]+>|\S+))/;

/** The exact sign-in command from a message, else the session's own. */
export function signInStep(message: string, fallback: string): string {
  return `run ${SIGN_IN.exec(message)?.[1] ?? fallback}`;
}

/** Final review M6: answers whose own words name a next step their code's generic one contradicts. */
const OWN_STEPS = new Map<string, string>([
  [`CHANNEL_REQUIRED:${PRIVATE_CHANNEL_NOT_A_MEMBER}`, PRIVATE_CHANNEL_NOT_A_MEMBER_STEP],
  [`SLACK_UNAVAILABLE:${CHANNEL_PRIVACY_NOT_SET_UP}`, CHANNEL_PRIVACY_NOT_SET_UP_STEP],
]);

/** A control-plane error answer as the tool error of FR-049; `secrets` never appear in its words. */
export function toolErrorFromResponse(status: number, value: unknown, signInCommand: string, secrets: readonly string[] = [], busyStep: string = NEXT_STEPS.TASK_BUSY): ToolError {
  const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = plainText(error?.message, `AgentX answered HTTP ${status}`, secrets);
  if (status === 401 || code === "AUTH_REQUIRED") return new ToolError("SIGN_IN_REQUIRED", message, `run ${signInCommand}`);
  if (code !== undefined && PASSED_THROUGH.has(code)) return new ToolError(code as ToolErrorCode, message, OWN_STEPS.get(`${code}:${message}`));
  if (code !== undefined && BUSY.has(code)) return new ToolError("TASK_BUSY", message, busyStep);
  if (code !== undefined && INVALID.has(code)) return new ToolError("INVALID_REQUEST", message);
  if (status >= 400 && status < 500) return new ToolError("CONTROL_PLANE_UNAVAILABLE", message, UNEXPECTED_ANSWER_STEP);
  return new ToolError("CONTROL_PLANE_UNAVAILABLE", message);
}
