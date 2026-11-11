// Automation, shared store helpers. Everything the automation features write goes through the document store port: a write that depends on what it read is conditional on it, a
// change that touches more than one row is one transaction, and a refused condition is an answer (`applied: false`), never an overwrite. A repeatable request leaves a request row
// in the same transaction as its change, so a repeat is answered from that row and writes nothing more.
import {
  INDEX_EXPIRY_ATTRIBUTE,
  agentRequestKey,
  agentXError,
  change,
  when,
  type AgentXErrorCode,
  type Condition,
  type DocumentKey,
  type DocumentStore,
  type JsonValue,
  type OrgId,
  type TransactItem,
  type UpdateOp,
} from "@agentx/contracts";

/** A stored row without its key. */
export type Item = Record<string, unknown>;

/** What the automation features need of the store, and of the clock. */
export interface Table {
  store: DocumentStore;
  now: () => number;
}

/** How long a request row answers a repeat; the store's time-to-live removes it after that, and a repeat later is a new request. */
export const REQUEST_MEMORY_DAYS = 7;

export const coded = (code: AgentXErrorCode, message: string) => agentXError(code, message);
/** A stored value as text: the value when it is text, else nothing. (A stored row is untrusted: a damaged one never turns an object into "[object Object]".) */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
export const iso = (table: Pick<Table, "now">): string => new Date(table.now()).toISOString();

/** The row without its key attributes. */
export function strip<T extends Item>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item;
  return rest;
}

/** A copy without the attributes that are undefined (the store holds flat JSON: it has no `undefined`). */
export const withoutUndefined = <T extends Item>(item: T): T => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) as T;

const json = (value: unknown): JsonValue => value as JsonValue;

/** A new row, written only if its key is free (or, with `condition`, only if that holds; `null` writes it whether or not it is there). */
export function putRow(key: DocumentKey, entityType: string, fields: Item, condition: Condition | null = when.absent()): TransactItem {
  return { kind: "put", item: { ...key, entityType, ...withoutUndefined(fields) }, ...(condition === null ? {} : { condition }) };
}

/** A row written whether or not it is there. */
export const overwriteRow = (key: DocumentKey, entityType: string, fields: Item): TransactItem => putRow(key, entityType, fields, null);

export const deleteRow = (key: DocumentKey, condition?: Condition): TransactItem => ({ kind: "delete", key, ...(condition === undefined ? {} : { condition }) });

/** An update of one row: `set` values (undefined skipped) and `remove` attributes, only while the row is there (or `condition` holds). */
export function updateRow(key: DocumentKey, changes: { set?: Item; remove?: string[]; condition?: Condition }): TransactItem {
  const ops: UpdateOp[] = [
    ...Object.entries(changes.set ?? {}).filter(([, value]) => value !== undefined).map(([name, value]) => change.set([name], json(value))),
    ...(changes.remove ?? []).map((name) => change.remove([name])),
  ];
  return { kind: "update", key, ops, condition: changes.condition ?? when.present() };
}

/** Sends one transaction; a refused condition becomes the error `refuse` picks from the indexes that failed (else the generic conflict). */
export async function transact(table: Table, items: readonly TransactItem[], refuse: (failed: ReadonlySet<number>) => Error | undefined = () => undefined): Promise<void> {
  const result = await table.store.transact(items);
  if (result.applied) return;
  throw refuse(new Set(result.failed)) ?? coded("CHANGE_STALE", "something changed while this was being written; try again");
}

/**
 * What makes a write repeatable: the request's id and a fingerprint of what it asked. The store writes one row for it in the same transaction as the change, holding what the change returned,
 * so a repeat of the request is answered from that row and writes nothing.
 */
export interface RequestMark {
  orgId: OrgId;
  actor: string;
  requestId: string;
  fingerprint: string;
  /** Overrides what is remembered, for a write that returns nothing itself. */
  result?: unknown;
}

export function requestMarkRow(table: Table, request: RequestMark, result?: unknown): TransactItem {
  const remembered = JSON.parse(JSON.stringify(request.result ?? result ?? null)) as JsonValue;
  const nowSeconds = Math.floor(table.now() / 1000);
  return {
    kind: "put",
    item: {
      ...agentRequestKey(request.orgId, request.actor, request.requestId), entityType: "AGENT_REQUEST",
      fingerprint: request.fingerprint, result: remembered, at: iso(table), [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + REQUEST_MEMORY_DAYS * 86_400,
    },
    // An expired row the time-to-live has not removed yet is as good as gone.
    condition: when.or(when.absent(), when.lte(INDEX_EXPIRY_ATTRIBUTE, nowSeconds)),
  };
}

/** What an earlier request of this actor's with this id did, or undefined when it did nothing or its row has expired. */
export async function readRequest(table: Table, orgId: OrgId, actor: string, requestId: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
  const earlier = await table.store.get(agentRequestKey(orgId, actor, requestId));
  const expires = earlier?.[INDEX_EXPIRY_ATTRIBUTE];
  if (earlier === undefined || (typeof expires === "number" && expires <= Math.floor(table.now() / 1000))) return undefined;
  return { fingerprint: text(earlier["fingerprint"]), result: earlier["result"] };
}

/** `transact` with the request's own row added: the mark is written with the change or not at all. */
export async function commit(table: Table, items: readonly TransactItem[], refuse: (failed: ReadonlySet<number>) => Error | undefined, request?: RequestMark, result?: unknown): Promise<void> {
  if (request === undefined) return transact(table, items, refuse);
  const at = items.length;
  return transact(table, [...items, requestMarkRow(table, request, result)], (failed) => (failed.has(at) ? coded("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.") : refuse(failed)));
}

/**
 * Counts one start against a limit in one conditional update; false when the limit is used up. The row is created by the first count. `lifetimeSeconds` is how long it lives (the store's
 * time-to-live removes it later). A limit that is not at least 1 allows nothing.
 */
export async function countOne(table: Table, key: DocumentKey, max: number, lifetimeSeconds: number): Promise<boolean> {
  if (!(max >= 1)) return false;
  const result = await table.store.update({
    key,
    ops: [change.add(["count"], 1), change.set([INDEX_EXPIRY_ATTRIBUTE], Math.floor(table.now() / 1000) + lifetimeSeconds)],
    condition: when.or(when.notExists("count"), when.lt("count", max)),
  });
  return result.applied;
}

/** Whether an error is the store's "something changed under this write": the caller tries the whole operation again from a fresh read. */
export const isStale = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "CHANGE_STALE";
