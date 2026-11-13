// TE-A2a: evidence pack v2 (the shape only; nothing writes it yet). v1 stays as it was, a v1 pack and a v2 pack convert both ways without loss, a reader that meets parts it does not know keeps and reports them,
// and every list and string is bounded. Every case fails when the rule it names is removed.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHECK_KINDS, EVIDENCE_CHECKS_MAX, EVIDENCE_V2_MAX_BYTES, EvidencePackSchema, EvidencePackV2Schema, NEWER_EVIDENCE_WORDS, NEWER_VALUE, evidencePackV1ToV2, evidencePackV2ToV1, readEvidencePack, readEvidencePackText,
  renderEvidence, renderEvidenceRead, unknownKeysOf, type EvidencePackV2, type EvidenceV2Context,
} from "../../packages/contracts/src/index.js";
import { DIGEST, SHA, v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const UPGRADE: EvidenceV2Context = { producer: { edition: "code", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] }, result: "verified" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ARTIFACT = { kind: "jpeg", sha256: "d".repeat(64), bytes: 10, retentionClass: "evidence-std" };
const readV2 = (input: unknown) => {
  const read = readEvidencePack(input);
  if (read.status !== "v2") throw new Error(`expected v2, got ${read.status}`);
  return read;
};

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

  it("names who ran a check as runBy", () => {
    const pack = clone(v2Pack());
    expect(pack.checks[0]!.runBy).toBe("rovara");
    expect(EvidencePackV2Schema.safeParse({ ...pack, checks: [{ ...pack.checks[0]!, producer: "rovara" }] }).success).toBe(false);
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
      pack.checks = Array.from({ length: count }, (_, index) => ({ id: `c${String(index)}`, kind: "build", label: "x".repeat(200), before: "passed", after: "passed", class: "passing", durationMs: 1 }));
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
    manyRepos.candidate.repositories = Array.from({ length: 17 }, (_, i) => ({ id: `r${String(i)}`, baseBranch: "main", baseCommit: SHA, headCommit: SHA }));
    expect(EvidencePackV2Schema.safeParse(manyRepos).success).toBe(false);
    const manyDeps = clone(v2Pack());
    manyDeps.dependencies = Array.from({ length: 25 }, (_, i) => ({ name: `d${String(i)}`, kind: "http", backing: "none", label: "not_available", trust: "simulated" }));
    expect(EvidencePackV2Schema.safeParse(manyDeps).success).toBe(false);
    const manyMeasures = clone(v2Pack());
    manyMeasures.checks[1]!.measures = Array.from({ length: 51 }, (_, i) => ({ name: `m${String(i)}`, unit: "ms", base: 1, head: 1, direction: "up_good" })) as never;
    expect(EvidencePackV2Schema.safeParse(manyMeasures).success).toBe(false);
    const manyNotTested = clone(v2Pack());
    manyNotTested.notTested = Array.from({ length: 201 }, () => ({ what: "x", reason: "y" }));
    expect(EvidencePackV2Schema.safeParse(manyNotTested).success).toBe(false);
  });

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

  // H2: the v1 builder attaches tests, coverage and findings by what a check's report held, whatever its kind, so an upgraded v1 pack always passes the writer schema.
  it.each([
    ["lint", "tests"], ["lint", "coverage"], ["test", "findings"], ["security", "tests"], ["smoke", "coverage"], ["build", "tests"], ["migration", "tests"], ["typecheck", "migrations"], ["other", "findings"],
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
  it("reads a v1 pack as v1, unchanged", () => {
    const read = readEvidencePack(v1Pack());
    expect(read.status).toBe("v1");
    if (read.status === "v1") expect(read.pack).toEqual(v1Pack());
  });

  it("reads a known v2 pack and reports nothing newer", () => {
    const read = readV2(v2Pack());
    expect(read.newer).toEqual({ unknownParts: [], unknownKinds: [], unknownValues: false, unreadableChecks: 0 });
    expect(read.pack).toEqual(v2Pack());
  });

  it("keeps unknown parts, kinds and values and reports them as newer evidence, never as a parse failure", () => {
    const input = clone(v2Pack()) as Record<string, unknown> & { checks: Record<string, unknown>[]; level: Record<string, unknown> };
    input.hologram = { depth: 3 };
    input.checks[0]!.fancyPart = { n: 1 };
    input.checks.push({ id: "future", kind: "hologram", label: "projector", stage: "teleport", before: "passed", after: "passed", class: "passing", durationMs: 5, extra: true });
    input.level.reached = "quantum";
    const read = readV2(input);
    expect([...read.newer.unknownParts].sort()).toEqual(["checks[0].fancyPart", "checks[2].extra", "hologram"]);
    expect(read.newer.unknownKinds).toEqual(["hologram"]);
    expect(read.newer.unknownValues).toBe(true);
    expect(read.pack.level.reached).toBe(NEWER_VALUE);
    expect(Object.getOwnPropertyDescriptor(read.pack, "hologram")?.value).toEqual({ depth: 3 });
    expect(read.pack.checks).toHaveLength(3);
    expect(NEWER_EVIDENCE_WORDS).toBe("Newer evidence, open in Rovara");
  });

  // M2: unknown keys are kept and reported at every level, and a part whose strict read failed is reported.
  it("reports unknown keys at every level: producer, level, proof, dependencies, mock, recording, measures, pairs and the v1 parts", () => {
    const input = clone(v2Pack({ environment: v1Pack().environment, selection: v1Pack().selection })) as Record<string, unknown> & {
      producer: Record<string, unknown>; level: Record<string, unknown>; proof: Record<string, unknown>; dependencies: Record<string, unknown>[]; checks: Record<string, unknown>[]; environment: Record<string, unknown>; selection: Record<string, unknown>;
    };
    input.producer.p1 = 1;
    input.level.l1 = 1;
    input.proof.pr1 = 1;
    (input.proof.verdicts as Record<string, unknown>[])[0]!.v1 = 1;
    input.dependencies[0]!.d1 = 1;
    input.dependencies[1]!.mock = { setId: "m1", version: 1, branch: "main", madeIn: "setup", store: "rovara", mk1: 1 };
    input.dependencies[1]!.recording = { store: "rovara", recordedOn: "2026-11-01", rc1: 1 };
    (input.checks[0]!.coverage as Record<string, unknown>).cv1 = 1;
    (input.checks[0]!.tests as Record<string, unknown>).ts1 = 1;
    (input.checks[1]!.measures as Record<string, unknown>[])[0]!.ms1 = 1;
    input.checks[1]!.pairs = [{ id: "shot", before: ARTIFACT, pr2: 1 }];
    input.environment.en1 = 1;
    input.selection.se1 = 1;
    const read = readV2(input);
    expect([...read.newer.unknownParts].sort()).toEqual([
      "checks[0].coverage.cv1", "checks[0].tests.ts1", "checks[1].measures[0].ms1", "checks[1].pairs[0].pr2", "dependencies[0].d1", "dependencies[1].mock.mk1", "dependencies[1].recording.rc1", "environment.en1", "level.l1",
      "producer.p1", "proof.pr1", "proof.verdicts[0].v1", "selection.se1",
    ].sort());
    expect(read.newer.unknownValues).toBe(false);
    expect((read.pack.checks[0]!.coverage as unknown as Record<string, unknown>).cv1).toBe(1);
  });

  it("reports a part that cannot be read and leaves it out, and keeps the array limits of the strict schema", () => {
    const input = clone(v2Pack()) as { checks: Record<string, unknown>[] };
    (input.checks[0]!.coverage as Record<string, unknown>).linesCovered = "many";
    const tests = input.checks[0]!.tests as Record<string, unknown>;
    tests.names = Array.from({ length: 501 }, (_, index) => ({ name: `t${String(index)}`, status: "passed" }));
    const read = readV2(input);
    expect([...read.newer.unknownParts].sort()).toEqual(["checks[0].coverage", "checks[0].tests"]);
    expect(read.pack.checks[0]!.coverage).toBeUndefined();
    expect(read.pack.checks[0]!.tests).toBeUndefined();
    expect(read.pack.checks).toHaveLength(2);
  });

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

  it("keeps an unknown field inside a known part, and a check that cannot be read is counted and left out, not fatal", () => {
    const input = clone(v2Pack()) as { checks: Record<string, unknown>[] };
    (input.checks[0]!.tests as Record<string, unknown>).flakyCount = 2;
    input.checks.push({ id: 7 });
    const read = readV2(input);
    expect(read.newer.unreadableChecks).toBe(1);
    expect(read.pack.checks).toHaveLength(2);
    expect((read.pack.checks[0]!.tests as unknown as Record<string, unknown>).flakyCount).toBe(2);
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

  // H1: JSON.parse makes "__proto__" an own key; assigning it onto a plain object would swap the prototype and let unvalidated values reach the renderer.
  it("keeps a __proto__ key as an ordinary own key: it never becomes the prototype, and its values never reach the renderer", () => {
    const evil = { provenCount: "![x](//evil.example/p.png) @octocat Fixes #12", loadFailureOnOld: 0, heldDraft: false };
    const base = clone(v2Pack()) as Record<string, unknown>;
    delete base.proof;
    delete base.meters;
    const top = readV2(JSON.parse(JSON.stringify(base).replace(/^\{/u, `{"__proto__":${JSON.stringify({ proof: evil, meters: { modelUsd: "boom" } })},`)));
    expect(Object.getPrototypeOf(top.pack)).toBe(Object.prototype);
    expect(top.pack.proof).toBeUndefined();
    expect(top.pack.meters).toBeUndefined();
    expect(top.newer.unknownParts).toContain("__proto__");
    const topText = renderEvidence(top.pack, { newer: top.newer }).text;
    expect(topText).not.toContain("octocat");
    expect(topText).not.toContain("Change proof");
    expect(topText).not.toContain("Spent");

    const checkText = JSON.stringify(clone(v2Pack())).replace('"id":"unit"', `"__proto__":${JSON.stringify({ tests: { total: "@everyone", newTests: [], failed: 0, errored: 0 } })},"id":"unit"`);
    const inCheck = readV2(JSON.parse(checkText));
    expect(Object.getPrototypeOf(inCheck.pack.checks[0])).toBe(Object.prototype);
    expect(inCheck.newer.unknownParts).toContain("checks[0].__proto__");
    expect(renderEvidence(inCheck.pack, { newer: inCheck.newer }).text).not.toContain("everyone");

    const nested = readV2(JSON.parse(JSON.stringify(v2Pack()).replace('"proof":{', '"proof":{"__proto__":{"override":{"actorId":42}},')));
    expect(Object.getPrototypeOf(nested.pack.proof)).toBe(Object.prototype);
    expect(nested.pack.proof?.override).toBeUndefined();
    expect(() => renderEvidence(nested.pack, { newer: nested.newer })).not.toThrow();
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
    expect(readEvidencePack(clone(v2Pack())).status).toBe("v2");
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

  it("lists at most 20 unknown parts", () => {
    const input = clone(v2Pack()) as Record<string, unknown>;
    for (let index = 0; index < 50; index += 1) input[`extra${String(index)}`] = index;
    expect(readV2(input).newer.unknownParts).toHaveLength(20);
  });

  it("lists unknown keys only", () => {
    expect(unknownKeysOf({ a: 1, b: 2, c: 3 }, ["a", "b"])).toEqual(["c"]);
    expect(unknownKeysOf("x", ["a"])).toEqual([]);
    expect(unknownKeysOf(null, ["a"])).toEqual([]);
  });

  it("renders what it read (a read-and-render round trip)", () => {
    expect(renderEvidenceRead(readEvidencePack(v2Pack())).firstLine).toBe("Verified · Real run by Rovara");
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
