// Lane L4-C B1: the verdict object of a pull request (packages/contracts/src/pr-verdict.ts). Trust-critical: it decides which facts may never be left inside a fold. One table row per exception of design 2.3, and one test (with a
// named mutant it kills, listed in the comment above it) per rule V1 to V9 of the module.
import { describe, expect, it } from "vitest";
import { rovaraCheckOf } from "../../packages/contracts/src/rovara-check.js";
import { PR_EXCEPTION_KINDS, prVerdictForCheck, prVerdictMarkdown, prVerdictOf, VERDICT_RESULT_WORDS, type PrExceptionKind, type PrVerdict, type PrVerdictInput, type VerdictCheckRow } from "../../packages/contracts/src/pr-verdict.js";
import { EvidenceDependencySchema, type EvidenceDependency } from "../../packages/contracts/src/evidence.js";

const AS_OF = "2026-11-17T12:00:00.000Z";
const pass = (label: string, passedTests?: number): VerdictCheckRow => ({ label, status: "passed", ...(passedTests === undefined ? {} : { passedTests }) });
const dep = (over: Partial<EvidenceDependency> & Pick<EvidenceDependency, "name" | "label" | "backing">): EvidenceDependency => over;
const POSTGRES = dep({ name: "Postgres", backing: "project_image", label: "real_project_image" });
const STRIPE_FRESH = dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", approvedAt: "2026-10-14T00:00:00.000Z", fixtureRevision: 3 });

/** The typical green task of design example 1. */
function green(over: Partial<PrVerdictInput> = {}): PrVerdictInput {
  return {
    asOf: AS_OF, testing: { result: "verified" }, checks: [pass("Unit tests", 176), pass("Integration tests", 38), pass("Lint"), pass("Type check")],
    requirements: [1, 2, 3].map((n) => ({ id: `R${n}`, text: `Requirement ${n}`, result: "proven" as const })),
    dependencies: [POSTGRES, STRIPE_FRESH], testedIn: "sandbox",
    changed: { source: "host", files: 4, added: 86, removed: 12, complete: true, testsAdded: 3, codeChanged: true },
    risk: { level: "low", reasons: ["A small change with no sensitive paths, dependency changes or open concerns."], judged: true },
    reviews: { code: "passed", security: "passed", accepted: [], partialDiff: false, sameModel: false },
    secondReview: { state: "agreed" }, ...over,
  };
}
const verdict = (over: Partial<PrVerdictInput> = {}): PrVerdict => prVerdictOf(green(over));
const kinds = (v: PrVerdict): PrExceptionKind[] => v.items.map((item) => item.kind);
/** Everything a reader sees without opening a fold: the heading, the six lines, the list. */
const aboveFold = (v: PrVerdict): string => [v.heading, v.lines.changed, v.lines.proven, v.lines.testedAgainst, v.lines.reviews, ...v.lines.risk, v.lines.needsYou, ...v.items.flatMap((item) => [item.title, item.detail, ...item.lines])].join("\n");

describe("the typical green task (design example 1)", () => {
  it("accepts additive approval provenance while retaining legacy rows without it", () => {
    expect(EvidenceDependencySchema.safeParse(STRIPE_FRESH).success).toBe(true);
    const legacy = { ...STRIPE_FRESH };
    delete legacy.approvedAt;
    expect(EvidenceDependencySchema.safeParse(legacy).success).toBe(true);
  });
  it("says Verified, low risk and nothing extra to check, with the six lines", () => {
    const v = verdict();
    expect(v.heading).toBe("Verified · Low risk · nothing extra to check");
    expect(v.count).toBe(0);
    expect(v.items).toEqual([]);
    expect(v.lines.changed).toBe("4 files, +86 -12. 3 tests added.");
    expect(v.lines.proven).toBe("3 of 3 requirements proven.");
    expect(v.lines.testedAgainst).toBe("Postgres (real, the project's image). Stripe (recorded fake, approved 34 days ago).");
    expect(v.lines.reviews).toBe("Code review and security review passed. The second review found no blocking finding.");
    expect(v.lines.risk).toEqual(["Low. A small change with no sensitive paths, dependency changes or open concerns."]);
    expect(v.lines.needsYou).toBe("The normal code review. Nothing else.");
    expect(v.drawers).toEqual({
      requirements: "Requirements and proof: 3 of 3 proven", checks: "Checks: 4 of 4 passed (214 tests)", setup: "Test setup: sandbox, 1 real service, 1 recorded fake, Stripe recorded fake, approved 34 days ago", reviews: "Reviews: 2 passed, 0 findings accepted, second review found no blocking finding",
    });
  });
  it("drawers for browser evidence and what Rovara used appear only when there is something", () => {
    expect(verdict().drawers.screenshots).toBeUndefined();
    expect(verdict().drawers.used).toBeUndefined();
    expect(verdict({ used: { lessons: 0, wikiPages: 0 } }).drawers.used).toBeUndefined();
    expect(verdict({ browser: { pages: 3, problems: [] }, used: { lessons: 2, wikiPages: 3 } }).drawers).toMatchObject({ screenshots: "Screenshots: 3 pages on the task page", used: "What Rovara used: 2 lessons, 3 wiki pages" });
  });
});

// One case per exception of design 2.3. Each must produce its kind, count it in the heading, and print it above the fold.
// Mutant X1: an exception is built but left out of `items` (only a drawer says it). Killed by the table (kind present) and by the completeness check below.
const TABLE: Array<[PrExceptionKind, Partial<PrVerdictInput>]> = [
  ["review_only", { testing: undefined, checks: [], reviewOnly: { why: "Documentation only" } }],
  ["check_failed", { testing: { result: "code_failed", reasons: ["check_failed"] }, checks: [{ label: "Integration tests", status: "failed", reason: "check_failed" }, pass("Lint")] }],
  ["check_blocked", { testing: { result: "blocked_by_environment", reasons: ["timed_out"] }, checks: [{ label: "Unit tests", status: "blocked", reason: "timed_out" }] }],
  ["check_not_run", { testing: { result: "partially_verified", reasons: ["check_not_run"] }, checks: [pass("Lint"), { label: "Browser tests", status: "not_run", reason: "check_not_run" }] }],
  ["check_already_failing", { testing: { result: "partially_verified", reasons: ["known_failing_only"] }, checks: [{ label: "Legacy suite", status: "known_failing", reason: "known_failing_only" }] }],
  ["check_made_by_rovara", { checks: [{ ...pass("Unit tests"), madeByRovara: true }] }],
  ["testing_reason", { testing: { result: "partially_verified", reasons: ["full_suite_pending"] } }],
  ["requirements_pending", { requirements: undefined, requirementsPending: true }],
  ["other_not_tested", { notTested: [{ kind: "scenario", text: "Checkout flow (a linked check or scenario did not run)" }] }],
  ["requirement_failed", { requirements: [{ id: "R3", text: "A refund above the captured amount is refused", result: "failed" }] }],
  ["requirement_partly_tested", { requirements: [{ id: "R1", text: "One", result: "partly_tested" }] }],
  ["requirement_not_tested", { requirements: [{ id: "R1", text: "One", result: "not_tested" }] }],
  ["requirement_not_proven", { requirements: [{ id: "R2", text: "A partial refund is sent", result: "passed", notProvenReason: "made_by_rovara" }] }],
  ["code_without_tests", { changed: { source: "host", files: 2, added: 9, removed: 1, complete: true, testsAdded: 0, codeChanged: true } }],
  ["service_not_available", { dependencies: [dep({ name: "Kafka", backing: "none", label: "not_available", testsNotRun: 4 })] }],
  ["service_made_by_rovara", { dependencies: [dep({ name: "Stripe", backing: "fake", label: "rovara_made_fake" })] }],
  ["service_hand_written", { dependencies: [dep({ name: "Stripe", backing: "fake", label: "hand_written_fake" })] }],
  ["service_made_up_answers", { dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", madeUpAnswers: 2 })] }],
  ["service_fell_back", { dependencies: [dep({ name: "Stripe", backing: "fake", label: "hand_written_fake", fellBack: { from: "test_account", reason: "test_account_expired" } })] }],
  ["service_emulated", { dependencies: [dep({ name: "S3", backing: "emulated", label: "rovara_local_aws" })] }],
  ["service_old_fake", { dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-07-02T00:00:00.000Z" })] }],
  ["service_spec_check", { dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", mockSpecResult: "mismatch", mockSpecVendor: "stripe" })] }],
  ["tests_weaker", { weakening: { weaker: ["Snapshot files changed: tests/orders/__snapshots__/order-page.snap"], flags: [], notCompared: [] } }],
  ["weakening_not_compared", { weakening: { weaker: [], flags: [], notCompared: ["Test weakening: could not compare (the test proof did not run for this code)"] } }],
  ["flagged_files", { weakening: { weaker: [], flags: ["Rovara instruction files changed (a flag, not an approval): CLAUDE.md"], notCompared: [] } }],
  ["finding_accepted", { reviews: { ...green().reviews, accepted: [{ role: "SECURITY", text: "Amount is not checked", reason: "Handled by the provider", by: "Dana K." }] } }],
  ["second_review_blocking", { secondReview: { state: "blocking", count: 1, model: "openai/model-b", findings: [{ text: "The refund amount is not checked", file: "src/payments/refund.ts", line: 88 }] } }],
  ["second_review_not_run", { secondReview: { state: "did_not_run", reasonLine: "Second review did not run: no other company's model is available" } }],
  ["reviews_partial", { reviews: { ...green().reviews, partialDiff: true } }],
  ["review_same_model", { reviews: { ...green().reviews, sameModel: true } }],
  ["flaky_rerun", { flakyReruns: 2 }],
  ["browser_problem", { browser: { pages: 1, problems: ["- `/invoice`: Not run: the app did not start"] } }],
  ["eval_worse", { evalCheck: { label: "Worse on eval", promptChanged: true } }],
  ["eval_prompt_without_run", { evalCheck: { label: "Not run", promptChanged: true } }],
  ["eval_no_run", { noEval: { reason: "not_a_prompt_change" } }],
  ["files_incomplete", { changed: { source: "host", files: 40, added: 1, removed: 1, complete: false, testsAdded: 1, codeChanged: true } }],
  ["files_not_read", { changed: undefined, risk: { level: "high", reasons: [], judged: false } }],
  ["merge_order", { mergeOrder: ["Merge the app pull request first, then the docs pull request."] }],
];

describe("every exception of design 2.3 is an item above the fold, counted in the heading (rule V3)", () => {
  it.each(TABLE)("%s", (kind, over) => {
    const v = verdict(over);
    expect(kinds(v)).toContain(kind);
    const item = v.items.find((entry) => entry.kind === kind)!;
    expect(item.title.length).toBeGreaterThan(0);
    expect(v.count).toBe(v.items.length);
    expect(v.heading).toContain(`${v.count} ${v.count === 1 ? "thing" : "things"} to check`);
    expect(aboveFold(v)).toContain(item.title);
    // The first item is first, in the page's order: what failed comes before what is merely weaker.
    expect(v.lines.needsYou).toContain("below");
  });
  it("the table covers every kind the module can produce, and the module produces no other", () => {
    expect(new Set(TABLE.map(([kind]) => kind))).toEqual(new Set(PR_EXCEPTION_KINDS));
    const produced = new Set(TABLE.flatMap(([, over]) => kinds(verdict(over))));
    for (const kind of produced) expect(PR_EXCEPTION_KINDS).toContain(kind);
  });
  it("the green task and its quiet parts produce no item at all (silent when fine)", () => {
    expect(verdict().items).toEqual([]);
    expect(verdict({ weakening: { weaker: [], flags: [], notCompared: [] }, mergeOrder: [], evalCheck: { label: "Improved on eval", promptChanged: true } }).items).toEqual([]);
    expect(verdict({ evalCheck: { label: "Not run", promptChanged: false } }).items).toEqual([]);
    expect(verdict({ changed: { source: "host", files: 3, added: 1, removed: 0, complete: true, testsAdded: 0, codeChanged: false } }).items).toEqual([]);
  });
  it("items are ordered with failures first (design 2.5: the failed check is item 1, the snapshot last)", () => {
    const v = verdict({
      checks: [{ label: "Integration tests", status: "failed", reason: "check_failed" }], testing: { result: "code_failed", reasons: ["check_failed"] },
      weakening: { weaker: ["Snapshot files changed: a.snap"], flags: [], notCompared: [] },
      secondReview: { state: "blocking", count: 1, findings: [{ text: "x" }] }, dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-07-02T00:00:00.000Z" })],
    });
    expect(kinds(v)).toEqual(["check_failed", "service_old_fake", "tests_weaker", "second_review_blocking"]);
  });
});

describe("rule V1: the result is never better than its worst row", () => {
  // Mutant X2: the result is taken from the Testing view alone, so a failed row can still read "Verified". Killed by the first two cases.
  it("a Testing view that says verified cannot outvote a failed or blocked row", () => {
    const failed = verdict({ testing: { result: "verified" }, checks: [pass("Unit tests"), { label: "Lint", status: "failed" }] });
    expect(failed.result).toBe("Code failed");
    expect(failed.heading.startsWith("Code failed")).toBe(true);
    expect(verdict({ testing: { result: "verified" }, checks: [{ label: "Lint", status: "blocked", reason: "timed_out" }] }).result).toBe("Blocked by environment");
    expect(verdict({ testing: { result: "verified" }, checks: [pass("a"), { label: "b", status: "pending", reason: "full_suite_pending" }] }).result).toBe("Partially verified");
    expect(verdict({ testing: { result: "verified" }, checks: [] }).result).toBe("Partially verified");
  });
  it("the worse of the view's result and the rows' result is used, in either direction", () => {
    expect(verdict({ testing: { result: "code_failed", reasons: ["check_failed"] }, checks: [pass("a")] }).resultKind).toBe("code_failed");
    expect(verdict({ testing: { result: "blocked_by_environment", reasons: ["timed_out"] }, checks: [{ label: "x", status: "failed" }] }).resultKind).toBe("code_failed");
  });
  it("with no Testing view the words are the fixed ones and never Verified", () => {
    const v = verdict({ testing: undefined });
    expect(v.result).toBe(VERDICT_RESULT_WORDS.checks_passed);
    expect(v.heading).not.toContain("Verified");
    expect(verdict({ testing: undefined, checks: [pass("a"), { label: "b", status: "failed" }] }).result).toBe("Checks failed");
    expect(verdict({ testing: undefined, checks: [{ label: "b", status: "blocked", reason: "timed_out" }] }).result).toBe("Checks could not run");
    expect(verdict({ testing: undefined, checks: [pass("a"), { label: "b", status: "not_run", reason: "check_not_run" }] }).result).toBe("Some checks did not run");
    expect(verdict({ testing: undefined, checks: [] }).result).toBe("No checks recorded");
  });
  it("a review-only task says it was not verified by automated checks", () => {
    const v = verdict({ testing: undefined, checks: [], reviewOnly: { why: "Documentation only" } });
    expect(v.result).toBe("Not verified by automated checks (review only)");
    expect(v.items[0]).toMatchObject({ kind: "review_only", detail: "Why: Documentation only" });
  });
});

describe("rule V2: proven means proven", () => {
  // Mutant X3: a requirement marked proven that carries a not-proven reason (a Rovara-made mock) is counted in "n of m proven". Killed here.
  it("a pass against a Rovara-made mock is counted as passed, never proven, even when the row says proven", () => {
    const v = verdict({ requirements: [{ id: "R1", text: "one", result: "proven" }, { id: "R2", text: "two", result: "proven", notProvenReason: "made_by_rovara" }, { id: "R3", text: "three", result: "passed", notProvenReason: "agent_replies_unconfirmed" }] });
    expect(v.lines.proven).toBe("1 of 3 requirements proven. 2 passed but are not proven.");
    expect(v.drawers.requirements).toBe("Requirements and proof: 1 of 3 proven, 2 passed but not proven");
    expect(kinds(v)).toContain("requirement_not_proven");
    expect(v.items.find((item) => item.kind === "requirement_not_proven")!.lines.join("\n")).toContain("Rovara-made mock");
  });
  it("a failed, partly tested and not tested requirement each keep their words in the line and the drawer", () => {
    const v = verdict({ requirements: [
      { id: "R1", text: "a", result: "proven" }, { id: "R2", text: "b", result: "failed" }, { id: "R3", text: "c", result: "partly_tested" }, { id: "R4", text: "d", result: "not_tested" }, { id: "R5", text: "e", result: "passed" },
    ] });
    expect(v.lines.proven).toBe("1 of 5 requirements proven. 1 failed. 1 only partly tested. 1 not tested.");
    expect(v.drawers.requirements).toBe("Requirements and proof: 1 of 5 proven, 1 failed, 1 partly tested, 1 not tested");
  });
  it("a task with no approved requirements says so and has no requirements drawer", () => {
    const v = verdict({ requirements: undefined });
    expect(v.lines.proven).toBe("No approved requirements to prove.");
    expect(v.drawers.requirements).toBeUndefined();
  });
  it("a check a Rovara-made mock answered is counted apart in the Checks drawer, not as a plain pass", () => {
    const v = verdict({ checks: [pass("a"), { ...pass("b"), madeByRovara: true }] });
    expect(v.drawers.checks).toBe("Checks: 2 of 2 passed, 1 with a Rovara-made mock");
  });
  it("the eval label is part of the Proven line", () => {
    expect(verdict({ evalCheck: { label: "Improved on eval", promptChanged: true } }).lines.proven).toBe("3 of 3 requirements proven. Improved on eval.");
    expect(verdict({ evalCheck: { label: "No regression measured", promptChanged: true } }).lines.proven).toContain("No regression measured.");
  });
});

describe("rule V4: every service is named, and only the quiet fake is quiet", () => {
  // Mutant X4: a mocked service is missing from the "Tested against" line. Killed by the loop below.
  it("every kind of dependency is named on the Tested against line with its label", () => {
    const all: EvidenceDependency[] = [
      POSTGRES, STRIPE_FRESH, dep({ name: "Kafka", backing: "none", label: "not_available" }), dep({ name: "Mailer", backing: "fake", label: "rovara_made_fake" }), dep({ name: "Search", backing: "fake", label: "hand_written_fake" }),
      dep({ name: "S3", backing: "emulated", label: "rovara_local_aws" }), dep({ name: "Redis", backing: "local", label: "company_approved", imageDigest: "a".repeat(64) }), dep({ name: "GitHub", backing: "test_account", label: "test_account" }),
      dep({ name: "Maps", backing: "vendor_test", label: "vendor_test" }), dep({ name: "Clock", backing: "none", label: "faked_by_tests" }),
    ];
    const line = verdict({ dependencies: all }).lines.testedAgainst;
    for (const entry of all) expect(line, entry.name).toContain(entry.name);
    expect(line).toContain("Mailer (fake made by Rovara)");
    expect(line).toContain("Search (fake written by hand)");
    expect(line).toContain("Kafka (not available)");
    expect(line).toContain("S3 (emulated, not real AWS)");
    expect(line).toContain("Clock (faked by the tests themselves)");
  });
  it("a fresh recorded fake with no made-up answer is named and quiet", () => {
    const v = verdict({ dependencies: [STRIPE_FRESH] });
    expect(v.lines.testedAgainst).toContain("Stripe (recorded fake, approved 34 days ago)");
    expect(v.drawers.setup).toContain("Stripe recorded fake, approved 34 days ago");
    expect(v.items).toEqual([]);
  });
  it("uses capture date wording for older evidence without approval provenance", () => {
    const legacy = dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z" });
    expect(verdict({ dependencies: [legacy] }).lines.testedAgainst).toContain("Stripe (recorded fake, recorded 34 days ago)");
    expect(kinds(verdict({ dependencies: [legacy] }))).toEqual([]);
  });
  it("a recorded fake over 90 days old, or with no date, is an item; 90 days exactly is still quiet", () => {
    const at = (days: number) => dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString() });
    expect(kinds(verdict({ dependencies: [at(90)] }))).toEqual([]);
    expect(kinds(verdict({ dependencies: [at(91)] }))).toEqual(["service_old_fake"]);
    expect(kinds(verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake" })] }))).toEqual(["service_old_fake"]);
    expect(verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake" })] }).lines.testedAgainst).toContain("date unknown");
  });
  it("uses approval age for the old fake rule even when the capture was recent", () => {
    const approvedLongAgo = dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-11-16T00:00:00.000Z", approvedAt: "2026-08-18T12:00:00.000Z" });
    expect(verdict({ dependencies: [approvedLongAgo] }).lines.testedAgainst).toContain("approved 91 days ago");
    expect(kinds(verdict({ dependencies: [approvedLongAgo] }))).toEqual(["service_old_fake"]);
  });
  it("keeps an approval exactly 90 days old quiet even when its capture is older", () => {
    const approvedAtBoundary = dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: new Date(Date.parse(AS_OF) - 200 * 86_400_000).toISOString(), approvedAt: new Date(Date.parse(AS_OF) - 90 * 86_400_000).toISOString() });
    const v = verdict({ dependencies: [approvedAtBoundary] });
    expect(kinds(v)).toEqual([]);
    expect(v.lines.testedAgainst).toContain("approved 90 days ago");
  });
  it("uses neutral age wording for an old mixed set of approved and legacy fakes", () => {
    const approved = dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-11-16T00:00:00.000Z", approvedAt: "2026-08-18T12:00:00.000Z" });
    const legacy = dep({ name: "Mailer", backing: "fake", label: "recorded_fake", recordedAt: "2026-08-18T12:00:00.000Z" });
    const item = verdict({ dependencies: [approved, legacy] }).items.find((entry) => entry.kind === "service_old_fake")!;
    expect(item.detail).not.toContain("Approved");
    expect(item.lines).toContain("Stripe: approved 91 days before this pull request");
    expect(item.lines).toContain("Mailer: recorded 91 days before this pull request");
  });
  it("made-up answers and a fallback are in the Tested against line as well as the list", () => {
    const v = verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", madeUpAnswers: 2, fellBack: { from: "test_account", reason: "test_account_busy" } })] });
    expect(v.lines.testedAgainst).toContain("2 made-up answers");
    expect(v.lines.testedAgainst).toContain("fell back: test account busy");
    expect(kinds(v)).toEqual(["service_made_up_answers", "service_fell_back"]);
  });
  it("no recorded dependency says so, never nothing", () => {
    expect(verdict({ dependencies: undefined }).lines.testedAgainst).toBe("Rovara has no record of which services the checks used.");
    expect(verdict({ dependencies: [] }).lines.testedAgainst).toBe("Rovara has no record of which services the checks used.");
  });
  it("the setup drawer counts every kind of service and says an old fake is old", () => {
    const v = verdict({ dependencies: [POSTGRES, dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-07-02T00:00:00.000Z" }), dep({ name: "Mailer", backing: "fake", label: "rovara_made_fake" })] });
    expect(v.drawers.setup).toBe("Test setup: sandbox, 1 real service, 1 old recorded fake, 1 fake made by Rovara, Stripe recorded fake, recorded 138 days ago");
  });
});

describe("rules V5 and V6: risk", () => {
  // Mutant X5: the risk level printed is the one given even when the files were not judged from the code host (a worker's list lowers it). Killed here.
  it("risk that was not judged from the host's file list is high, whatever level was given", () => {
    const v = verdict({ risk: { level: "low", reasons: ["A small change"], judged: false } });
    expect(v.riskLevel).toBe("high");
    expect(v.riskJudged).toBe(false);
    expect(v.heading).toBe("Verified · Risk not judged yet (treated as high) · nothing extra to check");
    expect(v.lines.needsYou).toContain("Merging needs a fresh sign-in (high risk)");
    expect(v.lines.needsYou).not.toContain("Nothing else");
  });
  it("a mock spec mismatch raises risk one level and adds the PR thing to check", () => {
    const v = verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", mockSpecResult: "mismatch", mockSpecVendor: "stripe" })] });
    expect(v.riskLevel).toBe("medium");
    expect(v.heading).toContain("Medium risk · 1 thing to check");
    expect(v.items.find((item) => item.kind === "service_spec_check")?.lines).toContain("Stripe: does not match Stripe's published API; check this mock.");
  });
  it("a mock spec mismatch raises medium risk to high", () => {
    const v = verdict({
      dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", mockSpecResult: "mismatch", mockSpecVendor: "stripe" })],
      risk: { level: "medium", reasons: ["A medium-risk change."], judged: true },
    });
    expect(v.riskLevel).toBe("high");
    expect(v.heading).toContain("High risk · 1 thing to check");
  });
  it("keeps catalog entries without a matching operation explicit and nonblocking", () => {
    const v = verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", mockSpecResult: "no_spec", mockSpecVendor: "stripe" })] });
    expect(v.riskLevel).toBe("low");
    expect(v.items.find((item) => item.kind === "service_spec_check")?.lines).toContain("Stripe: no published spec to check against.");
  });
  it("a file list read from the host but not judged is not 'still reading'", () => {
    expect(verdict({ risk: { level: "low", reasons: [], judged: false } }).lines.risk[0]).toBe("Not judged from the code host's list of changed files, so it counts as high.");
  });
  it("a file list the worker reported is not checked, is high risk and is one item; it never lowers the risk or the count", () => {
    const v = verdict({ changed: { source: "worker", files: 1, added: 1, removed: 0, complete: true, testsAdded: 1, codeChanged: true }, risk: { level: "low", reasons: [], judged: true } });
    expect(v.riskLevel).toBe("high");
    expect(v.lines.changed).toBe("Reported by the worker, not checked against the code host.");
    expect(v.lines.changed).not.toMatch(/\d/u);
    expect(kinds(v)).toEqual(["files_not_read"]);
  });
  it("a fresh pull request counts the unread files once (no second Risk is High item)", () => {
    const v = verdict({ changed: undefined, risk: { level: "high", reasons: ["Rovara couldn't read which files changed."], judged: false } });
    expect(kinds(v)).toEqual(["files_not_read"]);
    expect(v.lines.changed).toBe("The changed files have not been read yet.");
    expect(v.heading).toContain("Risk not judged yet (treated as high)");
  });
  it("a judged high risk is in the heading, the Risk line and Needs you, with every reason above the fold", () => {
    const reasons = ["Changes sensitive paths: src/payments/refund.ts.", "1 check failed on the latest code.", "A mock is out of date.", "The owner accepted a security review finding."];
    const v = verdict({ risk: { level: "high", reasons, judged: true } });
    expect(v.heading).toContain("High risk");
    expect(v.lines.risk[0]).toBe("High. Changes sensitive paths: src/payments/refund.ts.");
    for (const reason of reasons) expect(aboveFold(v)).toContain(reason);
    expect(v.lines.needsYou).toContain("fresh sign-in");
    expect(v.lines.needsYou).not.toContain("Nothing else");
    expect(verdict({ risk: { level: "medium", reasons: ["A big change"], judged: true } }).lines.needsYou).not.toContain("fresh sign-in");
  });
  it("the file count line says 'or more' and 'at least' when the list or the counts are partial", () => {
    expect(verdict({ changed: { source: "host", files: 40, added: 5, removed: 1, complete: false, testsAdded: 0, codeChanged: false } }).lines.changed).toBe("40 or more files, +5 -1; the list may be incomplete.");
    expect(verdict({ changed: { source: "host", files: 3, added: 5, removed: 1, uncounted: 1, complete: true, codeChanged: false } }).lines.changed).toBe("3 files, at least +5 -1.");
    expect(verdict({ changed: { source: "host", files: 1, added: 5, removed: 1, complete: true, codeChanged: false } }).lines.changed).toBe("1 file, +5 -1.");
  });
  it("a code change with no test is an item only when the list is whole and from the host", () => {
    const base = { files: 2, added: 9, removed: 1, testsAdded: 0, codeChanged: true } as const;
    expect(kinds(verdict({ changed: { ...base, source: "host", complete: true } }))).toEqual(["code_without_tests"]);
    expect(kinds(verdict({ changed: { ...base, source: "host", complete: false } }))).toEqual(["files_incomplete"]);
  });
});

describe("rule V7: the second review", () => {
  // Mutant X6: "agreed" is said when no second review was passed (a shadow one, or none). Killed by the first case.
  it("says nothing about a second review when none is passed (shadow, or not wanted)", () => {
    const v = verdict({ secondReview: undefined });
    expect(v.lines.reviews).toBe("Code review and security review passed.");
    expect(v.drawers.reviews).toBe("Reviews: 2 passed, 0 findings accepted");
    expect(v.lines.reviews).not.toMatch(/second/iu);
  });
  it("an agreeing second review is 'no blocking finding', never an approval", () => {
    const v = verdict();
    expect(v.lines.reviews).toContain("The second review found no blocking finding.");
    expect(v.lines.reviews).not.toMatch(/approv/iu);
  });
  it("a blocking second review keeps the first's pass in the line and names the finding in the list", () => {
    const v = verdict({ secondReview: { state: "blocking", count: 2, model: "openai/model-b", findings: [{ text: "The refund amount is not checked", file: "src/payments/refund.ts", line: 88 }] } });
    expect(v.lines.reviews).toContain("Code review and security review passed.");
    expect(v.lines.reviews).toContain("**The second review did not pass.**");
    const item = v.items.find((entry) => entry.kind === "second_review_blocking")!;
    expect(item.detail).toBe("Second review (openai/model-b) has 2 blocking findings.");
    expect(item.lines).toEqual(["The refund amount is not checked (src/payments/refund.ts:88)"]);
    expect(v.drawers.reviews).toContain("second review has 2 blocking findings");
  });
  // Mutant X16: a partial or same-model review is only in the list, not in the Reviews line. Killed here.
  it("a partial review, a same-model review and accepted findings are in the Reviews line as well as the list", () => {
    const v = verdict({ reviews: { ...green().reviews, partialDiff: true, sameModel: true, accepted: [{ role: "CRITIC", text: "x", reason: "y" }] } });
    expect(v.lines.reviews).toContain("**The reviews saw only part of the change.**");
    expect(v.lines.reviews).toContain("**Same model as the build.**");
    expect(v.lines.reviews).toContain("**The owner accepted 1 review finding.**");
  });
  it("a second review that was on and did not run is said above the fold", () => {
    const v = verdict({ secondReview: { state: "did_not_run", reasonLine: "Second review did not run: budget" } });
    expect(v.lines.reviews).toContain("**The second review did not run.**");
    expect(v.items[0]!.detail).toBe("Second review did not run: budget");
  });
});

describe("rule V8: no flag is never no weakening", () => {
  it("a could-not-compare line is an item, and an absent weakening part is not 'none'", () => {
    const v = verdict({ weakening: { weaker: [], flags: [], notCompared: ["Test weakening: could not compare (no test report to compare)"] } });
    expect(v.items[0]).toMatchObject({ kind: "weakening_not_compared", detail: "No flag here does not mean no tests were weakened." });
    expect(aboveFold(verdict())).not.toMatch(/none/iu);
  });
});

describe("rule V9: nothing a repository, person or model wrote can change the page", () => {
  // Mutant X7: a model-written line containing `</details>` or `<summary>` reaches the output as a tag. Killed here for every raw field and every pre-inert line.
  const hostile = `Evil</details><summary>x</summary><!-- hide --> @octocat https://evil.example #123 ENG-42 [x](http://e.example) ![i](http://e.example/i.png)\nnext`;
  // A line a module made inert already keeps its technical words (`V1-2`, `node-22`): the layout seals a Linear closing word before a key over the whole block, so the issue key is left out of those fields here.
  const pre = hostile.replace("ENG-42", "");
  const everything = (): PrVerdict => verdict({
    checks: [{ label: hostile, status: "failed", reason: "check_failed" }], testing: { result: "code_failed", reasons: ["check_failed"] },
    requirements: [{ id: hostile, text: hostile, result: "failed" }, { id: "R2", text: hostile, result: "passed", notProvenReason: "made_by_rovara" }],
    dependencies: [dep({ name: hostile, backing: "fake", label: "rovara_made_fake" }), dep({ name: hostile, backing: "none", label: "not_available", testsNotRun: 1 })],
    weakening: { weaker: [pre], flags: [pre], notCompared: [pre] }, mergeOrder: [pre],
    reviews: { ...green().reviews, accepted: [{ role: "CRITIC", text: hostile, reason: hostile, by: hostile }], },
    secondReview: { state: "blocking", count: 1, model: hostile, findings: [{ text: hostile, file: hostile, line: 3 }] },
    risk: { level: "high", reasons: [pre], judged: true }, reviewOnly: { why: hostile }, testedIn: hostile as never,
  });
  const everyString = (v: PrVerdict): string[] => [v.heading, v.result, v.riskPhrase, v.lines.changed, v.lines.proven, v.lines.testedAgainst, v.lines.reviews, ...v.lines.risk, v.lines.needsYou, ...v.items.flatMap((item) => [item.title, item.detail, ...item.lines]), ...Object.values(v.drawers)];
  it("no output string has a tag, a comment opener, a line break, a link, an image, a bare mention or a bare issue key", () => {
    for (const text of everyString(everything())) {
      expect(text, text).not.toMatch(/[<]/u);
      expect(text, text).not.toMatch(/[\r\n]/u);
      expect(text, text).not.toMatch(/\]\(/u);
      expect(text, text).not.toMatch(/!\[/u);
      expect(text, text).not.toMatch(/@(?!‍)/u);
      expect(text, text).not.toMatch(/:\/\/(?!‍)/u);
      expect(text, text).not.toMatch(/\bENG-\d/u);
    }
  });
  it("a hostile text cannot start a heading, a quote or a list in the list's own lines", () => {
    const v = verdict({ weakening: { weaker: ["# Heading", "> quote", "- item", "1. numbered", "| table |"], flags: [], notCompared: [] }, mergeOrder: ["## Merge", "* star"] });
    for (const line of v.items.flatMap((item) => item.lines)) expect(line, line).not.toMatch(/^(?:[#>|*+-]|\d+[.)])/u);
  });
  it("drawer summaries hold fixed words and counts only: nothing from the hostile fields is in any of them", () => {
    const drawers = Object.values(everything().drawers).join("\n");
    expect(drawers).not.toContain("Evil");
    expect(drawers).not.toContain("octocat");
  });
  it("text is cut: a very long line cannot grow the page", () => {
    const long = "a".repeat(5_000);
    const v = verdict({ weakening: { weaker: [long], flags: [], notCompared: [] }, checks: [{ label: long, status: "failed", reason: "check_failed" }], testing: { result: "code_failed", reasons: ["check_failed"] } });
    for (const text of everyString(v)) expect(Array.from(text).length).toBeLessThanOrEqual(400);
  });
});

describe("bad news is never only in a fold (the drawers repeat counts and result words)", () => {
  // Mutant X8: a drawer summary says "all passed" while an item above says otherwise. Killed here: each bad status must be named in the Checks summary.
  it("the Checks summary carries failed, blocked, not run and already failing counts", () => {
    const v = verdict({ checks: [pass("a"), { label: "b", status: "failed" }, { label: "c", status: "blocked", reason: "timed_out" }, { label: "d", status: "not_run", reason: "check_not_run" }, { label: "e", status: "pending", reason: "full_suite_pending" }, { label: "f", status: "known_failing", reason: "known_failing_only" }] });
    expect(v.drawers.checks).toBe("Checks: 1 of 6 passed, 1 failed, 1 blocked, 2 not run, 1 already failing");
  });
  it("the Reviews summary carries accepted findings, a blocking second review, a partial review and a same-model review", () => {
    const v = verdict({
      reviews: { ...green().reviews, accepted: [{ role: "CRITIC", text: "x", reason: "y" }], partialDiff: true, sameModel: true, code: "passed_after_accepted" },
      secondReview: { state: "blocking", count: 1, findings: [] },
    });
    expect(v.drawers.reviews).toBe("Reviews: 2 passed after accepted findings, 1 finding accepted, second review has 1 blocking finding, saw only part of the change, same model as the build");
  });
  it("design example 2: the heading, six lines and list of a task with a failed check, an old fake, a blocking second review and a changed snapshot", () => {
    const v = verdict({
      testing: { result: "code_failed", reasons: ["check_failed"] }, checks: [{ label: "Integration tests", status: "failed", reason: "check_failed" }, pass("Unit tests", 181), pass("Lint"), pass("Type check")],
      requirements: [{ id: "R1", text: "a", result: "proven" }, { id: "R2", text: "b", result: "passed", notProvenReason: "made_by_rovara" }, { id: "R3", text: "c", result: "failed" }, { id: "R4", text: "d", result: "proven" }],
      dependencies: [POSTGRES, dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-07-02T00:00:00.000Z" })],
      changed: { source: "host", files: 7, added: 231, removed: 40, complete: true, testsAdded: 5, codeChanged: true },
      risk: { level: "high", reasons: ["Changes sensitive paths: src/payments/refund.ts.", "1 check failed on the latest code."], judged: true },
      weakening: { weaker: ["Snapshot files changed: tests/orders/__snapshots__/order-page.snap"], flags: [], notCompared: [] },
      secondReview: { state: "blocking", count: 1, model: "openai/model-b", findings: [{ text: "The refund amount is not checked against the amount already refunded", file: "src/payments/refund.ts", line: 88 }] },
    });
    expect(v.heading).toBe("Code failed · High risk · 6 things to check");
    expect(v.lines.changed).toBe("7 files, +231 -40. 5 tests added.");
    expect(v.lines.proven).toBe("2 of 4 requirements proven. 1 failed. 1 passed but is not proven.");
    expect(v.lines.testedAgainst).toBe("Postgres (real, the project's image). Stripe (recorded fake, recorded 138 days ago).");
    expect(v.lines.reviews).toBe("Code review and security review passed. **The second review did not pass.**");
    expect(kinds(v)).toEqual(["check_failed", "requirement_failed", "requirement_not_proven", "service_old_fake", "tests_weaker", "second_review_blocking"]);
    expect(v.lines.needsYou).toBe("The 6 items below, then the normal code review. Merging needs a fresh sign-in (high risk).");
  });
});

// Findings of the first Opus review (L4-C B1 review): every one has a killing test.
describe("review findings", () => {
  const ALL_OK = (v: PrVerdict) => v.items.length === 0 && v.count === 0;
  // Mutant R1: a result that is not a pass comes with no item, so the page says "nothing extra to check".
  it("a result that is not a pass is never 'nothing extra to check', however it came about", () => {
    const noChecks = verdict({ testing: undefined, checks: [] });
    expect(noChecks.result).toBe("No checks recorded");
    expect(ALL_OK(noChecks)).toBe(false);
    expect(noChecks.heading).not.toContain("nothing extra to check");
    expect(noChecks.lines.needsYou).not.toContain("Nothing else");
    const downgraded = verdict({ testing: { result: "verified" }, checks: [] });
    expect(downgraded.result).toBe("Partially verified");
    expect(kinds(downgraded)).toEqual(["testing_reason"]);
    for (const result of ["code_failed", "partially_verified", "blocked_by_environment"] as const) {
      const v = verdict({ testing: { result }, checks: [pass("a")] });
      expect(v.count, result).toBeGreaterThan(0);
    }
    expect(kinds(verdict({ testing: { result: "code_failed", reasons: ["check_failed"] }, checks: [{ label: "a", status: "passed", reason: "check_failed" }] }))).toContain("testing_reason");
  });
  // Mutant R2: a passed row a Rovara-made mock answered is only in the Checks drawer.
  it("a passed check a Rovara-made mock answered is an item above the fold even with no dependency recorded", () => {
    const v = verdict({ dependencies: undefined, checks: [pass("a"), { ...pass("b"), madeByRovara: true }] });
    expect(kinds(v)).toEqual(["check_made_by_rovara"]);
    expect(aboveFold(v)).toContain("Rovara-made mock");
  });
  // Mutant R3: the Tested against line is cut at ten services, so a fake after the tenth is only an item (or nowhere).
  it("beyond ten services only plain real ones are ever left out; every fake stays named on the line", () => {
    const reals = Array.from({ length: 11 }, (_, index) => dep({ name: `Real${index}`, backing: "local", label: "real" }));
    const quiet = dep({ name: "StripeQuiet", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z" });
    const made = dep({ name: "MadeLast", backing: "fake", label: "rovara_made_fake" });
    const line = verdict({ dependencies: [...reals, quiet, made] }).lines.testedAgainst;
    expect(line).toContain("StripeQuiet (recorded fake, recorded 34 days ago)");
    expect(line).toContain("MadeLast (fake made by Rovara)");
    expect(line).toMatch(/and \d+ more real services/u);
    expect(verdict({ dependencies: Array.from({ length: 24 }, (_, index) => dep({ name: `Fake${index}`, backing: "fake", label: "hand_written_fake" })) }).lines.testedAgainst).toContain("Fake23");
  });
  // Mutant R5: a date in the future is clamped to 0 days and the fake reads as fresh.
  it("a recording dated after the pull request is not fresh", () => {
    expect(kinds(verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2099-01-01T00:00:00.000Z" })] }))).toEqual(["service_old_fake"]);
    expect(kinds(verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "not a date" })] }))).toEqual(["service_old_fake"]);
    const futureApproval = verdict({ dependencies: [dep({ name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-11-16T00:00:00.000Z", approvedAt: "2099-01-01T00:00:00.000Z" })] });
    expect(kinds(futureApproval)).toEqual(["service_old_fake"]);
    expect(futureApproval.lines.testedAgainst).toContain("approval date unknown");
    expect(kinds(verdict({ asOf: "garbage", dependencies: [STRIPE_FRESH] }))).toEqual(["service_old_fake"]);
  });
  // Mutant R7: counts, labels and statuses that cannot be read are read as "none" or "fine".
  it("fails closed on a count, a label or a status it cannot read", () => {
    expect(kinds(verdict({ dependencies: [dep({ name: "S", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", madeUpAnswers: Number.NaN })] }))).toEqual(["service_made_up_answers"]);
    expect(kinds(verdict({ dependencies: [dep({ name: "S", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", madeUpAnswers: 1.5 })] }))).toEqual(["service_made_up_answers"]);
    const unknown = verdict({ dependencies: [dep({ name: "S", backing: "fake", label: "from_the_future" as never })] });
    expect(kinds(unknown)).toEqual(["service_hand_written"]);
    expect(unknown.lines.testedAgainst).toBe("S (unknown kind, treated as a fake).");
    const status = verdict({ checks: [{ label: "x", status: "mystery" as never }] });
    expect(status.result).toBe("Partially verified");
    expect(kinds(status)).toContain("check_not_run");
    expect(kinds(verdict({ flakyReruns: Number.NaN }))).toEqual(["flaky_rerun"]);
  });
  // Mutant R8: a number or label the caller passed is printed as it is.
  it("prints no raw number or label: nothing is NaN, infinite or negative, and an unknown eval label is not printed", () => {
    const v = verdict({ changed: { source: "host", files: Number.POSITIVE_INFINITY, added: Number.NaN, removed: -3, complete: true, testsAdded: Number.NaN, codeChanged: true }, evalCheck: { label: "x</details>" as never, promptChanged: true } });
    for (const text of [v.lines.changed, v.lines.proven, v.heading, ...v.items.flatMap((item) => [item.title, item.detail, ...item.lines])]) expect(text, text).not.toMatch(/NaN|Infinity|∞|--|<|details/u);
    expect(kinds(v)).toContain("files_not_read");
    expect(kinds(v)).toContain("eval_prompt_without_run");
    const second = verdict({ secondReview: { state: "blocking", count: 1, findings: [{ text: "x", file: "a.ts", line: "3\n## pwn <details>" as never }] } });
    expect(second.items.find((item) => item.kind === "second_review_blocking")!.lines[0]).toBe("x (a.ts)");
  });
  // Mutant R11 and R12: the pre-inert second-review reason line and the browser problem lines are used raw.
  it("the second review's reason line and the browser problem lines are made safe", () => {
    const hostile = "Evil</details><!-- x --> @octocat https://evil.example\nnext";
    const v = verdict({ secondReview: { state: "did_not_run", reasonLine: hostile }, browser: { pages: 1, problems: [hostile] } });
    for (const item of v.items) for (const text of [item.title, item.detail, ...item.lines]) {
      expect(text, text).not.toMatch(/[<\r\n]/u);
      expect(text, text).not.toMatch(/@(?!\u200d)/u);
    }
    expect(kinds(v)).toEqual(["second_review_not_run", "browser_problem"]);
  });
  // Mutant R17: a failed requirement with a not-proven reason is listed twice (failed and not proven).
  it("a failed requirement is listed once, as failed", () => {
    const v = verdict({ requirements: [{ id: "R1", text: "a", result: "failed", notProvenReason: "made_by_rovara" }] });
    expect(kinds(v)).toEqual(["requirement_failed"]);
    expect(v.lines.proven).toBe("0 of 1 requirements proven. 1 failed.");
  });
  it("more than four merge-order lines say how many were left out", () => {
    const v = verdict({ mergeOrder: ["a", "b", "c", "d", "e", "f"] });
    expect(v.items[0]!.lines).toEqual(["a", "b", "c", "d", "and 2 more"]);
  });
});

describe("requirements that could not be rebuilt in time", () => {
  // Mutant R14: a stale table reads as "No approved requirements to prove".
  it("are said to be pending, never read as no requirements", () => {
    const v = verdict({ requirements: undefined, requirementsPending: true });
    expect(v.lines.proven).toBe("Requirements are being checked against the latest change.");
    expect(v.drawers.requirements).toBe("Requirements and proof: being updated for the latest change");
    expect(kinds(v)).toEqual(["requirements_pending"]);
    expect(v.lines.proven).not.toContain("No approved");
  });
});

describe("one set of words for the description and the Check (design rule 2.1.7)", () => {
  const RECEIVED = { proof: { kind: "proceed" as const, warns: false, relaxed: false, provenCount: 1, reasons: [] }, ci: "passing" as const, ciMode: "their_ci_fix" as const, fullSuite: "not_needed" as const, firstSeenAtMs: 0, nowMs: 60_000 };
  // Mutant K1: the Check's lines are written apart from the description's and drift (here: the list is left out of the Check).
  it("the Check is given the very lines the description prints, and takes them", () => {
    const v = verdict({ weakening: { weaker: ["Snapshot files changed: a.snap"], flags: [], notCompared: [] }, mergeOrder: ["Merge the app first."] });
    const { six, list } = prVerdictMarkdown(v);
    const forCheck = prVerdictForCheck(v);
    expect(forCheck.body).toEqual([...six, "", ...list.slice(0, -1)]);
    expect(forCheck.body.join("\n")).toContain("**The order of merging matters.**");
    expect(forCheck.heading).toBe(v.heading);
    const check = rovaraCheckOf({ ...RECEIVED, verdict: forCheck });
    expect(check.conclusion).toBe("success");
    expect(check.title).toBe(v.heading);
    expect(check.text).toContain("**Tests may be weaker.**");
  });
  it("a verdict that failed is in the Check's text but never its title; and a long list is bounded by the Check's own limits", () => {
    const failing = verdict({ testing: { result: "code_failed", reasons: ["check_failed"] }, checks: [{ label: "Unit tests", status: "failed", reason: "check_failed" }] });
    const check = rovaraCheckOf({ ...RECEIVED, verdict: prVerdictForCheck(failing) });
    expect(check.title).not.toContain("Code failed");
    expect(check.text).toContain(failing.heading);
    const many = verdict({ dependencies: Array.from({ length: 24 }, (_, index) => dep({ name: `Fake${index}`, backing: "fake", label: "hand_written_fake" })), mergeOrder: ["a", "b", "c", "d", "e"] });
    const text = rovaraCheckOf({ ...RECEIVED, verdict: prVerdictForCheck(many) });
    expect(text.conclusion).toBe("success");
    expect(text.text.length).toBeLessThanOrEqual(65_535);
  });
});

describe("L4-EVP: AI code was touched and no eval ran", () => {
  const item = (over: Partial<PrVerdictInput>) => verdict(over).items.find((entry) => entry.kind === "eval_no_run");
  it("says so with the reason, counts as a thing to check, and is advisory (it never changes the result)", () => {
    for (const reason of ["no_eval_configured", "not_a_prompt_change", "not_connected"] as const) {
      const found = item({ noEval: { reason } })!;
      expect(found.title).toBe("No eval ran for this change.");
      expect(found.detail).toMatch(/^Reason: /u);
    }
    expect(item({ noEval: { reason: "no_eval_configured" } })!.detail).toContain("no AI eval set up");
    expect(item({ noEval: { reason: "not_a_prompt_change" } })!.detail).toContain("not a prompt location the project confirmed");
    expect(item({ noEval: { reason: "not_connected" } })!.detail).toContain("not connected");
    expect(item({ noEval: { reason: "other", detail: "an owner must confirm the eval's call estimate in setup" } })!.detail).toBe("Reason: an owner must confirm the eval's call estimate in setup");
    const v = verdict({ noEval: { reason: "not_a_prompt_change" } });
    expect(v.heading).toBe("Verified · Low risk · 1 thing to check");
    expect(v.result).toBe(verdict().result);
  });
  it("makes the reason inert and refuses a reason it does not know", () => {
    expect(item({ noEval: { reason: "other", detail: "x\n## pwn <details> [a](http://x)" } })!.detail).not.toMatch(/\n|<details>/u);
    expect(item({ noEval: { reason: "made-up" as never } })).toBeUndefined();
  });
  it("is one line per fact: not beside a result, a worse result or the existing prompt-changed item; and absent it is today's verdict", () => {
    expect(item({ noEval: { reason: "not_connected" }, evalCheck: { label: "No regression measured", promptChanged: true } })).toBeUndefined();
    expect(item({ noEval: { reason: "not_connected" }, evalCheck: { label: "Improved on eval", promptChanged: true } })).toBeUndefined();
    expect(kinds(verdict({ noEval: { reason: "not_connected" }, evalCheck: { label: "Worse on eval", promptChanged: true } }))).toEqual(["eval_worse"]);
    expect(kinds(verdict({ noEval: { reason: "no_eval_configured" }, evalCheck: { label: "Not run", promptChanged: true } }))).toEqual(["eval_prompt_without_run"]);
    expect(kinds(verdict({ noEval: { reason: "not_connected" }, evalCheck: { label: "Not run", promptChanged: false } }))).toEqual(["eval_no_run"]);
    expect(verdict({ noEval: undefined })).toEqual(verdict());
  });
});
