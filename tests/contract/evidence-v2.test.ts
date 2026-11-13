// TE-A2a: evidence pack v2 (the shape only; nothing writes it yet). v1 stays as it was, a v1 pack and a v2 pack convert both ways without loss, a reader that meets parts it does not know keeps and reports them,
// and every list and string is bounded. Every case fails when the rule it names is removed.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EVIDENCE_CHECKS_MAX, EVIDENCE_V2_MAX_BYTES, EvidencePackSchema, EvidencePackV2ReaderSchema, EvidencePackV2Schema, NEWER_EVIDENCE_WORDS, evidencePackV1ToV2, evidencePackV2ToV1, readEvidencePack, readEvidencePackText,
  unknownKeysOf, type EvidencePackV2, type EvidenceV2Context,
} from "../../packages/contracts/src/index.js";
import { DIGEST, SHA, v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const UPGRADE: EvidenceV2Context = { producer: { edition: "code", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] }, result: "verified" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("v1 is unchanged", () => {
  it("still parses a v1 pack and still refuses a v2 pack and a v1 pack with an unknown field (strict old readers)", () => {
    expect(EvidencePackSchema.safeParse(v1Pack()).success).toBe(true);
    expect(EvidencePackSchema.safeParse(v2Pack()).success).toBe(false);
    expect(EvidencePackSchema.safeParse({ ...v1Pack(), newPart: 1 }).success).toBe(false);
  });
});

describe("the v2 schema", () => {
  it("accepts a complete pack", () => {
    const parsed = EvidencePackV2Schema.safeParse(v2Pack());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

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
    const scripted = clone(v2Pack());
    Object.assign(scripted.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "real" });
    expect(EvidencePackV2Schema.safeParse(scripted).success).toBe(false);
    Object.assign(scripted.checks[0]!, { trust: "simulated" });
    expect(EvidencePackV2Schema.safeParse(scripted).success).toBe(true);
    const undated = clone(v2Pack());
    delete (undated.dependencies![0] as { recordedOn?: string }).recordedOn;
    expect(EvidencePackV2Schema.safeParse(undated).success).toBe(false);
  });

  it("refuses text with hidden characters and a malformed commit", () => {
    const hidden = clone(v2Pack());
    hidden.checks[0]!.label = "pytest‮";
    expect(EvidencePackV2Schema.safeParse(hidden).success).toBe(false);
    const badSha = clone(v2Pack());
    badSha.candidate.repositories[0]!.headCommit = "xyz";
    expect(EvidencePackV2Schema.safeParse(badSha).success).toBe(false);
  });
});

describe("bounds", () => {
  it("allows at most EVIDENCE_CHECKS_MAX checks and refuses one more", () => {
    const make = (count: number) => {
      const pack = clone(v2Pack());
      pack.checks = Array.from({ length: count }, (_, index) => ({ id: `c${index}`, kind: "build", label: "x".repeat(200), before: "passed", after: "passed", class: "passing", durationMs: 1 }));
      return pack;
    };
    expect(EvidencePackV2Schema.safeParse(make(EVIDENCE_CHECKS_MAX)).success).toBe(true);
    expect(EvidencePackV2Schema.safeParse(make(EVIDENCE_CHECKS_MAX + 1)).success).toBe(false);
  });

  it("refuses over-long names and labels, too many repositories, dependencies, measures and not-tested rows", () => {
    const tooLong = clone(v2Pack());
    tooLong.checks[0]!.label = "x".repeat(201);
    expect(EvidencePackV2Schema.safeParse(tooLong).success).toBe(false);
    const manyRepos = clone(v2Pack());
    manyRepos.candidate.repositories = Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, baseBranch: "main", baseCommit: SHA, headCommit: SHA }));
    expect(EvidencePackV2Schema.safeParse(manyRepos).success).toBe(false);
    const manyDeps = clone(v2Pack());
    manyDeps.dependencies = Array.from({ length: 25 }, (_, i) => ({ name: `d${i}`, kind: "http", backing: "none", label: "not_available", trust: "simulated" }));
    expect(EvidencePackV2Schema.safeParse(manyDeps).success).toBe(false);
    const manyMeasures = clone(v2Pack());
    manyMeasures.checks[1]!.measures = Array.from({ length: 51 }, (_, i) => ({ name: `m${i}`, unit: "ms", base: 1, head: 1, direction: "up_good" })) as never;
    expect(EvidencePackV2Schema.safeParse(manyMeasures).success).toBe(false);
    const manyNotTested = clone(v2Pack());
    manyNotTested.notTested = Array.from({ length: 201 }, () => ({ what: "x", reason: "y" }));
    expect(EvidencePackV2Schema.safeParse(manyNotTested).success).toBe(false);
  });

  it("refuses text larger than EVIDENCE_V2_MAX_BYTES before parsing it", () => {
    const huge = JSON.stringify({ schemaVersion: 2, pad: "x".repeat(EVIDENCE_V2_MAX_BYTES) });
    expect(readEvidencePackText(huge)).toEqual({ status: "unreadable", reason: "too_large" });
  });
});

describe("round trip", () => {
  it("v1 to v2 to v1 gives back the same pack", () => {
    const v1 = v1Pack();
    const v2 = evidencePackV1ToV2(v1, UPGRADE);
    expect(EvidencePackV2Schema.safeParse(v2).success, JSON.stringify(EvidencePackV2Schema.safeParse(v2).error?.issues)).toBe(true);
    expect(v2.candidate.digest).toBe(DIGEST);
    expect(v2.checks.map((check) => check.id)).toEqual(["readiness:0", "readiness:1", "readiness:2"]);
    expect(evidencePackV2ToV1(v2)).toEqual(v1);
    expect(EvidencePackSchema.safeParse(evidencePackV2ToV1(v2)).success).toBe(true);
  });

  it("keeps a null exit code and an absent one apart", () => {
    const v1 = v1Pack();
    const back = evidencePackV2ToV1(evidencePackV1ToV2(v1, UPGRADE))!;
    expect(back.checks[1]!.exitCode).toBeNull();
    expect("exitCode" in back.checks[2]!).toBe(false);
  });

  it("v2 to v1 drops what v1 has no place for, and gives nothing when the v1 parts were never carried", () => {
    const full = evidencePackV1ToV2(v1Pack(), UPGRADE);
    const withV2Only = { ...full, level: { reached: "rovara_real_run", required: ["sealed"] }, meters: v2Pack().meters };
    expect(evidencePackV2ToV1(withV2Only as EvidencePackV2)).toEqual(v1Pack());
    expect(evidencePackV2ToV1(v2Pack())).toBeUndefined();
  });
});

describe("the forward-compatible reader", () => {
  it("reads a v1 pack as v1, unchanged", () => {
    const read = readEvidencePack(v1Pack());
    expect(read.status).toBe("v1");
  });

  it("reads a known v2 pack and reports nothing newer", () => {
    const read = readEvidencePack(v2Pack());
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(read.newer).toEqual({ unknownParts: [], unknownKinds: [], unknownValues: false, unreadableChecks: 0 });
  });

  it("keeps unknown parts, kinds and values and reports them as newer evidence, never as a parse failure", () => {
    const input = clone(v2Pack()) as Record<string, unknown> & { checks: Record<string, unknown>[]; level: Record<string, unknown> };
    input.hologram = { depth: 3 };
    input.checks[0]!.fancyPart = { n: 1 };
    input.checks.push({ id: "future", kind: "hologram", label: "projector", stage: "teleport", before: "passed", after: "passed", class: "passing", durationMs: 5, extra: true });
    input.level.reached = "quantum";
    const read = readEvidencePack(input);
    expect(read.status).toBe("v2");
    if (read.status !== "v2") return;
    expect(read.newer.unknownParts.sort()).toEqual(["checks[0].fancyPart", "checks[2].extra", "hologram"]);
    expect(read.newer.unknownKinds).toEqual(["hologram"]);
    expect(read.newer.unknownValues).toBe(true);
    expect(read.pack.level.reached).toBe("unknown");
    expect((read.pack as unknown as Record<string, unknown>).hologram).toEqual({ depth: 3 });
    expect(read.pack.checks).toHaveLength(3);
    expect(NEWER_EVIDENCE_WORDS).toBe("Newer evidence, open in Rovara");
  });

  it("keeps an unknown field inside a known part, and a check that cannot be read is counted and left out, not fatal", () => {
    const input = clone(v2Pack()) as { checks: Record<string, unknown>[] };
    (input.checks[0]!.tests as Record<string, unknown>).flakyCount = 2;
    input.checks.push({ id: 7 });
    const read = readEvidencePack(input);
    expect(read.status).toBe("v2");
    if (read.status !== "v2") return;
    expect(read.newer.unreadableChecks).toBe(1);
    expect(read.pack.checks).toHaveLength(2);
    expect((read.pack.checks[0]!.tests as unknown as Record<string, unknown>).flakyCount).toBe(2);
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

  it("an old (v1) reader refuses a v2 pack, which is why the broker keeps writing v1 until the Cloud half lands", () => {
    expect(EvidencePackSchema.safeParse(clone(v2Pack())).success).toBe(false);
    expect(EvidencePackV2ReaderSchema.safeParse(clone(v2Pack())).success).toBe(true);
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
