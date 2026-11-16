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
  it("not judged yet: in progress, no conclusion", () => {
    expect(of({})).toMatchObject({ status: "in_progress" });
    expect(of({}).conclusion).toBeUndefined();
  });
  it("ready, the first line holds: success", () => {
    expect(of({ proof: PROCEED })).toMatchObject({ status: "completed", conclusion: "success" });
  });
  it("a proof warning (preset warns, or the hold relaxed) is still success, and says so", () => {
    const warned = of({ proof: { ...PROCEED, warns: true, reasons: ["changed_code_not_run"] } });
    expect(warned.conclusion).toBe("success");
    expect(warned.text).toContain("no test ran the changed code");
    const relaxed = of({ proof: { ...PROCEED, warns: true, relaxed: true, reasons: ["proof_failed"] } });
    expect(relaxed.conclusion).toBe("success");
    expect(relaxed.text).toContain("More than 10%");
  });
  it("held: failure, with the hold's own words", () => {
    const held = of({ proof: HELD });
    expect(held).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(held.title).toContain("Held as a draft");
    expect(held.text).toContain("the new tests pass on the old code too");
  });
  it("held, then marked ready anyway: success, 'overridden by <person>' in the title", () => {
    const over = of({ proof: HELD, override: { by: "Priya" } });
    expect(over).toMatchObject({ status: "completed", conclusion: "success" });
    expect(over.title).toContain("overridden by Priya");
  });
  it("ready with nothing proven claims no proof: the title is only 'Ready'", () => {
    expect(of({ proof: { ...PROCEED, provenCount: 0 } })).toMatchObject({ conclusion: "success", title: "Ready" });
  });
  it("an override with no hold changes nothing", () => {
    expect(of({ proof: PROCEED, override: { by: "Priya" } }).title).not.toContain("overridden");
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
  it("a Rovara problem is neutral even over a hold: a Rovara fault never blocks a merge", () => {
    expect(of({ problem: "rovara_problem", proof: HELD }).conclusion).toBe("neutral");
    expect(of({ problem: "not_run", proof: HELD }).conclusion).toBe("neutral");
  });
  it("a hold is failure even when the customer's CI is not readable or absent (the hold is Rovara's own verdict)", () => {
    expect(of({ ci: "unreadable", proof: HELD }).conclusion).toBe("failure");
    expect(of({ ci: "none", proof: HELD }).conclusion).toBe("failure");
  });
  it("the full suite: pending is in progress, failed is failure, not run is neutral, passed lets the proof decide", () => {
    expect(of({ proof: PROCEED, fullSuite: "pending" })).toMatchObject({ status: "in_progress" });
    expect(of({ proof: PROCEED, fullSuite: "failed" }).conclusion).toBe("failure");
    expect(of({ proof: PROCEED, fullSuite: "not_run" }).conclusion).toBe("neutral");
    expect(of({ proof: PROCEED, fullSuite: "passed" }).conclusion).toBe("success");
    expect(of({ proof: PROCEED, fullSuite: "pending" }).text).toContain("Full suite");
  });
  it("a failed full suite is failure even with an override of the proof hold (the override is for the proof only)", () => {
    expect(of({ proof: HELD, override: { by: "Priya" }, fullSuite: "failed" }).conclusion).toBe("failure");
  });
  it("in progress for longer than the stale limit: neutral, 'Rovara could not finish'", () => {
    const stale = of({ nowMs: T0 + ROVARA_CHECK_STALE_MS + 1 });
    expect(stale).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(stale.title).toContain("Rovara could not finish");
    expect(of({ nowMs: T0 + ROVARA_CHECK_STALE_MS }).status).toBe("in_progress");
    expect(of({ proof: PROCEED, fullSuite: "pending", nowMs: T0 + ROVARA_CHECK_STALE_MS + 1 }).conclusion).toBe("neutral");
  });
  it("stopped following (the task left tracking) while in progress: neutral", () => {
    expect(of({ stopped: true })).toMatchObject({ status: "completed", conclusion: "neutral" });
  });
  it("stopped does not change a run that already finished", () => {
    expect(of({ stopped: true, proof: PROCEED }).conclusion).toBe("success");
    expect(of({ stopped: true, proof: HELD }).conclusion).toBe("failure");
  });
});

describe("words and bounds", () => {
  it("the name is 'Rovara'", () => {
    expect(ROVARA_CHECK_NAME).toBe("Rovara");
  });
  it("sections appear only for what ran", () => {
    expect(of({ proof: PROCEED }).text).not.toContain("Full suite");
    expect(of({ proof: PROCEED }).text).toContain("Change proof");
  });
  it("the override name is made inert: no mention, no link, no markup, bounded", () => {
    const hostile = of({ proof: HELD, override: { by: `@everyone [x](https://evil.example) <img src=x> ${"a".repeat(500)}` } });
    expect(hostile.title).not.toMatch(/@everyone|https:\/\/evil|<img/u);
    expect(Array.from(hostile.title).length).toBeLessThanOrEqual(ROVARA_CHECK_TITLE_MAX);
  });
  it("the override name never carries a secret", () => {
    const leaked = of({ proof: HELD, override: { by: "ghp_" + "A".repeat(36) } });
    expect(JSON.stringify(leaked)).not.toContain("A".repeat(36));
  });
  it("summary and text are within GitHub's 65,535 characters", () => {
    const all = of({ proof: { ...PROCEED, warns: true, reasons: ["proof_failed", "changed_code_not_run", "test_absent_on_new", "flaky_on_change"] }, fullSuite: "pending" });
    expect(all.summary.length).toBeLessThanOrEqual(ROVARA_CHECK_TEXT_MAX);
    expect(all.text.length).toBeLessThanOrEqual(ROVARA_CHECK_TEXT_MAX);
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
  it("not an object at all is the same refusal", () => {
    expect(rovaraCheckOf(undefined as unknown as RovaraCheckInput).conclusion).toBe("neutral");
  });
});

describe("Rovara's own Check is never read as the customer's CI", () => {
  const status = (checks: ChangeRequestStatus["checks"], requiredChecks: ChangeRequestStatus["requiredChecks"]): ChangeRequestStatus => ({
    id: "1", state: "open", draft: true, headRevision: "a".repeat(40), targetBranch: "main", mergeableState: "clean", checks, requiredChecks, targetHasRequiredChecks: requiredChecks.length > 0, headDefinesChecks: true,
    requestedReviewers: 0, reviews: [],
  } as unknown as ChangeRequestStatus);
  const unit = { name: "unit", state: "completed", conclusion: "success", required: true, url: "", source: "15368" } as const;
  const ours = { name: "Rovara", state: "completed", conclusion: "failure", required: true, url: "", source: "999" } as const;
  it("drops Rovara's own check and the required entry it would meet", () => {
    const out = withoutOwnRovaraCheck(status([unit, ours], [{ name: "unit" }, { name: "Rovara" }]), "999");
    expect(out.checks.map((check) => check.name)).toEqual(["unit"]);
    expect(out.requiredChecks).toEqual([{ name: "unit" }]);
    expect(out.targetHasRequiredChecks).toBe(true);
  });
  it("drops a required 'Rovara' that names our source, keeps one that names another app", () => {
    const out = withoutOwnRovaraCheck(status([unit], [{ name: "Rovara", source: "999" }, { name: "Rovara", source: "123" }]), "999");
    expect(out.requiredChecks).toEqual([{ name: "Rovara", source: "123" }]);
  });
  it("keeps a check named 'Rovara' from another app (a customer's own job)", () => {
    const theirs = { ...ours, source: "123" };
    expect(withoutOwnRovaraCheck(status([theirs], []), "999").checks).toEqual([theirs]);
  });
  it("a check with no source is never taken for ours", () => {
    const sourceless = { name: "Rovara", state: "completed", conclusion: "success", required: false, url: "" } as const;
    expect(withoutOwnRovaraCheck(status([sourceless], []), "999").checks).toHaveLength(1);
  });
  it("the only required check being ours leaves no required checks", () => {
    const out = withoutOwnRovaraCheck(status([{ ...unit, required: false }, ours], [{ name: "Rovara" }]), "999");
    expect(out.requiredChecks).toEqual([]);
    expect(out.targetHasRequiredChecks).toBe(false);
    expect(out.checks.every((check) => check.name !== "Rovara")).toBe(true);
  });
  it("a required 'Rovara' with no source is kept while Rovara's own Check is not on the head (a customer's own job of that name is still waited for)", () => {
    const out = withoutOwnRovaraCheck(status([unit], [{ name: "Rovara" }]), "999");
    expect(out.requiredChecks).toEqual([{ name: "Rovara" }]);
  });
  it("no source known: the status is returned unchanged (same object)", () => {
    const input = status([unit, ours], [{ name: "Rovara" }]);
    expect(withoutOwnRovaraCheck(input, undefined)).toBe(input);
  });
});
