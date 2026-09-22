import { createHash, randomUUID } from "node:crypto";
import {
  OperationRequestSchema,
  OperationSchema,
  TERMINAL_OPERATION_STATUSES,
  agentXError,
  type Operation,
  type OperationRequest,
  type OperationStatus,
  type WorkerInvocation,
} from "@agentx/contracts";
import { RequestIndexIntegrityError, taskPayloadHash } from "@agentx/broker";
import { inTransaction, type HostDatabase } from "./database.js";
import type { SqliteRegistry } from "./sqlite-registry.js";

export interface OutboxRecord {
  id: string;
  operationId: string;
  workspaceId: string;
  fence: number;
  invocation: WorkerInvocation;
  attempts: number;
  deliveredAt?: string;
}

export interface StoredEvent {
  sequence: number;
  type: string;
  payload: unknown;
  recordedAt: string;
}

export interface StoredArtifact {
  id: string;
  operationId: string;
  workspaceId: string;
  name: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  content: string;
}

export interface AcceptTaskOptions {
  /** Builds the worker invocation queued in the same transaction as the operation. */
  invocation: (input: { operationId: string; fence: number; request: OperationRequest }) => WorkerInvocation;
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/**
 * Durable replacement for `OperationStore`.
 *
 * Accepting work writes the operation, its request index entry and the outbox row in
 * one transaction. Either a caller is told about an operation that is queued and
 * recoverable, or nothing happened; there is no state where an accepted operation
 * exists that nothing will ever run.
 */
export class SqliteOperationStore {
  constructor(
    private readonly database: HostDatabase,
    private readonly registry: SqliteRegistry,
  ) {}

  async acceptTask(
    workspaceId: string,
    ownerKey: string,
    untrustedRequest: OperationRequest,
    options: AcceptTaskOptions,
  ): Promise<{ operation: Operation; duplicate: boolean }> {
    const request = OperationRequestSchema.parse(untrustedRequest);
    const hash = taskPayloadHash(request);
    return inTransaction(this.database, () => {
      const indexed = this.database
        .prepare(
          "SELECT operation_id, payload_hash FROM request_index WHERE owner_key = ? AND workspace_id = ? AND request_id = ?",
        )
        .get(ownerKey, workspaceId, request.requestId) as
        | { operation_id: string; payload_hash: string }
        | undefined;
      if (indexed) {
        if (indexed.payload_hash !== hash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was already used for a different payload");
        }
        return { operation: this.requireOperation(indexed.operation_id), duplicate: true };
      }

      // A conversation the caller invented is not a place to attach work. Checked
      // inside the transaction so it cannot be created between check and write.
      if (!this.registry.hasConversation(workspaceId, request.conversationId)) {
        throw agentXError("NOT_FOUND", "conversation not found");
      }

      const id = randomUUID();
      const fence = this.registry.acquireWriterLocked(workspaceId, ownerKey, id).fence;
      const now = new Date().toISOString();
      const operation: Operation = OperationSchema.parse({
        id,
        workspaceId,
        conversationId: request.conversationId,
        kind: "task",
        requestId: request.requestId,
        payloadHash: hash,
        status: "ACCEPTED",
        fence,
        createdAt: now,
        updatedAt: now,
      });
      this.writeOperation(operation);
      this.database
        .prepare(
          `INSERT INTO request_index (owner_key, workspace_id, request_id, operation_id, payload_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ownerKey, workspaceId, request.requestId, id, hash, now);
      const invocation = options.invocation({ operationId: id, fence, request });
      this.database
        .prepare(
          `INSERT INTO outbox (id, operation_id, workspace_id, fence, invocation, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(randomUUID(), id, workspaceId, fence, JSON.stringify(invocation), now);
      return { operation, duplicate: false };
    });
  }

  get(id: string): Operation | undefined {
    const row = this.database.prepare("SELECT document FROM operations WHERE id = ?").get(id) as
      | { document: string }
      | undefined;
    return row ? OperationSchema.parse(JSON.parse(row.document)) : undefined;
  }

  /**
   * Read the operation already accepted for an authenticated owner's request id.
   *
   * Recovery only: no writer lease, no queue entry, no state change. `undefined` means
   * this owner has no index entry for this request in this workspace. That is not proof
   * the original submission never reached a worker, so it can never authorize another
   * submission. `requestId` is matched byte for byte against the spelling acceptance
   * stored, so two spellings of one UUID stay two distinct request identities.
   */
  getByRequest(workspaceId: string, ownerKey: string, requestId: string): Operation | undefined {
    const indexed = this.database
      .prepare(
        "SELECT operation_id FROM request_index WHERE owner_key = ? AND workspace_id = ? AND request_id = ?",
      )
      .get(ownerKey, workspaceId, requestId) as { operation_id: string } | undefined;
    if (!indexed) return undefined;
    const operation = this.get(indexed.operation_id);
    if (!operation || operation.workspaceId !== workspaceId || operation.requestId !== requestId) {
      throw new RequestIndexIntegrityError();
    }
    return operation;
  }

  transition(id: string, status: OperationStatus, details?: { result?: unknown; error?: string }): Operation {
    return inTransaction(this.database, () => {
      const operation = this.requireOperation(id);
      if (TERMINAL_OPERATION_STATUSES.has(operation.status as never)) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "terminal operation results are immutable");
      }
      const updated: Operation = OperationSchema.parse({
        ...operation,
        status,
        updatedAt: new Date().toISOString(),
        ...(details?.result === undefined ? {} : { result: details.result }),
        ...(details?.error === undefined ? {} : { error: details.error }),
      });
      this.writeOperation(updated);
      return updated;
    });
  }

  /**
   * Record a worker's terminal result for an operation.
   *
   * A repeat of the identical terminal result is accepted, because a worker that lost
   * our reply will legitimately send it again. A *different* terminal result for the
   * same operation is refused: the first observed outcome is the one that happened.
   */
  settleTerminal(
    id: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    details: { result?: unknown; error?: string },
  ): Operation {
    return inTransaction(this.database, () => {
      const operation = this.requireOperation(id);
      if (TERMINAL_OPERATION_STATUSES.has(operation.status as never)) {
        const same =
          operation.status === status &&
          JSON.stringify(operation.result ?? null) === JSON.stringify(details.result ?? null);
        if (!same) throw agentXError("IDEMPOTENCY_CONFLICT", "terminal operation results are immutable");
        return operation;
      }
      const updated: Operation = OperationSchema.parse({
        ...operation,
        status,
        updatedAt: new Date().toISOString(),
        ...(details.result === undefined ? {} : { result: details.result }),
        ...(details.error === undefined ? {} : { error: details.error }),
      });
      this.writeOperation(updated);
      return updated;
    });
  }

  /**
   * Request cancellation of a running operation.
   *
   * Cancellation is its own operation with its own queued invocation, so the request is
   * durable and recoverable in the same way the original task was. Repeating it does not
   * create a second cancel, and a terminal operation is left exactly as it finished.
   */
  requestCancellation(
    id: string,
    options: { invocation: (input: { cancelOperationId: string }) => WorkerInvocation },
  ): Operation {
    return inTransaction(this.database, () => {
      const operation = this.requireOperation(id);
      if (TERMINAL_OPERATION_STATUSES.has(operation.status as never)) return operation;
      if (operation.status === "CANCEL_REQUESTED") return operation;
      const cancelOperationId = randomUUID();
      const now = new Date().toISOString();
      const cancelOperation: Operation = OperationSchema.parse({
        id: cancelOperationId,
        workspaceId: operation.workspaceId,
        kind: "cancel",
        requestId: cancelOperationId,
        payloadHash: taskPayloadHash({
          requestId: cancelOperationId,
          conversationId: operation.conversationId ?? cancelOperationId,
          prompt: `cancel ${operation.id}`,
        }),
        status: "ACCEPTED",
        fence: operation.fence,
        createdAt: now,
        updatedAt: now,
      });
      this.writeOperation(cancelOperation);
      this.database
        .prepare(
          `INSERT INTO outbox (id, operation_id, workspace_id, fence, invocation, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          randomUUID(), cancelOperationId, operation.workspaceId, operation.fence,
          JSON.stringify(options.invocation({ cancelOperationId })), now,
        );
      const updated: Operation = OperationSchema.parse({
        ...operation, status: "CANCEL_REQUESTED", updatedAt: now,
      });
      this.writeOperation(updated);
      return updated;
    });
  }

  countOperations(): number {
    return (this.database.prepare("SELECT COUNT(*) AS total FROM operations").get() as { total: number }).total;
  }

  // -- events -----------------------------------------------------------

  appendEvents(operationId: string, events: ReadonlyArray<{ type: string; payload: unknown }>): StoredEvent[] {
    return inTransaction(this.database, () => {
      this.requireOperation(operationId);
      const next = (
        this.database
          .prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM operation_events WHERE operation_id = ?")
          .get(operationId) as { last: number }
      ).last;
      const recordedAt = new Date().toISOString();
      return events.map((event, index) => {
        const sequence = next + index + 1;
        this.database
          .prepare(
            "INSERT INTO operation_events (operation_id, sequence, type, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(operationId, sequence, event.type, JSON.stringify(event.payload ?? null), recordedAt);
        return { sequence, type: event.type, payload: event.payload, recordedAt };
      });
    });
  }

  listEvents(operationId: string, after = 0, limit = 100): StoredEvent[] {
    return (
      this.database
        .prepare(
          `SELECT sequence, type, payload, recorded_at FROM operation_events
           WHERE operation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        )
        .all(operationId, after, limit) as Array<{
        sequence: number; type: string; payload: string; recorded_at: string;
      }>
    ).map((row) => ({
      sequence: row.sequence,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      recordedAt: row.recorded_at,
    }));
  }

  // -- artifacts --------------------------------------------------------

  /**
   * Store one artifact, keyed by operation and name.
   *
   * Re-uploading identical bytes returns the same receipt; different bytes under the
   * same name are a conflict rather than an overwrite, so retained evidence cannot be
   * replaced after the fact.
   */
  putArtifact(input: {
    id?: string;
    operationId: string;
    workspaceId: string;
    name: string;
    mediaType: string;
    content: string;
  }): { artifactId: string; sha256: string; sizeBytes: number } {
    // The content is opaque text: a candidate chunk is base64, a workspace diff is not.
    // It is hashed and stored exactly as sent, because that is what the producer's
    // receipt committed to and what a later rehash has to reproduce.
    const sha256 = digest(input.content);
    const sizeBytes = Buffer.byteLength(input.content);
    return inTransaction(this.database, () => {
      this.requireOperation(input.operationId);
      const existing = this.database
        .prepare("SELECT id, sha256, size_bytes FROM artifacts WHERE operation_id = ? AND name = ?")
        .get(input.operationId, input.name) as
        | { id: string; sha256: string; size_bytes: number }
        | undefined;
      if (existing) {
        if (existing.sha256 !== sha256) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "candidate artifact is immutable");
        }
        return { artifactId: existing.id, sha256: existing.sha256, sizeBytes: existing.size_bytes };
      }
      const id = input.id ?? randomUUID();
      this.database
        .prepare(
          `INSERT INTO artifacts (id, operation_id, workspace_id, name, media_type, sha256, size_bytes, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, input.operationId, input.workspaceId, input.name, input.mediaType, sha256, sizeBytes,
          input.content, new Date().toISOString(),
        );
      return { artifactId: id, sha256, sizeBytes };
    });
  }

  /** Read an artifact, rehashing the stored bytes before handing them back. */
  getArtifact(workspaceId: string, artifactId: string): StoredArtifact | undefined {
    const row = this.database
      .prepare(
        `SELECT id, operation_id, workspace_id, name, media_type, sha256, size_bytes, content
         FROM artifacts WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, artifactId) as
      | {
          id: string; operation_id: string; workspace_id: string; name: string;
          media_type: string; sha256: string; size_bytes: number; content: string;
        }
      | undefined;
    if (!row) return undefined;
    const content = row.content;
    if (digest(content) !== row.sha256) {
      throw agentXError("RUNTIME_UNAVAILABLE", "retained artifact integrity mismatch");
    }
    return {
      id: row.id, operationId: row.operation_id, workspaceId: row.workspace_id, name: row.name,
      mediaType: row.media_type, sha256: row.sha256, sizeBytes: row.size_bytes, content,
    };
  }

  listArtifacts(operationId: string): StoredArtifact[] {
    return (
      this.database
        .prepare("SELECT id, workspace_id, name FROM artifacts WHERE operation_id = ? ORDER BY created_at, name")
        .all(operationId) as Array<{ id: string; workspace_id: string; name: string }>
    ).map((row) => this.getArtifact(row.workspace_id, row.id)!);
  }

  // -- execution ownership and uncertainty -------------------------------

  /**
   * Claim ownership of an execution before anything is launched.
   *
   * Written first so that a launch we then lose sight of still has a durable owner. A
   * repeat for the same operation returns the existing claim rather than starting a
   * second one.
   */
  beginExecution(operationId: string, executionId: string): { executionId: string; duplicate: boolean } {
    return inTransaction(this.database, () => {
      this.requireOperation(operationId);
      const existing = this.database
        .prepare("SELECT execution_id FROM executions WHERE operation_id = ?")
        .get(operationId) as { execution_id: string } | undefined;
      if (existing) return { executionId: existing.execution_id, duplicate: true };
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO executions (operation_id, execution_id, state, created_at, updated_at)
           VALUES (?, ?, 'dispatched', ?, ?)`,
        )
        .run(operationId, executionId, now, now);
      return { executionId, duplicate: false };
    });
  }

  /**
   * Record that an execution's outcome could not be observed.
   *
   * This is a hold, not a verdict. It does not touch the operation: a host that cannot
   * see what a worker did must not convert its own blindness into evidence about the
   * work. What it does do is stop the outbox from handing the same job out again.
   */
  markExecutionUnknown(operationId: string, reason: string): void {
    inTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT execution_id FROM executions WHERE operation_id = ?")
        .get(operationId) as { execution_id: string } | undefined;
      const now = new Date().toISOString();
      if (existing) {
        this.database
          .prepare("UPDATE executions SET state = 'unknown', reason = ?, updated_at = ? WHERE operation_id = ?")
          .run(reason, now, operationId);
        return;
      }
      this.requireOperation(operationId);
      this.database
        .prepare(
          `INSERT INTO executions (operation_id, execution_id, state, reason, created_at, updated_at)
           VALUES (?, ?, 'unknown', ?, ?, ?)`,
        )
        .run(operationId, randomUUID(), reason, now, now);
    });
  }

  markExecutionSettled(operationId: string): void {
    this.database
      .prepare("UPDATE executions SET state = 'settled', updated_at = ? WHERE operation_id = ?")
      .run(new Date().toISOString(), operationId);
  }

  executionState(operationId: string): { executionId: string; state: string; reason?: string } | undefined {
    const row = this.database
      .prepare("SELECT execution_id, state, reason FROM executions WHERE operation_id = ?")
      .get(operationId) as { execution_id: string; state: string; reason: string | null } | undefined;
    return row
      ? { executionId: row.execution_id, state: row.state, ...(row.reason === null ? {} : { reason: row.reason }) }
      : undefined;
  }

  /** True while an operation must not be dispatched again without a decision. */
  executionHold(operationId: string): { held: boolean; reason?: string } {
    const state = this.executionState(operationId);
    if (state?.state === "unknown") {
      return { held: true, reason: state.reason ?? "execution outcome unknown; reconcile before retry" };
    }
    return { held: false };
  }

  /**
   * Release an unknown execution explicitly.
   *
   * `abandon` leaves the operation alone and lets the queued work be offered again;
   * `retain` keeps the hold. Either way the decision is recorded, because "we chose to
   * run it again knowing we could not see the first attempt" is a different fact from
   * "nothing happened".
   */
  reconcileUnknownExecution(operationId: string, resolution: "abandon" | "retain", reason: string): void {
    inTransaction(this.database, () => {
      const state = this.executionState(operationId);
      if (!state || state.state !== "unknown") return;
      this.database
        .prepare("UPDATE executions SET state = ?, reason = ?, updated_at = ? WHERE operation_id = ?")
        .run(resolution === "abandon" ? "reconciled" : "unknown", reason, new Date().toISOString(), operationId);
    });
  }

  // -- admissions --------------------------------------------------------

  /**
   * Claim one admission effect, keyed by a stable identity.
   *
   * Admitting the identical retained result twice is the same effect. Returning
   * `duplicate` lets the caller stop before appending the same events again.
   */
  claimAdmission(effectId: string, operationId: string, terminalStatus: string): { duplicate: boolean } {
    return inTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT effect_id FROM admissions WHERE effect_id = ?")
        .get(effectId);
      if (existing) return { duplicate: true };
      this.database
        .prepare(
          "INSERT INTO admissions (effect_id, operation_id, terminal_status, admitted_at) VALUES (?, ?, ?, ?)",
        )
        .run(effectId, operationId, terminalStatus, new Date().toISOString());
      return { duplicate: false };
    });
  }

  /** Mark every queued invocation for an operation delivered once it has settled. */
  settleOutboxFor(operationId: string): number {
    const changes = this.database
      .prepare("UPDATE outbox SET delivered_at = ? WHERE operation_id = ? AND delivered_at IS NULL")
      .run(new Date().toISOString(), operationId);
    return Number(changes.changes);
  }

  // -- outbox -----------------------------------------------------------

  pendingOutbox(): OutboxRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, operation_id, workspace_id, fence, invocation, attempts, delivered_at
           FROM outbox WHERE delivered_at IS NULL ORDER BY created_at, id`,
        )
        .all() as Array<{
        id: string; operation_id: string; workspace_id: string; fence: number;
        invocation: string; attempts: number; delivered_at: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      operationId: row.operation_id,
      workspaceId: row.workspace_id,
      fence: row.fence,
      invocation: JSON.parse(row.invocation) as WorkerInvocation,
      attempts: row.attempts,
      ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    }));
  }

  recordOutboxAttempt(id: string): void {
    const changes = this.database.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
    if (changes.changes !== 1) throw agentXError("NOT_FOUND", "outbox record not found");
  }

  markOutboxDelivered(id: string): void {
    const changes = this.database
      .prepare("UPDATE outbox SET delivered_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (changes.changes !== 1) throw agentXError("NOT_FOUND", "outbox record not found");
  }

  // -- model route (durable authority, reservations, receipts) -----------

  putRouteToken(token: {
    tokenId: string; operationId: string; caseId: string; attemptNumber: number;
    routeVersion: string; policyDigest: string; dataClass: string;
    modelAllowlist: readonly string[]; maxMicrounits: number; maxCalls: number; notAfter: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO model_route_tokens (token_id, operation_id, case_id, attempt_number, route_version,
           policy_digest, data_class, model_allowlist, max_microunits, max_calls, not_after, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO NOTHING`,
      )
      .run(
        token.tokenId, token.operationId, token.caseId, token.attemptNumber, token.routeVersion,
        token.policyDigest, token.dataClass, JSON.stringify([...token.modelAllowlist]),
        token.maxMicrounits, token.maxCalls, token.notAfter, new Date().toISOString(),
      );
  }

  getRouteToken(tokenId: string): {
    tokenId: string; operationId: string; caseId: string; attemptNumber: number;
    routeVersion: string; policyDigest: string; dataClass: string;
    modelAllowlist: string[]; maxMicrounits: number; maxCalls: number; notAfter: string;
  } | undefined {
    const row = this.database
      .prepare("SELECT * FROM model_route_tokens WHERE token_id = ?")
      .get(tokenId) as Record<string, string | number> | undefined;
    if (!row) return undefined;
    return {
      tokenId: String(row.token_id), operationId: String(row.operation_id), caseId: String(row.case_id),
      attemptNumber: Number(row.attempt_number), routeVersion: String(row.route_version),
      policyDigest: String(row.policy_digest), dataClass: String(row.data_class),
      modelAllowlist: JSON.parse(String(row.model_allowlist)) as string[],
      maxMicrounits: Number(row.max_microunits), maxCalls: Number(row.max_calls),
      notAfter: String(row.not_after),
    };
  }

  putRouteReservation(reservation: {
    reservationId: string; tokenId: string; operationId: string; attemptNumber: number;
    modelId: string; routeVersion: string; priceVersion: string; reservedMicrounits: number;
    observedMicrounits?: number; state: string; reason?: string; requestedAt: string; settledAt?: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO model_route_reservations (reservation_id, token_id, operation_id, attempt_number,
           model_id, route_version, price_version, reserved_microunits, observed_microunits, state,
           reason, requested_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(reservation_id) DO UPDATE SET observed_microunits = excluded.observed_microunits,
           state = excluded.state, reason = excluded.reason, settled_at = excluded.settled_at`,
      )
      .run(
        reservation.reservationId, reservation.tokenId, reservation.operationId, reservation.attemptNumber,
        reservation.modelId, reservation.routeVersion, reservation.priceVersion,
        reservation.reservedMicrounits, reservation.observedMicrounits ?? null, reservation.state,
        reservation.reason ?? null, reservation.requestedAt, reservation.settledAt ?? null,
      );
  }

  listRouteReservations(operationId: string, attemptNumber: number): Array<{
    reservationId: string; operationId: string; attemptNumber: number; modelId: string;
    routeVersion: string; priceVersion: string; reservedMicrounits: number;
    observedMicrounits?: number; state: "reserved" | "observed" | "unknown"; requestedAt: string;
  }> {
    return (
      this.database
        .prepare(
          "SELECT * FROM model_route_reservations WHERE operation_id = ? AND attempt_number = ? ORDER BY requested_at",
        )
        .all(operationId, attemptNumber) as Array<Record<string, string | number | null>>
    ).map((row) => ({
      reservationId: String(row.reservation_id), operationId: String(row.operation_id),
      attemptNumber: Number(row.attempt_number), modelId: String(row.model_id),
      routeVersion: String(row.route_version), priceVersion: String(row.price_version),
      reservedMicrounits: Number(row.reserved_microunits),
      ...(row.observed_microunits === null ? {} : { observedMicrounits: Number(row.observed_microunits) }),
      state: String(row.state) as "reserved" | "observed" | "unknown",
      requestedAt: String(row.requested_at),
    }));
  }

  getRouteReservation(reservationId: string): {
    reservationId: string; tokenId: string; operationId: string; attemptNumber: number;
    modelId: string; routeVersion: string; priceVersion: string; reservedMicrounits: number;
    observedMicrounits?: number; state: "reserved" | "observed" | "unknown"; requestedAt: string;
  } | undefined {
    const row = this.database
      .prepare("SELECT * FROM model_route_reservations WHERE reservation_id = ?")
      .get(reservationId) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return {
      reservationId: String(row.reservation_id), tokenId: String(row.token_id),
      operationId: String(row.operation_id), attemptNumber: Number(row.attempt_number),
      modelId: String(row.model_id), routeVersion: String(row.route_version),
      priceVersion: String(row.price_version), reservedMicrounits: Number(row.reserved_microunits),
      ...(row.observed_microunits === null ? {} : { observedMicrounits: Number(row.observed_microunits) }),
      state: String(row.state) as "reserved" | "observed" | "unknown",
      requestedAt: String(row.requested_at),
    };
  }

  putRouteReceipt(receipt: { receiptId: string; reservationId: string; settledAt: string }): void {
    this.database
      .prepare(
        `INSERT INTO model_route_receipts (receipt_id, reservation_id, document, settled_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(receipt_id) DO NOTHING`,
      )
      .run(receipt.receiptId, receipt.reservationId, JSON.stringify(receipt), receipt.settledAt);
  }

  listRouteReceipts(operationId: string): unknown[] {
    return (
      this.database
        .prepare(
          `SELECT r.document FROM model_route_receipts r
           JOIN model_route_reservations v ON v.reservation_id = r.reservation_id
           WHERE v.operation_id = ? ORDER BY r.settled_at`,
        )
        .all(operationId) as Array<{ document: string }>
    ).map((row) => JSON.parse(row.document) as unknown);
  }

  // -- internals --------------------------------------------------------

  private requireOperation(id: string): Operation {
    const operation = this.get(id);
    if (!operation) throw agentXError("NOT_FOUND", "operation not found");
    return operation;
  }

  private writeOperation(operation: Operation): void {
    this.database
      .prepare(
        `INSERT INTO operations (id, workspace_id, request_id, payload_hash, status, fence, document, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(
        operation.id, operation.workspaceId, operation.requestId, operation.payloadHash,
        operation.status, operation.fence, JSON.stringify(operation), operation.updatedAt,
      );
  }
}
