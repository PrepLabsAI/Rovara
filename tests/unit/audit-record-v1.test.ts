import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AuditRecordV1Schema, AuditSourceV1Schema, auditCanonicalV1, auditDetailCommitmentV1,
  auditGenesisHashV1, auditRecordDigestV1, decodeAuditEventIdV1, encodeAuditEventIdV1,
} from "../../packages/contracts/src/audit-record-v1.js";

const hex = "a".repeat(64);
const source = { installId: "install_1", companyId: "org_1", sourceKind: "code" as const, eventId: hex };
const time = "2026-11-19T00:00:00.000Z";
const body = {
  v: 1 as const, orgId: "org_1", seq: 1, eventId: `aev1.install_1.code.org_1.${hex}`,
  action: "task.approved", actor: { kind: "person", id: hex }, target: { kind: "none", id: "none" },
  occurredAt: time, recordedAt: time, related: [], facts: { sourceKind: "code", sourceInstall: "install_1" },
  details: [{ subject: "source", commit: hex }], prevHash: hex,
};

describe("public-safe audit v1", () => {
  it("pins the immutable source tuple encoding and round trips it without aliases", () => {
    expect(encodeAuditEventIdV1(source)).toBe(`aev1.install_1.code.org_1.${hex}`);
    expect(decodeAuditEventIdV1(encodeAuditEventIdV1(source))).toEqual(source);
    for (const key of ["installId", "companyId"] as const) {
      for (const value of ["x#y", "*", "x.y", "", "x/y", "x\ud800"]) {
        expect(() => encodeAuditEventIdV1({ ...source, [key]: value })).toThrow();
      }
    }
    expect(AuditSourceV1Schema.safeParse({ ...source, sourceKind: "replay" }).success).toBe(false);
    expect(() => decodeAuditEventIdV1(`${encodeAuditEventIdV1(source)}.extra`)).toThrow();
    expect(encodeAuditEventIdV1({ ...source, sourceKind: "cloud" })).not.toBe(encodeAuditEventIdV1(source));
  });

  it("matches independently calculated golden digests", () => {
    const golden = JSON.parse(readFileSync(new URL("../fixtures/audit-v1-golden.json", import.meta.url), "utf8")) as { record: string; genesis: string; commitment: string };
    expect(auditRecordDigestV1(body)).toBe(golden.record);
    expect(auditGenesisHashV1("org_1")).toBe(golden.genesis);
    expect(auditDetailCommitmentV1(new Uint8Array(32).fill(7), "source", { email: "erase@example.test" })).toBe(golden.commitment);
    expect(auditDetailCommitmentV1(new Uint8Array(32).fill(8), "source", { email: "erase@example.test" })).not.toBe(golden.commitment);
    expect(() => auditDetailCommitmentV1(new Uint8Array(15), "source", {})).toThrow();
  });

  it("binds every record field, nested values and array order, ignoring only hash", () => {
    const digest = auditRecordDigestV1(body);
    expect(auditRecordDigestV1({ ...body, hash: "b".repeat(64) })).toBe(digest);
    for (const key of Object.keys(body)) {
      const dropped = Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
      expect(auditRecordDigestV1(dropped), key).not.toBe(digest);
    }
    expect(auditRecordDigestV1({ ...body, actor: { ...body.actor, id: "b".repeat(64) } })).not.toBe(digest);
    expect(auditRecordDigestV1({ ...body, related: ["a", "b"] })).not.toBe(auditRecordDigestV1({ ...body, related: ["b", "a"] }));
    expect(auditRecordDigestV1({ ...body, extra: 1 })).not.toBe(digest);
  });

  it("refuses lossy canonical inputs rather than silently dropping fields", () => {
    for (const value of [undefined, NaN, 0.5, new Date(), { x: undefined }, [undefined], Array(1), "\ud800", { [Symbol("s")]: 1 }]) {
      expect(() => auditCanonicalV1(value)).toThrow();
    }
    expect(auditCanonicalV1(JSON.parse('{"__proto__":1,"a":0}') as unknown)).toBe('{"__proto__":1,"a":0}');
    expect(auditCanonicalV1({ b: [1, "é"], a: -0 })).toBe('{"a":0,"b":[1,"é"]}');
  });

  it("parses exact commitment-only records, checking hashes and source binding", () => {
    const record = { ...body, hash: auditRecordDigestV1(body) };
    expect(AuditRecordV1Schema.parse(record)).toEqual(record);
    for (const changed of [
      { ...record, proof: { kind: "none" } }, { ...record, email: "personal" },
      { ...record, actor: { kind: "person", id: "ann@example.test" } },
      { ...record, facts: { ...record.facts, name: "Ann" } }, { ...record, seq: 0 },
      { ...record, recordedAt: "2026-02-31T00:00:00.000Z" }, { ...record, hash: "b".repeat(64) },
      { ...record, orgId: "other" },
    ]) expect(AuditRecordV1Schema.safeParse(changed).success).toBe(false);
  });

  it("pins the mirrored source bytes and golden fixture", () => {
    const root = new URL("../../", import.meta.url);
    const pins = JSON.parse(readFileSync(new URL("contracts/shared/audit-v1.sha256.json", root), "utf8")) as Record<string, string>;
    for (const [path, digest] of Object.entries(pins)) {
      expect(createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex"), path).toBe(digest);
    }
  });
});
