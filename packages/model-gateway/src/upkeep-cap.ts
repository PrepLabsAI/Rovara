// Nightly upkeep's monthly cap (lead 4 L4-E, DEC 254z(2); design setup-upkeep-plan.md 2.2): AI the company's projects spend BY THEMSELVES at night
// (repair drafts, mock drafts, wiki refresh) is held to one monthly dollar cap per project, enforced here, in the place that holds the money.
//
//   Origin   a call is upkeep when its TC-1 token's `src` is "nightly" and it comes through the agent route (task tokens). Today the nightly run itself is
//            model-free, so no AI call carries that origin yet: Code mints it only for upkeep work. A token with another `src` (or none) is not upkeep.
//   Cap      `upkeepMonth` in the call's caps, from the project's `upkeep_month` spend limit (company-caps.ts readSpendLimit; Cloud's SPEND_LIMIT_KINDS),
//            else UPKEEP_DEFAULT_MONTH_MICROS. $0 means no upkeep spend. An item that does not read refuses the call (503); a failed read throws.
//   Fold     the meter adds the project's upkeep row to the call's rows (meter.ts MeterItem "upkeep"); the task, person, project and company rows still count
//            the same call, so the upkeep cap can only TIGHTEN what the project and company caps already allow, never loosen it.
//   Pause    a call the upkeep row refuses is `upkeep_paused` (fixed words, the reason in UPKEEP_PAUSE_HEADER) and is never sent: reserve runs BEFORE the call.
//            The caller (Code's nightly upkeep) turns it into the admins' notice; this gateway holds no inbox.
//   Absent   no limit source configured: an upkeep call is paused with `no_budget` (nothing spends unattended without an enforced cap).
import type { Caps } from "./caps.js";
import type { RouteRefusal } from "./server.js";
import type { TaskClaims } from "./model-gateway-token.js";

/** The `src` claim that marks nightly upkeep work (model-gateway-token.ts WORK_ORIGINS). */
export const UPKEEP_ORIGIN = "nightly" as const;
/** The cap when the project has no limit of its own: $25 a month, in micro-dollars (Cloud's company-store.ts UPKEEP_DEFAULT_MONTH_MICROS holds the same number; a contract test keeps them equal). */
export const UPKEEP_DEFAULT_MONTH_MICROS = 25_000_000;
export const UPKEEP_PAUSE_HEADER = "x-rovara-upkeep-pause";
export const UPKEEP_PAUSE_REASONS = ["no_budget", "monthly_limit", "cost_too_high"] as const;
export type UpkeepPauseReason = typeof UPKEEP_PAUSE_REASONS[number];
export const UPKEEP_PAUSE_MESSAGES: Readonly<Record<UpkeepPauseReason, string>> = Object.freeze({
  no_budget: "Nightly upkeep has no spending limit for this project, so it is paused.",
  monthly_limit: "This project's monthly nightly upkeep limit is used up, so upkeep is paused until next month.",
  cost_too_high: "One upkeep call of this size cannot fit this project's monthly upkeep limit.",
});
export const upkeepPaused = (reason: UpkeepPauseReason): RouteRefusal => ({ ok: false, status: 422, code: "upkeep_paused", message: UPKEEP_PAUSE_MESSAGES[reason], headers: { [UPKEEP_PAUSE_HEADER]: reason } });

/** The project's own upkeep limit, micro-dollars: undefined when it has none (the default applies), null when the stored item does not read (the caller refuses). A failed read throws. */
export interface UpkeepLimits { limitFor(cid: string, pid: string, signal?: AbortSignal): Promise<number | null | undefined> }

/** Whether a call on this route is nightly upkeep AI: a task-token call on the agent route (no purpose, not product) whose origin is nightly. */
export const isUpkeepCall = (route: { purpose?: string; product: boolean }, claims: TaskClaims): boolean => route.purpose === undefined && !route.product && claims.src === UPKEEP_ORIGIN;

/** The call's caps with the project's upkeep cap added, or a refusal. Only called for an upkeep call. */
export async function withUpkeepCap(caps: Caps, limits: UpkeepLimits | undefined, claims: TaskClaims, signal?: AbortSignal): Promise<Caps | RouteRefusal> {
  if (limits === undefined) return upkeepPaused("no_budget");
  const own = await limits.limitFor(claims.cid, claims.pid, signal);
  if (own === null) return { ok: false, status: 503, code: "unavailable", message: "model access unavailable" };
  return { ...caps, upkeepMonth: own ?? UPKEEP_DEFAULT_MONTH_MICROS };
}
/** The pause for a permanent refusal by the upkeep row: why, in words the caller can act on. */
export function upkeepRefusal(caps: Caps, estimateMicros: number): RouteRefusal {
  const month = caps.upkeepMonth ?? 0;
  if (month === 0) return upkeepPaused("no_budget");
  return upkeepPaused(estimateMicros > month ? "cost_too_high" : "monthly_limit");
}
