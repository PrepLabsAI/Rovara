import { redactCredentials } from "./events.js";

export type DiagnosticCategory = "setup" | "runtime" | "disk" | "authentication" | "interruption";

export interface DiagnosticRecord {
  timestamp: string;
  level: "info" | "warning" | "error";
  category: DiagnosticCategory;
  correlationId: string;
  workspaceId?: string;
  operationId?: string;
  message: string;
  details?: unknown;
}

export function createDiagnostic(input: Omit<DiagnosticRecord, "timestamp" | "message" | "details"> & {
  message: string;
  details?: unknown;
}): DiagnosticRecord {
  return {
    ...input,
    timestamp: new Date().toISOString(),
    message: String(redactCredentials(input.message)),
    ...(input.details === undefined ? {} : { details: redactCredentials(input.details) }),
  };
}

export function classifyFailure(error: unknown): DiagnosticCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOSPC|disk full|no space left/i.test(message)) return "disk";
  if (/credential|token|unauthori[sz]ed|expired|authentication/i.test(message)) return "authentication";
  if (/setup|clone|readiness/i.test(message)) return "setup";
  if (/interrupt|replaced|signal/i.test(message)) return "interruption";
  return "runtime";
}
