// Engine host (lane E2): Code's retention for the core's writes on a deployed install.
//
// Code's named-environment State table expires items on `indexExpiresAt` (infra/lib/control-plane.ts), the same attribute the core uses. The core's expiries are part of its logic
// (a lock or a pending notice past its time is no longer valid; conditions test the attribute), so by default they are KEPT: a core-only kind lives on AWS exactly as long as on a laptop.
//
// What must not happen is a core expiry landing on a kind the deployed broker keeps for good on the same table. Those collisions are the kinds the core writes with an expiry AND the
// deployed broker (everything under packages/broker/src outside core/, local/ and core-host/) also writes. Each one is reviewed in `CORE_EXPIRY_COLLISIONS`:
//   - `keep`  : the deployed broker expires this kind too; the core's expiry stands.
//   - `strip` : the deployed broker keeps this kind; the core's expiry is removed before the write reaches the table.
// tests/unit/core-host-code-modules.test.ts recomputes the collisions from the sources and fails on one that is not reviewed here (and on a reviewed kind that no longer collides), so a
// new collision is decided here, never silently. Changing a decision is a retention decision (owner). Separately, the owner's DEC 222 keeps some kinds for good on AWS (`KEPT_FOR_GOOD_ON_AWS`).
//
// An update names its kind only through a `set` of `entityType` (a `setIfAbsent` does not change an existing item's kind). An update that writes the expiry without setting the kind
// reads the item's current kind first (strongly consistent) and is judged by it. (A kind changing between that read and the write is not guarded: the stripped kinds are written once.)
import { INDEX_EXPIRY_ATTRIBUTE, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem, type UpdateOp } from "@agentx/contracts";

/** The kinds the core writes with an expiry that the deployed broker also writes, each decided. Reviewed 2026-11-15 against code/next. */
export const CORE_EXPIRY_COLLISIONS: Readonly<Record<string, "keep" | "strip">> = Object.freeze({
  // The deployed broker writes these with an expiry too (aws/broker-shared.ts dispatch rows, connections/request-marks.ts, aws/channel-links.ts, services/callbacks.ts,
  // aws/workflow-e2e-{baseline,grounding,replay}.ts).
  WORKFLOW_DISPATCH: "keep", AGENT_REQUEST: "keep", CHANNEL_LINK_CODE: "keep", OPERATION_EVENT: "keep", WORKFLOW_E2E_BASELINE: "keep", WORKFLOW_E2E_GROUNDING: "keep", WORKFLOW_E2E_REPLAY: "keep",
  // Separate key families (KEPT_ON_SEPARATE_KEYS): the core's items are `CHANNEL_THREAD#<session>` (core/channel/threads.ts), the deployed broker's `SLACK_THREAD#...`
  // (aws/channel-conversation.ts), so a core expiry never lands on a deployed item.
  CHANNEL_THREAD: "keep",
  // aws/developer-tasks.ts keeps a task's thread notes for good; the core's notes expire (core/sessions/notes.ts).
  WORKFLOW_THREAD_NOTE: "strip",
  // Separate key families too: the core's rate rows are company-scoped (core/script-tokens/rate.ts), the deployed broker's `<task partition>#RATE#...` (developer/page-comments.ts).
  TASK_RATE: "keep",
});

/**
 * Owner decision DEC 222 (2026-11-15): on AWS the cost ledger, approvals and decisions are kept with NO expiry; session summaries and operation and activity events expire as on a laptop
 * (their kinds keep the core's expiry, the default). These kinds lose the core's expiry before the write reaches the table, whatever the deployed broker writes. No core read depends on
 * their expiry (checked 2026-11-15): the ledger and the decision record are read by key only; an approval's own validity is its request's `expiresAt`, read by time; a spent or used proof
 * marker kept for good only keeps refusing a replay. `DECISION_EVIDENCE_OPENED` is not a decision (a short "the evidence was opened" mark, judged by its own `openedAt`): it keeps its expiry.
 */
export const KEPT_FOR_GOOD_ON_AWS: ReadonlySet<string> = new Set([
  // The cost ledger (core/cost/ledger.ts): each entry and its once-marker. The running total (COST_TOTAL) is written with no expiry.
  "COST_ENTRY", "COST_ENTRY_ONCE",
  // Approvals (core/decisions/approval-gate.ts): the decision and the proof markers it spends.
  "APPROVAL_DECISION", "APPROVAL_PROOF_USED", "APPROVAL_PROOF_SPENT",
  // Decisions (core/decisions/store.ts).
  "DECISION_RECORD",
  // The per-run cost history (core/cost/estimate.ts), part of the cost ledger by owner decision DEC 222a. The estimate reads only the newest ESTIMATE_HISTORY_SIZE rows, so this
  // changes an answer only for an agent that rarely runs: its year-old costs still count instead of the estimate falling back to the default.
  "RUN_COST",
]);
// On AWS the approval gate's `policy.proofKeepSeconds` (unset today) is overridden for the kinds above: they are kept for good.

/** The `keep` collisions whose core items never share a key with the deployed broker's (checked by hand; the scan cannot see key families). */
export const KEPT_ON_SEPARATE_KEYS: ReadonlySet<string> = new Set(["CHANNEL_THREAD", "TASK_RATE"]);

export type RetentionAction = "keep" | "strip";

export function retentionFor(entityType: unknown): RetentionAction {
  if (typeof entityType !== "string") return "keep";
  return CORE_EXPIRY_COLLISIONS[entityType] === "strip" || KEPT_FOR_GOOD_ON_AWS.has(entityType) ? "strip" : "keep";
}

/** The item as the deployed table keeps it: the expiry removed only for a kind the deployed broker keeps for good. */
export function withCodeRetention(item: StoredDocument): StoredDocument {
  if (!(INDEX_EXPIRY_ATTRIBUTE in item) || retentionFor(item.entityType) === "keep") return item;
  const kept: StoredDocument = { ...item };
  delete kept[INDEX_EXPIRY_ATTRIBUTE];
  return kept;
}

const writesExpiry = (op: UpdateOp): boolean => (op.op === "set" || op.op === "setIfAbsent" || op.op === "add") && op.path.length === 1 && op.path[0] === INDEX_EXPIRY_ATTRIBUTE;
/** The kind an update gives the item: a `set` of `entityType` (a `setIfAbsent` only counts for an item that has no kind yet). */
const kindStepOf = (ops: readonly UpdateOp[], which: "set" | "setIfAbsent"): { kind: unknown } | undefined => {
  const found = ops.find((op) => op.op === which && op.path.length === 1 && op.path[0] === "entityType") as { value?: unknown } | undefined;
  return found === undefined ? undefined : { kind: found.value };
};
const kindSetBy = (ops: readonly UpdateOp[]): { kind: unknown } | undefined => kindStepOf(ops, "set");

export interface RetentionLog {
  stripped(entityType: string): void;
}

/** Marks a store that already applies Code's retention, so the module list can refuse a storage adapter that skips it. */
const RETAINED = Symbol("core-host.code-retention");

export function appliesCodeRetention(store: DocumentStore): boolean {
  return (store as unknown as Record<symbol, unknown>)[RETAINED] === true;
}

/** The State table as the core sees it on a deployed install. Reads are untouched; `ttlAttribute` is still reported. */
export function codeRetentionStore(store: DocumentStore, log?: RetentionLog): DocumentStore {
  const note = (kind: unknown): void => { log?.stripped(typeof kind === "string" ? kind : "(none)"); };
  const item = (value: StoredDocument): StoredDocument => {
    const kept = withCodeRetention(value);
    if (kept !== value) note(value.entityType);
    return kept;
  };
  /** An update's steps as the table keeps them; `current` is the item's kind now, read only when the update writes the expiry without setting a kind. */
  const opsOf = (ops: readonly UpdateOp[], current: unknown): readonly UpdateOp[] => {
    if (!ops.some(writesExpiry)) return ops;
    const kind = kindSetBy(ops)?.kind ?? current ?? kindStepOf(ops, "setIfAbsent")?.kind;
    if (retentionFor(kind) === "keep") return ops;
    note(kind);
    const rest = ops.filter((op) => !writesExpiry(op));
    // Only the expiry was written: the step becomes a write of the kind the item already has (the port takes no empty update), so its condition and return value still apply.
    return rest.length > 0 ? rest : [{ op: "set", path: ["entityType"], value: kind as string }];
  };
  const needsKind = (ops: readonly UpdateOp[]): boolean => ops.some(writesExpiry) && kindSetBy(ops) === undefined;
  const kindOf = async (key: DocumentKey): Promise<unknown> => (await store.get(key))?.entityType;
  const wrapped: DocumentStore = {
    get indexes() { return store.indexes; },
    ...(store.ttlAttribute === undefined ? {} : { ttlAttribute: store.ttlAttribute }),
    ...(store.changes === undefined ? {} : { changes: store.changes }),
    get: (key) => store.get(key),
    getMany: (keys) => store.getMany(keys),
    put: (request) => store.put({ ...request, item: item(request.item) }),
    update: async (request) => store.update({ ...request, ops: opsOf(request.ops, needsKind(request.ops) ? await kindOf(request.key) : undefined) }),
    delete: (request) => store.delete(request),
    query: (request) => store.query(request),
    queryIndex: (request) => store.queryIndex(request),
    async transact(items) {
      const asked = items.map((value, index) => ({ value, index })).filter(({ value }) => value.kind === "update" && needsKind(value.ops));
      const kinds = new Map<number, unknown>();
      if (asked.length > 0) {
        const found = await store.getMany(asked.map(({ value }) => (value as Extract<TransactItem, { kind: "update" }>).key));
        asked.forEach(({ index }, at) => kinds.set(index, found[at]?.entityType));
      }
      return store.transact(items.map((value, index): TransactItem => {
        if (value.kind === "put") return { ...value, item: item(value.item) };
        if (value.kind === "update") return { ...value, ops: opsOf(value.ops, kinds.get(index)) };
        return value;
      }));
    },
  };
  Object.defineProperty(wrapped, RETAINED, { value: true, enumerable: false });
  return wrapped;
}
