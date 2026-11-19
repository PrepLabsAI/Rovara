// A command the broker will not carry into a proposal: it fetches code and runs it, or its text changes under the redactor (a secret-shaped value).
import { formatCommandLine, redactText, remoteCodeReason, type ProjectCommand } from "@agentx/contracts";

export function refusedCommand(command: ProjectCommand): boolean {
  const text = formatCommandLine(command);
  return remoteCodeReason(text) !== undefined || redactText(text) !== text;
}
