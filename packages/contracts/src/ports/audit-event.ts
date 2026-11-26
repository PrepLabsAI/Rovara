// Port lane P6 (item L2): what every part of Code's audit trail agrees on: how an event is checked, the digest that says two records are the same facts, and the key and shape of an event's `AUDIT#` row.
// Pure rules over the `audit-sink` port's event, so the document sink (`@agentx/broker/plugins/audit-sink-document`) and the laptop's append-only copy (`@agentx/local-adapters`) share one definition (issue #1538).
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import type { AuditEvent } from "./audit-sink.js";
import { companyScoped } from "./company-scope.js";
import type { JsonObject } from "./json.js";
import type { StoredDocument } from "./document-store.js";

/** Text a store keeps as given: no unpaired surrogate (SQLite turns one into U+FFFD) and no NUL character (it cuts the text short when read back). */
export function storableText(value: string): boolean {
  return !UNPAIRED_SURROGATE.test(value) && !value.includes("\u0000");
}
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const ACTION = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
/** The most bytes of an event's details. A record is facts for a reader, not a document store. */
export const AUDIT_DETAILS_MAX_BYTES = 16 * 1_024;

/** The trail could not take the event (a bad event, a write that failed, or an event id reused for other facts). The change it was to record must not be made. */
export class AuditLogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuditLogError";
  }
}

/** Throws `AuditLogError` for an event the trail will not hold. */
export function checkAuditEvent(event: AuditEvent): void {
  const text = (value: unknown, label: string, max: number): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > max || !storableText(value)) throw new AuditLogError(`the audit event's ${label} is not usable`);
  };
  text(event.eventId, "eventId", 256);
  text(event.companyId, "companyId", 128);
  text(event.at, "time", 64);
  if (Number.isNaN(Date.parse(event.at))) throw new AuditLogError("the audit event's time is not a time");
  text(event.actor?.id, "actor", 256);
  if (event.actor.type !== "person" && event.actor.type !== "agent" && event.actor.type !== "system") throw new AuditLogError("the audit event's actor type is not known");
  text(event.action, "action", 128);
  if (!ACTION.test(event.action)) throw new AuditLogError("the audit event's action is dotted lower-case words");
  if (event.details !== undefined && Buffer.byteLength(JSON.stringify(event.details)) > AUDIT_DETAILS_MAX_BYTES) throw new AuditLogError(`the audit event's details are over ${String(AUDIT_DETAILS_MAX_BYTES)} bytes`);
}

/** The event exactly as it is stored and hashed: fixed key order, no undefined members. */
export function storedAuditEvent(event: AuditEvent): AuditEvent {
  return {
    eventId: event.eventId,
    companyId: event.companyId,
    at: event.at,
    actor: { type: event.actor.type, id: event.actor.id },
    action: event.action,
    ...(event.subject === undefined ? {} : { subject: event.subject }),
    ...(event.details === undefined ? {} : { details: event.details }),
  };
}

/**
 * The digest of an event's FACTS: who did what to what, with which details. The time is left out, so a retry of the same fact at a later moment is the same record, while the same event id used for
 * other facts is not.
 */
export function auditDigest(event: AuditEvent): string {
  return createHash("sha256").update(canonicalJson({ companyId: event.companyId, actor: { type: event.actor.type, id: event.actor.id }, action: event.action, subject: event.subject ?? null, details: event.details ?? null })).digest("hex");
}

export const AUDIT_ENTITY_TYPE = "AUDIT";

/** The key of an event's row. */
export function auditRowKey(companyId: string, eventId: string): { pk: string; sk: string } {
  try {
    return { pk: companyScoped(companyId, "AUDIT"), sk: `EVENT#${eventId}` };
  } catch (error) {
    throw new AuditLogError("the audit event's company is not usable", { cause: error });
  }
}

/** An event's `AUDIT#` row: the stored event, its key and the digest of its facts. */
export function auditRow(event: AuditEvent): StoredDocument {
  checkAuditEvent(event);
  const stored = storedAuditEvent(event);
  return {
    ...auditRowKey(stored.companyId, stored.eventId),
    entityType: AUDIT_ENTITY_TYPE,
    eventId: stored.eventId,
    companyId: stored.companyId,
    at: stored.at,
    actor: { ...stored.actor },
    action: stored.action,
    ...(stored.subject === undefined ? {} : { subject: { ...stored.subject } }),
    ...(stored.details === undefined ? {} : { details: stored.details }),
    digest: auditDigest(stored),
  };
}

/** The event a row holds, or undefined for a document that is not an audit row. */
export function auditEventOfRow(row: StoredDocument | undefined): AuditEvent | undefined {
  if (row === undefined || row.entityType !== AUDIT_ENTITY_TYPE) return undefined;
  const { eventId, companyId, at, action } = row;
  if (typeof eventId !== "string" || typeof companyId !== "string" || typeof at !== "string" || typeof action !== "string") return undefined;
  const actor = row.actor as { type: AuditEvent["actor"]["type"]; id: string };
  return storedAuditEvent({
    eventId, companyId, at, actor, action,
    ...(row.subject === undefined ? {} : { subject: row.subject as unknown as NonNullable<AuditEvent["subject"]> }),
    ...(row.details === undefined ? {} : { details: row.details as JsonObject }),
  });
}
