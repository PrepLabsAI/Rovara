// E2/E7: the two interfaces this lane has with the Team record (design 3.8). The lane emits what it saw and asks the record to search; it never keeps
// source text itself. Until the Team record's own build lands, `TeamRecordSearch` answers nothing and `TeamRecordSink` drops events, so this lane ships
// without waiting for it. The interfaces are the design's, unchanged: switching to the real ones is an import change only.
import type { CitationStanding } from "@agentx/contracts";

/** What the broker emits after each context call, one per item (design 3.8). */
export interface ContextItemSeen {
  orgId: string;
  projectId: string;
  taskId: string;
  stage: string;
  sourceId: string;
  system: string;
  itemRef: string;
  url?: string | undefined;
  title: string;
  /** What the source said about who can see the item, as the connector reports it. Unknown is `null`: the record then treats the item as project-only. */
  permissionSnapshot: unknown;
  fetchedAt: string;
  contentDigest: string;
  /** Present only if the source's retention allows storing; live facts are already removed from it. */
  content?: string | undefined;
  standing: CitationStanding;
}

/** Fire and forget. A failure never blocks a task. */
export interface TeamRecordSink {
  seen(item: ContextItemSeen): Promise<void>;
}

export interface TeamRecordHit {
  itemRef: string;
  system: string;
  url?: string | undefined;
  title: string;
  snippet?: string | undefined;
  permissionSnapshot: unknown;
  score: number;
}

export interface TeamRecordSearch {
  search(input: { orgId: string; projectId: string; query: string; sources?: string[] | undefined; asAgentForTask: string; limit: number }): Promise<TeamRecordHit[]>;
}

/** The stand-ins until the Team record lands. */
export const droppingSink: TeamRecordSink = { seen: async () => undefined };
export const emptySearch: TeamRecordSearch = { search: async () => [] };

/** The most hits one search may ask for (design 3.8). */
export const TEAM_SEARCH_LIMIT_MAX = 20;

export { withoutLiveFacts } from "./present.js";

// ---------------------------------------------------------------------------------------------
// E7: the sink never blocks a task, and what it carries fits the storage lane's event
// ---------------------------------------------------------------------------------------------

/** The most items one org may have waiting for the Team record (design 3.9). More are dropped and counted. */
export const TEAM_SINK_QUEUE_MAX = 1_000;

export interface BoundedSinkOptions {
  maxPerOrg?: number;
  /** Told for every item dropped (the queue was full, or the record failed). The running total for the org is given, for a counter alarm. */
  onDrop?: (orgId: string, reason: "queue_full" | "record_failed", total: number) => void;
}

/**
 * `inner` made safe to call from a task: `seen` returns at once, items wait in a queue of at most `maxPerOrg` per org and are handed to `inner` one org at a time, and
 * an item the record refuses or the queue has no room for is dropped and counted. It never throws and never waits for the record.
 */
export function boundedSink(inner: TeamRecordSink, options: BoundedSinkOptions = {}): TeamRecordSink & { pending(orgId: string): number; dropped(orgId: string): number; idle(): Promise<void> } {
  const max = options.maxPerOrg ?? TEAM_SINK_QUEUE_MAX;
  const queues = new Map<string, ContextItemSeen[]>();
  const draining = new Set<string>();
  const dropped = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const drop = (orgId: string, reason: "queue_full" | "record_failed"): void => {
    const total = (dropped.get(orgId) ?? 0) + 1;
    dropped.set(orgId, total);
    try { options.onDrop?.(orgId, reason, total); } catch { /* a counter that fails is not the task's problem */ }
  };
  const drain = async (orgId: string): Promise<void> => {
    const queue = queues.get(orgId) ?? [];
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try { await inner.seen(item); } catch { drop(orgId, "record_failed"); }
    }
    queues.delete(orgId);
    draining.delete(orgId);
  };
  return {
    async seen(item) {
      const queue = queues.get(item.orgId) ?? [];
      if (queue.length >= max) { drop(item.orgId, "queue_full"); return; }
      queue.push(item);
      queues.set(item.orgId, queue);
      if (!draining.has(item.orgId)) {
        draining.add(item.orgId);
        const job = drain(item.orgId).finally(() => running.delete(job));
        running.add(job);
      }
    },
    pending: (orgId) => queues.get(orgId)?.length ?? 0,
    dropped: (orgId) => dropped.get(orgId) ?? 0,
    idle: async () => { while (running.size > 0) await Promise.all([...running]); },
  };
}
