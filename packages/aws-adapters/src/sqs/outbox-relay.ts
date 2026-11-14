// Convergence lane A2: when the outbox is relayed on AWS. The outbox port says how (`relay` is safe from a timer, from a change-feed
// consumer, or in a loop, and calls may overlap); this file is the two triggers a hosted deployment uses, written over the ports only:
//  - the hook: a change-feed consumer on the store's existing stream reader. A newly staged, pending outbox row names its company and
//    id, so the relay is asked for exactly those rows. Only an INSERT fires it: the relay's own bookkeeping (attempt counts, the move
//    to QUEUED) are MODIFY records and must not start another relay.
//  - the backstop: a schedule that relays every company's pending rows, oldest first. It is what delivers a row whose insert record
//    was missed (a reader outage, a hook error, a failed hand-over), so the stream is never the only way a message reaches its queue.
// Both are at least once and idempotent: a row handed over twice reaches a queue with duplicate suppression once, and any other queue
// with its `outboxId` attribute; the consumer is idempotent on its operation (dispatch claims it conditionally and drops an ended or running one). Neither promises order across calls: two relays running
// together may hand over two messages of one ordered group in either order, so nothing may rely on the outbox for order.
import type { DocumentChange, OutboxRelayReport, TransactionalOutbox } from "@agentx/contracts";

/** The outbox pieces the triggers read from a row. */
export interface PendingOutboxRow {
  companyId: string;
  id: string;
}

/** The staged row of a change, when the change is a new, pending outbox message. */
export function pendingOutboxRow(change: DocumentChange): PendingOutboxRow | undefined {
  if (change.kind !== "insert" || change.after === undefined) return undefined;
  const row = change.after;
  if (row.entityType !== "OUTBOX" || row.status !== "PENDING") return undefined;
  if (typeof row.companyId !== "string" || row.companyId === "" || typeof row.id !== "string" || row.id === "") return undefined;
  return { companyId: row.companyId, id: row.id };
}

const empty = (): OutboxRelayReport => ({ delivered: 0, failed: 0, dead: 0 });
const add = (total: OutboxRelayReport, report: OutboxRelayReport): void => {
  total.delivered += report.delivered;
  total.failed += report.failed;
  total.dead += report.dead;
};

export interface OutboxRelayHookOptions {
  outbox: Pick<TransactionalOutbox, "relay">;
  /** Told what each relay call reported (for metrics). A failed row stays pending: the backstop retries it. */
  onReport?: (report: OutboxRelayReport & { companyId: string }) => void;
}

/**
 * The consumer to subscribe on the store's change feed. It relays the rows of one batch, one call per company, and lets a failure of
 * the relay itself (the store unavailable) reach the feed, which retries the batch a bounded number of times and then reports it
 * poisoned; the backstop covers what that leaves.
 */
export function createOutboxRelayHook(options: OutboxRelayHookOptions): (changes: readonly DocumentChange[]) => Promise<void> {
  return async (changes) => {
    const byCompany = new Map<string, Set<string>>();
    for (const change of changes) {
      const row = pendingOutboxRow(change);
      if (row === undefined) continue;
      const ids = byCompany.get(row.companyId) ?? new Set<string>();
      ids.add(row.id);
      byCompany.set(row.companyId, ids);
    }
    for (const [companyId, ids] of byCompany) {
      const report = await options.outbox.relay({ companyId, ids: [...ids] });
      options.onReport?.({ companyId, ...report });
    }
  };
}

export interface OutboxBackstopOptions {
  outbox: Pick<TransactionalOutbox, "relay">;
  /** The companies to look at on this run. */
  companies: () => Promise<readonly string[]>;
  /** Pending rows one company's relay takes per call. Default 100 (the outbox's own default). */
  limitPerCompany?: number;
  /** Stop starting new companies after this many milliseconds; the next run takes the rest. Default: no limit. */
  budgetMs?: number;
  now?: () => number;
  /** Told what each company's relay reported. */
  onReport?: (report: OutboxRelayReport & { companyId: string }) => void;
  /** Told when one company's relay threw; the run goes on to the next company. */
  onError?: (companyId: string, error: unknown) => void;
}

export interface OutboxBackstopReport extends OutboxRelayReport {
  /** Companies whose relay ran. */
  companies: number;
  /** Companies left for the next run because the budget ran out. */
  deferred: number;
  /** Companies whose relay threw. */
  errors: number;
}

/** The scheduled run: one relay per company, sequentially (so a company's ordered groups see one relay at a time within this run). */
export function createOutboxBackstop(options: OutboxBackstopOptions): () => Promise<OutboxBackstopReport> {
  const now = options.now ?? Date.now;
  return async () => {
    const started = now();
    const total: OutboxBackstopReport = { ...empty(), companies: 0, deferred: 0, errors: 0 };
    const companies = await options.companies();
    for (const [position, companyId] of companies.entries()) {
      if (options.budgetMs !== undefined && position > 0 && now() - started >= options.budgetMs) {
        total.deferred = companies.length - position;
        break;
      }
      try {
        const report = await options.outbox.relay({ companyId, ...(options.limitPerCompany === undefined ? {} : { limit: options.limitPerCompany }) });
        add(total, report);
        total.companies += 1;
        options.onReport?.({ companyId, ...report });
      } catch (error) {
        total.errors += 1;
        options.onError?.(companyId, error);
      }
    }
    return total;
  };
}
