// Nightly upkeep, the cap signal (lead 4 L4-SR1; owner rule: nothing that spends AI by itself starts without a cap that is REALLY enforced). The nightly wiki refresh's model calls carry the TC-1 origin `nightly`, which is
// what the gateway holds to the project's `upkeep_month` limit (Cloud #125). Code cannot see the gateway's code, and a gateway from before #125 would let those calls through uncapped, so Code starts nightly AI only on a
// POSITIVE signal: the gateway's own answer, for THIS company, project and month, that it holds the cap (`UpkeepCapReadSchema`, contracts/upkeep.ts). The answer comes from a reader the host supplies:
//   - no reader (a laptop, an install with no gateway, a signer that is not there): the signal is "unknown";
//   - a reader that throws, answers late, answers nothing valid, or answers for another project or month: "unknown";
//   - "unknown" starts no AI. It is never read as "enforced", and an old answer is never kept (each night asks again).
// A project whose cap is $0 or used up is a pause the admins are told once, BEFORE any call is sent (`pauseOf`), so the night does not wait for the gateway's 422 to find out.
import { UpkeepCapReadSchema, upkeepMonthOf, type UpkeepPauseReason } from "@agentx/contracts";

/** The host's read of one project's cap at the gateway. Throws (fixed words, no detail) when it cannot answer. */
export interface UpkeepCapReader {
  read(project: string): Promise<unknown>;
}

export type UpkeepCapState =
  | { state: "unknown" }
  | { state: "enforced"; limitUsd: number; spentUsd: number; month: string; /** Set when the cap leaves no room: the night is paused before it starts. */ pause?: UpkeepPauseReason };

const UNKNOWN: UpkeepCapState = { state: "unknown" };

/**
 * The cap state of one project now. Always answers; every doubt is "unknown". `nowMs` fixes the month: an answer for another month is stale (the gateway's month is the UTC calendar month).
 */
export async function readUpkeepCap(reader: UpkeepCapReader | undefined, project: string, nowMs: number, companyId: string): Promise<UpkeepCapState> {
  if (reader === undefined) return UNKNOWN;
  let answer: unknown;
  try { answer = await reader.read(project); } catch { return UNKNOWN; }
  const parsed = UpkeepCapReadSchema.safeParse(answer);
  if (!parsed.success || parsed.data.project !== project || parsed.data.company !== companyId || parsed.data.month !== upkeepMonthOf(nowMs)) return UNKNOWN;
  const { limitMicros, spentMicros, month } = parsed.data;
  const pause: UpkeepPauseReason | undefined = limitMicros === 0 ? "no_budget" : spentMicros >= limitMicros ? "monthly_limit" : undefined;
  return { state: "enforced", limitUsd: limitMicros / 1_000_000, spentUsd: spentMicros / 1_000_000, month, ...(pause === undefined ? {} : { pause }) };
}
