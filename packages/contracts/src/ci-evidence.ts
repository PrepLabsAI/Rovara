// TE-E0 option A (owner, 2026-11-15): the customer's own pipeline as evidence. At setup the customer marks which of the checks GitHub reports run in their test environment and what they call them
// ("real model in our account"). Rovara then shows each marked check as "Real: reported by your pipeline", with the run number and the commit, waits for it on its own clock, and never calls a check
// that did not answer "failed". The settings are Cloud's to store (Code reads them through a port, as it reads the CI mode); this file is their shape and the words, so both editions say the same thing.
// Pure and browser-safe: no clock, no network, no Node module. Every word a customer or a repository wrote goes through `inertEvidenceText` before it is printed.
import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";

export const CI_EVIDENCE_LIMITS = {
  markedChecksMax: 20,
  checkNameMax: 200,
  calledAsMax: 80,
  sourceMax: 200,
  waitCapMinutesMin: 15,
  waitCapMinutesMax: 1_440,
  waitCapMinutesDefault: 120,
  expectedMinutesMax: 1_440,
  /** The most characters of one test's failure text that may be kept (B: capped failure text). */
  failureTextMax: 2_000,
} as const;

/** One check the customer marked at setup as running in their test environment. Matched by name (and by `source`, the reporting app, when given), never by position. */
export const MarkedCheckSchema = z.object({
  name: z.string().min(1).max(CI_EVIDENCE_LIMITS.checkNameMax),
  source: z.string().min(1).max(CI_EVIDENCE_LIMITS.sourceMax).optional(),
  /** What the customer calls it, in their words: "real model in our account". Shown inert. */
  calledAs: z.string().min(1).max(CI_EVIDENCE_LIMITS.calledAsMax),
  /** A long or paid run (a deploy, a real model): fixes get two rounds, and only after a full sandbox pass. */
  longOrPaid: z.boolean(),
  /** The customer's own expected time, in minutes. Absent: learned from past runs. Never above the wait cap. */
  expectedMinutes: z.number().int().min(1).max(CI_EVIDENCE_LIMITS.expectedMinutesMax).optional(),
}).strict();
export type MarkedCheck = z.infer<typeof MarkedCheckSchema>;

/**
 * L4-EVCI (owner decision D7): the ONE check of the customer's CI that is their eval, named at setup. Rovara reads that check's result on its pull request and says it as "Eval (reported
 * by your CI)", next to its own eval line when it has one. Advisory only: it is never a marked check (no waiting for readiness, no fix round, no comment) and never changes the Rovara Check. Matched by name (and by
 * `source`, the reporting app, when given), exactly as a marked check is.
 */
export const EvalCheckSchema = z.object({
  name: z.string().min(1).max(CI_EVIDENCE_LIMITS.checkNameMax),
  source: z.string().min(1).max(CI_EVIDENCE_LIMITS.sourceMax).optional(),
}).strict();
export type EvalCheck = z.infer<typeof EvalCheckSchema>;

const markedKey = (check: Pick<MarkedCheck, "name" | "source">): string => `${check.name}\u0000${check.source ?? ""}`;

export const CiEvidenceSettingsSchema = z.object({
  version: z.literal(1),
  markedChecks: z.array(MarkedCheckSchema).max(CI_EVIDENCE_LIMITS.markedChecksMax)
    .refine((checks) => new Set(checks.map(markedKey)).size === checks.length, "marks the same check twice"),
  /** The longest Rovara waits for any marked check, in minutes (default 2 h). */
  waitCapMinutes: z.number().int().min(CI_EVIDENCE_LIMITS.waitCapMinutesMin).max(CI_EVIDENCE_LIMITS.waitCapMinutesMax),
  /** B: read per-test reports (JUnit) from the run's artifacts: test names, outcomes and capped failure text only. */
  perTestReports: z.boolean(),
  /** Job logs and other artifacts of marked checks may reach the model. Off until the customer turns it on: failure text can carry customer data. */
  shareLogs: z.boolean(),
  /** L4-EVCI: the customer's own eval check, when a maintainer confirmed one at setup. Absent: nothing is read and every pull request is exactly what it was. */
  evalCheck: EvalCheckSchema.optional(),
}).strict();
export type CiEvidenceSettings = z.infer<typeof CiEvidenceSettingsSchema>;

/** A project with no settings: nothing marked, so every check is treated exactly as today. */
export const DEFAULT_CI_EVIDENCE_SETTINGS: CiEvidenceSettings = Object.freeze({
  version: 1, markedChecks: Object.freeze([]) as unknown as MarkedCheck[], waitCapMinutes: CI_EVIDENCE_LIMITS.waitCapMinutesDefault, perTestReports: true, shareLogs: false,
});

/** The one refusal a bad settings value gets. It never echoes the value. */
export const CI_EVIDENCE_SETTINGS_INVALID = "The CI evidence settings could not be read.";

/** Reads settings from anywhere (a store, a port, a request) at run time. Unknown fields, wrong types and unknown versions are refused with fixed words, never guessed. */
export function parseCiEvidenceSettings(value: unknown): { ok: true; settings: CiEvidenceSettings } | { ok: false; message: typeof CI_EVIDENCE_SETTINGS_INVALID } {
  const parsed = CiEvidenceSettingsSchema.safeParse(value);
  return parsed.success ? { ok: true, settings: parsed.data } : { ok: false, message: CI_EVIDENCE_SETTINGS_INVALID };
}

// ---- words

/** The label of every marked check's line: the customer's declaration, said as theirs. */
export const CI_EVIDENCE_REAL_LABEL = "Real: reported by your pipeline";

/** "40 min", "2 h", "1 h 30 min". A value that is not a positive finite number prints "?". */
export function waitWords(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "?";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

const name = (text: string): string => inertEvidenceText(text, 80) || "a check";
const shortSha = (sha: string): string => (/^[0-9a-f]{7,64}$/u.test(sha) ? sha.slice(0, 7) : "?");
const count = (value: number): string => (Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "?");
const runWords = (attempt: number | undefined): string => (attempt !== undefined && Number.isSafeInteger(attempt) && attempt >= 1 ? `on run ${String(attempt)}` : "(run number not reported)");

/** Test counts a pipeline reported for a run (from a per-test report). */
export interface PipelineCounts { passed: number; failed: number; skipped: number }

/** A marked check that answered: "Real: reported by your pipeline: real model (e2e-real) passed on run 2, commit 4f2a9c1, 212 passed, 0 failed". Never a plain pass: the run is always said. */
export function realCheckLine(input: { calledAs: string; check: string; outcome: "passed" | "failed"; attempt?: number | undefined; commit: string; counts?: PipelineCounts | undefined; proven?: number | undefined; flaky?: number | undefined }): string {
  const counts = (input.counts === undefined ? "no per-test counts reported"
    : `${count(input.counts.passed)} passed, ${count(input.counts.failed)} failed${input.counts.skipped > 0 ? `, ${count(input.counts.skipped)} skipped` : ""}`)
    + (input.proven !== undefined && input.proven > 0 ? `, ${count(input.proven)} proven (failed on the base run)` : "")
    + (input.flaky !== undefined && input.flaky > 0 ? `, ${count(input.flaky)} flaky (failed on an earlier run)` : "");
  return `${CI_EVIDENCE_REAL_LABEL}: ${inertEvidenceText(input.calledAs, CI_EVIDENCE_LIMITS.calledAsMax) || "your check"} (${name(input.check)}) ${input.outcome} ${runWords(input.attempt)}, commit ${shortSha(input.commit)}, ${counts}`;
}

/** A marked check still running: Rovara holds no machine while it waits. */
export function waitingCheckLine(input: { calledAs: string; check: string; expectedMs: number }): string {
  return `${CI_EVIDENCE_REAL_LABEL}: waiting for ${inertEvidenceText(input.calledAs, CI_EVIDENCE_LIMITS.calledAsMax) || "your check"} (${name(input.check)}), usually ${waitWords(input.expectedMs)}`;
}

/** Why a marked check did not run. `timed_out` is never "failed": nothing answered. */
export type NotRunReason = "timed_out" | "skipped" | "neutral";

/** "Not run: no result from e2e-real after 2 h". */
export function notRunLine(input: { check: string; reason: NotRunReason; afterMs?: number | undefined }): string {
  if (input.reason === "timed_out") return `Not run: no result from ${name(input.check)} after ${waitWords(input.afterMs ?? 0)}`;
  return `Not run: your pipeline reported ${name(input.check)} as ${input.reason === "skipped" ? "skipped" : "neutral"}`;
}

/** Why a red marked check is the customer's environment, not the change. */
export type EnvironmentReason = "failed_before_tests" | "red_on_main";

/** What a person reads when the failure is their environment: no fix, and where to re-run it. The link is shown only when it is a plain https address. */
export function environmentLine(input: { check: string; reason: EnvironmentReason; baseBranch?: string | undefined; rerunUrl?: string | undefined }): string {
  const what = input.reason === "failed_before_tests"
    ? `${name(input.check)} failed before any test ran`
    : `${name(input.check)} is also failing on ${input.baseBranch === undefined ? "the main branch" : inertEvidenceText(input.baseBranch, 60) || "the main branch"}'s latest run`;
  const link = safeLink(input.rerunUrl);
  return `${CI_EVIDENCE_ENVIRONMENT_PREFIX}${what}, so Rovara is not changing the code for it. ${link === undefined ? "Re-run it in your pipeline when it is fixed." : `Re-run it when it is fixed: ${link}`}`;
}

/** Why Rovara stops and asks a person about a marked check. */
export type CiEvidenceAskReason = "timed_out" | "cap_reached" | "no_detail" | "weakens_test" | "skipped";

/** Every stop for a marked check starts with one of these, so a person's Retry knows it (`isCiFixBlockReason`). */
export const CI_EVIDENCE_ENVIRONMENT_PREFIX = "Your environment: ";
export const CI_EVIDENCE_ASK_PREFIX = "Your pipeline: ";
export const CI_EVIDENCE_BLOCK_PREFIXES = [CI_EVIDENCE_ENVIRONMENT_PREFIX, CI_EVIDENCE_ASK_PREFIX] as const;

export const CI_EVIDENCE_ASK_WORDS: Record<CiEvidenceAskReason, (check: string) => string> = {
  timed_out: (check) => `${CI_EVIDENCE_ASK_PREFIX}no result from ${name(check)} in time. Check your pipeline, then re-run it or retry to let Rovara carry on.`,
  cap_reached: (check) => `${CI_EVIDENCE_ASK_PREFIX}${name(check)} is still failing after the fixes Rovara may try on its own. Look at it, then retry or take over.`,
  no_detail: (check) => `${CI_EVIDENCE_ASK_PREFIX}${name(check)} failed without saying which test failed, so Rovara won't guess at a fix. Look at the run, or turn on per-test reports.`,
  skipped: (check) => `${CI_EVIDENCE_ASK_PREFIX}${name(check)} did not run (your pipeline skipped it). If it skips draft pull requests, mark this one ready on the code host or let the check run on drafts, then retry.`,
  weakens_test: (check) => `${CI_EVIDENCE_ASK_PREFIX}the fix for ${name(check)} would weaken a test, so Rovara did not push it. Decide whether that is right.`,
};

/** What setup tells the customer about draft pull requests: their CI skips them (in these workflow files), runs on them, or Rovara could not tell. */
export function draftSkipWords(skip: { verdict: "skips_drafts"; workflows: readonly string[] } | { verdict: "runs_on_drafts" } | { verdict: "unknown" }): string {
  if (skip.verdict === "skips_drafts") {
    const files = skip.workflows.slice(0, 3).map((path) => inertEvidenceText(path.replace(/^\.github\/workflows\//u, ""), 60)).join(", ");
    const more = skip.workflows.length > 3 ? ` and ${String(skip.workflows.length - 3)} more` : "";
    return `Your CI skips draft pull requests (${files}${more}). Rovara opens drafts first, so your checks would not run until a person marks the pull request ready. Let them run on drafts, or expect "Not run" on the checks you mark.`;
  }
  if (skip.verdict === "runs_on_drafts") return "Your CI runs on draft pull requests.";
  return "Rovara could not tell whether your CI runs on draft pull requests. If it skips drafts, the checks you mark will say \"Not run\".";
}

/** A plain https address with no credentials, query or fragment, at most 300 characters; anything else is not shown. */
function safeLink(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
    const clean = `${parsed.origin}${parsed.pathname}`;
    return clean.length <= 300 && !/[\s<>()[\]]/u.test(clean) ? clean : undefined;
  } catch {
    return undefined;
  }
}

// ---- the customer's eval check (L4-EVCI)

/** The label of the customer's own eval result: said as theirs, and never merged with Rovara's own eval verdict ("Improved on eval", "Worse on eval", ...). */
export const EVAL_CI_LABEL = "Eval (reported by your CI)";

/** What the customer's eval check said on one head. `not_run`: the CI never reported it in time, skipped it or called it neutral. */
export interface EvalCiResult {
  outcome: "passed" | "failed" | "not_run";
  /** Why it did not run (`not_run` only). */
  reason?: NotRunReason | undefined;
  /** How long Rovara waited, for a `timed_out` (`not_run` only). */
  afterMs?: number | undefined;
  /** The test counts of the run's per-test report, when it exposed one Rovara could read. */
  counts?: PipelineCounts | undefined;
  /** The run's address, shown only when it is a plain https address. */
  url?: string | undefined;
}

/**
 * The one line: "Eval (reported by your CI): failed, 3 of 42 cases failing, https://...". Only fixed words, numbers and a plain https address are printed: nothing the customer or the repository wrote (not
 * the check's name, not a test's name, not a failure text), so the line is safe in a pull request, a chat message and a ticket as it stands.
 */
export function evalCiLine(result: EvalCiResult): string {
  const link = safeLink(result.url);
  const where = link === undefined ? "" : `, ${link}`;
  if (result.outcome === "not_run") {
    const why = result.reason === "timed_out" ? ` (no result after ${waitWords(result.afterMs ?? 0)})` : result.reason === "skipped" ? " (your CI skipped it)" : result.reason === "neutral" ? " (your CI reported it as neutral)" : "";
    return `${EVAL_CI_LABEL}: not run${why}${where}`;
  }
  const counts = result.counts;
  const total = counts === undefined ? undefined : counts.passed + counts.failed + counts.skipped;
  // Cases are said when some failed (or the count is not a number: shown as "?", never hidden), and, for a pass, how many there were; a failure that left no failed case (it failed before any ran) says no cases.
  const cases = counts === undefined ? ""
    : counts.failed !== 0 ? `, ${count(counts.failed)} of ${count(total!)} cases failing`
      : result.outcome === "passed" && total! > 0 ? `, ${count(total!)} ${total === 1 ? "case" : "cases"}, none failing` : "";
  return `${EVAL_CI_LABEL}: ${result.outcome}${cases}${where}`;
}

/** The line exactly as `evalCiLine` writes it (any outcome, with or without cases or an address): the only line of this kind Rovara will change or take out of a description. */
export const EVAL_CI_LINE_PATTERN = /^Eval \(reported by your CI\): (?:passed|failed|not run)(?: \((?:no result after (?:\?|[0-9]+ (?:min|h)(?: [0-9]+ min)?)|your CI skipped it|your CI reported it as neutral)\))?(?:, [0-9,?]+ of [0-9,?]+ cases failing|, [0-9,?]+ cases?, none failing)?(?:, https:\/\/[^\s<>()[\]]{1,300})?$/u;

// ---- per-test reports (TE-E0 option B)

/** The most tests one pipeline report keeps (the report adapters' own cap). */
export const PIPELINE_REPORT_TESTS_MAX = 50_000;
/** The most failed tests whose text is kept, and the most characters of all failure text together. */
export const PIPELINE_FAILURE_TEXTS_MAX = 20;
export const PIPELINE_FAILURE_TEXT_TOTAL_MAX = 8_000;

/** One test in a pipeline's per-test report: its id as the report gives it, its outcome, and (failed only) its capped failure text. Untrusted text. */
export const PipelineReportTestSchema = z.object({
  id: z.string().min(1).max(1_000),
  outcome: z.enum(["passed", "failed", "skipped"]),
  failureText: z.string().min(1).max(CI_EVIDENCE_LIMITS.failureTextMax).optional(),
}).strict();
export type PipelineReportTest = z.infer<typeof PipelineReportTestSchema>;

/** A parsed per-test report: names, outcomes and capped failure text only (logs and other artifacts are never part of it). */
export const PipelineReportSchema = z.object({
  tests: z.array(PipelineReportTestSchema).max(PIPELINE_REPORT_TESTS_MAX),
}).strict();
export type PipelineReport = z.infer<typeof PipelineReportSchema>;

/** What the parser says of one file: a report read whole, a file that is not a test report, or one that claims to be and could not be read whole (never a partial report). */
export type PipelineReportReading = { kind: "report"; report: PipelineReport } | { kind: "not_report" } | { kind: "unreadable" };

/**
 * The port that reads a report file's text (JUnit and the other formats of the report adapters, #529). The host fills it with the worker's adapters (`parsePipelineReport`); the broker never parses a
 * report itself.
 */
export type PipelineReportParser = (text: string) => PipelineReportReading;
