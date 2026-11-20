import { describe, expect, it } from "vitest";
import { EVIDENCE_RENDER_LIMITS, NEWER_EVIDENCE_WORDS, evidencePackV1ToV2, inertEvidenceText, readEvidencePack, renderEvidence, renderEvidenceRead, type EvidencePackV2 } from "../../packages/contracts/src/index.js";
import { v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";
import { expectLinearScaling } from "../support/scaling.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withLevel = (reached: string, isolation = "sealed", result = "verified"): EvidencePackV2 => v2Pack({ level: { reached, required: [] }, producer: { edition: "cloud", isolation }, result });
const ZWJ = "‍";

// M4: the first line never says "Real" for a pack that did not run in a sealed round or that rests on scripted AI replies.
describe("the first line is never better than where the checks ran", () => {


  it("words a scripted-AI proof as such and the change proof line says so", () => {
    const pack = withLevel("rovara_real_run");
    Object.assign(pack.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "simulated" });
    const out = renderEvidence(pack);
    expect(out.firstLine).toBe("Verified · Run against scripted AI replies");
    expect(out.firstLine).not.toMatch(/real/iu);
    expect(out.body).toContain("Change proof: 1 proven with scripted AI replies");
    expect(renderEvidence(v2Pack()).body).toContain("Change proof: 1 proven");
  });

});

describe("the full text of a complete pack", () => {

  it("renders a v1 pack upgraded with its context", () => {
    const upgraded = evidencePackV1ToV2(v1Pack(), { producer: { edition: "code", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] }, result: "verified" });
    const out = renderEvidence(upgraded);
    expect(out.firstLine).toBe("Verified · Checked by your CI");
    expect(out.producerLine).toBe("Ran on a developer machine");
    expect(out.text).toContain("- Tests: pytest -q: passed, 3 tests (1 new), 90% of changed lines covered");
  });
});

describe("trust and proof words", () => {

  it("counts Made by Rovara mocks by when they were made", () => {
    const pack = clone(v2Pack());
    pack.dependencies = [
      { name: "a", kind: "http", backing: "fake", label: "hand_written_fake", trust: "made_by_rovara", mock: { setId: "m1", version: 1, branch: "main", madeIn: "this_task", store: "rovara" } },
      { name: "b", kind: "http", backing: "fake", label: "hand_written_fake", trust: "made_by_rovara", mock: { setId: "m2", version: 1, branch: "main", madeIn: "this_task", store: "rovara" } },
      { name: "c", kind: "http", backing: "none", label: "faked_by_tests", trust: "no_outside_calls" },
    ];
    expect(renderEvidence(pack).text).toContain("Dependencies: Made by Rovara (2 made during this task) · No outside calls");
  });
});

describe("newer evidence", () => {
  it("adds one line when the reader met parts it did not know, and a first-line stand-in for a later version", () => {
    const read = readEvidencePack({ ...clone(v2Pack()), hologram: 1 });
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack, { newer: read.newer }).body.at(-1)).toBe(NEWER_EVIDENCE_WORDS);
    expect(renderEvidenceRead(readEvidencePack({ schemaVersion: 3 })).firstLine).toBe(NEWER_EVIDENCE_WORDS);
    expect(renderEvidenceRead({ status: "unreadable", reason: "not_a_pack" }).firstLine).toBe("Evidence could not be read, open in Rovara");
    expect(renderEvidenceRead({ status: "v1", pack: v1Pack() }).firstLine).toBe("Evidence from an older Rovara, open in Rovara for the level");
  });

});

describe("bounds", () => {
  const big = () => {
    const pack = clone(v2Pack());
    pack.checks = Array.from({ length: 64 }, (_unused, index) => ({ id: `c${String(index)}`, kind: "test", label: "L".repeat(200), before: "passed", after: "passed", class: "passing", durationMs: 1, tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } }));
    pack.notTested = Array.from({ length: 200 }, (_unused, index) => ({ what: "W".repeat(300), reason: `R${String(index)}` }));
    pack.dependencies = Array.from({ length: 24 }, (_unused, index) => ({ name: `${"D".repeat(70)}${String(index)}`, kind: "http", backing: "none", label: "not_available", trust: "simulated" }));
    return renderEvidence(pack);
  };

  it("stays inside the character limit and says how many it left out, for 64 checks with long labels and 200 not-tested rows", () => {
    const out = big();
    expect(out.text.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.textMax);
    expect(out.firstLine.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.lineMax);
    for (const line of out.text.split("\n")) expect(Array.from(line).length, line.slice(0, 40)).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.lineMax);
    expect(out.text).toContain(`and ${String(64 - EVIDENCE_RENDER_LIMITS.checksListed)} more checks`);
    expect(out.text).toContain(`and ${String(200 - EVIDENCE_RENDER_LIMITS.notTestedListed)} more`);
  });

  it("prints '?' for a count or an amount that is not a finite number, and never throws on one", () => {
    const pack = clone(v2Pack()) as unknown as Record<string, Record<string, unknown>>;
    pack.proof!.provenCount = "![x](//evil.example/p.png)";
    pack.meters = { modelUsd: "boom", machineMinutes: Number.NaN, machineUsd: null, caps: {} };
    const out = renderEvidence(pack as unknown as EvidencePackV2).text;
    expect(out).toContain("Change proof: ? proven");
    expect(out).toContain("Spent: $? model, ? machine minutes ($?)");
    expect(out).not.toContain("evil");
  });
});

describe("inert text", () => {
  const inert = (text: string) => inertEvidenceText(text, 300);

  it("drops an image and reduces a link to its text, so each strip matters", () => {
    expect(inert("x ![alt](http://e.co/p.png) y")).toBe("x y");
    expect(inert("[click](http://e.co)")).toBe("click");
  });

  it("neutralises an image or a link with brackets inside its text (nested brackets)", () => {
    expect(inert("![a[b]c](//evil.example/x.png)")).toBe("");
    expect(inert("[Verified[1]](//evil.example)")).toBe("Verified(1)");
  });

  it("neutralises reference-style images, links and definitions: no bracket survives", () => {
    for (const text of ["![a][r]", "[a][r]", "[r]: //evil.example/x.png", "[r]: <http://evil.example>", "![a]", "[a]"]) expect(inert(text), text).not.toMatch(/[[\]]/u);
  });

  it("puts a joiner before anything that would open a block at the start of the line", () => {
    for (const text of ["# Heading", "## Heading", "> quote", "---", "===", "```", "~~~", "| a | b |", "1. item", "2) item", "- item", "+ item", "* item", "___"]) expect(inert(text), text).toBe(`${ZWJ}${text}`);
    for (const text of ["12 tests", "ordinary line", "a # b", "(a)"]) expect(inert(text), text).toBe(text);
  });

  it("removes variation selectors", () => {
    expect(inert("a️b\u{E0100}c\u{E01EF}d︀")).toBe("abcd");
  });

  it("cuts its input before processing, so a hostile megabyte costs as much as a short line", () => {
    for (const text of ["![".repeat(500_000), "[](".repeat(500_000), "<".repeat(1_000_000), "&".repeat(1_000_000), "a".repeat(1_000_000)]) expect(Array.from(inert(text)).length).toBeLessThanOrEqual(300);
    // The cost must not grow faster than the input: each hostile shape at a small size (8N stays at or under 256 KiB so it stays in CPU cache). The full size was checked once above.
    for (const unit of ["![", "[](", "<", "&", "a"] as const) {
      expectLinearScaling((scale) => { const text = unit.repeat(scale); return () => inert(text); }, { n: Math.floor(32_768 / unit.length), unitBytes: unit.length, label: `inert text of ${JSON.stringify(unit)} repeated` });
    }
  });

  // SCALING-CAP-BLIND: the scaling checks above stop at 256 KiB, so they cannot see a regression that reads past the cap. These pin the cap itself: the last character inside it counts, the first one past it never does,
  // and a hostile text far past it gives exactly what the text cut at the cap gives (the cap refuses; it does not slow down).
  it("the 256 KiB read cap is exact: a word that ends inside it is kept, one that starts at the cap is never read", () => {
    const CAP = 262_144;
    const at = (gap: number) => `${"x".repeat(10)}${" ".repeat(gap)}tail`;
    expect(at(CAP - 10 - 4)).toHaveLength(CAP);
    expect(inertEvidenceText(at(CAP - 10 - 4), 300)).toBe("xxxxxxxxxx tail");
    expect(inertEvidenceText(at(CAP - 10 - 3), 300)).toBe("xxxxxxxxxx");
    expect(inertEvidenceText(at(CAP - 10 + 1), 300)).toBe("xxxxxxxxxx");
  });

  it("breaks a mention, a link, a bare www address (any case), an issue reference, a Linear key and a tag", () => {
    expect(inert("@octocat")).toBe(`@${ZWJ}octocat`);
    expect(inert("https://evil.example")).toBe(`https://${ZWJ}evil.example`);
    expect(inert("www.evil.example")).toBe(`www${ZWJ}.evil.example`);
    expect(inert("WWW.EVIL.EXAMPLE")).toBe(`WWW${ZWJ}.EVIL.EXAMPLE`);
    expect(inert("Fixes owner/repo#12")).toBe(`Fixes owner/repo#${ZWJ}12`);
    expect(inert("Fixes ENG-42")).toBe(`Fixes ENG-${ZWJ}42`);
    expect(inert("<img src=x onerror=alert(1)>")).toBe("");
    expect(inert("a < b")).toBe("a &lt; b");
    expect(inert("a & b")).toBe("a &amp; b");
  });

});

