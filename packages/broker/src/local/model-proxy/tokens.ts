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
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What one operation has spent through the proxy. In memory: a restarted broker starts every operation at 0 (see docs/ports.md, K1 gaps). */
export interface OperationLedger {
  currency: string | undefined;
  spentMicros: number;
  /** The worst-case cost of the calls running now, held against the budget until each settles to what it really used. */
  reservedMicros: number;
  /** Calls whose cost could not be priced (an unknown model): they are counted, never guessed. */
  unpriced: number;
  inFlight: number;
}

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export type TokenLookup = { ok: true; record: TokenRecord } | { ok: false; reason: "unknown" | "expired" };

export class ModelTokenBook {
  readonly #tokens = new Map<string, TokenRecord>();
  readonly #ledgers = new Map<string, OperationLedger>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlSeconds?: number } = {}) {
    this.#now = options.now ?? Date.now;
    const ttl = options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl < MIN_TOKEN_TTL_SECONDS) throw new RangeError(`a proxy token lasts at least ${String(MIN_TOKEN_TTL_SECONDS)} seconds, so the worker can ask for the next one in time`);
    this.#ttlMs = ttl * 1_000;
  }

  mint(grant: ModelGrant): { token: string; expiresAt: number } {
    this.#purge();
    // Oldest first (a Map keeps insertion order): keep room for the one being minted.
    const mine = [...this.#tokens].filter(([, record]) => record.operationId === grant.operationId);
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - (MAX_LIVE_TOKENS_PER_OPERATION - 1)))) this.#tokens.delete(hash);
    if (this.#tokens.size >= MAX_TOKENS) throw new RangeError("too many proxy tokens are live");
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tokens.set(digest(token), {
      workspaceId: grant.workspaceId, operationId: grant.operationId, fence: grant.fence, taskId: grant.taskId, projectName: grant.projectName,
      routes: new Map(grant.routes.map((route) => [route.alias, route])), budget: grant.budget, expiresAt,
    });
    if (!this.#ledgers.has(grant.operationId)) this.#ledgers.set(grant.operationId, { currency: undefined, spentMicros: 0, reservedMicros: 0, unpriced: 0, inFlight: 0 });
    return { token, expiresAt };
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

  ledger(operationId: string): OperationLedger {
    let ledger = this.#ledgers.get(operationId);
    if (ledger === undefined) {
      ledger = { currency: undefined, spentMicros: 0, reservedMicros: 0, unpriced: 0, inFlight: 0 };
      this.#ledgers.set(operationId, ledger);
    }
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

  /** Forgets an operation's spend as well (after its settlement). */
  forgetOperation(operationId: string): void {
    this.revokeOperation(operationId);
    this.#ledgers.delete(operationId);
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
