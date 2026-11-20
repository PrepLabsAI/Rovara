// Public-safe AUD-0 format. Independently implemented here; the private hosted
// capture/relay/ledger code is not part of this module. v1 refuses every
// ReplayRole delivery; recovery is only an original relay resending retained
// pending bytes. Successful-replay origin proof is deferred to the controller.
// Hash domains and field names remain compatible with the offline verifier.
import { createHash } from "node:crypto";
import { z } from "zod";

/** No undefined, surrogate replacement, sparse arrays or lossy numbers in evidence. */
export function auditCanonicalV1(value: unknown): string {
  const active = new Set<object>();
  const write = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "boolean") return String(item);
    if (typeof item === "number" && Number.isSafeInteger(item)) return String(item);
    if (typeof item === "string") {
      if (!(item as string & { isWellFormed(): boolean }).isWellFormed()) throw new TypeError("audit: invalid Unicode");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new TypeError("audit: invalid JSON");
    if (active.has(item)) throw new TypeError("audit: cyclic JSON");
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) values.push(write(item[i]));
      if (Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length) throw new TypeError("audit: array properties");
      result = `[${values.join(",")}]`;
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(item).length) throw new TypeError("audit: invalid object");
      const entries = Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      result = `{${entries.map(([key, member]) => `${write(key)}:${write(member)}`).join(",")}}`;
    }
    active.delete(item);
    return result;
  };
  return write(value);
}

const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const AuditHexV1Schema = z.string().regex(/^[0-9a-f]{64}$/u);
// These are deployment/company identifiers, never display names, URLs or IAM patterns.
export const AuditIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const AuditTimeV1Schema = z.string().refine((value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}, "audit: expected canonical UTC milliseconds");
export const AuditSourceV1Schema = z.strictObject({
  installId: AuditIdV1Schema, companyId: AuditIdV1Schema,
  sourceKind: z.enum(["code", "cloud"]),
  /** A salted commitment to the original ID; the raw ID never enters locked bytes. */
  eventId: AuditHexV1Schema,
});
export type AuditSourceV1 = z.infer<typeof AuditSourceV1Schema>;

/** The tuple is unambiguous, reversible and safe inside IAM/key delimiters. */
export function encodeAuditEventIdV1(value: AuditSourceV1): string {
  const source = AuditSourceV1Schema.parse(value);
  return `aev1.${source.installId}.${source.sourceKind}.${source.companyId}.${source.eventId}`;
}
export function decodeAuditEventIdV1(value: string): AuditSourceV1 {
  const [v, installId, sourceKind, companyId, eventId, extra] = value.split(".");
  if (v !== "aev1" || extra !== undefined) throw new TypeError("audit: invalid event identity");
  return AuditSourceV1Schema.parse({ installId, sourceKind, companyId, eventId });
}

/** Existing v1 record hash domain, over ALL own fields except hash. */
export function auditRecordDigestV1(record: object): string {
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "hash"));
  return sha("rovara-audit-record-v1\n" + auditCanonicalV1(fields));
}
export function auditGenesisHashV1(companyId: string): string {
  return sha("rovara-audit-genesis-v1\n" + AuditIdV1Schema.parse(companyId));
}

/** Existing commitment domain: salt || canonical({subject, fields}).
 * Supply a stable random per-event salt kept with the erasable source, never in
 * evidence/pending/receipts. Capture it once; a retry must reuse it. This function
 * does not generate, store or authenticate that salt.
 */
export function auditDetailCommitmentV1(salt: Uint8Array, subject: string, fields: object): string {
  if (!(salt instanceof Uint8Array) || salt.length < 16) throw new TypeError("audit: salt too short");
  return createHash("sha256").update(salt).update(auditCanonicalV1({ subject, fields })).digest("hex");
}

// Commitment-only subset of the existing AuditRecordV1 wire format. The existing
// offline verifier also reads historical records; this parser is for new capture.
export const AuditRecordContentV1Schema = z.strictObject({
  v: z.literal(1), orgId: AuditIdV1Schema,
  eventId: z.string().max(220).refine((id) => { try { decodeAuditEventIdV1(id); return true; } catch { return false; } }),
  action: z.string().max(128).regex(/^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/u),
  actor: z.strictObject({ kind: z.enum(["person", "agent", "system"]), id: AuditHexV1Schema }),
  target: z.union([
    z.strictObject({ kind: z.literal("none"), id: z.literal("none") }),
    z.strictObject({ kind: z.literal("commitment"), id: AuditHexV1Schema }),
  ]),
  occurredAt: AuditTimeV1Schema,
  related: z.array(AuditHexV1Schema).max(0),
  facts: z.strictObject({ sourceKind: z.enum(["code", "cloud"]), sourceInstall: AuditIdV1Schema }),
  details: z.tuple([z.strictObject({ subject: z.literal("source"), commit: AuditHexV1Schema })]),
}).superRefine((record, ctx) => {
  let source: AuditSourceV1;
  try { source = decodeAuditEventIdV1(record.eventId); } catch {
    ctx.addIssue({ code: "custom", message: "audit: invalid source identity" });
    return;
  }
  if (source.companyId !== record.orgId || source.sourceKind !== record.facts.sourceKind || source.installId !== record.facts.sourceInstall) {
    ctx.addIssue({ code: "custom", message: "audit: source mismatch" });
  }
});
export type AuditRecordContentV1 = z.infer<typeof AuditRecordContentV1Schema>;
export const AuditRecordBodyV1Schema = AuditRecordContentV1Schema.safeExtend({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), recordedAt: AuditTimeV1Schema, prevHash: AuditHexV1Schema,
});
export const AuditRecordV1Schema = AuditRecordBodyV1Schema.safeExtend({ hash: AuditHexV1Schema }).superRefine((record, ctx) => {
  if (auditRecordDigestV1(record) !== record.hash) ctx.addIssue({ code: "custom", message: "audit: record digest mismatch" });
});
export type AuditRecordV1 = z.infer<typeof AuditRecordV1Schema>;
