// Rovara Code (Plan 6 Task 13): the description of a version 2 task's pull request. It says what the approved plan set out to do, what changed, how it was tested, how the reviews went and how risky the
// code is, between markers that Rovara rewrites after every fix or sync, and it ends with the line that says a person approves and a person merges. The description is public to the repository's
// readers: every line that a model, a file name or a branch name wrote goes through `inertLine` (redacted, one line, no mention, link, image, cross-reference or hidden comment), every list is bounded,
// and the whole body stays under the byte cap with its markers, risk and closing line intact so it can always be regenerated in place.
import { attributionBodyLines, hideEmailAddresses, TESTING_RESULT_LABELS, type ActingAttribution, type RiskAssessment, type TestingView, type VerificationReport, type WorkflowSnapshot } from "@agentx/contracts";
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../../developer/pull-request-feedback-section.js";
import { inertLine } from "./inert-text.js";
import { reviewModelLines } from "./review-model-lines.js";
import { testingSectionLines } from "./testing-section.js";
import { linearCloseLine, neutralizeLinearWords, normalizeIssueKey, sealLinearText } from "./linear-close.js";
import { PROOF_LEVEL_LAST, proofSection, type ProofContext } from "./proof-section.js";
import { testProofLinesOf } from "./proof-table.js";
import type { EvidenceRiskSignal } from "./evidence-risk.js";
import { assessRisk, riskHeading } from "./risk.js";
import { verificationReport, type ChangedFileEntry, type VerificationProject } from "./verification-report.js";

export { ROVARA_STATUS_START, ROVARA_STATUS_END };

export const ROVARA_PULL_REQUEST_CLOSING = "Opened by Rovara after the approved plan, checks and reviews. A person must approve it and a person merges it.";

/** The most bytes a description holds. */
export const PULL_REQUEST_BODY_MAX_BYTES = 30_000;
/** The most bytes of the plan summary at the top. */
const SUMMARY_MAX_BYTES = 6_000;
const SUMMARY_LINE_MAX = 500;
const ITEM_MAX = 200;
/** How many entries each list shows before it says "and N more"; the body tries these in turn until it fits. */
const LIST_LIMITS = [20, 10, 5, 2, 0] as const;

/** The changed files of a task and whether the list is whole (it is not when the diff couldn't be read in full). */
export interface ChangedFilesRead {
  files: readonly ChangedFileEntry[];
  complete: boolean;
}

/** What the description needs beyond the workflow. */
export interface PullRequestBodyContext {
  /** Absent: the list of changed files could not be read. */
  changedFiles?: ChangedFilesRead | undefined;
  /** How the pull request's CI is judged (from the tracked pull request). */
  ciBasis?: "required" | "all_checks" | undefined;
  /** The base branch's name, for the all-checks line. */
  baseBranch?: string | undefined;
  /** The Linear issue key the task's session follows (Plan 6 Task 20): the block then says `Fixes <KEY>`, which Linear's GitHub integration closes the issue on. Anything that is not a key is ignored. */
  linearIssueKey?: string | undefined;
  /** The test-proof lines (whether the new tests fail on the original code), already redacted and made inert; informational, listed at the end of the Tests section. */
  proofLines?: readonly string[] | undefined;
  /** The reviews of this code ran on the build's own model (`reviewSameModelOf`): the Reviews section says so. */
  reviewSameModel?: boolean | undefined;
  /** SH34: the second review's lines (`secondReviewPullRequestLines`: already inert, none for a shadow opinion), listed at the end of the Reviews section. */
  secondReviewLines?: readonly string[] | undefined;
  /** The approved plan, the browser/API rows and the test proof for the Proof section (Playbook P1). Absent, or without a plan with claims: the description has no Proof section. */
  proof?: ProofContext | undefined;
  /** Proof and evidence P4: a security scan's new high findings on this code (the evidence pack, only while the proof switch is on). It can only raise the risk shown. */
  evidenceRisk?: EvidenceRiskSignal | undefined;
  /** I3: who asked for the work and who approved its plan, built by the broker from its own records (`broker/src/attribution`). Lines outside the marked block, so a status rewrite leaves them. */
  attribution?: ActingAttribution | undefined;
  /**
   * "Lessons used" (DECISIONS 24): the lessons the task loaded, each with the link that opens the task page ready to mark it not helpful (a page that asks, never a link that acts). Titles are the
   * lessons' own words and go through `inertLine`; only lessons of the project's own audience are listed (the description is read by everyone who can see the repository). Absent or empty: no section.
   */
  lessonsUsed?: LessonsUsedSection | undefined;
  /**
   * Setup and test health SH18 (only while `vx` is on; the caller builds it with `testingViewOf` and leaves it out otherwise): the Testing view of this code. Present, the description says `## Testing - <result>`
   * with one row per check instead of the `## Tests` lists, and the Proof table starts with the result. Absent, the description is exactly what it was.
   */
  testing?: TestingView | undefined;
}

/** One lesson the task loaded, for the description: its title and the https link to the task page that offers "not helpful" for it. */
export interface LessonUsedEntry { title: string; notHelpfulUrl: string; /** The number a comment command names it by (`/rovara lesson <number> wrong`), for an install with no page this description can link to. */ number?: number }
/** The "Lessons used" section: how many lessons the task used, the task page's link, and the lessons themselves only where the repository is known to be private (`entries` is empty otherwise). */
export interface LessonsUsedSection { count: number; taskUrl: string; entries: readonly LessonUsedEntry[]; /** The section is there and says none were used. `reason`: lessons are `off` on this install, or on but none `unused` yet; absent: an install with no lessons at all. */ none?: true; reason?: "off" | "unused" }
const SAFE_LINK = /^https:\/\/[^\s()<>[\]\\]{1,500}$/u;
/** The "Lessons used" section's lines, shrinking with the other lists: `limit` entries, then a count. Version 1 and version 2 descriptions both use it. */
export function lessonsUsedLines(used: LessonsUsedSection | undefined, limit: number): string[] {
  if (used?.none === true && used.count <= 0) {
    if (used.reason === "off") return ["## Lessons used", "None. Lessons are switched off on this install.", ""];
    if (used.reason === "unused") return ["## Lessons used", "None used yet. Lessons are on: Rovara learns from finished tasks, and each lesson waits for the owner's approval before it is used.", ""];
    return ["## Lessons used", "None. This install does not use lessons yet.", ""];
  }
  if (used === undefined || used.count <= 0) return [];
  const noun = used.count === 1 ? "lesson" : "lessons";
  const link = SAFE_LINK.test(used.taskUrl) ? used.taskUrl : undefined;
  if (used.entries.length === 0) {
    // A public repository, or one whose visibility is unknown: no titles, one link (the task page, behind sign-in), so the lessons' words are not published to everyone who can read the code.
    return ["## Lessons used", `Rovara used ${used.count} ${noun} from this project's record.${link === undefined ? "" : ` Review them, or tell Rovara one did not help, on the [task page](${link}).`}`, ""];
  }
  const shown = used.entries.slice(0, limit).map((entry) => `- ${entry.number === undefined ? "" : `${String(entry.number)}. `}${inertLine(entry.title, 100)}${SAFE_LINK.test(entry.notHelpfulUrl) ? ` ([not helpful](${entry.notHelpfulUrl}))` : ""}`);
  const byComment = used.entries.some((entry) => entry.number !== undefined && !SAFE_LINK.test(entry.notHelpfulUrl));
  return ["## Lessons used", `Rovara used ${used.count} ${noun} from this project's record. ${byComment ? "Comment `/rovara lesson <number> wrong` to tell Rovara one did not help." : "Tell Rovara when one did not help."}`, ...shown, ...(used.count > shown.length ? [`- and ${used.count - shown.length} more`] : []), ""];
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** The code reviewer's level for the workflow's current code, when it gave one. */
function reviewerRiskOf(workflow: WorkflowSnapshot): RiskAssessment["level"] | undefined {
  const current = workflow.candidate?.digest;
  const reviews = (workflow.reviews ?? []).filter((review) => review.role === "CRITIC" && review.candidateDigest === current);
  return reviews.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]?.risk;
}

/** The risk of the workflow's current code, from the files, the report, the findings and the reviewer. Undefined without a candidate. */
export function assessWorkflowRisk(workflow: WorkflowSnapshot, read: ChangedFilesRead | undefined, project: VerificationProject, evidence?: EvidenceRiskSignal): RiskAssessment | undefined {
  const digest = workflow.candidate?.digest;
  if (digest === undefined) return undefined;
  const files = read?.files ?? [];
  const reviewerRisk = reviewerRiskOf(workflow);
  const securityFindings = (workflow.reviews ?? [])
    .filter((review) => review.role === "SECURITY" && review.candidateDigest === digest)
    .reduce((count, review) => count + review.findings.filter((finding) => finding.origin === "INTRODUCED").length, 0);
  return assessRisk({
    changedFiles: files, changedFilesComplete: read?.complete === true, report: verificationReport(workflow, files, project),
    acceptedFindings: (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === digest).map((finding) => ({ role: finding.role })),
    securityFindings, ...(reviewerRisk === undefined ? {} : { reviewerRisk }), candidateDigest: digest,
    // A change made as a fix (CI, a conflict or comments) is judged for hiding the failure it was asked to fix.
    ...(workflow.fixSource === undefined ? {} : { fix: true }),
    ...(evidence === undefined ? {} : { evidence }),
  });
}

/**
 * The workflow with its risk recomputed for its current code. Call it whenever the candidate changes (the pull request opens, a fix or a sync is pushed). A version 1 task shows no risk level and is
 * returned as it is.
 */
export function recomputeRisk(workflow: WorkflowSnapshot, read: ChangedFilesRead | undefined, project: VerificationProject, evidence?: EvidenceRiskSignal): WorkflowSnapshot {
  if (workflow.definitionVersion !== "1.1.0") return workflow;
  const risk = assessWorkflowRisk(workflow, read, project, evidence);
  return risk === undefined ? workflow : { ...workflow, risk };
}

/** The risk the description shows: computed from the files when they are known, else the one recorded for this very code, else computed without the files (never low). */
function riskShown(workflow: WorkflowSnapshot, context: PullRequestBodyContext): RiskAssessment | undefined {
  if (context.changedFiles === undefined && workflow.risk !== undefined && workflow.risk.candidateDigest === workflow.candidate?.digest) return workflow.risk;
  // The evidence (kept for exactly this code, only while the proof switch is on) can only raise the level, through a security scan's new high findings.
  return assessWorkflowRisk(workflow, context.changedFiles, { ...(context.ciBasis === undefined ? {} : { ciBasis: context.ciBasis }) }, context.evidenceRisk);
}

const more = (count: number, listed: number) => (count > listed ? ` and ${count - listed} more` : "");

/** `a; b; c and 2 more`, each entry inert and cut. */
function joined(items: readonly string[], limit: number): string {
  const listed = items.slice(0, limit).map((item) => inertLine(item, ITEM_MAX));
  return `${listed.join("; ")}${more(items.length, listed.length)}`;
}

function changedLines(context: PullRequestBodyContext, limit: number): string[] {
  const read = context.changedFiles;
  if (read === undefined) return ["Rovara couldn't list the changed files."];
  if (read.files.length === 0) return [read.complete ? "No changed files were listed." : "Rovara couldn't list the changed files."];
  // A file the diff gave no count for is unknown, not 0 lines: the totals say "at least" and the file says it was not counted.
  const uncounted = read.files.filter((file) => file.added === undefined || file.removed === undefined).length;
  const added = read.files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = read.files.reduce((total, file) => total + (file.removed ?? 0), 0);
  const repositories = new Set(read.files.map((file) => file.repository));
  const countedFiles = read.files.length - uncounted;
  const counts = uncounted === 0 ? `+${added} -${removed}`
    : countedFiles === 0 ? "lines not counted"
      : `at least +${added} -${removed}; ${uncounted} ${uncounted === 1 ? "file" : "files"} not counted`;
  return [
    `${read.files.length}${read.complete ? "" : " or more"} file${read.files.length === 1 ? "" : "s"} changed (${counts})${read.complete ? "" : "; the list may be incomplete"}.`,
    ...read.files.slice(0, limit).map((file) => {
      const size = file.added === undefined || file.removed === undefined ? "lines not counted" : `+${file.added} -${file.removed}`;
      const moved = file.renamedFrom === undefined ? "" : ` renamed from ${inertLine(file.renamedFrom, ITEM_MAX)}`;
      return `- ${repositories.size > 1 ? `${inertLine(file.repository, 60)}: ` : ""}${inertLine(file.path, ITEM_MAX)}${moved} (${size})`;
    }),
    ...(read.files.length > limit && limit > 0 ? [`- and ${read.files.length - limit} more`] : []),
  ];
}

const SHORT_SHA = 8;
/** The most repositories whose tested commit the Tests section names. */
const TESTED_COMMITS_MAX = 8;

/**
 * The commit the checks ran on: the head of the current candidate, per repository, and the head the pull request holds when that is a different commit with the same code. Undefined when no check
 * ran on this code, because a line that said "tested" would then be untrue.
 */
function testedCommitLine(workflow: WorkflowSnapshot, report: VerificationReport): string | undefined {
  const candidate = workflow.candidate;
  if (candidate === undefined || report.passed.length + report.failed.length === 0) return undefined;
  const short = (sha: string) => sha.slice(0, SHORT_SHA);
  const entries = [...candidate.repositories].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)).map((repository) => {
    const pushed = (workflow.pullRequests ?? []).find((pullRequest) => pullRequest.repositoryId === repository.repositoryId && pullRequest.candidateDigest === candidate.digest)?.headSha;
    return { repositoryId: repository.repositoryId, text: `${short(repository.commitSha)}${pushed === undefined || pushed === repository.commitSha ? "" : ` (pushed as ${short(pushed)})`}` };
  });
  if (entries.length === 1) return `- Tested on head commit ${entries[0]!.text}`;
  const listed = entries.slice(0, TESTED_COMMITS_MAX).map((entry) => `${inertLine(entry.repositoryId, 60)} ${entry.text}`);
  return `- Tested on head commits: ${listed.join(", ")}${more(entries.length, listed.length)}`;
}

/** A test-proof line: its quoted names are cut already, so this only bounds the whole line. */
const PROOF_LINE_MAX = 600;

/** The lines of the old Tests section that the Testing section keeps: the tested commit, the tests added and the test proof. */
function testingExtraLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, limit: number): string[] {
  const report: VerificationReport = verificationReport(workflow, context.changedFiles?.files ?? [], { ...(context.ciBasis === undefined ? {} : { ciBasis: context.ciBasis }) });
  const lines: string[] = [];
  const tested = testedCommitLine(workflow, report);
  if (tested !== undefined) lines.push(tested);
  const added = report.testsAdded.map((item) => item.path);
  if (context.changedFiles === undefined) lines.push("- Tests added: Rovara couldn't list the changed files, so it can't say.");
  else if (added.length === 0) lines.push(`- Tests added: none${context.changedFiles.complete ? "" : " (the list of changed files may be incomplete)"}`);
  else lines.push(`- Tests added: ${joined(added, limit)}${context.changedFiles.complete ? "" : " (the list of changed files may be incomplete)"}`);
  for (const line of context.proofLines ?? testProofLinesOf(context.proof?.testProof, workflow.candidate?.digest)) lines.push(`- ${inertLine(line, PROOF_LINE_MAX)}`);
  return lines;
}

function testLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, limit: number): string[] {
  const report: VerificationReport = verificationReport(workflow, context.changedFiles?.files ?? [], { ...(context.ciBasis === undefined ? {} : { ciBasis: context.ciBasis }) });
  const base = context.baseBranch === undefined || context.baseBranch.trim() === "" ? "the base branch" : inertLine(context.baseBranch, 100);
  const lines: string[] = [];
  if (report.ciBasis === "all_checks") lines.push(`Checked against every check on this branch, because ${base} has no required checks.`);
  const tested = testedCommitLine(workflow, report);
  if (tested !== undefined) lines.push(tested);
  if (report.passed.length > 0) lines.push(`- Passed: ${joined(report.passed.map((item) => item.label), limit)}`);
  if (report.failed.length > 0) lines.push(`- Failed: ${joined(report.failed.map((item) => `${item.label} (${item.summary})`), limit)}`);
  if (report.notChecked.length > 0) lines.push(`- Not checked: ${joined(report.notChecked.map((item) => `${item.label} (${item.reason})`), limit)}`);
  if (report.passed.length + report.failed.length + report.notChecked.length === 0) lines.push("- No checks were recorded for this code.");
  const added = report.testsAdded.map((item) => item.path);
  if (context.changedFiles === undefined) lines.push("- Tests added: Rovara couldn't list the changed files, so it can't say.");
  else if (added.length === 0) lines.push(`- Tests added: none${context.changedFiles.complete ? "" : " (the list of changed files may be incomplete)"}`);
  else lines.push(`- Tests added: ${joined(added, limit)}${context.changedFiles.complete ? "" : " (the list of changed files may be incomplete)"}`);
  // The test-proof lines have one home, this section. The publication passes the lines it read; the rewrite after a pushed fix has the proof the Proof section's reads gave it and derives the same lines from it.
  for (const line of context.proofLines ?? testProofLinesOf(context.proof?.testProof, workflow.candidate?.digest)) lines.push(`- ${inertLine(line, PROOF_LINE_MAX)}`);
  return lines;
}

/**
 * The lines between the markers: What changed, Tests, Reviews and Risk, about the code now on the pull request. `reviewLines(listed)` gives the Reviews section's lines (at most `listed` accepted
 * findings named). The lists shrink until the block fits `budgetBytes`.
 */
export function rovaraStatusLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, reviewLines: (listed: number) => string[], budgetBytes = PULL_REQUEST_BODY_MAX_BYTES - SUMMARY_MAX_BYTES - 2_000): string[] {
  const risk = riskShown(workflow, context);
  const linearKey = normalizeIssueKey(context.linearIssueKey);
  let lines: string[] = [];
  const proof = proofSection(workflow, context.proof, context.testing === undefined ? undefined : TESTING_RESULT_LABELS[context.testing.result]);
  const testing = context.testing;
  // The Proof section shrinks with the lists: its evidence text first, then its proven and passed rows, never a failed row or a not-tested item. One more step after the lists are empty shortens it again.
  const steps = [...LIST_LIMITS.map((limit, index) => ({ limit, proofLevel: Math.min(index, 3) })), { limit: 0, proofLevel: PROOF_LEVEL_LAST }];
  for (const [level, { limit, proofLevel }] of steps.entries()) {
    // The last guard: whatever a path let through, no line has a Linear magic word before a key but Rovara's own Fixes line.
    // S3: no email address on GitHub; hidden before the size is checked, so the block still fits the budget it is given.
    lines = sealLinearText([
      "## What changed", ...changedLines(context, limit), "",
      ...(testing === undefined ? ["## Tests", ...testLines(workflow, context, limit)] : testingSectionLines(testing, level, testingExtraLines(workflow, context, limit))), "",
      ...(proof === undefined ? [] : [...proof(proofLevel), ""]),
      ...lessonsUsedLines(context.lessonsUsed, limit),
      "## Reviews", ...reviewLines(limit), ...reviewModelLines(workflow, context.reviewSameModel === true).map((line) => inertLine(line, ITEM_MAX)), ...(context.secondReviewLines ?? []), "",
      `## Risk: ${riskHeading(risk?.level ?? "medium")}`, ...(risk?.reasons ?? ["Rovara couldn't assess this change."]).map((reason) => `- ${Array.from(reason).slice(0, ITEM_MAX).join("")}`),
      ...(linearKey === undefined ? [] : ["", linearCloseLine(linearKey)]),
    ], linearKey).map((line) => hideEmailAddresses(line));
    if (byteLength(lines.join("\n")) <= budgetBytes) return lines;
  }
  return lines;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const NUMBER = String.raw`\d{1,3}|${NUMBER_WORDS.join("|")}`;
/** "Four files change", "3 files are touched": a statement of how many files the change touches, as the plan's words put it. */
const FILES_THEN_VERB = new RegExp(String.raw`\b(${NUMBER})\s+files?\s+((?:will\s+(?:be\s+)?)?(?:change|changes|changed|are\s+(?:changed|touched|modified|edited|affected)|need\s+to\s+change|get\s+changed))\b`, "giu");
/** "touches four files", "changing 3 files". */
const VERB_THEN_FILES = new RegExp(String.raw`\b(touch(?:es|ing)?|chang(?:es|ing)|modif(?:y|ies|ying)|edit(?:s|ing)?|affect(?:s|ing)?)\s+(${NUMBER})\s+files?\b`, "giu");

const numberOf = (word: string): number | undefined => (/^\d+$/u.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase()) === -1 ? undefined : NUMBER_WORDS.indexOf(word.toLowerCase()));

/**
 * A plan's count of the files it changes, set right by the diff. The plan is written before the code, and "Four files change" outlives the fifth file the work needed; the description's own count
 * (What changed) is the diff's, so the quoted plan must not contradict it. Only a statement of the whole change's file count is touched ("<n> files change", "touches <n> files"), only when the list
 * of changed files is whole, and only when the numbers differ; what the plan said stays in the line. A phrase with a word between the number and "files" ("three test files") counts something else and is left alone.
 */
export function withDiffFileCount(line: string, actual: number | undefined): string {
  if (actual === undefined) return line;
  const files = `${actual} ${actual === 1 ? "file" : "files"}`;
  return line
    .replace(FILES_THEN_VERB, (whole, said: string, verb: string) => (numberOf(said) === actual ? whole : `${files} ${verb} (the plan said ${said.toLowerCase()})`))
    .replace(VERB_THEN_FILES, (whole, verb: string, said: string) => (numberOf(said) === actual ? whole : `${verb} ${files} (the plan said ${said.toLowerCase()})`));
}

/** The plan summary lines, each inert and cut, within their byte budget. `files` is the diff's count of changed files when the list is whole. */
function summaryOf(lines: readonly string[], files?: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const text = withDiffFileCount(inertLine(line, SUMMARY_LINE_MAX), files);
    if (text === "") continue;
    bytes += byteLength(text) + 1;
    if (bytes > SUMMARY_MAX_BYTES) break;
    kept.push(text);
  }
  return kept;
}

/**
 * The description of a version 2 task's pull request: the plan summary (or the task's title), the marked block, the session link and the closing line. At most 30,000 bytes: the lists shrink first, and the
 * markers, the risk and the closing line always stay.
 */
export function rovaraPullRequestBody(input: {
  summary: readonly string[];
  fallbackTitle: string;
  workflow: WorkflowSnapshot;
  context: PullRequestBodyContext;
  reviewLines: (listed: number) => string[];
  pageUrl: string | undefined;
}): string {
  // The plan's words are a model's: they sit under their own heading as a quotation (a quotation holds a heading, a fence or a rule inside it), so they cannot pose as one of Rovara's sections.
  const read = input.context.changedFiles;
  const summary = summaryOf(input.summary, read !== undefined && read.complete && read.files.length > 0 ? read.files.length : undefined);
  const quoted = (summary.length > 0 ? summary : [inertLine(input.fallbackTitle, SUMMARY_LINE_MAX)]).map((line) => `> ${neutralizeLinearWords(line)}`);
  const head = ["## Plan summary", ...quoted].map((line) => hideEmailAddresses(line));
  const who = attributionBodyLines(input.context.attribution);
  const tail = [...(who.length === 0 ? [] : [...who, ""]), ...(input.pageUrl === undefined ? [] : [`Rovara session: ${input.pageUrl}`, ""]), ROVARA_PULL_REQUEST_CLOSING].map((line) => hideEmailAddresses(line));
  const assemble = (headLines: readonly string[], block: readonly string[]) => [...headLines, "", ROVARA_STATUS_START, ...block, ROVARA_STATUS_END, ...tail].join("\n");
  const fixed = byteLength(assemble(head, []));
  const block = rovaraStatusLines(input.workflow, input.context, input.reviewLines, PULL_REQUEST_BODY_MAX_BYTES - fixed);
  // The block's budget leaves room for the summary at its largest. The block at its shortest has no list entries, its Testing section is down to counts per fixed reason (`testingSectionLines` level 5, bounded by the
  // fixed lists whatever the rows hold), and every other part is bounded, so this always fits.
  return assemble(head, block);
}

// ---- the open description follows the binding

/** The line Rovara wrote itself: `Fixes <KEY>` and nothing else on the line. */
const OWN_FIXES_LINE = /^Fixes [A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]{0,8}$/u;

/**
 * An open pull request's description with Rovara's `Fixes <KEY>` line inside its marked block changed to `key`, or taken out when `key` is undefined (a binding that was replaced or removed). Only the block
 * is touched, only a line that is exactly Rovara's own, and the person's words around the block stay. `same`: nothing to change. `no_block`: a line is wanted but the block is not as Rovara wrote it (it was
 * edited away, doubled or cut), so nothing is written; with no `key` and no block there is nothing of Rovara's to take out.
 */
export function withLinearCloseLine(body: string, key: string | undefined): { kind: "same" } | { kind: "changed"; body: string } | { kind: "no_block" } {
  const start = body.indexOf(ROVARA_STATUS_START);
  const end = body.indexOf(ROVARA_STATUS_END);
  if (start === -1 && end === -1) return key === undefined ? { kind: "same" } : { kind: "no_block" };
  if (start === -1 || end === -1 || end < start || body.indexOf(ROVARA_STATUS_START, start + 1) !== -1 || body.indexOf(ROVARA_STATUS_END, end + 1) !== -1) return { kind: "no_block" };
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const inner = body.slice(start + ROVARA_STATUS_START.length, end).split(eol);
  const found = inner.flatMap((line, index) => (OWN_FIXES_LINE.test(line) ? [index] : []));
  const wanted = key === undefined ? undefined : linearCloseLine(key);
  let next: string[];
  if (found.length === 0) {
    if (wanted === undefined) return { kind: "same" };
    // Before the last (empty) element, which is the line break before the end marker.
    next = [...inner.slice(0, -1), "", wanted, ...inner.slice(-1)];
  } else if (wanted === undefined) {
    next = inner.filter((_line, index) => !found.includes(index) && !(index === found[0]! - 1 && inner[index] === ""));
  } else {
    if (found.length === 1 && inner[found[0]!] === wanted) return { kind: "same" };
    next = inner.flatMap((line, index) => (index === found[0] ? [wanted] : found.includes(index) ? [] : [line]));
  }
  return { kind: "changed", body: `${body.slice(0, start + ROVARA_STATUS_START.length)}${next.join(eol)}${body.slice(end)}` };
}
