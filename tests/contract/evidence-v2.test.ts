// TE-A2a: evidence pack v2 (the shape only; nothing writes it yet). v1 stays as it was, a v1 pack and a v2 pack convert both ways without loss, a reader that meets parts it does not know keeps and reports them,
// and every list and string is bounded. Every case fails when the rule it names is removed.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHECK_KINDS, EVIDENCE_CHECKS_MAX, EVIDENCE_V2_MAX_BYTES, EvidencePackSchema, EvidencePackV2Schema, NEWER_EVIDENCE_WORDS, NEWER_VALUE, evidencePackV1ToV2, evidencePackV2ToV1, readEvidencePack, readEvidencePackText, renderEvidence, unknownKeysOf, type EvidencePackV2, type EvidenceV2Context } from "../../packages/contracts/src/index.js";
import { DIGEST, v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const UPGRADE: EvidenceV2Context = { producer: { edition: "code", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] }, result: "verified" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const readV2 = (input: unknown) => {
  const read = readEvidencePack(input);
  if (read.status !== "v2") throw new Error(`expected v2, got ${read.status}`);
  return read;
};

describe("the v2 schema", () => {

  it("refuses unknown fields, an unregistered kind and a part the kind does not carry", () => {
    expect(EvidencePackV2Schema.safeParse(v2Pack({ extra: 1 })).success).toBe(false);
    const base = v2Pack();
    const unknownKind = clone(base);
    unknownKind.checks[0]!.kind = "hologram";
    expect(EvidencePackV2Schema.safeParse(unknownKind).success).toBe(false);
    const wrongPart = clone(base);
    wrongPart.checks[1]!.kind = "lint";
    expect(EvidencePackV2Schema.safeParse(wrongPart).success).toBe(false);
  });

  it("refuses duplicate check ids and duplicate dependency names", () => {
    const duplicateCheck = clone(v2Pack());
    duplicateCheck.checks[1]!.id = duplicateCheck.checks[0]!.id;
    expect(EvidencePackV2Schema.safeParse(duplicateCheck).success).toBe(false);
    const duplicateDependency = clone(v2Pack());
    duplicateDependency.dependencies![1]!.name = duplicateDependency.dependencies![0]!.name;
    expect(EvidencePackV2Schema.safeParse(duplicateDependency).success).toBe(false);
  });

  it("never lets a scripted-AI proof sit on a 'real' trust class, and a recorded dependency says when it was recorded", () => {
    const scripted = clone(v2Pack({ level: { reached: "sandbox_only", required: [] }, producer: { edition: "cloud", isolation: "sandbox" } }));
    Object.assign(scripted.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "real" });
    expect(EvidencePackV2Schema.safeParse(scripted).success).toBe(false);
    Object.assign(scripted.checks[0]!, { trust: "simulated" });
    expect(EvidencePackV2Schema.safeParse(scripted).success).toBe(true);
    const undated = clone(v2Pack());
    delete (undated.dependencies![0] as { recordedOn?: string }).recordedOn;
    expect(EvidencePackV2Schema.safeParse(undated).success).toBe(false);
  });

  it("allows a 'real run' in the agent's sandbox (O44: the final round runs unsealed, only the words change), and refuses one on a laptop or imported (M4)", () => {
    expect(EvidencePackV2Schema.safeParse(v2Pack({ producer: { edition: "cloud", isolation: "sealed" } })).success).toBe(true);
    const unsealed = v2Pack({ producer: { edition: "cloud", isolation: "sandbox" } });
    expect(EvidencePackV2Schema.safeParse(unsealed).success).toBe(true);
    expect(renderEvidence(unsealed).firstLine).toBe("Verified · Run by Rovara, not sealed");
    for (const isolation of ["developer_machine", "imported"]) {
      expect(EvidencePackV2Schema.safeParse(v2Pack({ producer: { edition: "cloud", isolation } })).success, isolation).toBe(false);
    }
    expect(EvidencePackV2Schema.safeParse(v2Pack({ producer: { edition: "cloud", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] } })).success).toBe(true);
  });

  it("refuses a 'real run' whose proof rests on scripted AI replies, in any isolation (M4)", () => {
    for (const isolation of ["sealed", "sandbox"]) {
      const scripted = clone(v2Pack({ producer: { edition: "cloud", isolation } }));
      Object.assign(scripted.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "simulated" });
      expect(EvidencePackV2Schema.safeParse(scripted).success, isolation).toBe(false);
      scripted.level.reached = "sandbox_only";
      expect(EvidencePackV2Schema.safeParse(scripted).success, `${isolation} sandbox_only`).toBe(true);
    }
  });

});

describe("bounds", () => {

  it("refuses text larger than EVIDENCE_V2_MAX_BYTES before parsing it, and checks the length before encoding it", () => {
    const huge = JSON.stringify({ schemaVersion: 2, pad: "x".repeat(EVIDENCE_V2_MAX_BYTES) });
    expect(readEvidencePackText(huge)).toEqual({ status: "unreadable", reason: "too_large" });
    // Few characters, but over the limit as UTF-8 (three bytes each): refused by the byte count, not the character count.
    const wide = JSON.stringify({ schemaVersion: 2, pad: "€".repeat(Math.floor(EVIDENCE_V2_MAX_BYTES / 3) + 10) });
    expect(wide.length).toBeLessThan(EVIDENCE_V2_MAX_BYTES);
    expect(readEvidencePackText(wide)).toEqual({ status: "unreadable", reason: "too_large" });
  });

  it("refuses an already-parsed value that is larger or deeper than the reader reads, whatever its version (L8)", () => {
    const big = { ...clone(v2Pack()), pad: "x".repeat(EVIDENCE_V2_MAX_BYTES + 1) };
    expect(readEvidencePack(big)).toEqual({ status: "unreadable", reason: "too_large" });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 100; level += 1) deep = { next: deep };
    expect(readEvidencePack({ ...clone(v2Pack()), deep })).toEqual({ status: "unreadable", reason: "too_large" });
    expect(readEvidencePack({ schemaVersion: 3, pad: "x".repeat(EVIDENCE_V2_MAX_BYTES + 1) })).toEqual({ status: "unreadable", reason: "too_large" });
  });

  it("reads at most 64 checks: the rest are counted as unreadable, never parsed (the reader's own cap)", () => {
    const pack = clone(v2Pack());
    pack.checks = Array.from({ length: 70 }, (_, index) => ({ id: `c${String(index)}`, kind: "build", label: "b", before: "passed", after: "passed", class: "passing", durationMs: 1 }));
    const read = readV2(pack);
    expect(read.pack.checks).toHaveLength(EVIDENCE_CHECKS_MAX);
    expect(read.newer.unreadableChecks).toBe(70 - EVIDENCE_CHECKS_MAX);
  });
});

describe("round trip", () => {

  // H2: the v1 builder attaches tests, coverage and findings by what a check's report held, whatever its kind, so an upgraded v1 pack always passes the writer schema.
  it.each([ ["typecheck", "migrations"],
  ] as const)("upgrades a v1 %s check that carries %s", (kind, part) => {
    const v1 = clone(v1Pack());
    const source = clone(v1Pack()).checks;
    const donor = { tests: source[0]!.tests, coverage: source[0]!.coverage, findings: source[2]!.findings, migrations: { applied: ["001"], rolledBack: false, schemaChanges: [] } } as const;
    const target = v1.checks[1]!;
    target.kind = kind;
    Object.assign(target, { [part]: donor[part] });
    expect(EvidencePackSchema.safeParse(v1).success, "valid v1").toBe(true);
    const v2 = evidencePackV1ToV2(v1, UPGRADE);
    const parsed = EvidencePackV2Schema.safeParse(v2);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(evidencePackV2ToV1(v2)).toEqual(v1);
  });

  it("gives the v1 kind for every v1 kind, and 'other' for a kind v1 does not have", () => {
    const v1 = v1Pack();
    const upgraded = clone(v2Pack({ environment: v1.environment, selection: v1.selection, api: v1.api, browser: v1.browser }));
    const back = evidencePackV2ToV1(upgraded)!;
    expect(back.checks.map((check) => check.kind)).toEqual(["test", "other"]);
    expect(EvidencePackSchema.safeParse(back).success).toBe(true);
    for (const kind of CHECK_KINDS) {
      const pack = clone(upgraded);
      pack.checks[0]!.kind = kind;
      expect(evidencePackV2ToV1(pack)!.checks[0]!.kind).toBe(kind);
    }
  });

  it("v2 to v1 drops what v1 has no place for, and gives nothing when the v1 parts were never carried", () => {
    const full = evidencePackV1ToV2(v1Pack(), UPGRADE);
    const withV2Only = { ...full, level: { reached: "rovara_real_run", required: ["sealed"] }, producer: { edition: "cloud", isolation: "sealed" }, meters: v2Pack().meters };
    expect(evidencePackV2ToV1(withV2Only as EvidencePackV2)).toEqual(v1Pack());
    expect(evidencePackV2ToV1(v2Pack())).toBeUndefined();
  });
});

describe("the forward-compatible reader", () => {

  it("keeps the cross-checks: covered lines above changed lines, and more than 2,000 test names in all, leave a check out and count it", () => {
    const inconsistent = clone(v2Pack()) as { checks: Record<string, unknown>[] };
    (inconsistent.checks[0]!.coverage as Record<string, unknown>).linesCovered = 11;
    const one = readV2(inconsistent);
    expect(one.newer.unreadableChecks).toBe(1);
    expect(one.pack.checks).toHaveLength(1);

    const many = clone(v2Pack());
    many.checks = Array.from({ length: 5 }, (_, index) => ({
      id: `t${String(index)}`, kind: "test", label: "t", before: "passed", after: "passed", class: "passing", durationMs: 1,
      tests: { total: 500, passed: 500, failed: 0, skipped: 0, errored: 0, names: Array.from({ length: 500 }, (_unused, n) => ({ name: `f${String(index)}::n${String(n)}`, status: "passed" })), newTests: [] },
    }));
    const capped = readV2(many);
    expect(capped.pack.checks).toHaveLength(4);
    expect(capped.newer.unreadableChecks).toBe(1);
  });

  // M1: "unknown" is a real check outcome, so an enum value the build does not know must read as something else, and be reported.
  it("reports an unknown check outcome and does not report the real outcome 'unknown'", () => {
    const flaky = clone(v2Pack());
    flaky.checks[0]!.after = "flaky" as never;
    const read = readV2(flaky);
    expect(read.newer.unknownValues).toBe(true);
    expect(read.pack.checks[0]!.after).toBe(NEWER_VALUE);
    expect(renderEvidence(read.pack, { newer: read.newer }).text).toContain(NEWER_EVIDENCE_WORDS);

    const real = clone(v2Pack());
    real.checks[0]!.after = "unknown";
    const known = readV2(real);
    expect(known.newer.unknownValues).toBe(false);
    expect(known.pack.checks[0]!.after).toBe("unknown");
  });

  it("reads a pack of a later version as 'newer' without parsing it", () => {
    expect(readEvidencePack({ schemaVersion: 3, candidate: { digest: DIGEST }, anything: [1] })).toEqual({ status: "newer", schemaVersion: 3, candidateDigest: DIGEST });
    expect(readEvidencePack({ schemaVersion: 3 })).toEqual({ status: "newer", schemaVersion: 3 });
  });

  it("keeps the core strict: a v2 pack with a bad digest, no producer or a non-list of checks is unreadable", () => {
    for (const bad of [{ candidate: { digest: "nope", repositories: [] } }, { producer: undefined }, { checks: "none" }, { schemaVersion: 2.5 }]) {
      expect(readEvidencePack({ ...v2Pack(), ...bad }).status, JSON.stringify(bad)).toBe("unreadable");
    }
    for (const junk of [null, 7, "x", [], {}, { schemaVersion: "2" }]) expect(readEvidencePack(junk).status).toBe("unreadable");
    expect(readEvidencePackText("{not json").status).toBe("unreadable");
  });

  // L1: what the report says came from the pack, so it is bounded and inert.
  it("bounds and makes inert the paths and kinds it reports", () => {
    const input = clone(v2Pack()) as Record<string, unknown> & { checks: Record<string, unknown>[] };
    input[`@octocat ${"k".repeat(100_000)}`] = 1;
    input.checks.push({ id: "future", kind: `@everyone ${"h".repeat(50)}`, label: "x", before: "passed", after: "passed", class: "passing", durationMs: 1 });
    const read = readV2(input);
    for (const entry of read.newer.unknownParts) {
      expect(entry.length).toBeLessThanOrEqual(120);
      expect(entry).toMatch(/^[\w$.[\]-]+$/u);
    }
    expect(read.newer.unknownParts[0]).toMatch(/^_octocat_k+\.\.\.$/u);
    expect(read.newer.unknownKinds).toHaveLength(1);
    expect(read.newer.unknownKinds[0]!.length).toBeLessThanOrEqual(40);
    expect(read.newer.unknownKinds[0]).not.toContain("@everyone");
  });

  it("lists unknown keys only", () => {
    expect(unknownKeysOf({ a: 1, b: 2, c: 3 }, ["a", "b"])).toEqual(["c"]);
    expect(unknownKeysOf("x", ["a"])).toEqual([]);
    expect(unknownKeysOf(null, ["a"])).toEqual([]);
  });

});

describe("the JSON Schema under docs/", () => {
  const file = new URL("../../docs/schemas/evidence-pack-v2.schema.json", import.meta.url);
  const generated = `${JSON.stringify(z.toJSONSchema(EvidencePackV2Schema, { target: "draft-2020-12", io: "output", unrepresentable: "any", reused: "inline" }), null, 2)}\n`;

  it("is the schema as it stands (UPDATE_EVIDENCE_SCHEMA=1 rewrites it)", () => {
    if (process.env.UPDATE_EVIDENCE_SCHEMA === "1") writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
  });

  it("names the schema version and the strict top level", () => {
    const schema = JSON.parse(readFileSync(file, "utf8")) as { properties: { schemaVersion: { const: number } }; additionalProperties: boolean; required: string[] };
    expect(schema.properties.schemaVersion.const).toBe(2);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(["schemaVersion", "candidate", "producer", "level", "result", "checks", "notTested"]));
  });
});
