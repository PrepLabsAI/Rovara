// Rovara Code (Plan 6 Task 13): the description of a version 2 task's pull request. It says what the approved plan set out to do, what changed, how it was tested, how the reviews went and how risky the
// code is, between markers that Rovara rewrites after every fix or sync, and it ends with the line that says a person approves and a person merges. The description is public to the repository's
// readers: every line that a model, a file name or a branch name wrote goes through `inertLine` (redacted, one line, no mention, link, image, cross-reference or hidden comment), every list is bounded,
// and the whole body stays under the byte cap with its markers, risk and closing line intact so it can always be regenerated in place.
import { attributionBodyLines, hideEmailAddresses, type ActingAttribution, type PrVerdict, type RiskAssessment, type TestingView, type VerdictSecondReview, type VerificationReport, type WorkflowSnapshot } from "@agentx/contracts";
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../../developer/pull-request-feedback-section.js";
import { inertLine } from "./inert-text.js";
import { reviewModelLines } from "./review-model-lines.js";
import { linearCloseLine, neutralizeLinearWords, normalizeIssueKey, sealLinearText } from "./linear-close.js";
import { LAYOUT_LEVEL_LAST, layoutBlockLines, verdictOfLayout } from "./pull-request-layout.js";
import { proofParts, recordedCheckIdsOf, type ProofContext } from "./proof-section.js";
import { testProofLinesOf, testProofQualifier } from "./proof-table.js";
import type { EvidenceRiskSignal } from "./evidence-risk.js";
import { assessRisk } from "./risk.js";
import { verificationReport, type ChangedFileEntry, type VerificationProject } from "./verification-report.js";

export { ROVARA_STATUS_START, ROVARA_STATUS_END };

export const ROVARA_PULL_REQUEST_CLOSING = "Opened by Rovara after the approved plan, checks and reviews. A person must approve it and a person merges it.";
/** The closing of a small change whose plan went to coding with no approval (the lighter flow). */
export const ROVARA_PULL_REQUEST_CLOSING_NO_APPROVAL = "Opened by Rovara after the plan (no approval needed: small change), checks and reviews. A person must approve it and a person merges it.";

/** The most bytes a description holds. */
export const PULL_REQUEST_BODY_MAX_BYTES = 30_000;
/** The most bytes of the plan summary at the top. */
const SUMMARY_MAX_BYTES = 6_000;
const SUMMARY_LINE_MAX = 500;
const ITEM_MAX = 200;
/** The most characters of the one-line quote on top of the description (what this change is for). */
const QUOTE_MAX = 200;

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
  /** Who accepted each accepted review finding and by what way (`acceptedByOf`, keyed by the finding's fingerprint): "<name> via <method>". Shown beside the finding's reason. */
  acceptedBy?: Readonly<Record<string, string>> | undefined;
  /** SH34: the second review's lines (`secondReviewPullRequestLines`: already inert, none for a shadow opinion), listed at the end of the Reviews drawer. */
  secondReviewLines?: readonly string[] | undefined;
  /** L4-C: the same second review as the verdict reads it (`secondReviewPrStatus`): only for an `on` review, never for a shadow one. The verdict says "agreed" only from this; absent, it says nothing about a second review. */
  secondReview?: VerdictSecondReview | undefined;
  /** L4-C: the date of the pull request (ISO), for the age of a recorded fake. Absent: the workflow's last update. */
  asOf?: string | undefined;
  /** The approved plan, the browser/API rows and the test proof for the Proof section (Playbook P1). Absent, or without a plan with claims: the description has no Proof section. */
  proof?: ProofContext | undefined;
  /** Proof and evidence P4: a security scan's new high findings on this code (the evidence pack, only while the proof switch is on). It can only raise the risk shown. */
  evidenceRisk?: EvidenceRiskSignal | undefined;
  /**
   * MR3b: the lines about the order this task's pull requests merge in (`mergeOrderLinesOfTask`: the order itself, or the fixed "no safe order" words, and what happened when one was merged ahead of the one it depends
   * on). Already inert and bounded; printed under their own heading at the top of the block, so every pull request of a multi-repository task says it. Absent or empty: no section, and the description is what it was.
   */
  mergeOrderLines?: readonly string[] | undefined;
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
  /**
   * TE-A2b: which version of the evidence the description prints. Absent or 1 (the default): exactly what it was, a v2 pack in `proof.evidence.read` changes nothing. 2: when `proof.evidence.read` is a v2 pack for this code,
   * the description starts with an Evidence block from the shared renderer (first line, where the checks ran, the flags, the checks, what was not tested), which takes the place of the flags block below; with any other
   * pack it is the v1 description. The caller chooses the version (in Cloud, by the TE-A1 company gate).
   */
  evidenceWriter?: 1 | 2 | undefined;
  /**
   * TE-A2b (B12 review M2): the repository is KNOWN to be private. The Evidence block carries check labels, test names and not-tested reasons, which a repository's own words and an address can reach, and a description
   * is read by everyone who can see the repository, so, like the lessons' titles, the block is printed only when this is true. Absent (unknown) or false (public): no block, the v1 lines. The caller sets it from the code host.
   */
  repositoryKnownPrivate?: boolean | undefined;
  /**
   * TE-H1 browser evidence (DEC 241d): the text lines about the before and after screenshots of the changed pages (`browserEvidenceLines`: who ran it, that it is visual evidence only, one line per page, "on the task page, behind sign-in").
   * Text only: no image, no address of one and no digest ever reaches GitHub, because an image a PR reader's browser can fetch would be public. Absent or empty: the description is exactly what it was.
   */
  browserEvidenceLines?: readonly string[] | undefined;
  /** L4-SC (DEC 254z c): one line per mock the approved plan made for this task (`mockPrLines`). Absent or empty: the description is exactly what it was. */
  setupLines?: readonly string[] | undefined;
}

/** One lesson the task loaded, for the description: its title and the https link to the task page that offers "not helpful" for it. */
export interface LessonUsedEntry { title: string; /** The lesson's reason, one line; shown after the title where there is one. */ why?: string; notHelpfulUrl: string; /** The number a comment command names it by (`/rovara lesson <number> wrong`), for an install with no page this description can link to. */ number?: number }
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
  const shown = used.entries.slice(0, limit).map((entry) => `- ${entry.number === undefined ? "" : `${String(entry.number)}. `}${inertLine(entry.title, 100)}${entry.why === undefined || inertLine(entry.why, 160) === "" ? "" : ` Why: ${inertLine(entry.why, 160)}`}${SAFE_LINK.test(entry.notHelpfulUrl) ? ` ([not helpful](${entry.notHelpfulUrl}))` : ""}`);
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

/** Supplied publication lines and derived rewrite lines carry the same mock qualifier. */
function testProofBodyLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext): string[] {
  const provenance = { recordedCheckIds: recordedCheckIdsOf(workflow), checkDependencies: context.proof?.checkDependencies, realModelRun: context.proof?.realModelRun };
  const qualifier = testProofQualifier(context.proof?.testProof, workflow.candidate?.digest, provenance);
  return context.proofLines === undefined
    ? testProofLinesOf(context.proof?.testProof, workflow.candidate?.digest, provenance)
    : context.proofLines.map((line) => `${qualifier}${line}`);
}

/**
 * The lines the Checks drawer keeps from the old Tests section: the basis of the CI judgement, the tested commit, the tests added (only when some: "none" is not said) and the test proof. Each is one line, redacted and made inert.
 * Returns the paths of the tests added too (undefined when the changed files were not read), for the verdict.
 */
function checksExtraLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, limit: number): { lines: string[]; testsAdded: string[] | undefined } {
  const report: VerificationReport = verificationReport(workflow, context.changedFiles?.files ?? [], { ...(context.ciBasis === undefined ? {} : { ciBasis: context.ciBasis }) });
  const base = context.baseBranch === undefined || context.baseBranch.trim() === "" ? "the base branch" : inertLine(context.baseBranch, 100);
  const lines: string[] = [];
  if (report.ciBasis === "all_checks") lines.push(`Checked against every check on this branch, because ${base} has no required checks.`);
  const tested = testedCommitLine(workflow, report);
  if (tested !== undefined) lines.push(tested);
  const added = context.changedFiles === undefined ? undefined : report.testsAdded.map((item) => item.path);
  if (added !== undefined && added.length > 0) lines.push(`- Tests added: ${joined(added, limit)}${context.changedFiles!.complete ? "" : " (the list of changed files may be incomplete)"}`);
  for (const line of testProofBodyLines(workflow, context)) lines.push(`- ${inertLine(line, PROOF_LINE_MAX)}`);
  return { lines, testsAdded: added };
}

/**
 * The lines between the markers: What changed, Tests, Reviews and Risk, about the code now on the pull request. `reviewLines(listed)` gives the Reviews section's lines (at most `listed` accepted
 * findings named). The lists shrink until the block fits `budgetBytes`.
 */
/** The "Setup change" section: the one line per task-only mock, each made inert and cut, so a service name from the plan can add no heading, link or mention. Nothing when there is none. */
export function setupChangeSection(lines: readonly string[] | undefined): string[] {
  const kept = (lines ?? []).filter((line) => typeof line === "string" && line !== "" && !/[\r\n]/u.test(line)).map((line) => inertLine(line, ITEM_MAX));
  return kept.length === 0 ? [] : ["## Setup change", ...kept, ""];
}

/** The "Browser evidence" section: its fixed lines under a heading and a blank line after; nothing for none. Each line is one line (a line with a break in it is dropped, so a section never carries other markup). */
export function browserEvidenceSection(lines: readonly string[] | undefined): string[] {
  const kept = (lines ?? []).filter((line) => typeof line === "string" && line !== "" && !/[\r\n]/u.test(line));
  return kept.length === 0 ? [] : ["## Browser evidence", ...kept, ""];
}

export function rovaraStatusLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, reviewLines: (listed: number) => string[], budgetBytes = PULL_REQUEST_BODY_MAX_BYTES - SUMMARY_MAX_BYTES - 2_000): string[] {
  const risk = riskShown(workflow, context);
  const linearKey = normalizeIssueKey(context.linearIssueKey);
  const parts = proofParts(workflow, context.proof);
  const reviewExtra = reviewModelLines(workflow, context.reviewSameModel === true).map((line) => inertLine(line, ITEM_MAX));
  const closeLine = linearKey === undefined ? undefined : linearCloseLine(linearKey);
  let lines: string[] = [];
  // The block shrinks level by level (pull-request-layout.ts) until it fits: tables fold their passed rows, "What Rovara used" becomes a count, drawer bodies point to the Check and the task page, the list keeps its first 10 items.
  // The quote, heading, six lines, first items, markers and closing line never shrink away.
  for (let level = 0; level <= LAYOUT_LEVEL_LAST; level += 1) {
    const extra = checksExtraLines(workflow, context, level >= 3 ? 3 : 10);
    const built = layoutBlockLines({
      workflow, context, risk, parts, reviewLines, checksExtra: extra.lines, testsAdded: extra.testsAdded, reviewExtra, linearCloseLine: closeLine, asOf: context.asOf ?? workflow.updatedAt,
      // L4-SC (#916, merged over the PR redesign in batch 14): the plan's "Setup change" lines, after the verdict list and before the drawers.
      setupChange: setupChangeSection(context.setupLines),
    }, level);
    // The last guard: whatever a path let through, no line has a Linear magic word before a key but Rovara's own Fixes line. No email address on GitHub; hidden before the size is checked.
    lines = sealLinearText(built.lines, linearKey).map((line) => hideEmailAddresses(line));
    if (byteLength(lines.join("\n")) <= budgetBytes) return lines;
  }
  return lines;
}

/**
 * L4-PRP: the verdict of the code now on the pull request, from the same facts and the same functions the description's block is written from (`rovaraStatusLines`): the "Rovara" Check says these words too. The verdict does
 * not depend on the shrink level (every level keeps the heading, the six lines and the first items), so it is computed once, at the full block's own inputs.
 */
export function rovaraPullRequestVerdict(workflow: WorkflowSnapshot, context: PullRequestBodyContext, reviewLines: (listed: number) => string[]): PrVerdict {
  const extra = checksExtraLines(workflow, context, 10);
  return verdictOfLayout({
    workflow, context, risk: riskShown(workflow, context), parts: proofParts(workflow, context.proof), reviewLines, checksExtra: extra.lines, testsAdded: extra.testsAdded,
    reviewExtra: [], linearCloseLine: undefined, asOf: context.asOf ?? workflow.updatedAt,
  });
}

/** The "Merge order" section: at most 4 lines, each one line (the lines are made inert where they are written, and are cut here again, so nothing a caller passes can add a heading or a link). */
export function mergeOrderSection(lines: readonly string[] | undefined): string[] {
  // A line that begins with a Markdown marker (a heading, a quote, a list item, a table bar) would become one: a zero-width joiner in front keeps it text.
  const shown = (lines ?? []).slice(0, 4).map((line) => inertLine(line, 600).replace(/^([#>|*+-]|\d+[.)])/u, "\u200d$1")).filter((line) => line !== "");
  return shown.length === 0 ? [] : ["## Merge order", ...shown, ""];
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
 * The description of a version 2 task's pull request (design pr-redesign.md 2.2): one quoted line on what the change is for, the marked block (the verdict, the list of things to check, the drawers), a closing drawer with the plan
 * and who asked, approved and where the record is, and the closing line. At most 30,000 bytes: the block shrinks first (`rovaraStatusLines`), and the markers, the quote and the closing line always stay.
 */
export function rovaraPullRequestBody(input: {
  summary: readonly string[];
  fallbackTitle: string;
  workflow: WorkflowSnapshot;
  context: PullRequestBodyContext;
  reviewLines: (listed: number) => string[];
  pageUrl: string | undefined;
}): string {
  // The plan's words are a model's: the quote and the closing drawer hold them as quotations (a quotation holds a heading, a fence or a rule inside it), so they cannot pose as one of Rovara's sections.
  const read = input.context.changedFiles;
  const summary = summaryOf(input.summary, read !== undefined && read.complete && read.files.length > 0 ? read.files.length : undefined);
  // The top claim as a sentence: a list marker of the plan's own ("1. ", "- ") is not part of it.
  const first = summary.length > 0 ? summary[0]!.replace(/^(?:[-*+]|\d{1,3}[.)])\s+/u, "") : inertLine(input.fallbackTitle, SUMMARY_LINE_MAX);
  const quote = `> ${neutralizeLinearWords(Array.from(first).slice(0, QUOTE_MAX).join(""))}`;
  const who = attributionBodyLines(input.context.attribution);
  // Each line of who asked, who approved and where the audit record is stays a line of its own, in the words erasure rewrites a person's line by (`rewriteAttributionBody`).
  const record = [
    ...(summary.length === 0 ? [] : [...summary.map((line) => `> ${neutralizeLinearWords(line)}`), ""]),
    ...(who.length === 0 ? [] : [...who, ""]), ...(input.pageUrl === undefined ? [] : [`Rovara session: ${input.pageUrl}`, ""]),
  ];
  const drawer = ["<details>", "<summary>Plan and record</summary>", "", ...(record.length === 0 ? ["No plan summary was recorded."] : record.slice(0, record.at(-1) === "" ? -1 : undefined)), "", "</details>", ""];
  const head = [quote, ""].map((line) => hideEmailAddresses(line));
  const tail = [...drawer, ROVARA_PULL_REQUEST_CLOSING].map((line) => hideEmailAddresses(line));
  const assemble = (block: readonly string[]) => [...head, ROVARA_STATUS_START, ...block, ROVARA_STATUS_END, "", ...tail].join("\n");
  const fixed = byteLength(assemble([]));
  const block = rovaraStatusLines(input.workflow, input.context, input.reviewLines, PULL_REQUEST_BODY_MAX_BYTES - fixed);
  return assemble(block);
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
