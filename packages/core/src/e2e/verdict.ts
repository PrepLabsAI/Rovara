/** The broker's verdict on a round of E2E evidence. PASS is the only one that lets the work be published. */
export type E2EVerdict = "PASS" | "FAILED" | "UNKNOWN";

/**
 * Combines the verdicts of the independent parts of one round (the portable admission and the application admission of a mixed plan, Ruling BA):
 * any FAILED gives FAILED, else any UNKNOWN gives UNKNOWN, else PASS. No part at all is UNKNOWN, never PASS.
 */
export function combineE2EVerdicts(verdicts: readonly E2EVerdict[]): E2EVerdict {
  if (verdicts.length === 0) return "UNKNOWN";
  if (verdicts.includes("FAILED")) return "FAILED";
  return verdicts.every((verdict) => verdict === "PASS") ? "PASS" : "UNKNOWN";
}
