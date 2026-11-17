// TE-B4: the one "Rovara" Check on a pull request's head (testing plan O48). Pure and browser-safe.
//
// `rovaraCheckOf` turns what Rovara knows about one head into the Check's status, conclusion and words. The conclusion is a fixed table, in this order (the first that applies wins):
//   1. a Rovara problem, or Rovara's checks did not run                -> neutral   (a Rovara fault must never block a customer's merge)
//   2. the change proof holds the draft                                -> failure   (a required check then blocks merge, which is what a hold means)
//      ... and a person pressed "mark ready anyway" for this head     -> success, "overridden by <person>" in the title (O30)
//   3. the full suite after the draft failed                           -> failure
//   4. CI not readable, "No CI", sandbox only by choice                -> neutral
//   5. the full suite is still running                                 -> in_progress
//   6. the full suite could not run                                    -> neutral
//   7. the change proof was judged and does not hold                   -> success (a warning is said in the text)
//   8. nothing judged yet                                              -> in_progress
// An in-progress Check older than `ROVARA_CHECK_STALE_MS`, or one whose task Rovara stopped following, is neutral ("Rovara could not finish"): a required check must not hang.
// GitHub counts `success`, `neutral` and `skipped` as passing for a required check, and `failure` as blocking.
//
// L4-C B4: with a `verdict` (the pull request's verdict object, rendered by the broker: `prVerdictOf`) the Check says the same words as the description. The title of a Ready (success) Check is the verdict's heading, unless the
// verdict's result is one that failed or could not run (a green Check must never be titled "Code failed"); a hold, a neutral reason and a refusal keep their own sentence as the title. The text starts with the verdict's
// lines and its "Check these before you approve" list, then the three parts above (Change proof, Your CI, Full suite), which are the gate. The verdict never changes the conclusion: the table above is the only thing that does.
//
// Every word is fixed except the overriding person's name, which is made inert (no mention, link, markup or secret). Input is checked at runtime: anything that does not fit is a fixed
// neutral refusal that echoes nothing, never a throw and never a guess.
import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";
import type { ChangeRequestStatus } from "./plugins/code-host.js";
import { PROOF_HOLD_REASONS, PROOF_HOLD_WORDS, proofHoldLine, type ProofHoldReason } from "./test-proof.js";

/** The Check's name on the code host. One Check of this name per head, from Rovara's own App. */
export const ROVARA_CHECK_NAME = "Rovara";
/** GitHub's limit for a Check's summary and for its text. */
export const ROVARA_CHECK_TEXT_MAX = 65_535;
/** The longest title written (code points). */
export const ROVARA_CHECK_TITLE_MAX = 200;
/** The longest overriding person's name shown (code points). */
const OVERRIDE_NAME_MAX = 60;
/** An in-progress Check older than this is neutral: no Rovara step on one head takes longer (the full-suite follow-up's own limit is the same four hours). */
export const ROVARA_CHECK_STALE_MS = 4 * 3_600_000;

export const ROVARA_CHECK_PROBLEMS = ["rovara_problem", "not_run"] as const;
export const ROVARA_CHECK_FULL_SUITE = ["not_needed", "pending", "passed", "failed", "not_run"] as const;
const CI_STATES = ["none", "pending", "passing", "failing", "unreadable", "required_missing"] as const;
const CI_MODES = ["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"] as const;
const COUNT = z.number().int().min(0).max(1_000_000);
const CLOCK = z.number().int().min(0).max(8_640_000_000_000_000);

const RovaraCheckInputSchema = z.object({
  proof: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_judged") }).strict(),
    z.object({ kind: z.literal("proceed"), warns: z.boolean(), relaxed: z.boolean(), provenCount: COUNT, reasons: z.array(z.enum(PROOF_HOLD_REASONS)).max(PROOF_HOLD_REASONS.length) }).strict(),
    z.object({ kind: z.literal("held"), reasons: z.array(z.enum(PROOF_HOLD_REASONS)).min(1).max(PROOF_HOLD_REASONS.length), provenCount: COUNT }).strict(),
  ]),
  /** A person marked this head ready anyway: their name as Rovara knows it. */
  override: z.object({ by: z.string().max(10_000) }).strict().optional(),
  problem: z.enum(ROVARA_CHECK_PROBLEMS).optional(),
  ci: z.enum(CI_STATES),
  ciMode: z.enum(CI_MODES),
  fullSuite: z.enum(ROVARA_CHECK_FULL_SUITE),
  /** When Rovara first saw this head (the Check's clock for "could not finish"). */
  firstSeenAtMs: CLOCK,
  nowMs: CLOCK,
  /** Rovara stopped following this pull request's task (closed, released, gone). */
  stopped: z.boolean().optional(),
  /** L4-C B4: the verdict of the pull request's code, rendered (inert, one markdown line each). Absent: the Check is what it was. */
  verdict: z.unknown().optional(),
}).strict();

/** The verdict as the Check takes it, checked on its own: one that does not fit is left out (the Check is then what it was), never a reason to refuse the whole input or to change a conclusion. */
const VerdictSchema = z.object({
  resultKind: z.string().min(1).max(60),
  heading: z.string().min(1).max(ROVARA_CHECK_TITLE_MAX).regex(/^[^\p{Cc}\p{Cf}<]*$/u),
  body: z.array(z.string().max(2_000).regex(/^[^\p{Cc}<]*$/u)).max(600),
}).strict();
export type RovaraCheckVerdict = z.infer<typeof VerdictSchema>;

export type RovaraCheckInput = Omit<z.input<typeof RovaraCheckInputSchema>, "verdict"> & { verdict?: RovaraCheckVerdict | undefined };
export type RovaraCheckProblem = (typeof ROVARA_CHECK_PROBLEMS)[number];
export type RovaraCheckFullSuite = (typeof ROVARA_CHECK_FULL_SUITE)[number];
export type RovaraCheckConclusion = "success" | "failure" | "neutral";

/** What the code host is asked to show. `conclusion` is present exactly when `status` is `completed`. */
export interface RovaraCheckPayload {
  status: "in_progress" | "completed";
  conclusion?: RovaraCheckConclusion;
  title: string;
  summary: string;
  text: string;
}

const COULD_NOT_FINISH = "Rovara could not finish";
/** Verdict results under which a Ready (success) Check keeps its own title: the heading would read as a failure on a green Check. */
const VERDICT_BAD_RESULTS: ReadonlySet<string> = new Set(["code_failed", "blocked_by_environment", "checks_failed", "checks_could_not_run"]);
const RELAXED_WORDS = "More than 10% of this project's recent pull requests were held, so this is a warning, not a hold.";

const PROBLEM_TITLES: Readonly<Record<RovaraCheckProblem, string>> = Object.freeze({
  rovara_problem: "Rovara had a problem with this change (it does not block the merge)",
  not_run: "Rovara's checks did not run on this change (it does not block the merge)",
});
const CI_WORDS: Readonly<Record<(typeof CI_STATES)[number], string>> = Object.freeze({
  none: "No CI ran on this pull request.",
  pending: "Your CI is still running.",
  passing: "Your CI passed.",
  failing: "Your CI is failing.",
  unreadable: "Rovara could not read your CI.",
  required_missing: "A required check has not reported.",
});
const FULL_SUITE_WORDS: Readonly<Record<RovaraCheckFullSuite, string>> = Object.freeze({
  not_needed: "",
  pending: "The full suite is running after the draft.",
  passed: "The full suite passed.",
  failed: "The full suite failed.",
  not_run: "The full suite did not run.",
});

const refusal = (): RovaraCheckPayload => finish({ status: "completed", conclusion: "neutral", title: COULD_NOT_FINISH, lines: ["Rovara could not work out a result for this head, so it does not block the merge."] });

function titled(text: string): string {
  const points = Array.from(text);
  return points.length <= ROVARA_CHECK_TITLE_MAX ? text : `${points.slice(0, ROVARA_CHECK_TITLE_MAX - 1).join("")}…`;
}
function bounded(text: string): string {
  return text.length <= ROVARA_CHECK_TEXT_MAX ? text : `${text.slice(0, ROVARA_CHECK_TEXT_MAX - 1)}…`;
}
function finish(input: { status: RovaraCheckPayload["status"]; conclusion?: RovaraCheckConclusion; title: string; lines: string[]; sections?: Array<{ heading: string; lines: string[] }>; verdictLines?: string[] }): RovaraCheckPayload {
  const sections = (input.sections ?? []).filter((section) => section.lines.length > 0);
  const text = [...input.lines, ...(input.verdictLines === undefined || input.verdictLines.length === 0 ? [] : ["", ...input.verdictLines]), ...sections.flatMap((section) => ["", `**${section.heading}**`, ...section.lines.map((line) => `- ${line}`)]), "", "Open in Rovara for the details and the actions (re-run, mark ready anyway)."].join("\n");
  return {
    status: input.status, ...(input.status === "completed" && input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
    title: titled(input.title), summary: bounded(input.lines.join("\n")), text: bounded(text),
  };
}

function proofLines(proof: z.infer<typeof RovaraCheckInputSchema>["proof"]): string[] {
  if (proof.kind === "not_judged") return ["Not judged yet."];
  if (proof.kind === "held") return [proofHoldLine(proof.reasons)];
  const lines = [proof.provenCount > 0 ? `Proven: ${String(proof.provenCount)} ${proof.provenCount === 1 ? "test fails" : "tests fail"} on the old code and ${proof.provenCount === 1 ? "passes" : "pass"} with the change.` : "Not held."];
  if (proof.warns && proof.reasons.length > 0) lines.push(`Not proven: ${proof.reasons.map((reason: ProofHoldReason) => PROOF_HOLD_WORDS[reason]).join("; ")}.`);
  if (proof.relaxed) lines.push(RELAXED_WORDS);
  return lines;
}

/** The Check for one head. Never throws: input that does not fit is a fixed neutral refusal. */
export function rovaraCheckOf(raw: RovaraCheckInput): RovaraCheckPayload {
  const parsed = RovaraCheckInputSchema.safeParse(raw);
  if (!parsed.success) return refusal();
  const input = parsed.data;
  const sections = [
    { heading: "Change proof", lines: proofLines(input.proof) },
    { heading: "Your CI", lines: input.ciMode === "sandbox_only" ? ["This project is checked in Rovara's sandbox only, by its own choice."] : [CI_WORDS[input.ci]] },
    { heading: "Full suite", lines: input.fullSuite === "not_needed" ? [] : [FULL_SUITE_WORDS[input.fullSuite]] },
  ];
  const checkedVerdict = VerdictSchema.safeParse(input.verdict);
  const verdict = input.verdict === undefined || !checkedVerdict.success ? undefined : checkedVerdict.data;
  // The verdict is said in the text whatever the conclusion; it is the title only of a Ready Check whose result did not fail (the gate's own sentence is the title everywhere else).
  const verdictLines = verdict === undefined ? undefined : [`**${verdict.heading}**`, ...verdict.body];
  const done = (conclusion: RovaraCheckConclusion, title: string, ready = false): RovaraCheckPayload => {
    const shown = ready && conclusion === "success" && verdict !== undefined && !VERDICT_BAD_RESULTS.has(verdict.resultKind) ? verdict.heading : title;
    return finish({ status: "completed", conclusion, title: shown, lines: [shown], sections, ...(verdictLines === undefined ? {} : { verdictLines }) });
  };
  const running = (title: string): RovaraCheckPayload => {
    if (input.stopped === true) return done("neutral", `${COULD_NOT_FINISH}: Rovara stopped following this pull request`);
    if (input.nowMs - input.firstSeenAtMs > ROVARA_CHECK_STALE_MS) return done("neutral", `${COULD_NOT_FINISH} in time (it does not block the merge)`);
    return finish({ status: "in_progress", title, lines: [title], sections, ...(verdictLines === undefined ? {} : { verdictLines }) });
  };

  if (input.problem !== undefined) return done("neutral", PROBLEM_TITLES[input.problem]);
  if (input.proof.kind === "held") {
    if (input.fullSuite === "failed") return done("failure", FULL_SUITE_WORDS.failed);
    if (input.override === undefined) return done("failure", proofHoldLine(input.proof.reasons));
    const name = inertEvidenceText(input.override.by, OVERRIDE_NAME_MAX);
    return done("success", `Ready, overridden by ${name.length === 0 ? "a person" : name}`);
  }
  if (input.fullSuite === "failed") return done("failure", FULL_SUITE_WORDS.failed);
  if (input.ciMode === "sandbox_only") return done("neutral", "Checked in Rovara's sandbox only, by the project's choice");
  if (input.ci === "unreadable") return done("neutral", "CI not readable (it does not block the merge)");
  if (input.ci === "none") return done("neutral", "No CI (it does not block the merge)");
  if (input.fullSuite === "pending") return running("Draft checked; full suite running");
  if (input.fullSuite === "not_run") return done("neutral", "Full suite not run (it does not block the merge)");
  // A proof is claimed only where one was judged and proved something; a head that is ready with nothing judged says only "Ready".
  if (input.proof.kind === "proceed") return done("success", input.proof.warns ? "Ready, with a warning about the change proof" : input.proof.provenCount > 0 ? "Ready: the change proof holds" : "Ready", !input.proof.warns);
  return running("Rovara is checking this change");
}

/**
 * The status without Rovara's own Check, so the Check is never read as the customer's CI (no fix loop on Rovara's own failure, no wait on itself when a person makes it required).
 * Dropped: a check named "Rovara" whose source is Rovara's own App; a required entry named "Rovara" that names Rovara's own App; and one that names no source, only while Rovara's own Check is on the head
 * (so a customer's own job called "Rovara" is still waited for when Rovara has not posted). A check with no source is never taken for ours.
 * Without a known source the status is returned as it is (the same object).
 */
export function withoutOwnRovaraCheck(status: ChangeRequestStatus, ownSource: string | undefined): ChangeRequestStatus {
  if (ownSource === undefined || ownSource.length === 0) return status;
  const ours = (check: ChangeRequestStatus["checks"][number]): boolean => check.name === ROVARA_CHECK_NAME && check.source === ownSource;
  const ownPresent = status.checks.some(ours);
  const checks = status.checks.filter((check) => !ours(check));
  const requiredChecks = status.requiredChecks.filter((entry) => !(entry.name === ROVARA_CHECK_NAME && (entry.source === ownSource || (entry.source === undefined && ownPresent))));
  if (checks.length === status.checks.length && requiredChecks.length === status.requiredChecks.length) return status;
  return { ...status, checks, requiredChecks, targetHasRequiredChecks: status.targetHasRequiredChecks && (requiredChecks.length > 0 || checks.some((check) => check.required)) };
}
