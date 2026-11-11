// The `realtime` point: the in-process adapter. It is both Code's default for `rovara up` (the install's own pages listen in the same process) and the fake the
// conformance suite and the core's tests use (`published()` shows what was sent, `setDown` makes every entry fail as a broken transport would).
//
// With no listener a publish is a no-op that still counts each valid entry as sent, so registering it changes nothing for an install whose pages do not listen.
import {
  REALTIME_BATCH_MAX, isRealtimeAudience, isRealtimeNotice, realtimeAudienceKey,
  type RealtimeAudience, type RealtimeBatch, type RealtimeEntry, type RealtimePublishResult, type RealtimePublisher,
} from "@agentx/contracts";

export interface HeardNotice extends RealtimeEntry {
  companyId: string;
}

export interface InProcessRealtime extends RealtimePublisher {
  /**
   * Hears every notice for one company, or only those for one audience. A listener that throws is skipped (it never fails a publish). Returns a function that stops
   * listening.
   */
  listen(companyId: string, listener: (heard: HeardNotice) => void, audience?: RealtimeAudience): () => void;
  /** Everything sent, oldest first (for tests; at most the last 1,000). */
  published(): HeardNotice[];
  /** Tests: every entry fails while down. */
  setDown(down: boolean): void;
}

const KEPT = 1_000;

export function createInProcessRealtime(): InProcessRealtime {
  const listeners = new Set<{ companyId: string; key: string | undefined; listener: (heard: HeardNotice) => void }>();
  const sent: HeardNotice[] = [];
  let down = false;
  return {
    capabilities: { remoteListeners: false, entriesPerRequest: REALTIME_BATCH_MAX },
    async publish(batch: RealtimeBatch): Promise<RealtimePublishResult> {
      const entries: readonly RealtimeEntry[] = batch.entries;
      if (batch.companyId === "") return { sent: 0, failed: entries.length };
      let ok = 0;
      let failed = 0;
      for (const [index, entry] of entries.entries()) {
        const late = batch.deadline !== undefined && Date.now() > batch.deadline;
        if (down || late || index >= REALTIME_BATCH_MAX || !isRealtimeAudience(entry.audience) || !isRealtimeNotice(entry.notice)) { failed += 1; continue; }
        const heard: HeardNotice = { companyId: batch.companyId, audience: structuredClone(entry.audience), notice: structuredClone(entry.notice) };
        sent.push(heard);
        if (sent.length > KEPT) sent.shift();
        const key = realtimeAudienceKey(entry.audience);
        for (const held of listeners) {
          if (held.companyId !== batch.companyId || (held.key !== undefined && held.key !== key)) continue;
          try { held.listener(structuredClone(heard)); } catch { /* a page's listener never fails a publish */ }
        }
        ok += 1;
      }
      return { sent: ok, failed };
    },
    listen(companyId, listener, audience) {
      const held = { companyId, key: audience === undefined ? undefined : realtimeAudienceKey(audience), listener };
      listeners.add(held);
      return () => { listeners.delete(held); };
    },
    published: () => sent.map((heard) => structuredClone(heard)),
    setDown(value) { down = value; },
    close() { listeners.clear(); },
  };
}
