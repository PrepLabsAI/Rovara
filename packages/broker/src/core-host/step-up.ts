// Lane ID part 2 (plan v3.2 7.2 change 2): the fresh step-up gate for a sensitive press on the deployed API, with the same contract as the decision and script-token routes (PR #662):
//   - the step-up's time and method come ONLY from the caller the broker's sign-in vouched for (`stepUp`, read from the verified access token's `step_up_at` / `step_up_amr`), never from a header,
//     a query or a body;
//   - the method must be one of Code's own factors (an emailed code, a passkey, a company sign-in's own re-authentication); a Slack, Google or GitHub round trip never counts;
//   - the age is checked here, on every request, against the company's window (the policy hook's `stepUpWindowSeconds`), which may only SHORTEN the ten-minute default. A hook that throws or answers
//     anything but a whole number from 0 to 86400 refuses the press (503, fixed words), never lets it through on the default. A zero window refuses every step-up.
//   - a time that is not in the strict ISO form the sign-in writes, older than the window, or further in the future than the clock-skew allowance (never longer than the window) is refused.
// When #662 lands, its private copy in dev-routes.ts uses this module, so the rule lives once.
import { APPROVAL_SIGN_IN_SKEW_SECONDS, FRESH_SIGN_IN_SECONDS, agentXError, checkApprovalSignIn } from "@agentx/contracts";

/** The factors Code owns (the sign-in server's step-up methods). */
export const STEP_UP_FACTORS = ["email_code", "passkey", "company_reauth"] as const;
export type StepUpFactor = (typeof STEP_UP_FACTORS)[number];
const FACTORS: ReadonlySet<unknown> = new Set<unknown>(STEP_UP_FACTORS);
/** The one time form the broker's sign-in writes (`toISOString`); a looser string Date.parse would still read is refused. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const STEP_UP_WINDOW_NO_ANSWER = "The company rules service did not answer, so nothing was done. Try again in a moment.";

export interface StepUpCaller {
  stepUp?: { at: string; method: string } | undefined;
}

/** The caller's step-up if it is fresh enough for this company now; otherwise REAUTH_REQUIRED with `refusal` (or 503 when the company's window could not be read). */
export async function freshStepUp(caller: StepUpCaller, windowSeconds: (() => Promise<unknown>) | undefined, nowMs: number, refusal: string): Promise<{ at: string; method: StepUpFactor }> {
  // The step-up is read first: a caller without one is refused without asking the company rules service.
  const stepUp = caller.stepUp;
  if (stepUp === undefined || stepUp === null || typeof stepUp !== "object" || typeof stepUp.at !== "string" || !ISO_INSTANT.test(stepUp.at) || !FACTORS.has(stepUp.method)) throw agentXError("REAUTH_REQUIRED", refusal);
  let seconds = FRESH_SIGN_IN_SECONDS;
  if (windowSeconds !== undefined) {
    let answer: unknown;
    try { answer = await windowSeconds(); } catch { answer = undefined; }
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer > 86_400) throw agentXError("RUNTIME_UNAVAILABLE", STEP_UP_WINDOW_NO_ANSWER);
    seconds = Math.min(seconds, answer);
  }
  if (seconds === 0) throw agentXError("REAUTH_REQUIRED", refusal);
  const verdict = checkApprovalSignIn({ mode: "window", seconds: Math.max(seconds, 60) }, { authTime: stepUp.at }, nowMs, { companySignIn: false });
  if (!verdict.ok) throw agentXError("REAUTH_REQUIRED", refusal);
  // Below a minute checkApprovalSignIn's floor is looser than the company asked: the exact age is checked too, and the skew allowance never exceeds the window.
  const age = nowMs - Date.parse(stepUp.at);
  if (age > seconds * 1000 || -age > Math.min(APPROVAL_SIGN_IN_SKEW_SECONDS, seconds) * 1000) throw agentXError("REAUTH_REQUIRED", refusal);
  return { at: stepUp.at, method: stepUp.method as StepUpFactor };
}
