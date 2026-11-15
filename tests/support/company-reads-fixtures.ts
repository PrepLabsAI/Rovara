// Fixtures for the company reads (lanes AU and EV): two companies, audit rows written by Code's own audit sink, and work events written by the
// work-event writer, in one store. Hostile rows (the wrong company, no company, a bad company, rubbish) are planted by hand.
import { IMPLICIT_COMPANY_ID, companyScoped, workEventId, workEventKey, type DocumentStore, type WorkEventInput, type WorkEventKind } from "@agentx/contracts";
import { DocumentAuditSink } from "../../packages/local-adapters/src/document-audit-sink.js";
import { workEventRow } from "../../packages/broker/src/core/work-events/work-events.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

export const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa";
export const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
export { IMPLICIT_COMPANY_ID };

export type StoreLike = MemoryDocumentStore;
export const newStore = (): StoreLike => new MemoryDocumentStore();

export interface AuditSeed {
  eventId: string;
  at: string;
  actor?: { type: "person" | "agent" | "system"; id: string };
  action?: string;
  subject?: { type: string; id: string };
  details?: Record<string, string | number | boolean>;
}

/** An audit row, written by Code's own sink (so the reader is tested against what the writer really stores). */
export async function seedAudit(store: StoreLike, companyId: string, seed: AuditSeed): Promise<void> {
  const sink = new DocumentAuditSink({ store: () => store });
  await sink.record({
    eventId: seed.eventId, companyId, at: seed.at, actor: seed.actor ?? { type: "person", id: "dev_ada" }, action: seed.action ?? "task.approved",
    ...(seed.subject === undefined ? {} : { subject: seed.subject }), ...(seed.details === undefined ? {} : { details: seed.details }),
  });
}

/** A raw row in a company's audit partition, for the cases the sink never writes. */
export async function plantAuditRow(store: StoreLike, partitionCompany: string, eventId: string, fields: Record<string, unknown>): Promise<void> {
  await store.put({ item: { pk: companyScoped(partitionCompany, "AUDIT"), sk: `EVENT#${eventId}`, entityType: "AUDIT", eventId, at: "2026-11-10T10:00:00.000Z", actor: { type: "person", id: "dev_ada" }, action: "task.approved", ...fields } });
}

/** A task id in each shard (the shard is the first byte of the id, modulo 8); `variant` makes more than one per shard. */
export const TASK_IN_SHARD = (shard: number, variant = 0): string => `0${String(shard % 8)}aa0000-0000-4000-8000-${String(variant).padStart(12, "0")}`;

export interface EventSeed { kind?: WorkEventKind; at: string; orgId?: string; project?: string; taskId?: string; source?: string; personId?: string; micros?: number }

export function eventInput(companyId: string, seed: EventSeed): WorkEventInput {
  const kind = seed.kind ?? "step_started";
  const taskId = seed.taskId ?? TASK_IN_SHARD(0);
  const id = workEventId({ kind, taskId, source: seed.source ?? seed.at });
  const base = { version: 1 as const, id, at: seed.at, orgId: seed.orgId ?? companyId, project: seed.project ?? "billing-service", taskId, actor: { kind: "person" as const, personId: seed.personId ?? "dev_ada" } };
  switch (kind) {
    case "step_started": return { ...base, kind, step: "coding" };
    case "task_started": return { ...base, kind };
    case "cost_settled": return { ...base, kind, micros: seed.micros ?? 1_000_000, currency: "USD", source: "model" };
    case "task_closed": return { ...base, kind, outcome: "merged" };
    default: throw new Error(`no fixture for ${kind}`);
  }
}

/** Writes an event into `companyId`'s partition (the key is built from the event's own orgId unless `partitionCompany` says otherwise: a hostile row). */
export async function seedEvent(store: StoreLike, companyId: string, seed: EventSeed, partitionCompany?: string): Promise<string> {
  const input = eventInput(companyId, seed);
  const row = workEventRow(input);
  if (partitionCompany !== undefined && partitionCompany !== (seed.orgId ?? companyId)) {
    const key = workEventKey({ orgId: partitionCompany, at: input.at, id: input.id, taskId: input.taskId });
    await store.put({ item: { ...row, ...key } });
  } else await store.put({ item: row });
  return input.id;
}

/** A store that counts the rows its queries hand back, and refuses every write (the reads are append-only from the API's side: they never write). */
export function countingReadOnly(store: StoreLike): { store: Pick<DocumentStore, "query">; rows: () => number; queries: () => number } {
  let rows = 0;
  let queries = 0;
  return {
    store: new Proxy({} as Pick<DocumentStore, "query">, {
      get(_target, property) {
        if (property !== "query") throw new Error(`the read touched ${String(property)}`);
        return async (request: Parameters<DocumentStore["query"]>[0]) => { queries += 1; const page = await store.query(request); rows += page.items.length; return page; };
      },
    }),
    rows: () => rows,
    queries: () => queries,
  };
}
