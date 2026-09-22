import { createHash, randomUUID } from "node:crypto";

/**
 * A refusal from the model route.
 *
 * Distinct from `AgentXError` because these are broker decisions, not wire responses:
 * nothing here is a status code the executor gets to interpret.
 */
export class MockModelRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockModelRouteError";
  }
}

export interface MockModelRouteConfig {
  routeVersion: string;
  policyDigest: string;
  dataClass: string;
  /** The exact model identifiers this route may dispatch. Nothing else is reachable. */
  modelAllowlist: readonly string[];
  /** Versioned prices; a reservation states which version priced it. */
  priceVersion: string;
  microunitsPerInputByte: number;
  microunitsPerOutputByte: number;
  /** Maximum output this route will ever accept, charged in full at reservation. */
  outputCapBytes: number;
}

export interface MockRouteTokenInput {
  operationId: string;
  caseId: string;
  attemptNumber: number;
  maxMicrounits: number;
  maxCalls: number;
  notAfter: string;
}

export interface MockRouteToken extends MockRouteTokenInput {
  /** Reference to the authority this route retained. The token is not the authority. */
  tokenId: string;
  routeVersion: string;
  policyDigest: string;
  dataClass: string;
  modelAllowlist: readonly string[];
}

/** Durable backing for retained authority, reservations and receipts. */
export interface ModelRouteStore {
  putRouteToken(token: MockRouteToken): void;
  getRouteToken(tokenId: string): MockRouteToken | undefined;
  putRouteReservation(reservation: Reservation & { tokenId: string }): void;
  listRouteReservations(operationId: string, attemptNumber: number): Reservation[];
  getRouteReservation(reservationId: string): (Reservation & { tokenId: string }) | undefined;
  putRouteReceipt(receipt: ModelReceipt): void;
}

export type ReservationState = "reserved" | "observed" | "unknown";

export interface Reservation {
  reservationId: string;
  operationId: string;
  attemptNumber: number;
  modelId: string;
  routeVersion: string;
  priceVersion: string;
  reservedMicrounits: number;
  observedMicrounits?: number;
  state: ReservationState;
  requestedAt: string;
  settledAt?: string;
  reason?: string;
}

export type ReceiptOutcome = "succeeded" | "provider_error" | "unknown";

export interface ModelReceipt {
  receiptId: string;
  reservationId: string;
  operationId: string;
  caseId: string;
  attemptNumber: number;
  routeVersion: string;
  policyDigest: string;
  dataClass: string;
  modelId: string;
  priceVersion: string;
  reservedMicrounits: number;
  observedMicrounits?: number;
  outcome: ReceiptOutcome;
  settledAt: string;
}

/**
 * A mock-only Model Access Broker.
 *
 * It holds no provider credential and reaches no provider. What it does hold is the
 * accounting and refusal behaviour a real route needs, so that behaviour can be built
 * and tested before any credential decision is made.
 *
 * Two rules shape everything here. Spend is reserved **before** dispatch, at a
 * conservative upper bound, and is never refunded — a call that failed or whose outcome
 * we could not observe still consumed the authorization to make it. And a receipt only
 * ever records what was actually observed: there is no path that writes `succeeded`
 * without an observed result, so silence is reported as `unknown`.
 *
 * The executor cannot write a receipt. Settlement requires a reservation this route
 * made, so an executor's claim about its own compliance has nothing to attach to.
 */
export class MockModelRoute {
  private readonly reservations = new Map<string, Reservation>();
  private readonly issued = new Map<string, ModelReceipt>();
  private readonly authorities = new Map<string, MockRouteToken>();
  private readonly tokenOf = new Map<string, string>();

  constructor(
    private readonly config: MockModelRouteConfig,
    /** When present, tokens, reservations and receipts survive a restart. */
    private readonly store?: ModelRouteStore,
  ) {
    if (config.modelAllowlist.length === 0) {
      throw new MockModelRouteError("a route with an empty allowlist can dispatch nothing");
    }
    if (config.outputCapBytes <= 0) throw new MockModelRouteError("outputCapBytes must be positive");
  }

  /** This route is mock-only by construction; it has no credential to hold. */
  isMockOnly(): boolean {
    return true;
  }

  /**
   * Mint an operation-scoped token.
   *
   * The token carries no secret: it is a statement of what this operation may spend and
   * until when, and the route re-checks all of it at reservation time anyway.
   */
  mint(input: MockRouteTokenInput): MockRouteToken {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
      throw new MockModelRouteError("attemptNumber must be a positive integer");
    }
    if (!Number.isInteger(input.maxCalls) || input.maxCalls < 1) {
      throw new MockModelRouteError("maxCalls must be a positive integer");
    }
    if (!Number.isInteger(input.maxMicrounits) || input.maxMicrounits < 0) {
      throw new MockModelRouteError("maxMicrounits must be a non-negative integer");
    }
    assertFiniteTimestamp(input.notAfter, "notAfter");
    if (typeof input.operationId !== "string" || input.operationId === "") {
      throw new MockModelRouteError("operationId is required");
    }
    if (typeof input.caseId !== "string" || input.caseId === "") {
      throw new MockModelRouteError("caseId is required");
    }
    const token: MockRouteToken = {
      ...input,
      tokenId: randomUUID(),
      routeVersion: this.config.routeVersion,
      policyDigest: this.config.policyDigest,
      dataClass: this.config.dataClass,
      modelAllowlist: [...this.config.modelAllowlist],
    };
    // The authority is retained here. What the caller holds is a reference to it.
    this.authorities.set(token.tokenId, token);
    this.store?.putRouteToken(token);
    return { ...token };
  }

  /** The authority this route issued, read back from where it was retained. */
  private authority(tokenId: string): MockRouteToken {
    const retained = this.authorities.get(tokenId) ?? this.store?.getRouteToken(tokenId);
    if (!retained) throw new MockModelRouteError("no such route token was issued by this route");
    this.authorities.set(tokenId, retained);
    return retained;
  }

  /**
   * Reserve budget before a dispatch, or refuse it.
   *
   * The reservation is the conservative upper bound for the authorized request: the
   * exact input the caller is sending, plus the route's whole output cap, priced at a
   * named price version. The response length is not knowable in advance, so the cap is
   * charged in full rather than estimated optimistically and reconciled later.
   */
  reserve(input: { token: MockRouteToken; modelId: string; inputBytes: number }): Reservation {
    if (typeof input.token?.tokenId !== "string") {
      throw new MockModelRouteError("reservation requires a token issued by this route");
    }
    // Read the authority back from where this route retained it, and require the
    // presented token to still match it in full. A token edited in flight therefore
    // changes nothing: the limits, expiry and binding that govern are the issued ones.
    const authority = this.authority(input.token.tokenId);
    assertSameBinding(authority, input.token);

    if (!this.config.modelAllowlist.includes(input.modelId)) {
      throw new MockModelRouteError(`model ${input.modelId} is not on route ${this.config.routeVersion}`);
    }
    if (!authority.modelAllowlist.includes(input.modelId)) {
      throw new MockModelRouteError(`model ${input.modelId} is not on this token's allowlist`);
    }
    const notAfter = assertFiniteTimestamp(authority.notAfter, "notAfter");
    if (notAfter <= Date.now()) throw new MockModelRouteError("route token has expired");
    if (!Number.isInteger(input.inputBytes) || input.inputBytes < 0) {
      throw new MockModelRouteError("inputBytes must be a non-negative integer");
    }

    const already = this.forOperation(authority.operationId, authority.attemptNumber);
    if (already.length >= authority.maxCalls) {
      throw new MockModelRouteError("route call limit reached for this attempt");
    }
    const reservedMicrounits =
      input.inputBytes * this.config.microunitsPerInputByte +
      this.config.outputCapBytes * this.config.microunitsPerOutputByte;
    const spent = already.reduce((total, entry) => total + entry.reservedMicrounits, 0);
    if (spent + reservedMicrounits > authority.maxMicrounits) {
      throw new MockModelRouteError("reservation would exceed the authorized budget");
    }

    const reservation: Reservation = {
      reservationId: randomUUID(),
      operationId: authority.operationId,
      attemptNumber: authority.attemptNumber,
      modelId: input.modelId,
      routeVersion: this.config.routeVersion,
      priceVersion: this.config.priceVersion,
      reservedMicrounits,
      state: "reserved",
      requestedAt: new Date().toISOString(),
    };
    this.reservations.set(reservation.reservationId, reservation);
    this.tokenOf.set(reservation.reservationId, authority.tokenId);
    this.store?.putRouteReservation({ ...reservation, tokenId: authority.tokenId });
    return { ...reservation };
  }

  /** Settle a reservation against a result the route actually observed. */
  settleObserved(
    reservationId: string,
    result: { outcome: Exclude<ReceiptOutcome, "unknown">; observedMicrounits: number },
  ): ModelReceipt {
    const reservation = this.require(reservationId);
    reservation.state = "observed";
    reservation.observedMicrounits = result.observedMicrounits;
    reservation.settledAt = new Date().toISOString();
    return this.issue(reservation, result.outcome);
  }

  /**
   * Settle a reservation whose outcome could not be observed.
   *
   * The reservation stands. We asked a provider to do something and cannot say what
   * happened, which is strictly worse than a known failure, so it is never refunded and
   * never recorded as a success.
   */
  settleUnknown(reservationId: string, reason: string): ModelReceipt {
    const reservation = this.require(reservationId);
    reservation.state = "unknown";
    reservation.settledAt = new Date().toISOString();
    reservation.reason = reason;
    return this.issue(reservation, "unknown");
  }

  /** Everything reserved for a token's attempt, refunded or not. Nothing is refunded. */
  spentMicrounits(token: MockRouteToken): number {
    return this.forOperation(token.operationId, token.attemptNumber)
      .reduce((total, entry) => total + entry.reservedMicrounits, 0);
  }

  ledger(): Reservation[] {
    return [...this.reservations.values()].map((entry) => ({ ...entry }));
  }

  receipts(): ModelReceipt[] {
    return [...this.issued.values()].map((entry) => ({ ...entry }));
  }

  private forOperation(operationId: string, attemptNumber: number): Reservation[] {
    // Durable rows are authoritative when a store is attached, so reservations survive
    // a restart and a recovered route cannot hand out budget that was already spent.
    if (this.store) return this.store.listRouteReservations(operationId, attemptNumber);
    return [...this.reservations.values()].filter(
      (entry) => entry.operationId === operationId && entry.attemptNumber === attemptNumber,
    );
  }

  private require(reservationId: string): Reservation {
    const reservation =
      this.reservations.get(reservationId) ?? this.store?.getRouteReservation(reservationId);
    if (!reservation) throw new MockModelRouteError("no such reservation on this route");
    this.reservations.set(reservationId, reservation);
    if (reservation.state !== "reserved") {
      throw new MockModelRouteError("reservation is already settled");
    }
    return reservation;
  }

  private issue(reservation: Reservation, outcome: ReceiptOutcome): ModelReceipt {
    const receipt: ModelReceipt = {
      receiptId: createHash("sha256")
        .update(`${reservation.reservationId}\0${outcome}\0${reservation.settledAt ?? ""}`)
        .digest("hex"),
      reservationId: reservation.reservationId,
      operationId: reservation.operationId,
      caseId: this.caseIdFor(reservation.reservationId),
      attemptNumber: reservation.attemptNumber,
      routeVersion: reservation.routeVersion,
      policyDigest: this.config.policyDigest,
      dataClass: this.config.dataClass,
      modelId: reservation.modelId,
      priceVersion: reservation.priceVersion,
      reservedMicrounits: reservation.reservedMicrounits,
      ...(reservation.observedMicrounits === undefined
        ? {}
        : { observedMicrounits: reservation.observedMicrounits }),
      outcome,
      settledAt: reservation.settledAt ?? new Date().toISOString(),
    };
    this.issued.set(receipt.receiptId, receipt);
    this.store?.putRouteReceipt(receipt);
    return { ...receipt };
  }

  /** The case a reservation was authorized under, kept on every receipt. */
  private caseIdFor(reservationId: string): string {
    const tokenId =
      this.tokenOf.get(reservationId) ?? this.store?.getRouteReservation(reservationId)?.tokenId;
    if (!tokenId) throw new MockModelRouteError("reservation has no issuing token");
    return this.authority(tokenId).caseId;
  }
}

/** Reject a timestamp that is absent, malformed or non-finite. */
function assertFiniteTimestamp(value: string, label: string): number {
  if (typeof value !== "string") throw new MockModelRouteError(`${label} must be a timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MockModelRouteError(`${label} is not a finite timestamp`);
  return parsed;
}

/**
 * Require a presented token to match the retained authority in full.
 *
 * Checked field by field rather than by shape so that an edited copy is refused rather
 * than silently governed by the stored values it disagrees with.
 */
function assertSameBinding(authority: MockRouteToken, presented: MockRouteToken): void {
  const fields: Array<keyof MockRouteToken> = [
    "tokenId", "operationId", "caseId", "attemptNumber", "routeVersion",
    "policyDigest", "dataClass", "maxMicrounits", "maxCalls", "notAfter",
  ];
  for (const field of fields) {
    if (authority[field] !== presented[field]) {
      throw new MockModelRouteError(`route token ${String(field)} does not match the issued authority`);
    }
  }
  const issued = [...authority.modelAllowlist].sort().join("\u0000");
  const shown = [...(presented.modelAllowlist ?? [])].sort().join("\u0000");
  if (issued !== shown) {
    throw new MockModelRouteError("route token allowlist does not match the issued authority");
  }
}
