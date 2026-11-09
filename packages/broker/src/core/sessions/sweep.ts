// The session sweep (lane L6b, inventory B6): refreshes every open session on a timer, so a change nothing told the projector about (a worker that died, a clock) still shows, and then lets the notification
// delivery run. The caller's timer calls it (the broker's scheduler is not a port yet); it stops starting new work at its deadline and the next call goes on.
import { openAgentSessionKey } from "@agentx/contracts";
import { refreshSessionSummary, type SummaryDependencies } from "./summary.js";

export const SESSION_SWEEP_PAGE = 100;
export const SESSION_SWEEP_BUDGET_MS = 20_000;

export interface SweepResult { visited: number; updated: number; failed: number; complete: boolean }

export async function sweepOpenSessions(deps: SummaryDependencies & { afterSweep?: (deadlineMs: number) => Promise<void> }, options: { budgetMs?: number; pageSize?: number } = {}): Promise<SweepResult> {
  const now = deps.now ?? (() => new Date());
  const deadline = now().getTime() + (options.budgetMs ?? SESSION_SWEEP_BUDGET_MS);
  const pk = openAgentSessionKey("org_00000000000000000000", "x").pk;
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const result: SweepResult = { visited: 0, updated: 0, failed: 0, complete: true };
  let cursor: string | undefined;
  do {
    const page = await deps.store.query({ pk, limit: options.pageSize ?? SESSION_SWEEP_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      if (now().getTime() >= deadline) { result.complete = false; break; }
      const { orgId, sessionId } = item;
      if (typeof orgId !== "string" || typeof sessionId !== "string") continue;
      result.visited += 1;
      try { if (await refreshSessionSummary(deps, orgId, sessionId) === "updated") result.updated += 1; } catch (error) {
        result.failed += 1;
        log({ event: "agent_session.sweep_refresh_failed", sessionId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
    cursor = result.complete ? page.cursor : undefined;
  } while (cursor !== undefined);
  // Delivery runs even when the refreshes ran out of time: a person waiting for a notice should not wait for the slowest session.
  try { await deps.afterSweep?.(deadline); } catch (error) { log({ event: "agent_session.after_sweep_failed", error: error instanceof Error ? error.name : "unknown" }); }
  return result;
}
