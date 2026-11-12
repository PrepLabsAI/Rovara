// The session service: sessions are kept current by the store's change feed (the projector) and by a sweep, and a committed change is handed to the hooks a host registers (the notice queue is one). A host composes it
// over its own facts about a task and its own cost source; the core's refresh, projector and sweep do the work.
//
//   start    subscribes the projector to the store's change feed. A store without one answers `undefined`: the sweep alone keeps the summaries current.
//   sweep    refreshes every open session, so a change nothing told the projector about (a worker that died, a clock) still shows. It stops starting new work at its budget; the next call goes on.
//   refresh  one session, now.
//
// Delivery of the notices a change queued is the notice service's (`deliver`), which the host's tick calls after the sweep.
import type { DocumentStore, OrgId, SessionId } from "@agentx/contracts";
import { startSessionProjector } from "../core/sessions/projector.js";
import { settleSteerDeliveriesFor } from "../core/sessions/steer.js";
import { sweepOpenSessions, type SweepResult } from "../core/sessions/sweep.js";
import { refreshSessionSummary, type SessionChangeHook, type SummaryDependencies } from "../core/sessions/summary.js";
import type { NoticeService } from "./notices.js";

export interface SessionServiceOptions {
  store: DocumentStore;
  /** What a task's session shows: facts about the task, read from the host's own records. */
  facts: SummaryDependencies["facts"];
  /** What the task has cost so far. */
  cost: SummaryDependencies["cost"];
  /** Told of every committed change, first: it queues what the change calls for. */
  notices?: Pick<NoticeService, "queue">;
  /** Told of every committed change after the notice service (a host's own hooks: a ticket write-back). */
  onChange?: readonly SessionChangeHook[];
  /** Run after every refresh of a session that exists. Default: settle the messages a step took (`settleSteerDeliveriesFor`). */
  afterRefresh?: SummaryDependencies["afterRefresh"];
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export interface SessionService {
  /** The dependencies the core's session functions take (a host may call `refreshSessionSummary` and friends with them). */
  readonly deps: SummaryDependencies;
  /** Subscribes the projector to the store's change feed. */
  start(): Promise<{ stop(): Promise<void> } | undefined>;
  sweep(options?: { budgetMs?: number; pageSize?: number }): Promise<SweepResult>;
  refresh(orgId: OrgId, sessionId: SessionId): Promise<"unchanged" | "updated">;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { store } = options;
  const notices = options.notices;
  const deps: SummaryDependencies = {
    store,
    facts: options.facts,
    cost: options.cost,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
    onChange: [...(notices === undefined ? [] : [(change: Parameters<SessionChangeHook>[0]) => notices.queue(change)]), ...(options.onChange ?? [])],
    afterRefresh: options.afterRefresh ?? ((orgId, sessionId) => settleSteerDeliveriesFor({ store, ...(options.now === undefined ? {} : { now: options.now }), ...(options.log === undefined ? {} : { log: options.log }) }, orgId, sessionId)),
  };
  return {
    deps,
    start: () => startSessionProjector(deps),
    sweep: (sweepOptions) => sweepOpenSessions(deps, sweepOptions),
    refresh: (orgId, sessionId) => refreshSessionSummary(deps, orgId, sessionId),
  };
}
