// TE-F10: the two renderings (public: counts and verdict words only; full: at most three inert examples), the pairs seam for the evidence writer, and old evidence left alone.
import { describe, expect, it } from "vitest";
import { CHECK_KINDS, EvidencePackV2Schema, partsOutsideKind, renderSideBySide, sideBySidePairsPart, SIDE_BY_SIDE_UNREADABLE_SENTENCE, type ArtifactRef, type SideBySideCaseOutcome, type SideBySideSummary } from "../../packages/contracts/src/index.js";
import { expectLinearScaling } from "../support/scaling.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";
import { PIN } from "../support/side-by-side-world.js";

const JUDGE_WORDS = "Judge: claude-judge 2026-10-01 (anthropic family), pinned before the task, from a different model family than the product and coding models.";
const ZERO = { calls: 0, costMicros: 0 };

function judged(caseId: string, verdict: "same" | "better" | "worse" | "unclear", oldText: string, newText: string): SideBySideCaseOutcome {
  return { caseId, status: "judged", verdict, oldText, newText };
}
function summaryOf(cases: SideBySideCaseOutcome[], extra: Partial<SideBySideSummary["counts"]> = {}): SideBySideSummary {
  const count = (verdict: string) => cases.filter((item) => item.status === "judged" && item.verdict === verdict).length;
  return {
    schemaVersion: 1,
    evidence: { kind: "prompt_side_by_side", countsTowardProof: false },
    judge: { ...PIN, family: "anthropic", independence: "different_family", productFamily: "google", codingFamily: "openai" },
    counts: {
      planned: cases.length, judged: cases.filter((item) => item.status === "judged").length, same: count("same"), better: count("better"), worse: count("worse"), unclear: count("unclear"),
      notRun: cases.filter((item) => item.status === "not_run").length, callFailed: cases.filter((item) => item.status === "call_failed").length, judgeNotRun: cases.filter((item) => item.status === "judge_not_run").length, refused: 0, possiblySteering: 0, ...extra,
    },
    cases,
    meters: { product: ZERO, rovara: ZERO },
  };
}
const five = (): SideBySideSummary => summaryOf([
  judged("c-1", "same", "old one", "new one"), judged("c-2", "same", "old two", "new two"), judged("c-3", "same", "old three", "new three"), judged("c-4", "better", "old four", "new four"), judged("c-5", "worse", "old five", "new five"),
]);

describe("the public rendering", () => {
  it("is fixed words, counts and verdict words only: a golden", () => {
    expect(renderSideBySide(five(), { mode: "public" })).toBe(`Old vs new prompt on 5 inputs, compared by an independent judge: 3 same, 1 better, 1 worse. ${JUDGE_WORDS}`);
  });
  it("names what did not run by count only", () => {
    const text = renderSideBySide(summaryOf([judged("c-1", "same", "a", "b"), { caseId: "c-2", status: "not_run", side: "old", sentence: "not run: provider rate limit" }, { caseId: "c-3", status: "judge_not_run", reason: "judge not run", oldText: "a", newText: "b" }]), { mode: "public" });
    expect(text).toBe(`Old vs new prompt on 3 inputs, compared by an independent judge: 1 same. 1 not run. The judge did not run for 1. ${JUDGE_WORDS}`);
  });
  it("is the same few words whatever the customer's data is, and is one line", () => {
    const hostile = summaryOf([judged("c-1", "better", "# ![x](http://evil.test) @everyone", "<script>x</script>")]);
    const text = renderSideBySide(hostile, { mode: "public" });
    expect(text).not.toContain("\n");
    expect(text).not.toMatch(/evil|everyone|script/u);
  });
});

describe("the full rendering", () => {
  it("makes every output inert: links, images (nested and reference style), mentions, #123, issue keys, HTML, block starts, hidden characters", () => {
    const nasty = [
      "[click](https://evil.test/a) ![img[1]](https://evil.test/i.png) ![ref][r] [r]: https://evil.test @everyone @team/owner Fixes #123 closes ENG-42 <img src=x onerror=1> <https://evil.test/auto> www.evil.test",
      "# heading\n> quote\n--- rule\n```js\ncode\n```\n~~~\n1. list",
      "hid\u200Bden\u202Etext\uFE0Fvar\u{E0100}sel",
    ];
    for (const out of nasty) {
      const text = renderSideBySide(summaryOf([judged("c-1", "worse", out, out)]), { mode: "full" });
      // Only what the answer became is checked: the bullets around it are the renderer's own.
      const shown = text.split("\n").filter((line) => /^ {2}- (?:Old|New): /u.test(line)).map((line) => line.replace(/^ {2}- (?:Old|New): /u, ""));
      expect(shown).toHaveLength(2);
      for (const value of shown) {
        expect(value, out).not.toMatch(/\]\(|!\[|<img|<script|<https?:|^[#>`~|=+*_-]|^\d+[.)]\s|\u200B|\u202E|\uFE0F|\u{E0100}/u);
        expect(value).not.toMatch(/(?<!\u200D)(?:@everyone|@team|#123|ENG-42)|:\/\/(?!\u200D)|\bwww\.(?!\u200D)/u);
        expect(value.includes("\n")).toBe(false);
      }
      for (const line of text.split("\n")) expect(line.length).toBeLessThan(1_200);
      expect(text.split("\n").filter((line) => /^\s*(?:```|~~~|#|>|---)/u.test(line))).toEqual([]);
    }
  });
  it("cuts a long output and takes a 1 MB output fast", () => {
    // A scaling check, not a wall-clock bound: the same render with a 30 KB and a 240 KB output (the 8N input stays at or under 256 KiB so it stays in CPU cache) may take about eight times as long, never sixty-four. The 1 MB output is rendered once, un-timed.
    let text = "";
    const renderHuge = (words: number) => {
      const huge = "word ".repeat(words);
      const summary = summaryOf([judged("c-1", "worse", huge, huge)]);
      return () => { text = renderSideBySide(summary, { mode: "full" }); };
    };
    expectLinearScaling(renderHuge, { n: 6_000, unitBytes: 5, label: "side-by-side render of a huge output" });
    expect(text.length).toBeLessThan(2_500);
    text = "";
    renderHuge(200_000)();
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(2_500);
  });
  it("shows a case that did not run by its fixed sentence, and a judge that did not run by its words, without outputs it has no verdict for being presented as a result", () => {
    const text = renderSideBySide(summaryOf([{ caseId: "c-1", status: "not_run", side: "new", sentence: "not run: provider rate limit" }, { caseId: "c-2", status: "judge_not_run", reason: "judge not run", oldText: "o", newText: "n" }]), { mode: "full" });
    expect(text).toContain("not run: provider rate limit");
    expect(text).toMatch(/judge: not run/u);
  });
});

describe("the evidence seam", () => {
  const ref = (kind: ArtifactRef["kind"], seed: string): ArtifactRef => ({ kind, sha256: seed.repeat(64).slice(0, 64), bytes: 10, retentionClass: kind === "log_txt" ? "evidence-std" : "evidence-std" });
  it("is accepted by the strict v2 writer schema as a side_by_side check, and a part the kind does not carry is refused", () => {
    const part = sideBySidePairsPart(five(), { mode: "full" }, ({ side }) => ref("log_txt", side === "old" ? "a" : "b"));
    const check = { id: "sbs", kind: part.kind, label: part.label, before: "passed", after: "passed", class: "passing", runBy: "rovara", durationMs: 0, pairs: part.pairs };
    const pack = v2Pack();
    const withCheck = { ...pack, checks: [...pack.checks, check] };
    expect(EvidencePackV2Schema.safeParse(withCheck).success).toBe(true);
    const withTests = { ...pack, checks: [...pack.checks, { ...check, tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } }] };
    expect(EvidencePackV2Schema.safeParse(withTests).success).toBe(false);
    expect(partsOutsideKind("prompt_side_by_side", ["pairs", "measures"])).toEqual(["measures"]);
  });
  it("leaves old evidence alone: v1's kind list is unchanged and does not hold the new kind", () => {
    expect([...CHECK_KINDS]).toEqual(["test", "lint", "typecheck", "security", "migration", "build", "smoke", "other"]);
    expect([...CHECK_KINDS]).not.toContain("prompt_side_by_side");
  });
});

describe("a summary that is not the right shape (fix round 1, M4)", () => {
  const FIXED = "This side-by-side summary could not be read.";
  const missingCounts = (): SideBySideSummary => ({ ...five(), counts: undefined } as never);
  it("says one fixed sentence, in both modes, for a summary that is empty, missing its counts or not an object", () => {
    expect(SIDE_BY_SIDE_UNREADABLE_SENTENCE).toBe(FIXED);
    for (const bad of [{}, missingCounts(), null, undefined, "text", 7, []]) {
      for (const mode of ["public", "full"] as const) expect(renderSideBySide(bad as never, { mode }), `${JSON.stringify(bad)} ${mode}`).toBe(FIXED);
    }
  });
  it("does not throw in the full rendering for a case that is null, not an object, or has texts that are not strings", () => {
    const odd = { ...five(), cases: [null, 7, "x", { caseId: "c", status: "judged", verdict: "same", oldText: 5, newText: { a: 1 } }, { caseId: "d", status: "not_run", side: "old", sentence: 9 }, judged("c-1", "worse", "old ok", "new ok")] } as never;
    const text = renderSideBySide(odd, { mode: "full" });
    expect(text).toContain("old ok");
    expect(() => sideBySidePairsPart(odd, { mode: "full" }, () => undefined)).not.toThrow();
    expect(() => sideBySidePairsPart({} as never, { mode: "full" }, () => undefined)).not.toThrow();
    expect(() => sideBySidePairsPart({ ...five(), cases: null } as never, { mode: "full" }, () => undefined)).not.toThrow();
  });
});

describe("the verdict and the side come only from the closed word lists (fix round 1, M5)", () => {
  const LINK = "[click](http://evil.example) @bob";
  it("never prints a verdict that is not one of the four words: a link or a mention becomes a fixed word", () => {
    const hostile = summaryOf([{ caseId: "c-1", status: "judged", verdict: LINK as never, oldText: "o", newText: "n" }, { caseId: "c-2", status: "judged", verdict: "__proto__" as never, oldText: "o2", newText: "n2" }]);
    const text = renderSideBySide(hostile, { mode: "full" });
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("@bob");
    expect(text).not.toContain("__proto__");
    expect(text).toContain("(judge: unclear)");
  });
  it("never prints a side that is not old or new", () => {
    const hostile = summaryOf([{ caseId: "c-1", status: "not_run", side: "[x](http://e.example) @bob" as never, sentence: "not run: provider rate limit" }, { caseId: "c-2", status: "call_failed", side: "new", sentence: "the new prompt's call failed" }]);
    const text = renderSideBySide(hostile, { mode: "full" });
    expect(text).not.toContain("e.example");
    expect(text).not.toContain("@bob");
    expect(text).toContain("(new prompt)");
    expect(text).toContain("(unknown prompt)");
  });
});
