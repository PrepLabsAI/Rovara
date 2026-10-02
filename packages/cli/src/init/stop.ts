// Spec 048 FR-060: a stop the person chose (declining the plan, Stop for now, stopping at the root
// warning or a check-again question) is not a failure, so the page shows no failure screen for it.
import { agentXError } from "@agentx/contracts";

const chosen = new WeakSet<object>();

export function markOperatorStop<T>(error: T): T {
  if (typeof error === "object" && error !== null) chosen.add(error);
  return error;
}

// Stops made with their own words (declining the plan, the root warning): those words are the
// page's outcome. A stop marked on an error (declining a check-again question) is not.
const worded = new WeakSet<object>();

export function operatorStop(message: string): Error {
  const error = markOperatorStop(agentXError("CONFIG_INVALID", message));
  worded.add(error);
  return error;
}

/** True for a stop made by operatorStop(message), whose message says why in the person's terms. */
export function isWordedOperatorStop(error: unknown): boolean {
  return typeof error === "object" && error !== null && worded.has(error);
}

export function isOperatorStop(error: unknown): boolean {
  return typeof error === "object" && error !== null && chosen.has(error);
}
