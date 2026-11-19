// The session sweep (lane L6b, inventory B6): refreshes every open session on a timer, so a change nothing told the projector about (a worker that died, a clock) still shows, and then lets the notification
// delivery run. The caller's timer calls it (the broker's scheduler is not a port yet); it stops starting new work at its deadline and the next call goes on.
import { OrgIdSchema, openAgentSessionKey } from "@agentx/contracts";
import { refreshSessionSummary, type SummaryDependencies } from "./summary.js";

export const SESSION_SWEEP_PAGE = 100;
export const SESSION_SWEEP_BUDGET_MS = 20_000;

export interface SweepResult { visited: number; updated: number; failed: number; complete: boolean }

export async function sweepOpenSessions(deps: SummaryDependencies & { afterSweep?: (deadlineMs: number) => Promise<void> }, options: { budgetMs?: number; pageSize?: number; companyId?: string; maxItems?: number; scan?: { cursor: string | undefined } } = {}): Promise<SweepResult> {
  const now = deps.now ?? (() => new Date());
  const deadline = now().getTime() + (options.budgetMs ?? SESSION_SWEEP_BUDGET_MS);
  const pk = openAgentSessionKey("org_00000000000000000000", "x").pk;
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const result: SweepResult = { visited: 0, updated: 0, failed: 0, complete: true };
  if (options.companyId !== undefined && !OrgIdSchema.safeParse(options.companyId).success) throw new Error("the session sweep company is invalid");
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  let scanned = 0;
  let cursor: string | undefined = options.scan?.cursor;
  do {
    if (now().getTime() >= deadline || scanned >= maxItems) { result.complete = false; break; }
    const page = await deps.store.query({ pk, ...(options.companyId === undefined ? {} : { sk: { op: "beginsWith" as const, prefix: `${options.companyId}#` } }), limit: Math.min(options.pageSize ?? SESSION_SWEEP_PAGE, maxItems - scanned), ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      if (now().getTime() >= deadline || scanned >= maxItems) { result.complete = false; break; }
      scanned += 1;
      const { orgId, sessionId } = item;
      if (options.companyId !== undefined && orgId !== options.companyId) continue;
      if (typeof orgId !== "string" || typeof sessionId !== "string") continue;
      result.visited += 1;
      try { if (await refreshSessionSummary(deps, orgId, sessionId) === "updated") result.updated += 1; } catch (error) {
        result.failed += 1;
        log({ event: "agent_session.sweep_refresh_failed", sessionId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
    if (result.complete) { cursor = page.cursor; if (options.scan !== undefined) options.scan.cursor = cursor; }
    else cursor = undefined;
  } while (cursor !== undefined);
  // Delivery runs even when the refreshes ran out of time: a person waiting for a notice should not wait for the slowest session.
  try { await deps.afterSweep?.(deadline); } catch (error) { log({ event: "agent_session.after_sweep_failed", error: error instanceof Error ? error.name : "unknown" }); }
  return result;
}
