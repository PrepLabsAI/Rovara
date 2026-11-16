// Lane W (plan v3.2 section 7.2 change 2, DEC 214 decision 7): the fresh step-up the old broker's sensitive client routes need (a company role change, a removal, a merge, loosening
// a project's merge rules).
//
// This is the same contract as lane ID's `DeployedCaller.stepUp` and its route check (`freshStepUp`, PR #662, stacked on #660 which puts the step-up's time and method in the token):
//   - The step-up comes ONLY from the verified access token's `step_up_at` (whole seconds) and `step_up_amr` claims, never from a header, a query or a body. Either claim alone, or a
//     claim that does not read, is no step-up.
//   - The method must be one of the factors Code owns (`email_code`, `passkey`, `company_reauth`). A Slack, Google or GitHub round trip never counts.
//   - The age is checked HERE, on every such request, against the window (ten minutes, `FRESH_SIGN_IN_SECONDS`; a company's window may only shorten it), with the clock-skew allowance
//     never longer than the window.
// Until #660 lands on code/next no token carries these claims, so every sensitive press is refused (fails closed). When #660/#662 land, `stepUpOfClaims` and `requireFreshStepUp` are
// replaced by their `stepUpOf` and `freshStepUp` (same inputs, same answers); the tests here pin the shared behaviour.
import { APPROVAL_SIGN_IN_SKEW_SECONDS, FRESH_SIGN_IN_SECONDS, agentXError } from "@agentx/contracts";

/** The factors Code owns (lane ID's DEVELOPER_STEP_UP_METHODS). */
export const STEP_UP_FACTORS = ["email_code", "passkey", "company_reauth"] as const;
export type StepUpFactor = (typeof STEP_UP_FACTORS)[number];
export interface CallerStepUp { at: string; method: StepUpFactor }

/** The step-up a VERIFIED token's claims carry, or undefined (no claim, either claim alone, a time that is not a whole number of seconds, a method that is not Code's). */
export function stepUpOfClaims(claims: Record<string, unknown>): CallerStepUp | undefined {
  const at = claims["step_up_at"];
  const method = claims["step_up_amr"];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0 || at > 8_640_000_000_000) return undefined;
  if (typeof method !== "string" || !(STEP_UP_FACTORS as readonly string[]).includes(method)) return undefined;
  return { at: new Date(at * 1000).toISOString(), method: method as StepUpFactor };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * The caller's step-up if it is fresh now; otherwise `REAUTH_REQUIRED` with the route's fixed refusal. `windowSeconds` (the company's, when one is wired) may only shorten the default;
 * an answer that is not a whole number from 0 to 86400 refuses rather than falls back.
 */
export function requireFreshStepUp(stepUp: CallerStepUp | undefined, nowMs: number, refusal: string, windowSeconds: unknown = FRESH_SIGN_IN_SECONDS): CallerStepUp {
  if (stepUp === undefined || stepUp === null || typeof stepUp !== "object" || typeof stepUp.at !== "string" || !ISO_INSTANT.test(stepUp.at)
    || !(STEP_UP_FACTORS as readonly unknown[]).includes(stepUp.method)) throw agentXError("REAUTH_REQUIRED", refusal);
  if (typeof windowSeconds !== "number" || !Number.isInteger(windowSeconds) || windowSeconds < 0 || windowSeconds > 86_400) throw agentXError("REAUTH_REQUIRED", refusal);
  const seconds = Math.min(FRESH_SIGN_IN_SECONDS, windowSeconds);
  if (seconds === 0) throw agentXError("REAUTH_REQUIRED", refusal);
  const age = nowMs - Date.parse(stepUp.at);
  if (!Number.isFinite(age) || age > seconds * 1000 || -age > Math.min(APPROVAL_SIGN_IN_SKEW_SECONDS, seconds) * 1000) throw agentXError("REAUTH_REQUIRED", refusal);
  return { at: stepUp.at, method: stepUp.method };
}
