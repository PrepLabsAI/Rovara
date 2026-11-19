// Port lane P6 (item L2): what both parts of Code's local audit trail agree on: how an event is checked, and the digest that says two records are the same facts.
import { createHash } from "node:crypto";
import { canonicalJson, type AuditEvent } from "@agentx/contracts";
import { storableText } from "./sqlite-database.js";

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
