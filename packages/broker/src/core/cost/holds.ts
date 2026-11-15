// Spend holds (switch-on lane L8): the part of a company's daily allowance an admission has promised to work that has not been booked yet. A deployed install's admission
// (core-host/hosted-modules.ts) takes a hold in the same transaction as the change it admits (a task start), the cost ledger draws a booked dollar usage down from the task's own hold,
// `settle` and `release` close a hold, and the hold sweep gives back a hold nobody closed. The laptop keeps none (its ledger is built without holds).
//
// Layout, in the company's own partitions:
//   `ORG#<c>#COST_HOLD` / `HOLD#<reservationId>`                    one per hold: what it held, how much of it usage has drawn, its UTC day, its state (open, settled, released)
//   `ORG#<c>#COST_HOLD_OPEN` / `<expiresAt, 12 digits>#<reservationId>` one per OPEN hold, ordered by expiry, so the sweep reads only the holds that are past their time
//   `ORG#<c>#COST_DAY` / `DAY#<yyyy-mm-dd>` (the ledger's day row)   gains `reservedMicros` (what open holds still hold) and `loadMicros`: booked dollars + reserved + what a settle kept.
//                                                                     A cap is checked on `loadMicros` alone (a condition cannot add two attributes), so every write that changes
//                                                                     `usdMicros` or `reservedMicros` changes `loadMicros` by the same amount in the same transaction.
// The reservation id names the company (`hold:<company>:<hash of the request key>`), so `settle` and `release`, which get only the id, find the hold in that company's own partition.
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, change, companyScoped, when, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { companyDayKey } from "./ledger.js";
import type { LedgerHolds } from "./ledger.js";

/** How long a task start's hold lasts before the sweep gives it back (a task that runs longer simply books what it uses). */
export const TASK_HOLD_SECONDS = 24 * 3_600;
/** How long any other hold lasts (one model call, one run). */
export const CALL_HOLD_SECONDS = 2 * 3_600;
/** A closed hold's rows are kept this long after the hold's own expiry, then the store may delete them. */
const HOLD_KEPT_SECONDS = 30 * 86_400;
const RESERVATION = /^hold:(org_[0-9a-z]{20}):([0-9a-f]{40})$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The reservation id of one request key in one company: asking again with the same key names the same hold. */
export function reservationIdOf(companyId: string, idempotencyKey: string): string {
  return `hold:${companyId}:${createHash("sha256").update(`${companyId}\n${idempotencyKey}`).digest("hex").slice(0, 40)}`;
}

/** The company a reservation id names, or undefined for anything that is not one of ours. */
export function companyOfReservation(reservationId: unknown): string | undefined {
  if (typeof reservationId !== "string") return undefined;
  const match = RESERVATION.exec(reservationId);
  return match !== null && OrgIdSchema.safeParse(match[1]).success ? match[1] : undefined;
}

export const holdKey = (companyId: string, reservationId: string): DocumentKey => ({ pk: companyScoped(companyId, "COST_HOLD"), sk: `HOLD#${reservationId}` });
export const openHoldKey = (companyId: string, expiresAt: number, reservationId: string): DocumentKey => ({ pk: companyScoped(companyId, "COST_HOLD_OPEN"), sk: `${String(expiresAt).padStart(12, "0")}#${reservationId}` });

/** An open or closed hold as stored, read strictly: anything that does not read is no hold (a caller then does nothing it cannot undo). */
interface Hold {
  companyId: string;
  reservationId: string;
  day: string;
  heldMicros: number;
  drawnMicros: number;
  state: "open" | "settled" | "released";
  expiresAt: number;
}

function holdOf(row: StoredDocument | undefined, companyId: string, reservationId: string): Hold | undefined {
  if (row === undefined || row["companyId"] !== companyId || row["reservationId"] !== reservationId) return undefined;
  const { day, heldMicros, drawnMicros, state, expiresAt } = row;
  if (typeof day !== "string" || !DAY.test(day) || !natural(heldMicros) || !natural(drawnMicros) || drawnMicros > heldMicros || !natural(expiresAt)) return undefined;
  if (state !== "open" && state !== "settled" && state !== "released") return undefined;
  return { companyId, reservationId, day, heldMicros, drawnMicros, state, expiresAt };
}

// ---- the company's day, as a cap reads it

/**
 * What the company's day holds against its cap: booked dollars, open holds and what settles kept, in micros. `unknown` when the day has usage with no dollar figure, or its row does not read
 * (a figure missing or not a whole number, or less than the dollars booked): a cap reader then refuses rather than guess.
 */
export async function readDayLoad(store: Pick<DocumentStore, "get">, companyId: string, day: string): Promise<number | "unknown"> {
  const row = await store.get(companyDayKey(companyId, day));
  if (row === undefined) return 0;
  const { loadMicros, usdMicros, uncountedEntries, reservedMicros } = row;
  if (!natural(loadMicros) || !natural(uncountedEntries) || uncountedEntries > 0) return "unknown";
  if (usdMicros !== undefined && (!natural(usdMicros) || usdMicros > loadMicros)) return "unknown";
  if (reservedMicros !== undefined && (!natural(reservedMicros) || reservedMicros > loadMicros)) return "unknown";
  return loadMicros;
}

/** The condition that holds a day under its cap with `micros` more on it: no row yet, or a readable row whose load leaves room and that has no usage without a dollar figure. */
export function dayRoomCondition(capMicros: number, micros: number) {
  const room = micros === 0 ? when.lt("loadMicros", capMicros) : when.lte("loadMicros", capMicros - micros);
  return when.or(when.absent(), when.and(room, when.eq("uncountedEntries", 0)));
}

// ---- taking a hold

export interface HoldRequest {
  companyId: string;
  reservationId: string;
  /** What the hold is for (`task.start`, `model.call`, ...): kept on the row for a person reading it. */
  action: string;
  /** The task whose usage draws the hold down (a task start's hold only). */
  taskId?: string | undefined;
  /** The UTC day it counts on. */
  day: string;
  /** Whole micros, above zero. */
  micros: number;
  capMicros: number;
  /** Seconds since the epoch. */
  nowSeconds: number;
  holdSeconds: number;
}

/** The steps that take a hold, for the caller's transaction (or the admission's own): the hold, its open-hold index row, and the day row, held under its cap. */
export function holdItems(request: HoldRequest): TransactItem[] {
  if (!natural(request.micros) || request.micros === 0) throw new Error("a hold is a whole number of micros above zero");
  const expiresAt = request.nowSeconds + request.holdSeconds;
  const kept = expiresAt + HOLD_KEPT_SECONDS;
  return [
    {
      kind: "put", condition: when.absent(),
      item: {
        ...holdKey(request.companyId, request.reservationId), entityType: "COST_HOLD", companyId: request.companyId, reservationId: request.reservationId, action: request.action,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }), day: request.day, heldMicros: request.micros, drawnMicros: 0, state: "open", expiresAt,
        createdAt: new Date(request.nowSeconds * 1000).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: kept,
      },
    },
    { kind: "put", condition: when.absent(), item: { ...openHoldKey(request.companyId, expiresAt, request.reservationId), entityType: "COST_HOLD_OPEN", companyId: request.companyId, reservationId: request.reservationId, expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: kept } },
    {
      kind: "update", key: companyDayKey(request.companyId, request.day),
      ops: [
        change.setIfAbsent("entityType", "COST_DAY"), change.setIfAbsent("companyId", request.companyId), change.setIfAbsent("day", request.day),
        change.setIfAbsent("usdMicros", 0), change.setIfAbsent("entries", 0), change.setIfAbsent("uncountedEntries", 0),
        change.add("reservedMicros", request.micros), change.add("loadMicros", request.micros),
      ],
      condition: dayRoomCondition(request.capMicros, request.micros),
    },
  ];
}

/** Whether a hold was taken for this reservation id (by an earlier ask with the same key). */
export async function holdExists(store: Pick<DocumentStore, "get">, reservationId: string): Promise<boolean> {
  const companyId = companyOfReservation(reservationId);
  return companyId !== undefined && holdOf(await store.get(holdKey(companyId, reservationId)), companyId, reservationId) !== undefined;
}

// ---- closing a hold

/**
 * Closes an open hold: `release` gives back what it still holds; `settle` keeps what the work it covered actually cost and was not booked through the ledger (`actualMicros` less what usage
 * already drew), or, when the actual cost is not known in dollars, keeps everything the hold still holds (never $0 for unknown spend). A closed, missing or unreadable hold, or an id that is
 * not ours, is a no-op. A lost race with a booking that drew the hold is read again.
 */
export async function closeHold(store: DocumentStore, reservationId: unknown, how: { kind: "release" } | { kind: "settle"; actualMicros: number | undefined }, now: () => Date): Promise<void> {
  const companyId = companyOfReservation(reservationId);
  if (companyId === undefined) return;
  const id = reservationId as string;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hold = holdOf(await store.get(holdKey(companyId, id)), companyId, id);
    if (hold === undefined || hold.state !== "open") return;
    const remaining = hold.heldMicros - hold.drawnMicros;
    const kept = how.kind === "release" ? 0 : how.actualMicros === undefined ? remaining : Math.max(0, how.actualMicros - hold.drawnMicros);
    const committed = await store.transact([
      {
        kind: "update", key: holdKey(companyId, id),
        ops: [change.set("state", how.kind === "release" ? "released" : "settled"), change.set("keptMicros", kept), change.set("closedAt", now().toISOString())],
        condition: when.and(when.eq("state", "open"), when.eq("drawnMicros", hold.drawnMicros)),
      },
      { kind: "delete", key: openHoldKey(companyId, hold.expiresAt, id) },
      {
        kind: "update", key: companyDayKey(companyId, hold.day),
        ops: [change.add("reservedMicros", -remaining), change.add("loadMicros", kept - remaining), ...(kept > 0 ? [change.add("settledMicros", kept)] : [])],
        condition: when.present(),
      },
    ]);
    if (committed.applied) return;
  }
  throw new Error("the spend hold could not be closed");
}

// ---- drawing a hold down (the ledger's side)

/** The ledger's holds: a booked dollar usage of a task is drawn from the task's own open hold (its start's), so the day counts it once. */
export function createLedgerHolds(store: Pick<DocumentStore, "get">): LedgerHolds {
  return {
    async drawdown({ companyId, total, usdMicros }) {
      if (!natural(usdMicros) || usdMicros === 0) return { items: [] };
      const reservationId = total?.["holdId"];
      if (companyOfReservation(reservationId) !== companyId) return { items: [] };
      const id = reservationId as string;
      const hold = holdOf(await store.get(holdKey(companyId, id)), companyId, id);
      if (hold === undefined || hold.state !== "open" || hold.drawnMicros >= hold.heldMicros) return { items: [] };
      const drawn = Math.min(usdMicros, hold.heldMicros - hold.drawnMicros);
      return {
        items: [{ kind: "update", key: holdKey(companyId, id), ops: [change.add("drawnMicros", drawn)], condition: when.and(when.eq("state", "open"), when.eq("drawnMicros", hold.drawnMicros)) }],
        day: { day: hold.day, micros: drawn },
      };
    },
  };
}

// ---- the sweep

/** At most this many expired holds are given back in one pass; the next pass takes the rest. */
export const HOLD_SWEEP_MAX = 200;

/** Gives back the company's open holds past their time (a caller that crashed before it could close one), oldest first, within the time and count it is given. */
export async function sweepExpiredHolds(store: DocumentStore, companyId: string, options: { budgetMs: number; now: () => Date }): Promise<{ released: number; failed: number; more: boolean }> {
  if (!OrgIdSchema.safeParse(companyId).success) throw new Error("the hold sweep needs a company");
  const started = options.now().getTime();
  const nowSeconds = Math.floor(started / 1000);
  const partition = companyScoped(companyId, "COST_HOLD_OPEN");
  let released = 0;
  let failed = 0;
  let cursor: string | undefined;
  do {
    if (options.now().getTime() - started >= options.budgetMs || released + failed >= HOLD_SWEEP_MAX) return { released, failed, more: true };
    const page = await store.query({ pk: partition, sk: { op: "lt", value: `${String(nowSeconds).padStart(12, "0")}#` }, limit: Math.min(100, HOLD_SWEEP_MAX - released - failed), ...(cursor === undefined ? {} : { cursor }) });
    for (const row of page.items) {
      if (options.now().getTime() - started >= options.budgetMs) return { released, failed, more: true };
      const reservationId = row["reservationId"];
      const expiresAt = row["expiresAt"];
      // An index row that does not read as one of this company's is left for its own expiry (it holds nothing: the day's figures live on the hold).
      if (companyOfReservation(reservationId) !== companyId || !natural(expiresAt)) { failed += 1; continue; }
      try {
        const hold = holdOf(await store.get(holdKey(companyId, reservationId as string)), companyId, reservationId as string);
        // A hold already closed (or one that does not read) keeps nothing open here; an open one is given back.
        if (hold === undefined || hold.state !== "open") await store.delete({ key: openHoldKey(companyId, expiresAt, reservationId as string) });
        else await closeHold(store, reservationId, { kind: "release" }, options.now);
        released += 1;
      } catch {
        failed += 1;
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return { released, failed, more: false };
}
