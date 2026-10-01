// Spec 048 FR-060: a stop the person chose (declining the plan, Stop for now, stopping at the root
// warning or a check-again question) is not a failure, so the page shows no failure screen for it.
import { agentXError } from "@agentx/contracts";

const chosen = new WeakSet<object>();

export function markOperatorStop<T>(error: T): T {
  if (typeof error === "object" && error !== null) chosen.add(error);
  return error;
}

export function operatorStop(message: string): Error {
  return markOperatorStop(agentXError("CONFIG_INVALID", message));
}

export function isOperatorStop(error: unknown): boolean {
  return typeof error === "object" && error !== null && chosen.has(error);
}
