// Port lane L9a, K1: the per-task proxy tokens and the spend each operation has run up.
//
// A token is 32 random bytes the proxy hands to one worker for one operation. Only its SHA-256 is kept, so reading the book (a core dump, a
// debug print) gives no usable token. A token dies at its expiry, when its operation is revoked, and when the operation stops holding its
// workspace (the proxy asks before every call). It is bound to one workspace: the egress gateway of that worker stamps the workspace on every
// call it relays, and a token presented for another workspace is refused.
import { createHash, randomBytes } from "node:crypto";
import type { Cost } from "@agentx/contracts";
import type { ModelGrant, ProxyRoute } from "./types.js";

export const TOKEN_PREFIX = "rvm_";
/** The worker asks again 60 s before expiry (`MODEL_ACCESS_MARGIN_MS`), so a token has to outlast that by a good margin. */
export const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
export const MIN_TOKEN_TTL_SECONDS = 150;
const MAX_TOKENS = 2_000;
/** How many operations' called aliases are remembered. */
const CALLED_OPERATIONS_MAX = 500;
/** The spend records of design-review slot keys kept after their operation ended (a round has at most 4; two rounds and a few tasks). */
const MAX_SLOT_LEDGERS = 200;
/** The worker needs one live token per operation (it asks again a minute before expiry). Minting another beyond this revokes the oldest, so one operation can never fill the book. */
export const MAX_LIVE_TOKENS_PER_OPERATION = 3;

export interface TokenRecord {
  workspaceId: string;
  operationId: string;
  fence: number | undefined;
  taskId: string | undefined;
  projectName: string | undefined;
  routes: ReadonlyMap<string, ProxyRoute>;
  budget: Cost | undefined;
  /** A design review's key slot, when this token is one reviewer's. */
  slot: string | undefined;
  /** The bound used for a slot whose model has no price (see `ModelGrant.assumedPrice`). */
  assumedPrice: ModelGrant["assumedPrice"];
  /** The id of the key (the token's SHA-256): what the broker records and the worker reports. */
  keyId: string;
  /** The spend record this token adds to: the operation's own, or (for a slot) the slot's. */
  ledgerId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What one operation has spent through the proxy. In memory: a restarted broker starts every operation at 0 (see docs/ports.md, K1 gaps). */
export interface OperationLedger {
  currency: string | undefined;
  spentMicros: number;
  /**
   * What calls cost that the Metering port could not record (priced without recording). It counts against THIS operation's budget but is not in `spentBy`: the task's cost ledger does not hold it, so a token made
   * again for this operation must not take it off the ledger's total as if it were there.
   */
  unrecordedMicros: number;
  /** The worst-case cost of the calls running now, held against the budget until each settles to what it really used. */
  reservedMicros: number;
  /** Calls whose cost could not be priced (an unknown model): they are counted, never guessed. */
  unpriced: number;
  inFlight: number;
}

/** What one capped route has spent in one operation, in millionths of a dollar: settled spend, and the worst case of the calls running now. */
export interface RouteLedger { spentMicros: number; reservedMicros: number }

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export type TokenLookup = { ok: true; record: TokenRecord } | { ok: false; reason: "unknown" | "expired" };

export class ModelTokenBook {
  readonly #tokens = new Map<string, TokenRecord>();
  readonly #ledgers = new Map<string, OperationLedger>();
  readonly #routeLedgers = new Map<string, RouteLedger>();
  /** The aliases each operation's calls were forwarded on. Kept after the operation's spend is forgotten (the broker reads it when the operation's result arrives), and bounded. */
  readonly #called = new Map<string, Set<string>>();
  /** Key id to the spend record of a design-review slot's key. */
  readonly #slotLedgers = new Map<string, string>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlSeconds?: number } = {}) {
    this.#now = options.now ?? Date.now;
    const ttl = options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl < MIN_TOKEN_TTL_SECONDS) throw new RangeError(`a proxy token lasts at least ${String(MIN_TOKEN_TTL_SECONDS)} seconds, so the worker can ask for the next one in time`);
    this.#ttlMs = ttl * 1_000;
  }

  mint(grant: ModelGrant, options: { ttlSeconds?: number } = {}): { token: string; keyId: string; expiresAt: number } {
    this.#purge();
    // Oldest first (a Map keeps insertion order): keep room for the one being minted. A slot's token counts against its own slot only.
    const mine = [...this.#tokens].filter(([, record]) => record.operationId === grant.operationId && record.slot === grant.slot);
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - (MAX_LIVE_TOKENS_PER_OPERATION - 1)))) this.#tokens.delete(hash);
    if (this.#tokens.size >= MAX_TOKENS) throw new RangeError("too many proxy tokens are live");
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + (options.ttlSeconds === undefined ? this.#ttlMs : options.ttlSeconds * 1_000);
    const keyId = digest(token);
    const ledgerId = grant.slot === undefined ? grant.operationId : `${grant.operationId}#${keyId}`;
    this.#tokens.set(keyId, {
      workspaceId: grant.workspaceId, operationId: grant.operationId, fence: grant.fence, taskId: grant.taskId, projectName: grant.projectName,
      routes: new Map(grant.routes.map((route) => [route.alias, route])), budget: grant.budget, slot: grant.slot, assumedPrice: grant.assumedPrice, keyId, ledgerId, expiresAt,
    });
    if (!this.#ledgers.has(ledgerId)) this.#ledgers.set(ledgerId, { currency: undefined, spentMicros: 0, unrecordedMicros: 0, reservedMicros: 0, unpriced: 0, inFlight: 0 });
    if (grant.slot !== undefined) {
      this.#slotLedgers.set(keyId, ledgerId);
      // A slot's spend record outlives its operation (the round is recorded after the operation ends and reads it); the oldest are dropped past a bound, but never the record of a token that is still live: its spend would start again from nothing.
      for (const [oldKey, oldLedger] of this.#slotLedgers) {
        if (this.#slotLedgers.size <= MAX_SLOT_LEDGERS) break;
        if (this.#tokens.has(oldKey)) continue;
        this.#slotLedgers.delete(oldKey);
        this.#ledgers.delete(oldLedger);
      }
    }
    return { token, keyId, expiresAt };
  }

  lookup(token: string): TokenLookup {
    const hash = digest(token);
    const record = this.#tokens.get(hash);
    if (record === undefined) return { ok: false, reason: "unknown" };
    if (record.expiresAt <= this.#now()) {
      this.#tokens.delete(hash);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, record };
  }

  /** What one operation has spent so far in this process, or undefined when it has no record (nothing is made for it). */
  spentBy(operationId: string): { micros: number; currency: string | undefined } | undefined {
    const ledger = this.#ledgers.get(operationId);
    return ledger === undefined ? undefined : { micros: ledger.spentMicros, currency: ledger.currency };
  }

  ledger(operationId: string): OperationLedger {
    let ledger = this.#ledgers.get(operationId);
    if (ledger === undefined) {
      ledger = { currency: undefined, spentMicros: 0, unrecordedMicros: 0, reservedMicros: 0, unpriced: 0, inFlight: 0 };
      this.#ledgers.set(operationId, ledger);
    }
    return ledger;
  }

  /** Notes that a call of `operationId` was forwarded to the provider on `alias`. */
  noteCall(operationId: string, alias: string): void {
    let seen = this.#called.get(operationId);
    if (seen === undefined) {
      seen = new Set();
      this.#called.set(operationId, seen);
      while (this.#called.size > CALLED_OPERATIONS_MAX) this.#called.delete(this.#called.keys().next().value as string);
    }
    seen.add(alias);
  }

  /** The aliases this operation's calls went out on, or undefined when the proxy has no record of the operation (a restart, or one that made no call). */
  calledAliases(operationId: string): ReadonlySet<string> | undefined {
    return this.#called.get(operationId);
  }

  /** The spend of one capped route in one operation (made when first asked). */
  routeLedger(operationId: string, alias: string): RouteLedger {
    const key = `${operationId}\0${alias}`;
    let ledger = this.#routeLedgers.get(key);
    if (ledger === undefined) { ledger = { spentMicros: 0, reservedMicros: 0 }; this.#routeLedgers.set(key, ledger); }
    return ledger;
  }

  /** Ends every token of an operation (it finished, was cancelled, or lost its workspace). Its spend is kept for a later operation. */
  revokeOperation(operationId: string): number {
    let count = 0;
    for (const [hash, record] of this.#tokens) {
      if (record.operationId === operationId) {
        this.#tokens.delete(hash);
        count += 1;
      }
    }
    return count;
  }

  /** Forgets an operation's spend as well (after its settlement). A design-review slot's spend record stays: the round is recorded after the operation ended and reads it. */
  forgetOperation(operationId: string): void {
    this.revokeOperation(operationId);
    this.#ledgers.delete(operationId);
    for (const key of [...this.#routeLedgers.keys()]) if (key.startsWith(`${operationId}\0`)) this.#routeLedgers.delete(key);
  }

  /** Blocks these keys now: their tokens die, and a call that was admitted stays counted. Idempotent. */
  closeKeys(keyIds: readonly string[]): void {
    for (const keyId of keyIds) this.#tokens.delete(keyId);
  }

  /** What these keys spent, in micros of one currency: the settled spend plus what the calls still running could cost (never under-counted). Undefined when a key has no record (the broker then charges its whole ceiling). */
  keySpend(keyIds: readonly string[]): { micros: number; currency: string | undefined } | undefined {
    let micros = 0;
    let currency: string | undefined;
    for (const keyId of keyIds) {
      const ledgerId = this.#slotLedgers.get(keyId);
      const ledger = ledgerId === undefined ? undefined : this.#ledgers.get(ledgerId);
      if (ledger === undefined) return undefined;
      micros += ledger.spentMicros + ledger.reservedMicros;
      currency ??= ledger.currency;
    }
    return { micros, currency };
  }

  /** How many operations have a spend record (a ledger is freed when its operation is seen to end: `forgetOperation`). */
  ledgerCount(): number {
    return this.#ledgers.size;
  }

  liveTokensOf(operationId: string): number {
    this.#purge();
    let count = 0;
    for (const record of this.#tokens.values()) if (record.operationId === operationId) count += 1;
    return count;
  }

  liveTokens(): number {
    this.#purge();
    return this.#tokens.size;
  }

  #purge(): void {
    const now = this.#now();
    for (const [hash, record] of this.#tokens) if (record.expiresAt <= now) this.#tokens.delete(hash);
  }
}
