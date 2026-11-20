// TE-B5: the pure change-proof hold rule (`proofHolds`). A draft stays a draft, with the reason, when the proof failed (the new tests pass on the old code too), changed code was not run, a test that ran on the old
// code is absent on the new, or a test is flaky on the change; only an assertion failure on the old code counts as proven; scripted AI reply origins never hold a draft (DEC 192a); and above 10% held the hold becomes a warning by itself (O43).
import { describe, expect, it } from "vitest";
import { EvidencePackV2Schema, renderEvidence } from "../../packages/contracts/src/index.js";
import { expectLinearScaling } from "../support/scaling.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";
import {
  PROOF_HOLD_WINDOW, proofHoldFactsOf, ProofHoldReasonSchema, REPLY_ORIGIN_WORDS, proofHoldLine, proofHoldRelaxes, proofHolds, proofSectionOf,
  type ProofHoldFacts, type TestProof, type TestProofItem,
} from "../../packages/contracts/src/index.js";

const DIGEST = "d".repeat(64);
const item = (checkId: string, verdict: TestProofItem["verdict"], reason: TestProofItem["reason"], extra: Partial<TestProofItem> = {}): TestProofItem => ({ checkId, label: checkId, granularity: "check", verdict, reason, ...extra });
const proof = (items: TestProofItem[], status: TestProof["status"] = "checked"): TestProof => ({
  schemaVersion: 1, candidateDigest: DIGEST, status, note: status === "checked" ? "completed" : "no_changed_tests", changedTests: { added: 1, changed: 0, deleted: 0 }, items, durationMs: 10,
});
const PROVES = item("unit", "proves_change", "assertion_failed_on_old");
const VACUOUS = item("unit", "does_not_prove", "passed_on_old");
const LOAD = item("unit", "could_not_run_on_old", "load_failure_on_old");
const facts = (over: Partial<ProofHoldFacts> = {}): ProofHoldFacts => ({ proof: proof([PROVES]), ...over });
const hold = (over: Partial<ProofHoldFacts> = {}, mode: "off" | "warn" | "hold" = "hold", recent?: { held: number; total: number }) => proofHolds({ facts: facts(over), mode, ...(recent === undefined ? {} : { recent }) });

describe("proofHolds: the ready rule's truth table", () => {
  it("an unknown proof (none read, not checked, no changed tests) never holds: a Rovara fault must not block", () => {
    expect(hold({ proof: undefined }).holds).toBe(false);
    expect(hold({ proof: proof([VACUOUS], "not_checked") }).holds).toBe(false);
    expect(hold({ proof: proof([], "no_changed_tests") }).holds).toBe(false);
    expect(hold({ proof: proof([item("unit", "not_checked", "timed_out")]) }).holds).toBe(false);
  });
});

describe("proofHolds: scripted AI replies (DEC 192a)", () => {
  it.each(["before_task", "independent_agent", "coding_agent", "failure_pack", "unknown", "made_up", "constructor", ""])("%s never holds, counts for the hold rule, and retains the scripted basis", (origin) => {
    const result = hold({ scriptedReplies: { unit: origin } });
    expect(result).toMatchObject({ holds: false, warns: false, wouldHold: false, relaxed: false, reasons: [], provenCount: 1, proofBasis: "scripted_ai_replies" });
    expect(proofHoldLine(result.reasons)).toBe("");
  });
  it.each([
    [{ proof: proof([VACUOUS]) }, "proof_failed"],
    [{ changedLines: { changed: 2, covered: 0 } }, "changed_code_not_run"],
    [{ absentOnNew: ["missing"] }, "test_absent_on_new"],
    [{ flakyOnChange: ["flaky"] }, "flaky_on_change"],
  ] as const)("preserves the other hold for %j", (input, reason) => {
    expect(hold({ ...input, scriptedReplies: { unit: "coding_agent" } })).toMatchObject({ holds: true, reasons: [reason] });
  });
  it("uses the approved coding-agent words and rejects the removed reason on the unshipped B5 contract", () => {
    expect(REPLY_ORIGIN_WORDS.coding_agent).toBe("scripted replies written in this task");
    expect(ProofHoldReasonSchema.safeParse("replies_not_counted").success).toBe(false);
    for (const reason of ["proof_failed", "changed_code_not_run", "test_absent_on_new", "flaky_on_change"]) {
      expect(ProofHoldReasonSchema.safeParse(reason).success).toBe(true);
    }
  });
  it("keeps hostile origin text out of the decision and every remaining hold line at the proof item limit", () => {
    const hostile = "[click](https://example.invalid) ![image][ref] @person #123 <b>secret</b>\n# > --- ``` ~~~\u200b\ufe0f" + "x".repeat(1_000_000);
    const cases = [
      [{ proof: proof([VACUOUS]) }, "Held as a draft: the new tests pass on the old code too."],
      [{ changedLines: { changed: 1, covered: 0 } }, "Held as a draft: no test ran the changed code."],
      [{ absentOnNew: [hostile] }, "Held as a draft: a test that ran on the old code is missing from the new code."],
      [{ flakyOnChange: [hostile] }, "Held as a draft: a test is flaky on this change but passed on the base."],
    ] as const;
    // The work is a change with `count` proving tests, each resting on a 1 MB hostile origin, and the four hold lines beside it. A scaling check, not a
    // wall-clock bound: the time at 200 proof items (the limit) may be about eight times the time at 25, never sixty-four.
    let result: ReturnType<typeof hold> | undefined;
    let lines: string[] = [];
    expectLinearScaling((count) => {
      const items = Array.from({ length: count }, (_, i) => item(`test:${String(i)}`, "proves_change", "assertion_failed_on_old"));
      const scriptedReplies = Object.fromEntries(items.map((entry) => [entry.checkId, hostile]));
      return () => {
        result = hold({ proof: proof(items), scriptedReplies });
        lines = cases.map(([input]) => proofHoldLine(hold({ ...input, scriptedReplies: { unit: hostile } }).reasons));
      };
    }, { n: 25, unitBytes: 100, label: "proof hold with hostile origin text" }); // 8N = 200 items of about 100 bytes (the 1 MB hostile string is one shared constant)
    expect(result).toMatchObject({ holds: false, provenCount: 200, proofBasis: "scripted_ai_replies" });
    expect(JSON.stringify(result)).not.toContain("example.invalid");
    expect(lines).toEqual(cases.map(([, expected]) => expected));
  });
});

describe("no scripted replies: byte-identical decision goldens", () => {
  it.each([
    [{}, [], 1, [{ checkId: "unit", verdict: "proves_change", reason: "assertion_failed_on_old" }]],
    [{ proof: undefined }, [], 0, []],
    [{ proof: proof([VACUOUS]) }, ["proof_failed"], 0, [{ checkId: "unit", verdict: "does_not_prove", reason: "passed_on_old" }]],
    [{ changedLines: { changed: 1, covered: 0 } }, ["changed_code_not_run"], 1, [{ checkId: "unit", verdict: "proves_change", reason: "assertion_failed_on_old" }]],
    [{ absentOnNew: ["missing"] }, ["test_absent_on_new"], 1, [{ checkId: "unit", verdict: "proves_change", reason: "assertion_failed_on_old" }]],
    [{ flakyOnChange: ["flaky"] }, ["flaky_on_change"], 1, [{ checkId: "unit", verdict: "proves_change", reason: "assertion_failed_on_old" }]],
  ] as const)("preserves the full decision bytes for %j", (input, reasons, provenCount, verdicts) => {
    expect(JSON.stringify(hold(input))).toBe(JSON.stringify({ holds: reasons.length > 0, warns: false, wouldHold: reasons.length > 0, relaxed: false, reasons, provenCount, loadFailureOnOld: 0, verdicts }));
  });
});

describe("proofHolds: the preset mode and O43's automatic relaxation", () => {
  const VACUOUS_FACTS = { proof: proof([VACUOUS]) };
  it("off ignores everything", () => {
    expect(hold(VACUOUS_FACTS, "off")).toMatchObject({ holds: false, warns: false, reasons: [], wouldHold: false });
  });
  it("warn says it and never holds (Lightweight)", () => {
    expect(hold(VACUOUS_FACTS, "warn")).toMatchObject({ holds: false, warns: true, wouldHold: true, relaxed: false, reasons: ["proof_failed"] });
  });
  it("a young project is judged against the whole window: 2 held of 5 is not more than 10% of 20", () => {
    expect(PROOF_HOLD_WINDOW).toBe(20);
    expect(proofHoldRelaxes({ held: 2, total: 5 })).toBe(false);
    expect(proofHoldRelaxes({ held: 3, total: 5 })).toBe(true);
  });
  it("garbage history never relaxes the hold", () => {
    for (const recent of [{ held: -1, total: 20 }, { held: Number.NaN, total: 20 }, { held: 5, total: Number.POSITIVE_INFINITY }, { held: 25, total: 20 }, { held: 1.5, total: 20 }]) {
      expect(proofHoldRelaxes(recent as never)).toBe(false);
    }
    expect(proofHoldRelaxes(undefined)).toBe(false);
  });
});

describe("words and the pack's proof section", () => {
  it("builds the v2 pack's proof section: held, the counts and the override with its optional reason", () => {
    const held = hold({ proof: proof([VACUOUS, LOAD]) });
    expect(proofSectionOf(held)).toEqual({ verdicts: [{ checkId: "unit", verdict: "does_not_prove", reason: "passed_on_old" }, { checkId: "unit", verdict: "could_not_run_on_old", reason: "load_failure_on_old" }], provenCount: 0, loadFailureOnOld: 1, heldDraft: true });
    const withOverride = proofSectionOf(held, { actorId: "p1", at: "2026-11-13T10:00:00.000Z" });
    expect(withOverride.override).toEqual({ actorId: "p1", at: "2026-11-13T10:00:00.000Z" });
    expect(withOverride.heldDraft).toBe(true);
    expect(proofSectionOf(held, { actorId: "p1", at: "2026-11-13T10:00:00.000Z", reason: "reviewed by hand" }).override?.reason).toBe("reviewed by hand");
  });
  it("the section is one the strict v2 writer accepts, and the pull request's evidence says held and marked ready anyway", () => {
    const held = hold({ proof: proof([VACUOUS]) });
    const section = proofSectionOf(held, { actorId: "person-1", at: "2026-11-13T10:00:00.000Z", reason: "reviewed by hand" });
    const pack = EvidencePackV2Schema.parse({ ...v2Pack(), proof: section });
    const rendered = renderEvidence(pack);
    expect(rendered.firstLine).toContain("marked ready anyway");
    expect(renderEvidence(pack, { compact: true }).firstLine).toBe(rendered.firstLine);
    expect(rendered.text).toContain("Held as a draft until the change is proven");
    expect(rendered.text).toContain("Marked ready anyway by person-");
    expect(rendered.text).toContain("reviewed by hand");
    expect(renderEvidence(EvidencePackV2Schema.parse({ ...v2Pack(), proof: proofSectionOf(held) })).firstLine).not.toContain("marked ready anyway");
    expect(EvidencePackV2Schema.safeParse({ ...v2Pack(), proof: { ...section, override: { actorId: "p", at: "yesterday" } } }).success).toBe(false);
  });
});

describe("proofHoldFactsOf: the facts from the checks a pack already has", () => {
  const test = { id: "unit", kind: "test", coverage: { linesChanged: 10, linesCovered: 0 } };
  it("reads a v2 check (id) and a v1 check (checkId) alike, sums coverage and says unknown when there is none", () => {
    expect(proofHoldFactsOf({ checks: [test, { checkId: "e2e", kind: "e2e", coverage: { linesChanged: 5, linesCovered: 5 } }, { id: "lint", kind: "lint" }] }).changedLines).toEqual({ changed: 15, covered: 5 });
    expect(proofHoldFactsOf({ checks: [{ id: "lint", kind: "lint" }] }).changedLines).toBeUndefined();
    expect(proofHoldFactsOf({}).changedLines).toBeUndefined();
  });
  it("a change no test ran holds through the facts; a lint's proof does not count", () => {
    const facts = proofHoldFactsOf({ proof: proof([PROVES]), checks: [test] });
    expect(proofHolds({ facts, mode: "hold" })).toMatchObject({ holds: true, reasons: ["changed_code_not_run"] });
    const lint = proofHoldFactsOf({ proof: proof([item("lint", "proves_change", "assertion_failed_on_old")]), checks: [{ id: "lint", kind: "lint" }] });
    expect(proofHolds({ facts: lint, mode: "hold" }).provenCount).toBe(0);
  });
  it("a scripted check retains its basis with a named origin or the unknown fallback", () => {
    const checks = [{ id: "unit", kind: "test", proofBasis: "scripted_ai_replies" }];
    expect(proofHolds({ facts: proofHoldFactsOf({ proof: proof([PROVES]), checks }), mode: "hold" })).toMatchObject({ holds: false, provenCount: 1, proofBasis: "scripted_ai_replies" });
    expect(proofHolds({ facts: proofHoldFactsOf({ proof: proof([PROVES]), checks, replyOrigins: { unit: "independent_agent" } }), mode: "hold" })).toMatchObject({ holds: false, proofBasis: "scripted_ai_replies" });
  });
});

describe("Round 2 M2: only explicit assertion proof counts", () => {
  it.each([
    { ...PROVES, verdict: "future_verdict" },
    { ...PROVES, verdict: null },
    { ...PROVES, verdict: undefined },
    { ...PROVES, reason: "load_failure_on_old" },
    { ...PROVES, reason: "future_reason" },
    null,
  ])("fails closed on an unsupported row %j", (bad) => {
    for (const items of [[bad], [VACUOUS, bad], [PROVES, bad]]) {
      const result = hold({ proof: proof(items as TestProofItem[]) });
      expect(result).toMatchObject({ holds: true, provenCount: 0 });
      expect(result.verdicts).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("future_");
    }
  });
  it("rejects oversized rows before parsing them and supports the maximum", () => {
    expect(hold({ proof: proof(Array.from({ length: 200 }, () => PROVES)) }).provenCount).toBe(200);
    expect(hold({ proof: proof(Array.from({ length: 201 }, () => PROVES)) })).toMatchObject({ holds: true, provenCount: 0, verdicts: [] });
    // A million rows are refused on their count: the cost must not grow with the size (a scaling check, not a wall-clock bound).
    // The timed N is small so the 8N array (8 bytes per row) stays at or under 256 KiB and in CPU cache; the full million rows are checked once, un-timed.
    expectLinearScaling((count) => {
      const many = new Array<TestProofItem>(count).fill(PROVES);
      return () => { hold({ proof: proof(many) }); };
    }, { n: 4_096, unitBytes: 8, label: "proof hold refuses oversized rows" });
    const refused = hold({ proof: proof(new Array<TestProofItem>(1_000_000).fill(PROVES)) });
    expect(refused).toMatchObject({ holds: true, provenCount: 0, verdicts: [] });
  });
});

describe("Round 2: proof boundary validation", () => {
  it.each([
    { ...proof([PROVES]), status: "future_status" },
    { ...proof([PROVES]), items: null },
    { ...proof([PROVES]), weakening: [{ checkId: "unit", skippedBefore: 0, skippedAfter: 0, absentOnNew: ["missing"], absentOnNewCount: 0 }] },
    { ...proof([PROVES]), weakeningNotCompared: [{ checkId: "unit", reason: "future_reason" }] },
  ])("never silently drops malformed proof input %j", (raw) => {
    expect(hold({ proof: raw as TestProof })).toMatchObject({ holds: true, provenCount: 0, verdicts: [] });
  });
});
