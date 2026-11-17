// Lane L4-C (design pr-redesign.md, sections 2.1 to 2.3 and 4): the verdict of a pull request, as one pure object. It is what the description's heading and six lines, the "Check these before you approve" list and the
// drawers' one-line summaries are written from, and what the "Rovara" Check's title is written from, so every surface says the same words (rule 7).
//
// PURE and browser-safe: no clock (the caller gives `asOf`), no network, no model. It decides what is said where, and the rules below are the reason it exists. A layout puts text on a page; this object decides which facts
// may NOT be left inside a fold. Every rule has a test and a mutant that the test kills (tests/unit/contracts-pr-verdict.test.ts).
//
// Rules this module keeps:
//   V1  The result is never better than the worst row it was made from: a failed or blocked row never reads as "Verified", whatever a Testing view says. Without a Testing view the words are the fixed ones in `VERDICT_RESULT_WORDS`
//       ("Checks passed", never "Verified"): nothing here decides that a task is Verified, only the classifier does.
//   V2  A requirement is "proven" only when it says so AND no Rovara-made mock, unconfirmed scripted reply or made-up answer stands behind it. `notProvenReason` or a labelled check always wins over `result: "proven"`.
//   V3  Every exception (2.3) is an ITEM, listed above the fold and counted in the heading. Every kind has an owner here and nothing else produces it. A drawer summary only repeats counts and result words.
//   V4  A service the checks used is always named on the "Tested against" line, a quiet one too. A fake is never dropped from the line (only plain real services are ever cut, beyond ten). A fake that is fresh, recorded and made up no
//       answers is quiet (no item), and so is a fake the project's own tests make; every other kind of fake, an emulator, a missing service, a made-up answer and a fallback is an item.
//   V5  The changed files come from the code host. `changed.source: "worker"` is "reported by the worker, not checked": no counts are printed, and it never lowers the risk. Risk that was not judged from the host's file list is HIGH
//       ("treated as high"), whatever level was passed in. The level printed is the one the risk module judged (it already folds evidence in, and only ever raises); this object never lowers it.
//   V6  A fresh pull request's risk says "not judged yet (treated as high)" and counts the unread file list as one thing to check, not two (no separate "Risk is High" item).
//   V7  A second review's "agreed" is said only when the caller says the mode is on (it passes no second review for a shadow one), and only as "no blocking finding". A blocking or missing one is an item.
//   V8  "No flag" is never "no weakening": a "could not compare" line is an item. Nothing is printed as "none".
//   V9  Free text a repository, a person or a model wrote goes through `inertEvidenceText` (redacted, one line, no tag, link, mention or issue key, `<` and `&` as entities). A line the caller says is already inert (`lines`)
//       is still made structural-safe here: control characters out, no `<` (so nothing can close a drawer or open a comment), cut. Summary lines of drawers hold fixed words and counts only.
import { inertEvidenceText } from "./evidence-inert.js";
import type { EvidenceDependency } from "./evidence.js";
import { EVIDENCE_FALLBACK_REASON_WORDS, EVIDENCE_TIERS } from "./evidence.js";
import { TESTING_REASON_CLASS, TESTING_REASON_TEXT, TESTING_RESULT_LABELS, type TestingReason, type TestingResult, type TestingRowStatus } from "./verification-result.js";

// ---- inputs

export interface VerdictCheckRow {
  /** Raw text: made inert here. */
  label: string;
  status: TestingRowStatus;
  reason?: TestingReason | undefined;
  passedTests?: number | undefined;
  /** A Rovara-made mock answered this check: it is never counted as a plain pass. */
  madeByRovara?: true | undefined;
}

export type VerdictRequirementResult = "proven" | "passed" | "failed" | "partly_tested" | "not_tested";
export interface VerdictRequirement {
  id: string;
  /** Raw text: made inert here. */
  text: string;
  result: VerdictRequirementResult;
  notProvenReason?: "made_by_rovara" | "agent_replies_unconfirmed" | "agent_replies_disagreed" | undefined;
}

export interface VerdictSecondReviewFinding { text: string; file?: string | undefined; line?: number | undefined }
/** Only for a second review in mode `on`. A shadow second review is never passed (rule V7). */
export type VerdictSecondReview =
  | { state: "agreed" }
  | { state: "blocking"; count: number; model?: string | undefined; findings: readonly VerdictSecondReviewFinding[] }
  | { state: "did_not_run"; /** Fixed words from the second-review module (already inert). */ reasonLine: string };

export interface VerdictAcceptedFinding { role: "CRITIC" | "SECURITY"; text: string; reason: string; by?: string | undefined }

export interface VerdictEval {
  label: "Improved on eval" | "No regression measured" | "Worse on eval" | "Not run";
  /** The change touched a prompt. */
  promptChanged: boolean;
}

export interface PrVerdictInput {
  /** The date of the pull request (ISO), for the age of a recorded fake. */
  asOf: string;
  /** The Testing view's result, when the task has one. Absent: the fixed words of a task with no classified result (rule V1). */
  testing?: { result: TestingResult; reasons?: readonly TestingReason[] | undefined } | undefined;
  checks: readonly VerdictCheckRow[];
  /** No automated check applied, and why (raw text). The task was reviewed only. */
  reviewOnly?: { why?: string | undefined } | undefined;
  /** Absent: the task has no approved plan with requirements. */
  requirements?: readonly VerdictRequirement[] | undefined;
  /** The requirement table could not be rebuilt in time for this code: its results are not known yet (never read as "no requirements"). */
  requirementsPending?: true | undefined;
  /** What the plan or the evidence says was not tested beyond the requirements' own rows: a planned browser or API scenario that did not run, a check that could not run, a mocked service no dependency row explains. Raw text, made inert here. */
  notTested?: readonly { kind: "scenario" | "check" | "mocked_service"; text: string }[] | undefined;
  /** What the checks ran against; absent: nothing was recorded. */
  dependencies?: readonly EvidenceDependency[] | undefined;
  /** Where the checks ran: one of the pack's fixed tiers. Any other value is ignored (a drawer summary holds fixed words only). */
  testedIn?: (typeof EVIDENCE_TIERS)[number] | undefined;
  changed?: { source: "host" | "worker"; files: number; added?: number | undefined; removed?: number | undefined; uncounted?: number | undefined; complete: boolean; testsAdded?: number | undefined; codeChanged: boolean } | undefined;
  risk: { level: "low" | "medium" | "high"; /** Already-inert, fixed-vocabulary reasons from the risk module. */ reasons: readonly string[]; /** Judged from the host's list of changed files. */ judged: boolean };
  /** Lines already made inert by their modules (weakening and flags words, from contracts `weakeningLines` and `notComparedLines`). */
  weakening?: { weaker: readonly string[]; flags: readonly string[]; notCompared: readonly string[] } | undefined;
  reviews: {
    code: "passed" | "passed_after_accepted"; security: "passed" | "passed_after_accepted";
    accepted: readonly VerdictAcceptedFinding[]; partialDiff: boolean; sameModel: boolean;
  };
  secondReview?: VerdictSecondReview | undefined;
  evalCheck?: VerdictEval | undefined;
  /** Lines already inert from the merge-order module. */
  mergeOrder?: readonly string[] | undefined;
  /** Tests that failed once and passed on the round's rerun: a failure that was set aside is never only in a fold. */
  flakyReruns?: number | undefined;
  /** How many pages the browser evidence covered, and the lines (already inert) about a page or the run that did not run, was not shown, kept no video or had console errors. Absent: no browser evidence ran. */
  browser?: { pages: number; problems: readonly string[] } | undefined;
  used?: { lessons: number; wikiPages: number } | undefined;
}

// ---- outputs

export const PR_EXCEPTION_KINDS = [
  "review_only", "check_failed", "check_blocked", "check_not_run", "check_already_failing", "check_made_by_rovara", "testing_reason",
  "requirements_pending", "other_not_tested", "requirement_failed", "requirement_partly_tested", "requirement_not_tested", "requirement_not_proven", "code_without_tests",
  "service_not_available", "service_made_by_rovara", "service_hand_written", "service_made_up_answers", "service_fell_back", "service_emulated", "service_old_fake",
  "tests_weaker", "weakening_not_compared", "flagged_files",
  "finding_accepted", "second_review_blocking", "second_review_not_run", "reviews_partial", "review_same_model",
  "flaky_rerun", "browser_problem", "eval_worse", "eval_prompt_without_run", "files_incomplete", "files_not_read", "merge_order",
] as const;
export type PrExceptionKind = (typeof PR_EXCEPTION_KINDS)[number];

export interface PrVerdictItem {
  kind: PrExceptionKind;
  /** Fixed words, bold in the page. */
  title: string;
  /** One inert line after the title; may be empty. */
  detail: string;
  /** Further inert lines (at most 10), shown as a sub-list. */
  lines: string[];
}

export const VERDICT_RESULT_WORDS = {
  checks_passed: "Checks passed", checks_failed: "Checks failed", checks_could_not_run: "Checks could not run", checks_incomplete: "Some checks did not run", no_checks: "No checks recorded", review_only: "Not verified by automated checks (review only)",
} as const;
export type VerdictResultKind = TestingResult | keyof typeof VERDICT_RESULT_WORDS;

export interface PrVerdict {
  /** Which result the heading says; the one an automatic reader (the Check) switches on. */
  resultKind: VerdictResultKind;
  result: string;
  /** The level printed: `high` whenever it was not judged from the host. */
  riskLevel: "low" | "medium" | "high";
  riskJudged: boolean;
  riskPhrase: string;
  count: number;
  /** The heading's text without the markdown: `Verified · Low risk · nothing extra to check`. */
  heading: string;
  /** The six lines, each inert, without their bold labels. `risk` has the reasons after the first line. */
  lines: { changed: string; proven: string; testedAgainst: string; reviews: string; risk: string[]; needsYou: string };
  items: PrVerdictItem[];
  /** One-line summaries of the folded sections: fixed words and counts only. A section with nothing to say is absent. */
  drawers: { requirements?: string; checks: string; setup: string; reviews: string; screenshots?: string; used?: string };
}

// ---- text

const LINE_MAX = 300;
const LIST_MAX = 10;
const RISK_WORDS = { low: "Low", medium: "Medium", high: "High" } as const;
const OLD_FAKE_DAYS = 90;

/** Raw text a repository, person or model wrote: made inert (rule V9). */
const raw = (text: string, max = 120): string => inertEvidenceText(text, max);
/**
 * A line a module already made inert (it holds `&amp;`, `&lt;` and zero-width joiners, which are read back first so none turns into a space): made inert again WITHOUT escaping its entities a second time. The entities are read back first, so a line that was already inert comes out the
 * same, and a line that was not (a caller's mistake) is made inert here, so nothing can open a tag, a link, a mention or a block whoever wrote the line.
 */
function safeLine(text: string, max = LINE_MAX): string {
  // `inertEvidenceText` also breaks anything shaped like an issue key (`V1-2`, `node-22`, `SHA-256`), which is right for a name but would change the technical words of a line a module made inert already (a path, a risk reason). A Linear
  // closing word before a real key is the layout's own seal (`sealLinearText`, over the whole block), so only that one rule is not repeated here.
  return inertEvidenceText(text.replaceAll("\u200D", "").replaceAll("&lt;", "<").replaceAll("&amp;", "&"), max).replace(/\b([A-Za-z][A-Za-z0-9]{0,9})-\u200D(?=\d)/gu, "$1-");
}
/** A count as a whole number: anything else (NaN, a fraction, a negative, infinity) is read as 0 where it is only printed. Where a count decides whether to say something, `some` fails closed instead. */
const whole = (count: number | undefined): number => (typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0);
/** Whether a count says "some": anything that is not a whole 0 is some (a count that cannot be read is never read as none). */
const some = (count: number | undefined): boolean => count !== undefined && !(Number.isInteger(count) && count === 0);
const plural = (count: number, one: string, many = `${one}s`): string => `${whole(count)} ${whole(count) === 1 ? one : many}`;
const number = (count: number): string => whole(count).toLocaleString("en-US");
/** At most `LIST_MAX` entries, then a count. */
function bounded(entries: readonly string[]): string[] {
  return entries.length <= LIST_MAX ? [...entries] : [...entries.slice(0, LIST_MAX), `and ${entries.length - LIST_MAX} more`];
}

// ---- the result (rule V1)

const SEVERITY: Record<TestingResult, number> = { verified: 0, partially_verified: 1, blocked_by_environment: 2, code_failed: 3 };
const RESULT_OF_SEVERITY: TestingResult[] = ["verified", "partially_verified", "blocked_by_environment", "code_failed"];

/** The worst result any row alone allows. */
function rowsResult(rows: readonly VerdictCheckRow[]): TestingResult {
  let worst = 0;
  for (const row of rows) {
    const severity = row.status === "failed" ? 3 : row.status === "blocked" ? 2 : row.status === "passed" ? 0 : 1;
    worst = Math.max(worst, severity);
  }
  // No row at all is not a pass.
  return rows.length === 0 ? "partially_verified" : RESULT_OF_SEVERITY[worst]!;
}

function resultOf(input: PrVerdictInput): { kind: VerdictResultKind; words: string } {
  const fromRows = rowsResult(input.checks);
  if (input.testing !== undefined) {
    const kind = RESULT_OF_SEVERITY[Math.max(SEVERITY[input.testing.result], SEVERITY[fromRows])]!;
    return { kind, words: TESTING_RESULT_LABELS[kind] };
  }
  if (input.reviewOnly !== undefined) return { kind: "review_only", words: VERDICT_RESULT_WORDS.review_only };
  const kind: VerdictResultKind = input.checks.length === 0 ? "no_checks" : fromRows === "code_failed" ? "checks_failed" : fromRows === "blocked_by_environment" ? "checks_could_not_run" : fromRows === "partially_verified" ? "checks_incomplete" : "checks_passed";
  return { kind, words: VERDICT_RESULT_WORDS[kind as keyof typeof VERDICT_RESULT_WORDS] };
}

// ---- requirements (rule V2)

interface RequirementCounts { total: number; proven: number; failed: number; partly: number; notTested: number; passedNotProven: number; passed: number }
function requirementCounts(requirements: readonly VerdictRequirement[]): RequirementCounts {
  const counts: RequirementCounts = { total: requirements.length, proven: 0, failed: 0, partly: 0, notTested: 0, passedNotProven: 0, passed: 0 };
  for (const requirement of requirements) {
    if (requirement.result === "failed") counts.failed += 1;
    else if (requirement.result === "partly_tested") counts.partly += 1;
    else if (requirement.result === "not_tested") counts.notTested += 1;
    else if (requirement.result === "proven" && requirement.notProvenReason === undefined) counts.proven += 1;
    else if (requirement.notProvenReason !== undefined) counts.passedNotProven += 1;
    else counts.passed += 1;
  }
  return counts;
}

const NOT_PROVEN_WORDS = {
  made_by_rovara: "it was tested only against a Rovara-made mock", agent_replies_unconfirmed: "it was tested only with scripted AI replies the real model did not confirm", agent_replies_disagreed: "the real model did not agree with the scripted AI replies it was tested with",
} as const;

// ---- services (rule V4)

type ServiceClass = "quiet" | "not_available" | "made_by_rovara" | "hand_written" | "emulated" | "old_fake";
function ageDays(recordedAt: string | undefined, asOf: string): number | undefined {
  if (recordedAt === undefined) return undefined;
  const then = Date.parse(recordedAt);
  const now = Date.parse(asOf);
  // A date in the future is not a date a recording can have: the age is unknown, so the fake is not fresh.
  return Number.isFinite(then) && Number.isFinite(now) && then <= now ? Math.floor((now - then) / 86_400_000) : undefined;
}

/** What the "Tested against" line says of one service, in a few words. */
function serviceWords(dependency: EvidenceDependency, asOf: string): string {
  const name = raw(dependency.name, 40) || "a service";
  const made = dependency.madeUpAnswers ?? 0;
  const madeText = Number.isInteger(made) && made >= 0 ? `${number(made)} made-up ${made === 1 ? "answer" : "answers"}` : "made-up answers";
  const age = dependency.label === "recorded_fake" ? ageDays(dependency.approvedAt ?? dependency.recordedAt, asOf) : undefined;
  const base: Record<EvidenceDependency["label"], string> = {
    real: "real", real_project_image: "real, the project's image", company_approved: "real, the company's own image", rovara_local_aws: "emulated, not real AWS", test_account: "a test account", vendor_test: "the vendor's test mode",
    recorded_fake: `recorded fake${age === undefined ? (dependency.approvedAt === undefined ? ", date unknown" : ", approval date unknown") : `, ${dependency.approvedAt === undefined ? "recorded" : "approved"} ${number(age)} ${age === 1 ? "day" : "days"} ago`}`, hand_written_fake: "fake written by hand", rovara_made_fake: "fake made by Rovara", faked_by_tests: "faked by the tests themselves", not_available: "not available",
  };
  const extra = [...(some(dependency.madeUpAnswers) ? [madeText] : []), ...(dependency.fellBack === undefined ? [] : [`fell back: ${EVIDENCE_FALLBACK_REASON_WORDS[dependency.fellBack.reason]}`])];
  return `${name} (${[Object.hasOwn(base, dependency.label) ? base[dependency.label] : "unknown kind, treated as a fake", ...extra].join(", ")})`;
}

function serviceClass(dependency: EvidenceDependency, asOf: string): ServiceClass {
  switch (dependency.label) {
    case "not_available": return "not_available";
    case "rovara_made_fake": return "made_by_rovara";
    case "hand_written_fake": return "hand_written";
    case "rovara_local_aws": return "emulated";
    case "recorded_fake": {
      const age = ageDays(dependency.approvedAt ?? dependency.recordedAt, asOf);
      // An unknown age is not fresh: the fake cannot be called recent.
      return age === undefined || age > OLD_FAKE_DAYS ? "old_fake" : "quiet";
    }
    case "real": case "real_project_image": case "company_approved": case "test_account": case "vendor_test": case "faked_by_tests": return "quiet";
    // A label this build does not know is the weakest class, never a real service (the pack's own rule).
    default: return "hand_written";
  }
}

// ---- the verdict

const ROW_STATUSES: readonly string[] = ["passed", "failed", "blocked", "not_run", "pending", "known_failing"];

export function prVerdictOf(rawInput: PrVerdictInput): PrVerdict {
  // A row whose status this build does not know did not run: it is never a pass (fail closed).
  const input: PrVerdictInput = { ...rawInput, checks: rawInput.checks.map((row) => (ROW_STATUSES.includes(row.status) ? row : { ...row, status: "not_run" as const })) };
  const result = resultOf(input);
  const items: PrVerdictItem[] = [];
  const add = (kind: PrExceptionKind, title: string, detail = "", lines: readonly string[] = []): void => { items.push({ kind, title, detail, lines: bounded(lines) }); };

  // Review only: no automated check applied.
  if (input.reviewOnly !== undefined) add("review_only", "No automated check applied.", input.reviewOnly.why === undefined || input.reviewOnly.why === "" ? "This change was reviewed, not tested." : `Why: ${raw(input.reviewOnly.why, 200)}`);

  // Checks
  const rowsOf = (...statuses: TestingRowStatus[]) => input.checks.filter((row) => statuses.includes(row.status));
  const rowLine = (row: VerdictCheckRow) => `${raw(row.label, 80)}${row.reason === undefined ? "" : `: ${TESTING_REASON_TEXT[row.reason]}`}`;
  const failed = rowsOf("failed"); const blocked = rowsOf("blocked"); const notRun = rowsOf("not_run", "pending"); const known = rowsOf("known_failing");
  if (failed.length > 0) add("check_failed", failed.length === 1 ? "A check failed." : `${failed.length} checks failed.`, "The code is at fault, not the environment.", failed.map(rowLine));
  if (blocked.length > 0) add("check_blocked", blocked.length === 1 ? "A check was blocked." : `${blocked.length} checks were blocked.`, "The environment gave no verdict, so the code is not shown to be fine.", blocked.map(rowLine));
  if (notRun.length > 0) add("check_not_run", notRun.length === 1 ? "A check did not run." : `${notRun.length} checks did not run.`, "", notRun.map(rowLine));
  if (known.length > 0) add("check_already_failing", known.length === 1 ? "A check was already failing before this change." : `${known.length} checks were already failing before this change.`, "", known.map(rowLine));
  const madeRows = input.checks.filter((row) => row.status === "passed" && row.madeByRovara === true);
  if (madeRows.length > 0) add("check_made_by_rovara", madeRows.length === 1 ? "A check passed against a Rovara-made mock." : `${madeRows.length} checks passed against a Rovara-made mock.`, "A pass against a Rovara-made mock is not proven.", madeRows.map((row) => raw(row.label, 80)));
  // The classifier's own reasons that no row shows (a full run still pending, a claim not tested, no checks ran).
  const rowReasons = new Set(input.checks.map((row) => row.reason));
  const spare = (input.testing?.reasons ?? []).filter((reason) => !rowReasons.has(reason));
  // A reason of the code failing or of the environment belongs under the item of the rows it explains (said once); the others (what did not run) are their own item.
  const unplaced: TestingReason[] = [];
  for (const reason of spare) {
    const home = TESTING_REASON_CLASS.code.has(reason) ? items.find((item) => item.kind === "check_failed") : TESTING_REASON_CLASS.blocked.has(reason) ? items.find((item) => item.kind === "check_blocked") : undefined;
    if (home === undefined) unplaced.push(reason);
    else home.lines = bounded([...home.lines, TESTING_REASON_TEXT[reason]]);
  }
  if (unplaced.length > 0) add("testing_reason", `The test result is ${result.words.toLowerCase()}.`, "", unplaced.map((reason) => TESTING_REASON_TEXT[reason]));
  // A result that is not a pass always has something to check: whatever way it came about (no rows, a downgrade from the rows, a view with no reasons), it is never "nothing extra to check".
  const PASS_KINDS: readonly string[] = ["verified", "checks_passed"];
  if (!PASS_KINDS.includes(result.kind) && !items.some((item) => ["review_only", "check_failed", "check_blocked", "check_not_run", "check_already_failing", "testing_reason"].includes(item.kind))) {
    add("testing_reason", `The test result is ${result.words.toLowerCase()}.`, input.checks.length === 0 ? "No check was recorded for this change." : "The recorded checks do not show a clean pass.");
  }

  // Requirements
  if (input.requirementsPending === true) add("requirements_pending", "The requirements are being checked against the latest change.", "Their results are not known yet for this code.");
  const requirements = input.requirements;
  const counts = requirements === undefined ? undefined : requirementCounts(requirements);
  if (requirements !== undefined) {
    const line = (requirement: VerdictRequirement) => `${raw(requirement.id, 20)}: ${raw(requirement.text, 100)}`;
    const failedRequirements = requirements.filter((requirement) => requirement.result === "failed");
    const partly = requirements.filter((requirement) => requirement.result === "partly_tested");
    const notTested = requirements.filter((requirement) => requirement.result === "not_tested");
    const weak = requirements.filter((requirement) => requirement.notProvenReason !== undefined && requirement.result !== "failed" && requirement.result !== "not_tested" && requirement.result !== "partly_tested");
    if (failedRequirements.length > 0) add("requirement_failed", failedRequirements.length === 1 ? "A requirement is not met." : `${failedRequirements.length} requirements are not met.`, "", failedRequirements.map(line));
    if (partly.length > 0) add("requirement_partly_tested", partly.length === 1 ? "A requirement is only partly tested." : `${partly.length} requirements are only partly tested.`, "", partly.map(line));
    if (notTested.length > 0) add("requirement_not_tested", notTested.length === 1 ? "A requirement is not tested." : `${notTested.length} requirements are not tested.`, "", notTested.map(line));
    if (weak.length > 0) add("requirement_not_proven", weak.length === 1 ? "A requirement passed but is not proven." : `${weak.length} requirements passed but are not proven.`, "Passed is not proven: the check that passed does not show the new tests fail on the original code.", weak.map((requirement) => `${line(requirement)} (${NOT_PROVEN_WORDS[requirement.notProvenReason!]})`));
  }
  // Counts that are not whole numbers cannot be printed as a count: the list is read as not read (never as 0 files).
  const others = input.notTested ?? [];
  if (others.length > 0) {
    const noun = { scenario: "Scenario", check: "Check", mocked_service: "Mocked service" } as const;
    add("other_not_tested", others.length === 1 ? "Something was not tested." : `${others.length} things were not tested.`, "", others.map((entry) => `${noun[entry.kind] ?? "Item"}: ${raw(entry.text, 100)}`));
  }
  const changed = input.changed !== undefined && [input.changed.files, input.changed.added ?? 0, input.changed.removed ?? 0, input.changed.uncounted ?? 0, input.changed.testsAdded ?? 0].every((count) => Number.isInteger(count) && count >= 0) ? input.changed : undefined;
  if (changed !== undefined && changed.source === "host" && changed.complete && changed.codeChanged && changed.testsAdded === 0) add("code_without_tests", "The change adds no test.", "Code changed and no test file was added or changed.");

  // Services
  const dependencies = input.dependencies ?? [];
  const byClass = (cls: ServiceClass) => dependencies.filter((dependency) => serviceClass(dependency, input.asOf) === cls);
  const madeUp = dependencies.filter((dependency) => some(dependency.madeUpAnswers));
  const fellBack = dependencies.filter((dependency) => dependency.fellBack !== undefined);
  const named = (dependency: EvidenceDependency) => raw(dependency.name, 40) || "a service";
  const notAvailable = byClass("not_available");
  if (notAvailable.length > 0) add("service_not_available", notAvailable.length === 1 ? "A service was not available." : `${notAvailable.length} services were not available.`, "Tests that need it did not run.", notAvailable.map((dependency) => `${named(dependency)}${dependency.testsNotRun === undefined ? "" : `: ${plural(dependency.testsNotRun, "test")} did not run`}`));
  const madeFakes = byClass("made_by_rovara");
  if (madeFakes.length > 0) add("service_made_by_rovara", madeFakes.length === 1 ? "A service was a fake made by Rovara." : `${madeFakes.length} services were fakes made by Rovara.`, madeFakes.length === 1 ? "Its answers were made, not recorded from the real service. A pass against it is not proven." : "Their answers were made, not recorded from the real service. A pass against them is not proven.", madeFakes.map(named));
  const handFakes = byClass("hand_written");
  if (handFakes.length > 0) add("service_hand_written", handFakes.length === 1 ? "A service was a fake written by hand." : `${handFakes.length} services were fakes written by hand.`, handFakes.length === 1 ? "Its answers were not recorded from the real service." : "Their answers were not recorded from the real service.", handFakes.map(named));
  if (madeUp.length > 0) add("service_made_up_answers", "A fake made up answers.", "A request with no recording got an answer that was made up.", madeUp.map((dependency) => `${named(dependency)}: ${Number.isInteger(dependency.madeUpAnswers) ? plural(dependency.madeUpAnswers ?? 0, "request") : "some requests"}`));
  if (fellBack.length > 0) add("service_fell_back", fellBack.length === 1 ? "A service fell back to a fake." : `${fellBack.length} services fell back to fakes.`, "", fellBack.map((dependency) => `${named(dependency)}: ${EVIDENCE_FALLBACK_REASON_WORDS[dependency.fellBack!.reason]}`));
  const emulated = byClass("emulated");
  if (emulated.length > 0) add("service_emulated", "AWS was emulated, not real.", "The emulator does not check permissions, so nothing here shows the change is allowed to do it on real AWS.", emulated.map(named));
  const oldFakes = byClass("old_fake");
  if (oldFakes.length > 0) add("service_old_fake", oldFakes.length === 1 ? "A recorded fake is old." : `${oldFakes.length} recorded fakes are old.`, `More than ${OLD_FAKE_DAYS} days old (or the date is unknown). Real behaviour may have changed.`, oldFakes.map((dependency) => { const age = ageDays(dependency.approvedAt ?? dependency.recordedAt, input.asOf); const verb = dependency.approvedAt === undefined ? "recorded" : "approved"; return `${named(dependency)}: ${age === undefined ? `${verb} on an unknown date` : `${verb} ${number(age)} days before this pull request`}`; }));

  // Weakened tests and flags
  const weakening = input.weakening;
  if (weakening !== undefined) {
    if (weakening.weaker.length > 0) add("tests_weaker", "Tests may be weaker.", "", weakening.weaker.map((entry) => safeLine(entry)));
    if (weakening.flags.length > 0) add("flagged_files", "Instruction files or files CI runs changed.", "", weakening.flags.map((entry) => safeLine(entry)));
    if (weakening.notCompared.length > 0) add("weakening_not_compared", "Rovara could not compare the tests before and after.", "No flag here does not mean no tests were weakened.", weakening.notCompared.map((entry) => safeLine(entry)));
  }

  // Reviews
  const accepted = input.reviews.accepted;
  if (accepted.length > 0) {
    add("finding_accepted", accepted.length === 1 ? "The owner accepted a review finding." : `The owner accepted ${accepted.length} review findings.`, "", accepted.slice(0, 3).map((finding) => `[${finding.role === "SECURITY" ? "security" : "code"}] ${raw(finding.text, 140)}: accepted because ${raw(finding.reason, 140)}${finding.by === undefined ? "" : ` (by ${raw(finding.by, 60)})`}`).concat(accepted.length > 3 ? [`and ${accepted.length - 3} more, listed on the task page`] : []));
  }
  const second = input.secondReview;
  if (second?.state === "blocking") {
    add("second_review_blocking", "The second review disagrees with the first.", `${second.model === undefined ? "The second review" : `Second review (${raw(second.model, 80)})`} has ${plural(second.count, "blocking finding")}.`,
      second.findings.slice(0, 5).map((finding) => `${raw(finding.text, 200)}${finding.file === undefined ? "" : ` (${raw(finding.file, 120)}${typeof finding.line === "number" && Number.isInteger(finding.line) && finding.line > 0 ? `:${finding.line}` : ""})`}`));
  } else if (second?.state === "did_not_run") {
    add("second_review_not_run", "The second review did not run.", safeLine(second.reasonLine, 200));
  }
  if (input.reviews.partialDiff) add("reviews_partial", "The reviews saw only part of the change.", "The change was too large to show the reviewers in full. Review the rest by hand.");
  if (input.reviews.sameModel) add("review_same_model", "The review used the same model as the build.", "It is not an independent review. Enable another model for one.");

  // Failures set aside, and browser evidence that did not fully run
  if (some(input.flakyReruns)) add("flaky_rerun", input.flakyReruns === 1 ? "A test failed once and passed on a rerun." : Number.isInteger(input.flakyReruns) ? `${input.flakyReruns} tests failed once and passed on a rerun.` : "Tests failed once and passed on a rerun.", "A failure that was set aside is not the same as a pass.");
  if (input.browser !== undefined && input.browser.problems.length > 0) add("browser_problem", "The browser evidence did not fully run.", "", input.browser.problems.map((entry) => safeLine(entry)));

  // AI evaluation
  const EVAL_LABELS: readonly string[] = ["Improved on eval", "No regression measured", "Worse on eval", "Not run"];
  // An eval label this build does not know is not printed (only the four fixed ones are), and a missing result on a changed prompt is the "no evaluation ran" item.
  const evalCheck = input.evalCheck === undefined ? undefined : EVAL_LABELS.includes(input.evalCheck.label) ? input.evalCheck : { ...input.evalCheck, label: "Not run" as const };
  if (evalCheck?.label === "Worse on eval") add("eval_worse", "The AI evaluation got worse.", "Worse on eval: the answers the change gives are worse than before.");
  else if (evalCheck !== undefined && evalCheck.label === "Not run" && evalCheck.promptChanged) add("eval_prompt_without_run", "A prompt changed and no evaluation ran.", "AI quality was not measured.");

  // Files and merge order
  if (changed === undefined) add("files_not_read", "The changed files have not been read yet.", "The risk counts as high until they are.");
  else if (changed.source === "worker") add("files_not_read", "The changed files are what the worker reported, not what the code host shows.", "Not checked. The risk counts as high until they are read from the code host.");
  else if (!changed.complete) add("files_incomplete", "The list of changed files may be incomplete.", "Rovara could not read all of them.");
  if (input.mergeOrder !== undefined && input.mergeOrder.length > 0) add("merge_order", "The order of merging matters.", "", [...input.mergeOrder.slice(0, 4).map((entry) => safeLine(entry, 400)), ...(input.mergeOrder.length > 4 ? [`and ${input.mergeOrder.length - 4} more`] : [])]);

  // ---- risk (rules V5, V6)
  const judged = input.risk.judged && changed !== undefined && changed.source === "host";
  const riskLevel: "low" | "medium" | "high" = judged ? input.risk.level : "high";
  const riskJudged = judged;
  const riskPhrase = riskJudged ? `${RISK_WORDS[riskLevel]} risk` : "Risk not judged yet (treated as high)";

  // The heading
  const count = items.length;
  const heading = `${result.words} · ${riskPhrase} · ${count === 0 ? "nothing extra to check" : `${plural(count, "thing")} to check`}`;

  // The six lines
  const proven = ((): string => {
    const parts: string[] = [];
    if (input.requirementsPending === true) parts.push("Requirements are being checked against the latest change.");
    else if (requirements === undefined || counts === undefined) parts.push("No approved requirements to prove.");
    else {
      parts.push(counts.total === 0 ? "No requirements." : `${counts.proven} of ${counts.total} requirements proven.`);
      if (counts.failed > 0) parts.push(`${counts.failed} failed.`);
      if (counts.passedNotProven > 0) parts.push(`${counts.passedNotProven} passed but ${counts.passedNotProven === 1 ? "is" : "are"} not proven.`);
      if (counts.partly > 0) parts.push(`${counts.partly} only partly tested.`);
      if (counts.notTested > 0) parts.push(`${counts.notTested} not tested.`);
    }
    if (evalCheck !== undefined && evalCheck.label !== "Not run") parts.push(`${evalCheck.label}.`);
    return parts.filter((part) => part !== "").join(" ");
  })();

  const changedLine = ((): string => {
    if (changed === undefined) return "The changed files have not been read yet.";
    if (changed.source === "worker") return "Reported by the worker, not checked against the code host.";
    const counted = changed.uncounted === undefined || changed.uncounted === 0 ? `+${number(changed.added ?? 0)} -${number(changed.removed ?? 0)}` : `at least +${number(changed.added ?? 0)} -${number(changed.removed ?? 0)}`;
    const files = `${number(changed.files)}${changed.complete ? "" : " or more"} ${changed.files === 1 && changed.complete ? "file" : "files"}, ${counted}${changed.complete ? "" : "; the list may be incomplete"}.`;
    const tests = changed.testsAdded === undefined ? "" : changed.testsAdded === 0 ? "" : ` ${plural(changed.testsAdded, "test")} added.`;
    return `${files}${tests}`;
  })();

  const testedAgainst = ((): string => {
    if (dependencies.length === 0) return "Rovara has no record of which services the checks used.";
    // Only plain real services are ever left out of the line (and counted); every fake, emulator, missing service and test account stays named.
    const plain = (dependency: EvidenceDependency) => dependency.label === "real" || dependency.label === "real_project_image" || dependency.label === "company_approved";
    const plainKept = new Set(dependencies.filter(plain).slice(0, Math.max(3, LIST_MAX - dependencies.filter((dependency) => !plain(dependency)).length)));
    const shown = dependencies.filter((dependency) => !plain(dependency) || plainKept.has(dependency)).map((dependency) => serviceWords(dependency, input.asOf));
    const hidden = dependencies.filter(plain).length - plainKept.size;
    return `${[...shown, ...(hidden > 0 ? [`and ${hidden} more real ${hidden === 1 ? "service" : "services"}`] : [])].join(". ")}.`;
  })();

  const reviewsLine = ((): string => {
    const code = input.reviews.code; const security = input.reviews.security;
    const first = code === security ? `Code review and security review ${code === "passed" ? "passed" : "passed after the owner accepted their findings"}.`
      : `Code review ${code === "passed" ? "passed" : "passed after the owner accepted its findings"}. Security review ${security === "passed" ? "passed" : "passed after the owner accepted its findings"}.`;
    const parts = [first];
    if (accepted.length > 0) parts.push(`**The owner accepted ${plural(accepted.length, "review finding")}.**`);
    if (second?.state === "agreed") parts.push("The second review found no blocking finding.");
    if (second?.state === "blocking") parts.push("**The second review did not pass.**");
    if (second?.state === "did_not_run") parts.push("**The second review did not run.**");
    if (input.reviews.partialDiff) parts.push("**The reviews saw only part of the change.**");
    if (input.reviews.sameModel) parts.push("**Same model as the build.**");
    return parts.join(" ");
  })();

  const riskLines = ((): string[] => {
    const reasons = input.risk.reasons.map((reason) => safeLine(reason, 200));
    const first = riskJudged ? `${RISK_WORDS[riskLevel]}.${reasons[0] === undefined ? "" : ` ${reasons[0]}`}`
      : changed === undefined ? "Not judged yet, so it counts as high. Rovara is still reading the changed files."
        : "Not judged from the code host's list of changed files, so it counts as high.";
    // The evidence can only raise the level above what the caller gave; the caller's reasons are all kept (rule V5), the rest one per line.
    return [first, ...(riskJudged ? reasons.slice(1) : reasons)];
  })();

  const needsYou = ((): string => {
    // High risk is never "nothing else": merging it needs a fresh sign-in.
    const base = count === 0 ? (riskLevel === "high" ? "The normal code review." : "The normal code review. Nothing else.") : `The ${count === 1 ? "item" : `${count} items`} below, then the normal code review.`;
    return riskLevel === "high" ? `${base} Merging needs a fresh sign-in (high risk).` : base;
  })();

  // ---- the drawers' summaries: fixed words and counts only
  const passedRows = input.checks.filter((row) => row.status === "passed" && row.madeByRovara !== true).length;
  const madePassed = input.checks.filter((row) => row.status === "passed" && row.madeByRovara === true).length;
  const tests = input.checks.reduce((sum, row) => sum + (row.status === "passed" ? row.passedTests ?? 0 : 0), 0);
  const checkParts = [
    `${passedRows + madePassed} of ${input.checks.length} passed${tests > 0 ? ` (${number(tests)} tests)` : ""}`,
    ...(madePassed > 0 ? [`${madePassed} with a Rovara-made mock`] : []), ...(failed.length > 0 ? [`${failed.length} failed`] : []), ...(blocked.length > 0 ? [`${blocked.length} blocked`] : []),
    ...(notRun.length > 0 ? [`${notRun.length} not run`] : []), ...(known.length > 0 ? [`${known.length} already failing`] : []),
  ];
  const checksSummary = input.checks.length === 0 ? "Checks: none recorded" : `Checks: ${checkParts.join(", ")}`;

  const requirementsSummary = input.requirementsPending === true ? "Requirements and proof: being updated for the latest change" : counts === undefined ? undefined : `Requirements and proof: ${counts.proven} of ${counts.total} proven${counts.failed > 0 ? `, ${counts.failed} failed` : ""}${counts.passedNotProven > 0 ? `, ${counts.passedNotProven} passed but not proven` : ""}${counts.partly > 0 ? `, ${counts.partly} partly tested` : ""}${counts.notTested > 0 ? `, ${counts.notTested} not tested` : ""}`;

  const setupParts = ((): string[] => {
    const tally = new Map<string, number>();
    for (const dependency of dependencies) {
      const word = dependency.label === "recorded_fake" ? (serviceClass(dependency, input.asOf) === "old_fake" ? "old recorded fake" : "recorded fake") : dependency.label === "real" || dependency.label === "real_project_image" || dependency.label === "company_approved" ? "real service" : dependency.label === "rovara_made_fake" ? "fake made by Rovara" : dependency.label === "hand_written_fake" ? "hand-written fake" : dependency.label === "rovara_local_aws" ? "emulated AWS" : dependency.label === "not_available" ? "service not available" : dependency.label === "faked_by_tests" ? "service faked by the tests" : dependency.label === "test_account" ? "test account" : "vendor test mode";
      tally.set(word, (tally.get(word) ?? 0) + 1);
    }
    return [...tally].map(([word, n]) => (n === 1 ? `1 ${word}` : `${n} ${word}s`));
  })();
  const setupDetails = dependencies.filter((dependency) => dependency.label === "recorded_fake").map((dependency) => {
    const age = ageDays(dependency.approvedAt ?? dependency.recordedAt, input.asOf);
    return age === undefined ? undefined : `${raw(dependency.name, 40) || "a service"} recorded fake, ${dependency.approvedAt === undefined ? "recorded" : "approved"} ${number(age)} ${age === 1 ? "day" : "days"} ago`;
  }).filter((detail): detail is string => detail !== undefined);
  const setupSummary = `Test setup: ${[...(input.testedIn !== undefined && EVIDENCE_TIERS.includes(input.testedIn) ? [input.testedIn] : []), ...setupParts, ...setupDetails].join(", ") || "where the checks ran"}`;

  const reviewsSummary = `Reviews: ${input.reviews.code === "passed" && input.reviews.security === "passed" ? "2 passed" : "2 passed after accepted findings"}, ${plural(accepted.length, "finding")} accepted${second === undefined ? "" : second.state === "agreed" ? ", second review found no blocking finding" : second.state === "blocking" ? `, second review has ${plural(second.count, "blocking finding")}` : ", second review did not run"}${input.reviews.partialDiff ? ", saw only part of the change" : ""}${input.reviews.sameModel ? ", same model as the build" : ""}`;

  const drawers: PrVerdict["drawers"] = {
    ...(requirementsSummary === undefined ? {} : { requirements: requirementsSummary }), checks: checksSummary, setup: setupSummary, reviews: reviewsSummary,
    ...(input.browser === undefined ? {} : { screenshots: `Screenshots: ${plural(input.browser.pages, "page")} on the task page` }),
    ...(input.used === undefined || input.used.lessons + input.used.wikiPages <= 0 ? {} : { used: `What Rovara used: ${[...(input.used.lessons > 0 ? [plural(input.used.lessons, "lesson")] : []), ...(input.used.wikiPages > 0 ? [plural(input.used.wikiPages, "wiki page")] : [])].join(", ")}` }),
  };

  return {
    resultKind: result.kind, result: result.words, riskLevel, riskJudged, riskPhrase, count, heading,
    lines: { changed: changedLine, proven, testedAgainst, reviews: reviewsLine, risk: riskLines, needsYou }, items, drawers,
  };
}

// ---- the words of the verdict as markdown lines (one function, so the description and the Check say the same thing)

/** At most this many things to check are listed; the rest are counted in a last line. */
export const VERDICT_ITEMS_LISTED = 10;

/**
 * The verdict's six lines and its numbered list of things to check, as markdown lines (the heading and the drawers are the caller's). The six lines carry their bold labels; the list is empty when nothing needs a person; beyond
 * `listed` items the rest are one counted line. Every line is one inert line with no tag, so it can go in the description and, unchanged, in the "Rovara" Check's text (design rule 2.1.7: the same words everywhere).
 */
export function prVerdictMarkdown(verdict: PrVerdict, listed = VERDICT_ITEMS_LISTED): { six: string[]; list: string[] } {
  const six = [
    `**Changed** ${verdict.lines.changed}`, `**Proven** ${verdict.lines.proven}`, `**Tested against** ${verdict.lines.testedAgainst}`, `**Reviews** ${verdict.lines.reviews}`,
    `**Risk** ${verdict.lines.risk[0] ?? ""}`, ...verdict.lines.risk.slice(1).map((reason) => `  - ${reason}`), `**Needs you** ${verdict.lines.needsYou}`,
  ];
  const shown = verdict.items.slice(0, listed);
  const list = verdict.count === 0 ? [] : [
    "### Check these before you approve", "",
    ...shown.flatMap((item, index) => [`${index + 1}. **${item.title}**${item.detail === "" ? "" : ` ${item.detail}`}`, ...item.lines.map((line) => `${" ".repeat(String(index + 1).length + 2)}- ${line}`)]),
    ...(verdict.items.length > shown.length ? [`${shown.length + 1}. and ${verdict.items.length - shown.length} more things to check, listed on the task page.`] : []), "",
  ];
  return { six, list };
}

/** What the "Rovara" Check is given of a verdict (`RovaraCheckInput.verdict`): the result kind, the heading, and the six lines and the list as body lines. */
export function prVerdictForCheck(verdict: PrVerdict): { resultKind: string; heading: string; body: string[] } {
  const { six, list } = prVerdictMarkdown(verdict, verdict.items.length);
  return { resultKind: verdict.resultKind, heading: Array.from(verdict.heading).slice(0, 200).join(""), body: [...six, ...(list.length === 0 ? [] : ["", ...list.slice(0, -1)])] };
}
