// The projector (lane L6b, inventory B6): keeps summaries current by listening to the task's changes. In the hosted product it reads the table's stream; here it is a consumer of the document store's change
// feed (the port's replacement for the stream readers). It works out which sessions a batch touches and refreshes each once; a refresh recomputes from the source records, so a stale, repeated or out-of-order
// batch only means looking again. The session sweep (sweep.ts) catches whatever a batch missed.
import type { DocumentChange, OrgId, SessionId } from "@agentx/contracts";
import { refreshSessionSummary, type SummaryDependencies } from "./summary.js";

export const SESSION_PROJECTOR_CONSUMER = "session-projector";
const PER_BATCH_MAX = 100;
const CONCURRENCY = 8;

export interface SessionTarget { orgId: OrgId; sessionId: SessionId }

/**
 * Which sessions a batch of changes is about: a task document (`DEVTASK#<id>` partitions) that names its session and company, before or after the change. Anything else is not about a session.
 * The company is the record's own, and the refresh re-checks it against the session, so a change cannot make a session refresh for another company.
 */
export function sessionTargetsOf(changes: readonly DocumentChange[]): SessionTarget[] {
  const targets = new Map<string, SessionTarget>();
  for (const change of changes) {
    if (!change.key.pk.startsWith("DEVTASK#")) continue;
    for (const document of [change.after, change.before]) {
      const orgId = document?.["companyId"] ?? document?.["orgId"];
      const sessionId = document?.["sessionId"];
      if (typeof orgId === "string" && typeof sessionId === "string") targets.set(`${orgId}\u0000${sessionId}`, { orgId: orgId, sessionId: sessionId });
    }
  }
  return [...targets.values()].slice(0, PER_BATCH_MAX);
}

/** Runs the refreshes of a batch, a few at a time. A refresh that fails is logged and the rest go on; the batch handler throws only when every refresh failed, so the feed retries it. */
export async function projectChanges(deps: SummaryDependencies, changes: readonly DocumentChange[]): Promise<{ refreshed: number; failed: number }> {
  const targets = sessionTargetsOf(changes);
  let refreshed = 0;
  let failed = 0;
  let next = 0;
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const worker = async (): Promise<void> => {
    for (let index = next++; index < targets.length; index = next++) {
      const target = targets[index]!;
      try { await refreshSessionSummary(deps, target.orgId, target.sessionId); refreshed += 1; } catch (error) {
        failed += 1;
        log({ event: "agent_session.projector_refresh_failed", sessionId: target.sessionId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  if (targets.length > 0 && failed === targets.length) throw new Error("no session could be refreshed");
  return { refreshed, failed };
}

/** Subscribes the projector to the store's change feed. A store without one answers `undefined`: the sweep alone keeps summaries current. */
export async function startSessionProjector(deps: SummaryDependencies): Promise<{ stop(): Promise<void> } | undefined> {
  const feed = (deps.store).changes;
  if (feed === undefined) return undefined;
  return feed.subscribe(SESSION_PROJECTOR_CONSUMER, async (changes) => { await projectChanges(deps, changes); });
}
