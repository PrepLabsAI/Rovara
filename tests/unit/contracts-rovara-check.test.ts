// TE-B4: the one "Rovara" Check's conclusion (testing plan O48) and its words. Pure: the table, the precedence, the bounds, refusal of bad input, no echoed input.
import { describe, expect, it } from "vitest";
import {
  ROVARA_CHECK_NAME, ROVARA_CHECK_STALE_MS, ROVARA_CHECK_TEXT_MAX, ROVARA_CHECK_TITLE_MAX, rovaraCheckOf, withoutOwnRovaraCheck, type ChangeRequestStatus, type RovaraCheckInput,
} from "../../packages/contracts/src/index.js";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const base: RovaraCheckInput = { proof: { kind: "not_judged" }, ci: "passing", ciMode: "their_ci_fix", fullSuite: "not_needed", firstSeenAtMs: T0, nowMs: T0 + 60_000 };
const of = (over: Partial<RovaraCheckInput>) => rovaraCheckOf({ ...base, ...over });
type Proof = RovaraCheckInput["proof"];
const PROCEED = { kind: "proceed", warns: false, relaxed: false, provenCount: 2, reasons: [] } satisfies Proof;
const HELD: Proof = { kind: "held", reasons: ["proof_failed"], provenCount: 0 };

describe("the conclusion table (O48)", () => {
  it("a proof warning (preset warns, or the hold relaxed) is still success, and says so", () => {
    const warned = of({ proof: { ...PROCEED, warns: true, reasons: ["changed_code_not_run"] } });
    expect(warned.conclusion).toBe("success");
    expect(warned.text).toContain("no test ran the changed code");
    const relaxed = of({ proof: { ...PROCEED, warns: true, relaxed: true, reasons: ["proof_failed"] } });
    expect(relaxed.conclusion).toBe("success");
    expect(relaxed.text).toContain("More than 10%");
  });
  it("ready with nothing proven claims no proof: the title is only 'Ready'", () => {
    expect(of({ proof: { ...PROCEED, provenCount: 0 } })).toMatchObject({ conclusion: "success", title: "Ready" });
  });
  it.each([
    ["rovara_problem", { problem: "rovara_problem" }],
    ["not run", { problem: "not_run" }],
    ["CI not readable", { ci: "unreadable" }],
    ["No CI", { ci: "none" }],
    ["sandbox only by choice", { ciMode: "sandbox_only", ci: "none" }],
    ["sandbox only by choice, CI passing", { ciMode: "sandbox_only", ci: "passing" }],
  ] as const)("%s: neutral, whatever the proof says when it is not a hold", (_label, over) => {
    for (const proof of [PROCEED, { kind: "not_judged" }] satisfies Proof[]) {
      expect(of({ ...over, proof })).toMatchObject({ status: "completed", conclusion: "neutral" });
    }
  });
  it("a failed full suite is failure even with an override of the proof hold (the override is for the proof only)", () => {
    expect(of({ proof: HELD, override: { by: "Priya" }, fullSuite: "failed" }).conclusion).toBe("failure");
  });
});

describe("words and bounds", () => {
  it("the name is 'Rovara'", () => {
    expect(ROVARA_CHECK_NAME).toBe("Rovara");
  });
  it("the override name is made inert: no mention, no link, no markup, bounded", () => {
    const hostile = of({ proof: HELD, override: { by: `@everyone [x](https://evil.example) <img src=x> ${"a".repeat(500)}` } });
    expect(hostile.title).not.toMatch(/@everyone|https:\/\/evil|<img/u);
    expect(Array.from(hostile.title).length).toBeLessThanOrEqual(ROVARA_CHECK_TITLE_MAX);
  });
  it.each([
    ["unknown proof kind", { proof: { kind: "maybe" } }],
    ["unknown reason", { proof: { kind: "held", reasons: ["because"], provenCount: 0 } }],
    ["unknown ci", { ci: "green" }],
    ["unknown full suite", { fullSuite: "half" }],
    ["unknown problem", { problem: "oops" }],
    ["clock not a number", { nowMs: "soon" }],
    ["negative proven count", { proof: { ...PROCEED, provenCount: -1 } }],
    ["override name not a string", { proof: HELD, override: { by: 42 } }],
  ])("bad input (%s) is a fixed neutral refusal, never a throw or a guess, and echoes nothing", (_label, over) => {
    const refused = rovaraCheckOf({ ...base, ...(over as object) });
    expect(refused).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(refused.title).toBe("Rovara could not finish");
    for (const word of ["maybe", "because", "green", "half", "oops", "soon"]) expect(JSON.stringify(refused)).not.toContain(word);
  });
});

describe("Rovara's own Check is never read as the customer's CI", () => {
  const status = (checks: ChangeRequestStatus["checks"], requiredChecks: ChangeRequestStatus["requiredChecks"]): ChangeRequestStatus => ({
    id: "1", state: "open", draft: true, headRevision: "a".repeat(40), targetBranch: "main", mergeableState: "clean", checks, requiredChecks, targetHasRequiredChecks: requiredChecks.length > 0, headDefinesChecks: true,
    requestedReviewers: 0, reviews: [],
  } as unknown as ChangeRequestStatus);
  const unit = { name: "unit", state: "completed", conclusion: "success", required: true, url: "", source: "15368" } as const;
  const ours = { name: "Rovara", state: "completed", conclusion: "failure", required: true, url: "", source: "999" } as const;
  it("keeps a check named 'Rovara' from another app (a customer's own job)", () => {
    const theirs = { ...ours, source: "123" };
    expect(withoutOwnRovaraCheck(status([theirs], []), "999").checks).toEqual([theirs]);
  });
  it("the only required check being ours leaves no required checks", () => {
    const out = withoutOwnRovaraCheck(status([{ ...unit, required: false }, ours], [{ name: "Rovara" }]), "999");
    expect(out.requiredChecks).toEqual([]);
    expect(out.targetHasRequiredChecks).toBe(false);
    expect(out.checks.every((check) => check.name !== "Rovara")).toBe(true);
  });
  it("no source known: the status is returned unchanged (same object)", () => {
    const input = status([unit, ours], [{ name: "Rovara" }]);
    expect(withoutOwnRovaraCheck(input, undefined)).toBe(input);
  });
});

// L4-C B4: with a verdict the Check says the description's words; the verdict is words only and never moves the conclusion.
describe("the verdict in the Check (L4-C B4)", () => {
  const verdict = { resultKind: "verified", heading: "Verified · Low risk · nothing extra to check", body: ["**Changed** 4 files, +86 -12.", "**Needs you** The normal code review. Nothing else."] };
  // Mutant C1: the verdict changes a conclusion. Killed by the loop: every input gives the same status and conclusion with and without a verdict.
  it("never changes the status or the conclusion, for any input of the table", () => {
    const inputs: Array<Partial<RovaraCheckInput>> = [
      {}, { proof: PROCEED }, { proof: { ...PROCEED, warns: true, reasons: ["changed_code_not_run"] } }, { proof: HELD }, { proof: HELD, override: { by: "Priya" } }, { problem: "rovara_problem" }, { problem: "not_run" },
      { ci: "unreadable" }, { ci: "none" }, { fullSuite: "failed" }, { fullSuite: "pending", proof: PROCEED }, { fullSuite: "not_run", proof: PROCEED }, { ciMode: "sandbox_only", proof: PROCEED }, { stopped: true }, { nowMs: T0 + ROVARA_CHECK_STALE_MS + 1 },
    ];
    for (const over of inputs) {
      const without = of(over);
      const withIt = of({ ...over, verdict });
      expect(withIt.status, JSON.stringify(over)).toBe(without.status);
      expect(withIt.conclusion, JSON.stringify(over)).toBe(without.conclusion);
    }
  });
  it("is bounded, and a verdict that does not fit is left out: the Check is exactly what it was, never refused and never another conclusion", () => {
    const long = of({ proof: PROCEED, verdict: { ...verdict, body: Array.from({ length: 200 }, () => "x".repeat(2_000)) } });
    expect(long.text.length).toBeLessThanOrEqual(ROVARA_CHECK_TEXT_MAX);
    expect(Array.from(long.title).length).toBeLessThanOrEqual(ROVARA_CHECK_TITLE_MAX);
    const plain = of({ proof: PROCEED });
    for (const bad of [{ ...verdict, heading: "a<b" }, { ...verdict, heading: "x".repeat(ROVARA_CHECK_TITLE_MAX + 1) }, { ...verdict, body: ["<!-- hide -->"] }, { ...verdict, body: ["a\nb"] }, { ...verdict, extra: 1 }, { ...verdict, body: Array.from({ length: 601 }, () => "x") }, "not an object"]) {
      const dropped = of({ proof: PROCEED, verdict: bad as never });
      expect(dropped).toEqual(plain);
      expect(JSON.stringify(dropped)).not.toContain("hide");
    }
    // Even for a held draft: a malformed verdict never turns a failure into a neutral Check.
    expect(of({ proof: HELD, verdict: { ...verdict, heading: "a<b" } }).conclusion).toBe("failure");
  });
});
