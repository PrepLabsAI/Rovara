// TE-B3: the words for weakened tests and for the flag at the top (instruction files, files CI runs), in the one renderer and in the pack v2 shape; the test proof's weakening facts; old data keeps working.
import { describe, expect, it } from "vitest";
import {
  EvidencePackV2Schema, TestProofSchema, WEAKENING_LIMITS, evidencePackV1ToV2, evidencePackV2ToV1, readEvidencePack, renderEvidence, weakeningLines,
} from "../../packages/contracts/src/index.js";
import { DIGEST, v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const weakening = (over: Record<string, unknown> = {}) => ({ removedTests: [], absentOnNew: [], changedTestConfig: [], changedSnapshots: [], changedFixtures: [], ...over });

describe("weakeningLines", () => {
  it("is empty for no facts, an empty list, a steady skip count and a fall in skips", () => {
    expect(weakeningLines({})).toEqual({ flags: [], weakening: [] });
    expect(weakeningLines({ absentOnNew: [], changedSnapshots: [], skipRise: { before: 3, after: 3 } })).toEqual({ flags: [], weakening: [] });
    expect(weakeningLines({ skipRise: { before: 5, after: 2 } }).weakening).toEqual([]);
  });
  it("words each fact, flags first, in the words the screen shows", () => {
    const lines = weakeningLines({
      instructionFiles: ["AGENTS.md"], ciExecutedFiles: ["Makefile", "conftest.py"], absentOnNew: ["a::t1", "a::t2"], skipRise: { before: 1, after: 4 }, removedTests: ["b::t3"],
      changedTestConfig: ["pytest.ini"], changedSnapshots: ["x.snap"], changedFixtures: ["f.json"],
    });
    expect(lines.flags).toEqual([
      "Rovara instruction files changed (a flag, not an approval): AGENTS.md",
      "Files that CI runs changed (a flag, not an approval): Makefile, conftest.py",
    ]);
    expect(lines.weakening).toEqual([
      "2 tests ran before and not now: a::t1, a::t2",
      "3 more tests skipped than before",
      "1 test removed: b::t3",
      "Test config files changed: pytest.ini",
      "Snapshot files changed: x.snap",
      "Fixture files changed: f.json",
    ]);
  });
  it("says 'and N more' past three names, and uses the true count when the list was cut", () => {
    expect(weakeningLines({ changedSnapshots: ["a", "b", "c", "d", "e"] }).weakening).toEqual(["Snapshot files changed: a, b, c and 2 more"]);
    expect(weakeningLines({ absentOnNew: ["a", "b", "c", "d"], absentOnNewCount: 2_500 }).weakening).toEqual(["2,500 tests ran before and not now: a, b, c and 2,497 more"]);
    expect(weakeningLines({ skipRise: { before: 0, after: 1 } }).weakening).toEqual(["1 more test skipped than before"]);
  });
  it("never prints a number that is not one, and never trusts an entry to be text", () => {
    const hostile = { absentOnNew: ["a", 7, null, { x: 1 }], absentOnNewCount: Number.NaN, skipRise: { before: 0, after: Number.POSITIVE_INFINITY } } as unknown as Parameters<typeof weakeningLines>[0];
    const text = weakeningLines(hostile).weakening.join("\n");
    expect(text).not.toMatch(/NaN|Infinity|undefined|object/u);
    expect(text).toBe("4 tests ran before and not now: a and 3 more");
  });
  it("bounds a very long name and a 1 MB name", () => {
    const started = Date.now();
    const lines = weakeningLines({ instructionFiles: ["x".repeat(1_000_000)], changedSnapshots: Array.from({ length: 100_000 }, (_unused, n) => `s${String(n)}`) });
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const line of [...lines.flags, ...lines.weakening]) expect(Array.from(line).length).toBeLessThanOrEqual(WEAKENING_LIMITS.lineMax);
  });
});

describe("the pack v2 shape", () => {
  it("accepts the new optional parts and the count, and an older v2 pack without them still parses", () => {
    expect(EvidencePackV2Schema.safeParse(v2Pack()).success).toBe(true);
    const pack = v2Pack({ weakening: weakening({ absentOnNew: ["a::t"], absentOnNewCount: 40 }), flags: { instructionFiles: ["AGENTS.md"], ciExecutedFiles: ["Makefile"] } });
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
    expect(EvidencePackV2Schema.safeParse(v2Pack({ flags: { instructionFiles: [] } })).success).toBe(false);
    expect(EvidencePackV2Schema.safeParse(v2Pack({ flags: { instructionFiles: ["a".repeat(501)], ciExecutedFiles: [] } })).success).toBe(false);
  });
  it("the renderer puts the flags right after the producer line, and the weakening under its own heading", () => {
    const pack = v2Pack({ weakening: weakening({ absentOnNew: ["a::t"], changedSnapshots: ["x.snap"] }), flags: { instructionFiles: ["AGENTS.md"], ciExecutedFiles: [] } });
    const { body } = renderEvidence(pack);
    expect(body[0]).toBe("Checked in a sealed round");
    expect(body[1]).toBe("- Rovara instruction files changed (a flag, not an approval): AGENTS.md");
    const heading = body.indexOf("Tests may be weaker:");
    expect(body.slice(heading, heading + 3)).toEqual(["Tests may be weaker:", "- 1 test ran before and not now: a::t", "- Snapshot files changed: x.snap"]);
  });
  it("says nothing extra for a pack without flags or weakening", () => {
    const { text } = renderEvidence(v2Pack());
    expect(text).not.toMatch(/Tests may be weaker|flag, not an approval/u);
  });
  it("reads a v2 pack with the parts as written, and a newer writer's other fields are only reported", () => {
    const read = readEvidencePack(JSON.parse(JSON.stringify(v2Pack({ flags: { instructionFiles: ["AGENTS.md"], ciExecutedFiles: [] } }))));
    expect(read.status).toBe("v2");
    expect(read.status === "v2" && read.pack.flags?.instructionFiles).toEqual(["AGENTS.md"]);
  });
  it("renders hostile names inert in the v2 words too", () => {
    const pack = v2Pack({ flags: { instructionFiles: ["[x](https://evil.example) @everyone Fixes ENG-1"], ciExecutedFiles: ["![i](https://evil.example/p.png)"] } });
    const { text } = renderEvidence(pack);
    expect(text).not.toMatch(/\]\(|!\[|(^|[^\u200d])@\w|Fixes ENG-\d/u);
  });
  it("converting a v1 pack both ways keeps the absent-test facts in the check's tests part", () => {
    const v1 = v1Pack();
    v1.checks[0]!.tests = { ...v1.checks[0]!.tests!, absentOnNew: ["tests/a.py::gone"], absentOnNewCount: 1 };
    const v2 = evidencePackV1ToV2(v1, { producer: { edition: "code", isolation: "sandbox" }, level: { reached: "sandbox_only", required: [] }, result: "verified" });
    expect(EvidencePackV2Schema.safeParse(v2).success).toBe(true);
    expect(evidencePackV2ToV1(v2)?.checks[0]?.tests?.absentOnNew).toEqual(["tests/a.py::gone"]);
  });
});

describe("the test proof's weakening facts", () => {
  const proof = (weakeningPart: unknown) => ({ schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 5, ...(weakeningPart === undefined ? {} : { weakening: weakeningPart }) });
  it("an old proof without them parses; one with them parses; the schema is strict and bounded", () => {
    expect(TestProofSchema.safeParse(proof(undefined)).success).toBe(true);
    const fact = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 2, absentOnNew: ["a::t"], absentOnNewCount: 1 };
    expect(TestProofSchema.safeParse(proof([fact])).success).toBe(true);
    expect(TestProofSchema.safeParse(proof([{ ...fact, extra: 1 }])).success).toBe(false);
    expect(TestProofSchema.safeParse(proof([{ ...fact, absentOnNewCount: 0 }])).success).toBe(false);
    expect(TestProofSchema.safeParse(proof([{ ...fact, absentOnNew: Array.from({ length: 101 }, () => "a"), absentOnNewCount: 101 }])).success).toBe(false);
    expect(TestProofSchema.safeParse(proof([{ ...fact, skippedAfter: -1 }])).success).toBe(false);
    expect(TestProofSchema.safeParse(proof(Array.from({ length: 65 }, (_unused, n) => ({ ...fact, checkId: `readiness:${String(n)}` })))).success).toBe(false);
  });
});
