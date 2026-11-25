// MEMBERSHIP-READ-FAILS-SAFE (briefs/arch-cleanup/REMOVED-MEMBER-ANSWER-FINDINGS.md): the ONE rule for a read of a person's company membership (or of the grant that rides on it).
//   "The read says there is NO membership (or it is revoked)": a positive fact. Access ends and the answer stays as it was (fail closed): a refusal, and where a session is involved the session may end.
//   "The read FAILED" (the store threw, timed out, was throttled): NOT a fact about the person. The answer is a retryable 503 (RUNTIME_UNAVAILABLE, the existing words), nothing is served, and NOTHING is revoked, ended or
//   refused as "no such task" / "sign in again". Absence is never inferred from an error.
// Every place that reads membership wraps the read in `readingMembership` (so any throw becomes the one marked error), and every place that used to catch such a read and treat it as "no membership" lets the marked
// error through (`rethrowMembershipReadFailure`). The token refresh and the request path use this same pair, so the two cannot disagree.
import { agentXError, type AgentXError } from "@agentx/contracts";

/** The existing runtime-unavailable words (aws/broker-shared.ts AWS_TEMPORARY_MESSAGE), the words every retryable AWS failure already answers. */
export const MEMBERSHIP_READ_FAILED_WORDS = "AgentX could not reach AWS just now; try again in a moment";

const failures = new WeakSet<object>();

/** The one error for "the membership read failed": 503 RUNTIME_UNAVAILABLE with the existing words. Never carries the store's own words. */
export function membershipReadFailed(): AgentXError {
  const error = agentXError("RUNTIME_UNAVAILABLE", MEMBERSHIP_READ_FAILED_WORDS);
  failures.add(error);
  return error;
}

export function isMembershipReadFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && failures.has(error);
}

/** Runs a read of a person's membership (or grant). A throw of any kind is "the read failed", never "no membership". */
export async function readingMembership<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw isMembershipReadFailure(error) ? error : membershipReadFailed();
  }
}

/** For a `catch` that used to turn any error into "no membership": a failed read goes on up as the retryable answer. */
export function rethrowMembershipReadFailure(error: unknown): void {
  if (isMembershipReadFailure(error)) throw error;
}
