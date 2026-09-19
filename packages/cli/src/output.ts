import { AgentXError, type AgentXErrorCode } from "@agentx/contracts";

export interface FormattedError {
  text: string;
  exitCode: number;
}

export function formatSuccess(data: unknown, json: boolean): string {
  if (json) return `${JSON.stringify({ ok: true, data })}\n`;
  return typeof data === "string" ? `${data}\n` : `${JSON.stringify(data, null, 2)}\n`;
}

export function formatError(error: unknown, json: boolean): FormattedError {
  const normalized: { code: AgentXErrorCode | "INTERNAL_ERROR"; message: string } =
    error instanceof AgentXError
      ? { code: error.code, message: stripCodePrefix(error.message, error.code) }
      : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "unexpected error" };
  const text = json
    ? `${JSON.stringify({ ok: false, error: normalized })}\n`
    : `AgentX error [${normalized.code}]: ${normalized.message}\n`;
  return {
    text,
    exitCode: normalized.code === "INTERNAL_ERROR" ? 1 : exitCodeForError(normalized.code),
  };
}

export function exitCodeForError(code: AgentXErrorCode): number {
  if (code === "CONFIG_INVALID" || code === "PROJECT_REVISION_MISMATCH") return 2;
  if (code === "AUTH_REQUIRED") return 3;
  if (code === "FORBIDDEN" || code === "NOT_FOUND" || code === "CALLBACK_FORBIDDEN") return 4;
  if (code === "WORKSPACE_NOT_READY" || code === "WORKSPACE_BUSY") return 5;
  if (code === "RUNTIME_UNAVAILABLE" || code === "OPERATION_INTERRUPTED" || code === "STALE_FENCE") return 6;
  return 7;
}

function stripCodePrefix(message: string, code: string): string {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
