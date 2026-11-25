// DEC 254zzz41 (lane L4-GW6): reviewer grants and the review session a grant opens (a task token carrying `reviewer`: model-gateway-token.ts).
//
// A grant is claimed ONCE, by its jti, before any provider call. That one claim OPENS a review session: the first use holds the grant's whole
// `ceilingUsd` on the meter (one ordinary hold inside the task's limit AND the company's cap) and every call of the review, the first included,
// DEBITS the session until the ceiling is used up, the session ends, or it is closed (the unused money is then released). A grant is never usable
// as a fresh grant twice: a later call with the same jti only continues the session it opened, for the same company, project, task, workspace,
// operation, kind, slot and model, for at most REVIEW_SESSION_SECONDS, and never past the ceiling.
//
// The session is one conditional put in the markers table the gateway already writes (the ended-task list lives there too), under the company's own
// key (`CO#[iss,cid]`, so the serving role's LeadingKeys condition already covers it) and with the table's `expiresAt` TTL; no new table, record kind or IAM:
//
//   markers table CO#[iss,cid] / REVGRANT#<jti>     one per grant: the session (hold id, ceiling, room left, status, end time)
//
// It is durable: a second gateway process, or the same one after a restart, finds the item and refuses a replay of an unrelated or exhausted grant. A
// claim that cannot be made (the store is down, times out, or its answer is lost) is a refusal: the caller spends nothing. A lost answer after the
// write applied leaves a claimed grant, which is the safe side (a grant is never "maybe once more").
import { AwsNotSentError } from "./aws.js";
import { companyPartition, HOLD_SWEEP_AGE_MS } from "./dynamo-meter.js";
import type { CapsSource } from "./caps.js";
import type { Dynamo } from "./dynamo.js";
import type { Meter, MeterScope, Reservation } from "./meter.js";
import { COMPANY, whole } from "./model-gateway-token.js";

/** How long a review session may run after its first call (several model calls; the grants' own 120 seconds still bound each call's token). */
export const REVIEW_SESSION_SECONDS = 600;
/**
 * How long after the session's end the gateway closes it. A call still running then stays counted at its worst case (its debit is inside the total the hold settles at), so
 * the unused ceiling is released promptly and closing never waits for slow calls.
 */
export const REVIEW_SESSION_CLOSE_GRACE_MS = 30_000;
/**
 * How long a session's item outlives the hold sweep's earliest time for its hold (HOLD_SWEEP_AGE_MS after the hold's openFrom = the session's end plus the close grace): the session-aware
 * sweep (dynamo-meter.ts reviewTotal) must still find it, and a closed item keeps refusing the grant until it is gone. DynamoDB deletes lazily after the TTL.
 */
export const REVIEWER_GRANT_KEEP_SECONDS = 3600;
const JTI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One review session as stored. `room` is what the ceiling still allows (ceiling less everything debited). */
export interface ReviewSession { bind: string; holdId: string; ceilingMicros: number; roomMicros: number; debitedMicros: number; endsAt: number; status: "open" | "closed" }
export interface NewReviewSession { iss: string; cid: string; jti: string; bind: string; holdId: string; ceilingMicros: number; firstDebitMicros: number; endsAt: number }
export interface ReviewerGrantStore {
  /** The session this grant opened, or undefined when none. Throws when the store cannot answer. */
  read(iss: string, cid: string, jti: string, signal?: AbortSignal): Promise<ReviewSession | undefined>;
  /** The claim: true for the first one only. It opens the session with the first call's debit already taken. */
  open(session: NewReviewSession, signal?: AbortSignal): Promise<boolean>;
  /** One more call's worst case, taken only while the session is open, inside its end time, for exactly this binding and while the ceiling has room. */
  debit(iss: string, cid: string, jti: string, bind: string, micros: number, nowSeconds: number, signal?: AbortSignal): Promise<boolean>;
  /** Gives back what a finished call did not use (the debit less its real cost). Never throws; a failure leaves the call counted at its worst case. */
  giveBack(iss: string, cid: string, jti: string, micros: number): Promise<void>;
  /** Marks the session closed exactly once: its hold id and total debited the first time, undefined afterwards or when none. */
  close(iss: string, cid: string, jti: string, expectHoldId?: string): Promise<{ holdId: string; debitedMicros: number } | undefined>;
}

const readSession = (item: Record<string, unknown> | undefined): ReviewSession | undefined => {
  if (item === undefined) return undefined;
  const { bind, holdId, ceilingMicros, roomMicros, debitedMicros, endsAt, status } = item;
  if (typeof bind !== "string" || typeof holdId !== "string" || !whole(ceilingMicros) || !whole(roomMicros) || !whole(debitedMicros) || !whole(endsAt) || (status !== "open" && status !== "closed") || roomMicros + debitedMicros !== ceilingMicros) throw new Error("review session unreadable");
  return { bind, holdId, ceilingMicros, roomMicros, debitedMicros, endsAt, status };
};

export class DynamoReviewerGrants implements ReviewerGrantStore {
  /** `table` is the agent route's markers table (GATEWAY_MARKERS_TABLE). */
  constructor(private readonly db: Dynamo, private readonly table: string, private readonly now: () => number = Date.now) {}
  #key(iss: string, cid: string, jti: string) {
    if (typeof iss !== "string" || iss.length === 0 || iss.length > 2048 || !COMPANY.test(cid) || !JTI.test(jti)) throw new AwsNotSentError();
    return { pk: companyPartition(iss, cid), sk: `REVGRANT#${jti.toLowerCase()}` };
  }
  async read(iss: string, cid: string, jti: string, signal?: AbortSignal): Promise<ReviewSession | undefined> {
    return readSession(await this.db.get(this.table, this.#key(iss, cid, jti), { consistent: true, ...(signal === undefined ? {} : { signal }) }));
  }
  async open(s: NewReviewSession, signal?: AbortSignal): Promise<boolean> {
    const key = this.#key(s.iss, s.cid, s.jti);
    if (!whole(s.ceilingMicros) || !whole(s.firstDebitMicros) || s.firstDebitMicros > s.ceilingMicros || !whole(s.endsAt) || s.endsAt <= 0 || s.bind.length === 0 || s.bind.length > 1024 || s.holdId.length === 0 || s.holdId.length > 64) throw new AwsNotSentError();
    return this.db.put(
      this.table,
      { ...key, bind: s.bind, holdId: s.holdId, ceilingMicros: s.ceilingMicros, roomMicros: s.ceilingMicros - s.firstDebitMicros, debitedMicros: s.firstDebitMicros, endsAt: s.endsAt, status: "open", claimedAt: Math.floor(this.now() / 1000),
        expiresAt: s.endsAt + Math.ceil((REVIEW_SESSION_CLOSE_GRACE_MS + HOLD_SWEEP_AGE_MS) / 1000) + REVIEWER_GRANT_KEEP_SECONDS },
      (e) => `attribute_not_exists(${e.name("pk")})`,
      signal === undefined ? {} : { signal },
    );
  }
  async debit(iss: string, cid: string, jti: string, bind: string, micros: number, nowSeconds: number, signal?: AbortSignal): Promise<boolean> {
    const key = this.#key(iss, cid, jti);
    if (!whole(micros) || micros < 1 || !whole(nowSeconds)) throw new AwsNotSentError();
    return this.db.update(this.table, key,
      (e) => `SET ${e.name("roomMicros")} = ${e.name("roomMicros")} - ${e.value(micros)}, ${e.name("debitedMicros")} = ${e.name("debitedMicros")} + ${e.value(micros)}`,
      (e) => `${e.name("status")} = ${e.value("open")} AND ${e.name("bind")} = ${e.value(bind)} AND ${e.name("endsAt")} > ${e.value(nowSeconds)} AND ${e.name("roomMicros")} >= ${e.value(micros)}`,
      signal === undefined ? {} : { signal });
  }
  async giveBack(iss: string, cid: string, jti: string, micros: number): Promise<void> {
    try {
      if (!whole(micros) || micros < 1) return;
      await this.db.update(this.table, this.#key(iss, cid, jti),
        (e) => `SET ${e.name("roomMicros")} = ${e.name("roomMicros")} + ${e.value(micros)}, ${e.name("debitedMicros")} = ${e.name("debitedMicros")} - ${e.value(micros)}`,
        (e) => `${e.name("status")} = ${e.value("open")} AND ${e.name("debitedMicros")} >= ${e.value(micros)}`);
    } catch { /* The call stays counted at its worst case. */ }
  }
  async close(iss: string, cid: string, jti: string, expectHoldId?: string): Promise<{ holdId: string; debitedMicros: number } | undefined> {
    const key = this.#key(iss, cid, jti);
    // A debit that lands between the read and the conditional write changes debitedMicros: read again, a few times, then leave it to the hold sweep.
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = readSession(await this.db.get(this.table, key, { consistent: true }));
      if (seen === undefined || seen.status !== "open" || (expectHoldId !== undefined && seen.holdId !== expectHoldId)) return undefined;
      const closed = await this.db.update(this.table, key, (e) => `SET ${e.name("status")} = ${e.value("closed")}`, (e) => `${e.name("status")} = ${e.value("open")} AND ${e.name("debitedMicros")} = ${e.value(seen.debitedMicros)} AND ${e.name("holdId")} = ${e.value(seen.holdId)}`);
      if (closed) return { holdId: seen.holdId, debitedMicros: seen.debitedMicros };
    }
    return undefined;
  }
}

/** The store for tests and harnesses only: it forgets everything when the process ends, so it must never back a deployed gateway (process.ts builds the Dynamo one). */
export class InMemoryReviewerGrants implements ReviewerGrantStore {
  readonly sessions = new Map<string, ReviewSession>();
  #key = (iss: string, cid: string, jti: string) => JSON.stringify([iss, cid, jti.toLowerCase()]);
  async read(iss: string, cid: string, jti: string): Promise<ReviewSession | undefined> { const s = this.sessions.get(this.#key(iss, cid, jti)); return s === undefined ? undefined : { ...s }; }
  async open(s: NewReviewSession): Promise<boolean> {
    const key = this.#key(s.iss, s.cid, s.jti);
    if (this.sessions.has(key)) return false;
    this.sessions.set(key, { bind: s.bind, holdId: s.holdId, ceilingMicros: s.ceilingMicros, roomMicros: s.ceilingMicros - s.firstDebitMicros, debitedMicros: s.firstDebitMicros, endsAt: s.endsAt, status: "open" });
    return true;
  }
  async debit(iss: string, cid: string, jti: string, bind: string, micros: number, nowSeconds: number): Promise<boolean> {
    const s = this.sessions.get(this.#key(iss, cid, jti));
    if (s === undefined || s.status !== "open" || s.bind !== bind || s.endsAt <= nowSeconds || s.roomMicros < micros) return false;
    s.roomMicros -= micros; s.debitedMicros += micros;
    return true;
  }
  async giveBack(iss: string, cid: string, jti: string, micros: number): Promise<void> {
    const s = this.sessions.get(this.#key(iss, cid, jti));
    if (s !== undefined && s.status === "open" && s.debitedMicros >= micros) { s.roomMicros += micros; s.debitedMicros -= micros; }
  }
  async close(iss: string, cid: string, jti: string, expectHoldId?: string): Promise<{ holdId: string; debitedMicros: number } | undefined> {
    const s = this.sessions.get(this.#key(iss, cid, jti));
    if (s === undefined || s.status !== "open" || (expectHoldId !== undefined && s.holdId !== expectHoldId)) return undefined;
    s.status = "closed";
    return { holdId: s.holdId, debitedMicros: s.debitedMicros };
  }
}

/**
 * Closes one review session: marks it closed (once), then settles its hold at what the review really used, which gives the rest of the ceiling back to
 * the task's and the company's rows. A failure after the mark leaves the hold to the hold sweep, which settles a review hold at what its session debited (dynamo-meter.ts reviewTotal), the whole ceiling only if the session cannot be read.
 * `expectHoldId`: close only the session that THIS hold opened.
 * `meter.adopt` re-creates the settle handle in a gateway task that did not take the hold (DynamoMeter only).
 */
export async function closeReviewSession(store: ReviewerGrantStore, meter: Meter & { adopt?(iss: string, cid: string, reservation: Reservation): Reservation }, scope: Pick<MeterScope, "iss" | "cid">, jti: string, expectHoldId?: string): Promise<boolean> {
  const closed = await store.close(scope.iss, scope.cid, jti, expectHoldId);
  if (closed === undefined) return false;
  const handle: Reservation = { id: closed.holdId };
  await meter.settle(meter.adopt?.(scope.iss, scope.cid, handle) ?? handle, closed.debitedMicros);
  return true;
}

/** The project and task id the company-limit read uses: the company's row does not depend on either. */
export const REVIEWER_LIMIT_ID = "reviewer-limit";
/**
 * The room left in the company's ONE cap (the agent meter's company row, which every route's holds count in), in micro-dollars: what a review may
 * still take, the same figure the reserve below enforces. Undefined when the cap or the row cannot be read as this company's (no reviewer access).
 */
export async function companyRoomMicros(caps: CapsSource, meter: Pick<Meter, "read">, iss: string, cid: string, signal?: AbortSignal): Promise<number | undefined> {
  const scope = { iss, cid, pid: REVIEWER_LIMIT_ID, tid: REVIEWER_LIMIT_ID };
  const cap = (await caps.capsFor(scope, signal)).companyMonth;
  const row = (await meter.read(scope)).find((r) => r.item === "company");
  return cap === undefined || !Number.isSafeInteger(cap) || row === undefined || row.company !== cid ? undefined : Math.max(0, cap - row.committed);
}
