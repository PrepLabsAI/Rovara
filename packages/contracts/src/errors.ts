import { z } from "zod";

export const AgentXErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PROJECT_REVISION_MISMATCH",
  "WORKSPACE_NOT_READY",
  "WORKSPACE_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "RUNTIME_UNAVAILABLE",
  "OPERATION_INTERRUPTED",
  "CONVERSATION_STATE_LOST",
  "CALLBACK_FORBIDDEN",
  "STALE_FENCE",
  "PROJECT_NOT_FOUND",
  "PROJECT_ACCESS_DENIED",
  "PROJECT_TASKS_DISABLED",
  "TASK_NOT_FOUND",
  "TASK_BUSY",
  "CHANNEL_REQUIRED",
  "WORKSPACE_LIMIT",
  "SLACK_UNAVAILABLE",
]);

export type AgentXErrorCode = z.infer<typeof AgentXErrorCodeSchema>;

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
  if (code === "AUTH_REQUIRED") return 401;
  if (code === "FORBIDDEN" || code === "PROJECT_ACCESS_DENIED" || code === "PROJECT_TASKS_DISABLED") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "TASK_NOT_FOUND") return 404;
  if (code === "CONFIG_INVALID") return 400;
  if (code === "RUNTIME_UNAVAILABLE" || code === "SLACK_UNAVAILABLE") return 503;
  return 409;
}

export function agentXError(code: AgentXErrorCode, message: string): AgentXError {
  return new AgentXError(code, message, errorStatus(code));
}
