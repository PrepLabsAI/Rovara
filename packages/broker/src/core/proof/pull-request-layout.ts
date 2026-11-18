// Lane L4-C (design pr-redesign.md 2.2 and 2.7): the redesigned description's block, between the markers. A verdict (`prVerdictOf`, contracts) says the result, the risk and how many things need a person, in a heading and six lines; the
// things to check are numbered above the fold; everything else is one `<details>` drawer per section whose one-line summary already says its result. The verdict object decides what is said where; this module only lays it out.
//
// Rule T1 (design 4.2): a drawer never holds the only copy of bad news. Every exception is an ITEM of the verdict, printed above the first drawer, and every drawer's summary line is built by the verdict from counts and fixed words. The
// drawers' bodies may repeat an exception in their own tables with the same words. A test fails if an exception exists only inside a drawer (tests/unit/core-proof-pr-layout.test.ts).
//
// Shrink (design 2.7), level by level: 0 full; 1 and 2 the tables fold their passed rows (as before); 3 "What Rovara used" becomes a count and a link, and the requirement table folds its proven rows; 4 every drawer body becomes
// "Listed in the Rovara Check and on the task page"; 5 the list keeps its first 10 items. The quote, the heading, the six lines, the first 10 items, the markers and the closing line never shrink away.
// Free text never reaches a `<summary>`: summaries are the verdict's (fixed words and counts).
import {
  prVerdictMarkdown, prVerdictOf, redactText, TESTING_RESULT_LABELS, weakeningLines, workflowSelectedChecks, type PrVerdict, type PrVerdictInput, type RiskAssessment, type TestingRow, type TestingView, type VerdictAcceptedFinding, type VerdictCheckRow, type VerdictRequirement, type VerdictSecondReview,
  type WorkflowSnapshot, workflowIsReviewOnly, workflowReviewsSawPartialDiff,
} from "@agentx/contracts";
import { boundEvidence } from "./evidence-lines.js";
import { evidencePublicAiLines, evidenceV2Lines } from "./evidence-v2-lines.js";
import { inertLine } from "./inert-text.js";
import type { ProofParts } from "./proof-section.js";
import { proofCheckResults } from "./proof-section.js";
import { testingTableLines } from "./testing-section.js";
import { notComparedLines, weakeningFactsOf } from "./weakening-flags.js";
import { isTestPath, type ChangedFileEntry } from "./verification-report.js";
import type { LessonsUsedSection, PullRequestBodyContext } from "./pull-request-body.js";

/** The last shrink level of the block. */
export const LAYOUT_LEVEL_LAST = 5;
/** What a drawer says when its body was left out to keep the description within its limit. */
export const DRAWER_LEFT_OUT = "Listed in the Rovara Check and on the task page.";
/** At most this many things to check are listed (the verdict counts them all); the rest are counted. */
const ITEMS_LISTED = 20;
/** At the last shrink level the list keeps its first 10 things. */
const ITEMS_LISTED_LAST = 10;
const SAFE_LINK = /^https:\/\/[^\s()<>[\]\\]{1,500}$/u;
const DOCUMENT_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/iu;

/** What the layout is built from, all of it prepared by the description's builder. */
export interface LayoutInput {
  workflow: WorkflowSnapshot;
  context: PullRequestBodyContext;
  /** The risk of this code as the description shows it (`riskShown`). */
  risk: RiskAssessment | undefined;
  parts: ProofParts | undefined;
  /** `reviewLines(listed)`: the Reviews drawer's lines about the first reviews, with at most `listed` accepted findings named. */
  reviewLines: (listed: number) => string[];
  /** The lines the Checks drawer keeps from the old Tests section: the tested commit, tests added (when some), the test proof, the basis of the CI judgement. Already inert. */
  checksExtra: readonly string[];
  /** The tests the change added (paths, from the host's file list); undefined when the list was not read. */
  testsAdded: readonly string[] | undefined;
  /** The Reviews drawer's extra lines (reviewer models and the same-model note), already inert. */
  reviewExtra: readonly string[];
  linearCloseLine: string | undefined;
  /** L4-SC: the "Setup change" section (`setupChangeSection`, already inert), shown whole after the verdict list; absent or empty: nothing. */
  setupChange?: readonly string[];
  /** The date of the pull request (ISO), for the age of a recorded fake. */
  asOf: string;
}

const plainRows = (rows: readonly TestingRow[]): VerdictCheckRow[] => rows.map((row) => ({ label: row.label, status: row.status, ...(row.reason === undefined ? {} : { reason: row.reason }), ...(row.passedTests === undefined ? {} : { passedTests: row.passedTests }), ...(row.madeByRovara === true ? { madeByRovara: true as const } : {}) }));

/** The rows of the checks when the task has no Testing view: one per selected check, from the results recorded for this code. Words are the task's own, redacted and made inert where printed. */
export function checkRowsOf(workflow: WorkflowSnapshot): TestingRow[] {
  if (workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy)) return [];
  const results = new Map(proofCheckResults(workflow).map((result) => [result.checkId, result]));
  return workflowSelectedChecks(workflow.checkPolicy).map((check): TestingRow => {
    const label = inertLine(check.label, 120) || check.id;
    const command = inertLine([check.command.executable, ...check.command.args].join(" "), 120) || "command";
    const result = results.get(check.id);
    if (result === undefined || result.status === "UNKNOWN") return { label, command, status: "not_run", reason: "check_not_run" };
    if (result.status === "PASS") return { label, command, status: "passed", ...(result.madeByRovara === true ? { madeByRovara: true as const } : {}) };
    return result.couldNotRun === true ? { label, command, status: "blocked", reason: "check_command_broken" } : { label, command, status: "failed", reason: "check_failed" };
  });
}

/** The browser evidence lines' summary: how many pages were shown, and the lines that say something did not run, was not shown, kept no video or had console errors. */
function browserSummary(lines: readonly string[] | undefined): { pages: number; problems: string[] } | undefined {
  const kept = (lines ?? []).filter((line) => typeof line === "string" && line !== "" && !/[\r\n]/u.test(line));
  if (kept.length === 0) return undefined;
  const pages = kept.filter((line) => line.includes(": before and after screenshots")).length;
  const problems = kept.slice(1).filter((line) => /Not run|Not shown|Not kept|console error|not shown/u.test(line)).map((line) => line.replace(/^- /u, ""));
  return { pages, problems };
}

/**
 * A caller that passes only the second review's lines (`secondReviewLines`, which exist only for an `on` review that blocked or did not run) still has them above the fold: they are read back as that state, and a line that is
 * neither reading is a blocking review of unknown count (never silence). No lines: nothing (a second review that agreed is only ever said from the structured status).
 */
export function secondReviewFromLines(lines: readonly string[] | undefined): VerdictSecondReview | undefined {
  const kept = (lines ?? []).filter((line) => line !== "");
  if (kept.length === 0) return undefined;
  const first = kept[0]!;
  if (first.startsWith("Second review did not run")) return { state: "did_not_run", reasonLine: first };
  const named = /^Second review \((.*)\): (\d{1,3}) blocking findings?$/u.exec(first);
  const bullets = kept.slice(1).filter((line) => line.startsWith("- ")).map((line) => ({ text: line.slice(2) }));
  return { state: "blocking", count: named === null ? Math.max(1, bullets.length) : Number(named[2]), ...(named === null ? {} : { model: named[1]! }), findings: bullets };
}

/** The verdict of this code, and the lists the layout needs next to it. */
export function verdictOfLayout(input: LayoutInput): PrVerdict {
  const { workflow, context } = input;
  const digest = workflow.candidate?.digest;
  const files: readonly ChangedFileEntry[] = context.changedFiles?.files ?? [];
  const pack = boundEvidence(context.proof?.evidence, digest);
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  const rows = context.testing?.rows ?? checkRowsOf(workflow);
  const parts = input.parts;
  const requirements: VerdictRequirement[] | undefined = parts === undefined || parts.stale || parts.table.rows.length === 0 ? undefined
    : parts.table.rows.map((row) => {
      const reason = row.evidence.find((item) => item.notProvenReason !== undefined)?.notProvenReason;
      return { id: row.claimId, text: parts.claimTexts.get(row.claimId) ?? row.requirement, result: row.result, ...(reason === undefined ? {} : { notProvenReason: reason }) };
    });
  // Flags and weakened tests: the same facts the Evidence block and the old flags block used (the host's files and the pack's test parts), as words the contracts own.
  const weakeningProof = context.proof === undefined || (context.proof.testProof === undefined && (context.proof.plan?.claims?.length ?? 0) === 0) ? undefined : { testProof: context.proof.testProof, candidateDigest: digest };
  const words = weakeningLines(weakeningFactsOf(files, pack));
  const notCompared = weakeningProof === undefined ? [] : notComparedLines(weakeningProof.testProof, weakeningProof.candidateDigest);
  const accepted: VerdictAcceptedFinding[] = (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === digest).map((finding) => ({
    role: finding.role, text: redactText(finding.text), reason: redactText(finding.reason), ...(context.acceptedBy?.[finding.fingerprint] === undefined ? {} : { by: context.acceptedBy[finding.fingerprint]! }),
  }));
  const reviewWord = (role: "CRITIC" | "SECURITY") => ((workflow.reviews ?? []).some((review) => review.role === role && review.candidateDigest === digest && review.status === "FINDINGS") ? "passed_after_accepted" as const : "passed" as const);
  const read = context.changedFiles;
  const tests = input.testsAdded;
  const flaky = pack?.checks.reduce((sum, check) => sum + (check.tests?.flakyOnRerunCount ?? 0), 0) ?? 0;
  const aiRead = context.proof?.evidence?.read;
  const ai = aiRead !== undefined && aiRead.status === "v2" && digest !== undefined && aiRead.pack.candidate.digest === digest ? aiRead.pack.ai : undefined;
  const risk = input.risk;
  // What was not tested beyond the requirement rows (design 2.1 rule 2: "not tested" is above the fold): a planned scenario or check the table lists, and a mocked service that no dependency row explains.
  const dependenciesKnown = (pack?.environment.dependencies?.length ?? 0) > 0;
  const otherNotTested: Array<{ kind: "scenario" | "check" | "mocked_service"; text: string }> = [
    ...(parts?.table.notTested ?? []).flatMap((item) => (item.kind === "claim" ? [] : [{ kind: item.kind, text: `${item.text} (${item.reason})` }])),
    ...(pack === undefined || dependenciesKnown ? [] : pack.notTested.filter((item) => item.kind === "mocked_service").map((item) => ({ kind: "mocked_service" as const, text: `${item.text === "" ? item.id : item.text} (${item.reason})` }))),
  ];
  const verdictInput: PrVerdictInput = {
    asOf: input.asOf,
    ...(context.testing === undefined ? {} : { testing: { result: context.testing.result, reasons: context.testing.reasons } }),
    checks: plainRows(rows),
    ...(reviewOnly ? { reviewOnly: { why: workflow.checkPolicy?.noneReason === undefined ? undefined : redactText(workflow.checkPolicy.noneReason) } } : {}),
    ...(otherNotTested.length === 0 ? {} : { notTested: otherNotTested }),
    ...(requirements === undefined ? {} : { requirements }), ...(parts?.stale === true ? { requirementsPending: true as const } : {}),
    ...(pack === undefined || pack.environment.dependencies === undefined ? {} : { dependencies: pack.environment.dependencies }),
    ...(pack === undefined ? {} : { testedIn: pack.environment.tier }),
    ...(read === undefined ? {} : {
      changed: {
        source: "host" as const, files: read.files.length,
        ...(read.files.every((file) => file.added !== undefined && file.removed !== undefined) ? {} : { uncounted: read.files.filter((file) => file.added === undefined || file.removed === undefined).length }),
        added: read.files.reduce((total, file) => total + (file.added ?? 0), 0), removed: read.files.reduce((total, file) => total + (file.removed ?? 0), 0),
        complete: read.complete, ...(tests === undefined ? {} : { testsAdded: tests.length }),
        codeChanged: read.files.some((file) => !isTestPath(file.path) && !DOCUMENT_FILE.test(file.path)),
      },
    }),
    risk: { level: risk?.level ?? "high", reasons: risk?.reasons ?? ["Rovara couldn't assess this change."], judged: read !== undefined && risk !== undefined },
    weakening: { weaker: words.weakening, flags: words.flags, notCompared },
    reviews: { code: reviewWord("CRITIC"), security: reviewWord("SECURITY"), accepted, partialDiff: workflowReviewsSawPartialDiff(workflow), sameModel: context.reviewSameModel === true },
    ...((): Pick<PrVerdictInput, "secondReview"> => { const second = context.secondReview ?? secondReviewFromLines(context.secondReviewLines); return second === undefined ? {} : { secondReview: second }; })(),
    ...(ai === undefined || (ai.eval.label as string) === "newer" ? {} : { evalCheck: { label: ai.eval.label === "No regression measured (eval)" ? "No regression measured" as const : ai.eval.label as "Improved on eval" | "Worse on eval" | "Not run", promptChanged: ai.promptWithoutEval === true } }),
    ...(flaky > 0 ? { flakyReruns: flaky } : {}),
    ...(context.mergeOrderLines === undefined || context.mergeOrderLines.length === 0 ? {} : { mergeOrder: context.mergeOrderLines }),
    ...((): Pick<PrVerdictInput, "browser"> => { const summary = browserSummary(context.browserEvidenceLines); return summary === undefined ? {} : { browser: summary }; })(),
    ...((): Pick<PrVerdictInput, "used"> => { const used = context.lessonsUsed; return used === undefined || used.count <= 0 ? {} : { used: { lessons: used.count, wikiPages: 0 } }; })(),
  };
  return prVerdictOf(verdictInput);
}

// ---- drawers

const details = (summary: string, body: readonly string[]): string[] => ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>", ""];

/** The "What Rovara used" drawer's lines: the lessons (titles and "not helpful" links only where the repository is known to be private: `entries` is empty otherwise), or a count and the one link. */
export function usedDrawerLines(used: LessonsUsedSection | undefined, limit: number): string[] {
  if (used === undefined || used.count <= 0) return [];
  const noun = used.count === 1 ? "lesson" : "lessons";
  const link = SAFE_LINK.test(used.taskUrl) ? used.taskUrl : undefined;
  if (used.entries.length === 0 || limit <= 0) return [`Rovara used ${used.count} ${noun} from this project's record.${link === undefined ? "" : ` Review them, or tell Rovara one did not help, on the [task page](${link}).`}`];
  const shown = used.entries.slice(0, limit).map((entry) => `${entry.number === undefined ? "-" : `${String(entry.number)}.`} ${inertLine(entry.title, 100)}${SAFE_LINK.test(entry.notHelpfulUrl) ? ` ([not helpful](${entry.notHelpfulUrl}))` : ""}`);
  const byComment = used.entries.some((entry) => entry.number !== undefined && !SAFE_LINK.test(entry.notHelpfulUrl));
  return [`Rovara used ${used.count} ${noun} from this project's record. ${byComment ? "Comment `/rovara lesson <number> wrong` to tell Rovara one did not help." : "Tell Rovara when one did not help."}`, "", ...shown, ...(used.count > shown.length ? [`and ${used.count - shown.length} more`] : [])];
}

/** The block's lines at a shrink level (0 is the full block): heading, six lines, the list, the drawers, the Fixes line. */
export function layoutBlockLines(input: LayoutInput, level: number): { verdict: PrVerdict; lines: string[] } {
  const verdict = verdictOfLayout(input);
  const { context, parts } = input;
  const at = Math.min(LAYOUT_LEVEL_LAST, Math.max(0, level));
  const tableLevel = Math.min(at, 4);
  const render = parts?.render(tableLevel);
  const bodyOf = (lines: readonly string[]): string[] => (at >= 4 ? [DRAWER_LEFT_OUT] : [...lines]);

  const { six, list } = prVerdictMarkdown(verdict, at >= LAYOUT_LEVEL_LAST ? ITEMS_LISTED_LAST : ITEMS_LISTED);

  // Requirements and proof
  const hasRequirements = parts !== undefined && (parts.stale || parts.table.rows.length > 0);
  const requirementsBody = render === undefined ? [] : [...render.requirements, ...(render.notTested.length > 0 && hasRequirements ? ["", "What wasn't tested:", ...render.notTested] : [])];
  // Checks
  const rows = context.testing?.rows ?? checkRowsOf(input.workflow);
  const view: TestingView | undefined = context.testing;
  const resultLine = view === undefined ? [] : [`Result: ${TESTING_RESULT_LABELS[view.result]}.`, ""];
  const evidenceOpen = ((): string[] => {
    // A private repository with a version 2 evidence writer keeps the shared renderer's block (its first line, where the checks ran, the sandbox caveat, the checks) under Checks, without its heading (the drawer is the heading). A public one keeps the counts-only AI lines.
    if (context.evidenceWriter !== 2) return [];
    const block = context.repositoryKnownPrivate === true ? evidenceV2Lines(context.proof?.evidence, input.workflow.candidate?.digest, context.changedFiles?.files, tableLevel) : evidencePublicAiLines(context.proof?.evidence, input.workflow.candidate?.digest);
    return block === undefined ? [] : block.slice(1).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  })();
  const checksBody = [...resultLine, ...testingTableLines(rows, tableLevel), ...(input.checksExtra.length === 0 ? [] : ["", ...input.checksExtra]), ...(render === undefined || render.checksEvidence.length === 0 ? [] : ["", ...render.checksEvidence.map((line) => `- ${line}`)]), ...(evidenceOpen.length === 0 ? [] : ["", ...evidenceOpen])];
  // Test setup
  const setupLines = [...(context.setupLine === undefined ? [] : [`- ${inertLine(context.setupLine, 300)}`]), ...(render === undefined ? [] : render.setupEvidence.map((line) => `- ${line}`))];
  const setupNotTested = render !== undefined && render.notTested.length > 0 && !hasRequirements ? ["", "What wasn't tested:", ...render.notTested] : [];
  const setupBody = setupLines.length + setupNotTested.length === 0 ? ["No test setup details were recorded for this code."] : [...setupLines, ...setupNotTested];
  // Reviews
  const reviewsBody = [...input.reviewLines(at >= 3 ? 3 : 20), ...input.reviewExtra, ...(context.secondReview?.state === "agreed" ? ["Second review: no blocking finding."] : []), ...(context.secondReviewLines ?? [])];
  const screenshots = verdict.drawers.screenshots === undefined ? [] : context.browserEvidenceLines?.filter((line) => typeof line === "string" && line !== "" && !/[\r\n]/u.test(line)) ?? [];
  const used = usedDrawerLines(context.lessonsUsed, at >= 3 ? 0 : 10);

  const drawers = [
    ...(verdict.drawers.requirements === undefined ? [] : details(verdict.drawers.requirements, bodyOf(requirementsBody.length === 0 ? ["No requirement table was recorded."] : requirementsBody))),
    // A task whose AI evaluation got worse keeps the AI evidence (the label, the counts, the question that broke a safety rule) in the drawer even at the last shrink level: it is bad news with detail the list above cannot hold.
    ...details(verdict.drawers.checks, at >= 4 && verdict.items.some((item) => item.kind === "eval_worse") && evidenceOpen.length > 0 ? [DRAWER_LEFT_OUT, "", ...evidenceOpen] : bodyOf(checksBody.length === 0 ? ["No checks were recorded for this code."] : checksBody)),
    ...details(verdict.drawers.setup, bodyOf(setupBody)),
    ...details(verdict.drawers.reviews, bodyOf(reviewsBody)),
    ...(verdict.drawers.screenshots === undefined ? [] : details(verdict.drawers.screenshots, bodyOf(screenshots))),
    ...(verdict.drawers.used === undefined ? [] : details(verdict.drawers.used, bodyOf(used))),
  ];
  const lines = [`## ${verdict.heading}`, "", ...six, "", ...list, ...(input.setupChange ?? []), ...drawers, ...(input.linearCloseLine === undefined ? [] : [input.linearCloseLine])];
  return { verdict, lines };
}
