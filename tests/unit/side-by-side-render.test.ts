// TE-F10: the two renderings (public: counts and verdict words only; full: at most three inert examples), the pairs seam for the evidence writer, and old evidence left alone.
import { describe, expect, it } from "vitest";
import {
  CHECK_KINDS, EvidencePackV2Schema, partsOutsideKind, renderSideBySide, runSideBySide, sideBySidePairsPart, SIDE_BY_SIDE_EXAMPLES_MAX, type ArtifactRef, type SideBySideCaseOutcome, type SideBySideSummary,
} from "../../packages/contracts/src/index.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";
import { PIN, RUN_DEFAULTS, canary, COMPANY_A, recordingJudge, reportNeeded, sbsWorld, source, verdictText } from "../support/side-by-side-world.js";

const policy = { preset: "careful", aiPilot: false, optIn: false } as const;
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
  it("shows nothing a customer wrote: canaries in outputs, inputs, case ids and not-run text never appear, and no output text is shown at all", async () => {
    const world = sbsWorld();
    const ids = [`${canary("caseid")}-1`, `${canary("caseid")}-2`];
    world.answers(`old ${canary("out-old")}`, `new ${canary("out-new")}`, `old2 ${canary("out-old")}`, `new2 ${canary("out-new")}`);
    const result = await runSideBySide({
      ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 2, { inputs: ids.map((caseId) => ({ caseId, input: `ask ${canary("input")}` })), oldSystem: canary("sys") }),
      judge: recordingJudge(COMPANY_A, (call) => verdictText(call, "a_better")), report: reportNeeded(), policy, seed: "s",
    });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const publicText = renderSideBySide(result.summary, { mode: "public" });
    for (const label of ["caseid", "out-old", "out-new", "input", "sys"]) expect(publicText, label).not.toContain(canary(label));
    expect(publicText).toMatch(/^Old vs new prompt on 2 inputs/u);
    // ... and the same summary DOES show outputs in the full rendering, so the test above is not passing by looking at nothing.
    expect(renderSideBySide(result.summary, { mode: "full" })).toContain(canary("out-old"));
    expect(renderSideBySide(result.summary, { mode: "public" })).not.toContain("old ");
  });
  it("is the same few words whatever the customer's data is, and is one line", () => {
    const hostile = summaryOf([judged("c-1", "better", "# ![x](http://evil.test) @everyone", "<script>x</script>")]);
    const text = renderSideBySide(hostile, { mode: "public" });
    expect(text).not.toContain("\n");
    expect(text).not.toMatch(/evil|everyone|script/u);
  });
});

describe("the full rendering", () => {
  it("shows the headline and at most three examples, worst news first", () => {
    const text = renderSideBySide(five(), { mode: "full" });
    expect(SIDE_BY_SIDE_EXAMPLES_MAX).toBe(3);
    expect(text.split("\n").slice(0, 2)).toEqual(["Old vs new prompt on 5 inputs, compared by an independent judge: 3 same, 1 better, 1 worse.", JUDGE_WORDS]);
    expect(text.match(/^- Example \d/gmu)).toHaveLength(3);
    expect(text).toMatch(/^- Example 1 \(judge: worse\)/mu);
    expect(text).toContain("old five");
    expect(text).toContain("new five");
  });
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
  it("never puts an output in a code block", () => {
    const text = renderSideBySide(summaryOf([judged("c-1", "worse", "    indented\n\tcode", "```\nfenced\n```")]), { mode: "full" });
    // No line opens a fence or is indented four or more spaces (which would be an indented code block); a fence in the middle of a line opens nothing.
    expect(text.split("\n").filter((line) => /^\s*(?:```|~~~)|^ {4}|^\t/u.test(line))).toEqual([]);
  });
  it("cuts a long output and takes a 1 MB output fast", () => {
    const huge = "word ".repeat(200_000);
    const started = process.hrtime.bigint();
    const text = renderSideBySide(summaryOf([judged("c-1", "worse", huge, huge)]), { mode: "full" });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(2_000);
    expect(text.length).toBeLessThan(2_500);
  });
  it("shows a secret-shaped output redacted", () => {
    const key = ["sk", "live", "0123456789abcdef0123456789abcdef"].join("-");
    const text = renderSideBySide(summaryOf([judged("c-1", "worse", `the key is ${key}`, "ok")]), { mode: "full" });
    expect(text).not.toContain(key);
  });
  it("shows a case that did not run by its fixed sentence, and a judge that did not run by its words, without outputs it has no verdict for being presented as a result", () => {
    const text = renderSideBySide(summaryOf([{ caseId: "c-1", status: "not_run", side: "new", sentence: "not run: provider rate limit" }, { caseId: "c-2", status: "judge_not_run", reason: "judge not run", oldText: "o", newText: "n" }]), { mode: "full" });
    expect(text).toContain("not run: provider rate limit");
    expect(text).toMatch(/judge: not run/u);
  });
  it("does not call it proof: no 'Real', no 'verified', no 'proves'", () => {
    for (const mode of ["public", "full"] as const) expect(renderSideBySide(five(), { mode })).not.toMatch(/\breal\b|verified|proves|proof|\bproven\b|no regression measured|improved on eval/iu);
  });
});

describe("the evidence seam", () => {
  const ref = (kind: ArtifactRef["kind"], seed: string): ArtifactRef => ({ kind, sha256: seed.repeat(64).slice(0, 64), bytes: 10, retentionClass: kind === "log_txt" ? "evidence-std" : "evidence-std" });
  it("maps at most three examples to a pairs part with artifact refs, never text, and carries no trust or proof", () => {
    const stored: string[] = [];
    const part = sideBySidePairsPart(five(), { mode: "full" }, ({ pairId, side, text }) => {
      stored.push(`${pairId}/${side}/${text}`);
      return ref("log_txt", side === "old" ? "a" : "b");
    });
    expect(part.kind).toBe("prompt_side_by_side");
    expect(part.pairs).toHaveLength(3);
    expect(part.pairs.map((pair) => pair.id)).toEqual(["pair-1", "pair-2", "pair-3"]);
    expect(stored.some((item) => item.includes("old five"))).toBe(true);
    expect(JSON.stringify(part)).not.toContain("old five");
    expect(Object.keys(part).sort()).toEqual(["kind", "label", "pairs"]);
    // The judge's identity is in the evidence: the check's label names it.
    expect(part.label).toBe("Old vs new prompt (judge: claude-judge 2026-10-01, different model family)");
  });
  it("makes no pair at all in public mode, and no pair when the writer stores nothing", () => {
    expect(sideBySidePairsPart(five(), { mode: "public" }, () => ref("log_txt", "a")).pairs).toEqual([]);
    expect(sideBySidePairsPart(five(), { mode: "full" }, () => undefined).pairs).toEqual([]);
  });
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
