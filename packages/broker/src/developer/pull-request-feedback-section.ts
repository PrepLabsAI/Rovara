// D2: the "Fixes from PR feedback" section of a workflow pull request's description. After an approved PR feedback fix
// is pushed, the description lists briefly what was changed for which comments, from each approved proposal's summary,
// and is kept up to date across rounds. The summaries come from a reviewer reading untrusted comments: each is redacted
// and made inert for GitHub (no mention, link or cross-reference) before it is written.
import { PULL_REQUEST_BODY_MAX_CHARS, WORKFLOW_KEEP_PULL_REQUESTS_NOTE, WorkflowFeedbackReviewReportSchema, redactText, type WorkflowFeedbackReviewReport, type WorkflowSnapshot } from "@agentx/contracts";
import { createHash } from "node:crypto";

/** Around the description's lines about the checks and reviews of the code on the pull request (since this release). */
export const PULL_REQUEST_STATUS_START = "<!-- agentx:checks-and-reviews -->";
export const PULL_REQUEST_STATUS_END = "<!-- /agentx:checks-and-reviews -->";
const START = "<!-- agentx:pr-feedback-fixes -->";
const END = "<!-- /agentx:pr-feedback-fixes -->";
const HEADING = "### Fixes from PR feedback";
/** The newest fixes listed; older ones are counted in one line. */
const FIXES_LISTED = 20;
/** The most characters of a fix's line before its comment link: one short sentence. */
const SUMMARY_MAX = 120;
/** The fewest characters a cut summary keeps; a shorter one gives way to the fallback line. */
const SUMMARY_MIN = 30;
/** A fix's line when its summary has no short opening that can be cut cleanly. */
const SUMMARY_FALLBACK = "Made the change the comment asked for.";
const LINKS_LISTED = 3;
const REPORT_MAX_BYTES = 1_000_000;
/** The newest approvals whose reports are read for the section (each report is read from storage). */
const APPROVALS_READ = 20;

export interface FeedbackFix { summary: string; comments: string[] }

/**
 * A reviewer's line made plain text on GitHub: one line; `&` escaped first, so no entity decodes into a mention, a
 * reference or a link; every Markdown or HTML metacharacter backslash-escaped, so nothing is a link, a reference-style
 * definition, an image, a tag, an HTML comment or one of this section's markers; then a zero-width joiner after every @,
 * inside every `//` (a scheme or protocol-relative address), after `www`, and between `#` or `GH-` and a digit, so no one is
 * mentioned or notified and no issue or pull request is cross-referenced.
 */
export function inertGitHubText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replace(/[\\`*_{}[\]()<>!#|~-]/gu, (match) => `\\${match}`)
    .replaceAll("@", "@\u200D")
    .replaceAll("//", "/\u200D/")
    .replace(/\bwww(?=\.)/giu, (match) => `${match}\u200D`)
    .replace(/#(?=\d)/gu, "#\u200D")
    .replace(/\b(gh)\\-(?=\d)/giu, (_match, prefix: string) => `${prefix}\\-\u200D`);
}

/** A GitHub feedback item's own link on its pull request (`discussion:12` is the conversation comment 12). */
export function feedbackCommentUrl(pullRequestUrl: string, commentId: string): string | undefined {
  const match = /^(discussion|review_comment|review):(\d+)$/u.exec(commentId);
  if (match === null) return undefined;
  const anchor = match[1] === "discussion" ? "issuecomment-" : match[1] === "review_comment" ? "discussion_r" : "pullrequestreview-";
  return `${pullRequestUrl}#${anchor}${match[2]}`;
}

/**
 * The approved fixes on one pull request, oldest first, from each approval's report: every selected finding bound to that
 * pull request (by its feedback bundle), with its proposed fix and the comments it answers. A fix for another
 * repository's pull request is never listed here. An approval the owner set aside (Keep the pull request as it is) changed
 * nothing and is left out, as is a report that cannot be read or whose digest does not match. Only the newest
 * APPROVALS_READ approvals' reports are read; `earlier` says older ones were left unread.
 */
export async function approvedFeedbackFixes(
  workflow: WorkflowSnapshot,
  pullRequest: { repositoryId: string; number: number },
  readReport: (objectKey: string, maxBytes: number) => Promise<string | undefined>,
  reportPrefix: string,
): Promise<{ fixes: FeedbackFix[]; earlier: boolean }> {
  const decisions = workflow.feedbackDecisions ?? [];
  const keptAsIs = new Set(decisions.filter((decision) => decision.decision === "DISMISS" && decision.ownerNote === WORKFLOW_KEEP_PULL_REQUESTS_NOTE).map((decision) => decision.reviewDigest));
  const refs = [...(workflow.feedbackReviewHistory ?? []), ...(workflow.feedbackReview?.reviewRef === undefined ? [] : [workflow.feedbackReview.reviewRef])];
  const approvals = decisions.filter((entry) => entry.decision === "APPROVE" && !keptAsIs.has(entry.reviewDigest)
    && entry.candidates.some((candidate) => candidate.repositoryId === pullRequest.repositoryId && candidate.number === pullRequest.number));
  const url = (workflow.pullRequests ?? []).find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number)?.url;
  const fixes: FeedbackFix[] = [];
  for (const decision of approvals.slice(-APPROVALS_READ)) {
    const ref = refs.find((candidate) => candidate.sha256 === decision.reviewDigest);
    if (ref === undefined || ref.objectKey !== `${reportPrefix}${ref.sha256}.json`) continue;
    let report: WorkflowFeedbackReviewReport;
    try {
      const text = await readReport(ref.objectKey, REPORT_MAX_BYTES);
      if (text === undefined || createHash("sha256").update(text, "utf8").digest("hex") !== ref.sha256) continue;
      const parsed = WorkflowFeedbackReviewReportSchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.taskId !== workflow.taskId) continue;
      report = parsed.data;
    } catch {
      continue;
    }
    for (const finding of report.findings.filter((item) => decision.selectedFindingIds.includes(item.id))) {
      const binding = report.candidateBindings.find((candidate) => candidate.bundleDigest === finding.bundleDigest);
      if (binding?.repositoryId !== pullRequest.repositoryId || binding.number !== pullRequest.number) continue;
      const comments = url === undefined ? [] : finding.commentIds.flatMap((id) => feedbackCommentUrl(url, id) ?? []);
      fixes.push({ summary: finding.fixProposal?.summary ?? finding.rationale, comments });
    }
  }
  return { fixes, earlier: approvals.length > APPROVALS_READ };
}

/** Spans a line is never cut inside: a Markdown link or image, a code span, and an address (a URL, `//host` or `www.`). */
const UNCUT = /!?\[[^\]]*\]\([^)]*\)|`[^`]*`|\S*(?:\/\/|\bwww\.)\S*/giu;
/** Words whose trailing period does not end a sentence. */
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf)$/iu;

/**
 * A reviewer's summary as one short sentence for the description: its first sentence, or, when that is longer than
 * SUMMARY_MAX, cut at the last space that fits with an ellipsis, never inside a link, a code span or an address. A
 * Markdown link is reduced to its text first; a sentence ends only outside quotes.
 * Undefined when nothing short can be cut cleanly (the summary opens with a long address, say).
 */
export function shortFixSummary(summary: string): string | undefined {
  // A Markdown link or image reads as its text: the description shows no link from a reviewer anyway.
  const text = summary.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\s+/gu, " ").trim();
  // Whether a quote opened before `at` is still open there (an apostrophe inside a word is no quote).
  const quoted = (at: number) => {
    const before = text.slice(0, at);
    return (before.match(/(?:^|[\s(])['"\u2018\u201C]/gu)?.length ?? 0) > (before.match(/['"\u2019\u201D](?=[\s.,;:!?)]|$)/gu)?.length ?? 0);
  };
  const spans = [...text.matchAll(UNCUT)].map((match) => [match.index, match.index + match[0].length] as const);
  const inside = (at: number) => spans.some(([start, end]) => at > start && at < end);
  let sentence = text;
  for (const match of text.matchAll(/[.!?](?=\s|$)/gu)) {
    if (inside(match.index) || quoted(match.index) || ABBREVIATION.test(text.slice(0, match.index))) continue;
    sentence = text.slice(0, match.index + 1);
    break;
  }
  if (sentence.length <= SUMMARY_MAX) return sentence === "" ? undefined : sentence;
  for (let at = sentence.lastIndexOf(" ", SUMMARY_MAX - 1); at > 0; at = sentence.lastIndexOf(" ", at - 1)) {
    if (inside(at)) continue;
    const cut = sentence.slice(0, at).replace(/[\s,;:(\-\u2013\u2014'"]+$/u, "");
    // Too little left to say what changed.
    return cut.length < SUMMARY_MIN ? undefined : `${cut}\u2026`;
  }
  return undefined;
}

function fixLine(fix: FeedbackFix): string {
  // Cut before it is escaped, so no cut lands inside an escape.
  const summary = inertGitHubText(shortFixSummary(redactText(fix.summary)) ?? SUMMARY_FALLBACK);
  if (fix.comments.length === 0) return `- ${summary}`;
  const links = fix.comments.slice(0, LINKS_LISTED).map((url, index) => `[comment ${index + 1}](${url})`);
  const more = fix.comments.length > LINKS_LISTED ? ` and ${fix.comments.length - LINKS_LISTED} more` : "";
  return `- ${summary} (for ${fix.comments.length === 1 ? `[this comment](${fix.comments[0]})` : `${links.join(", ")}${more}`})`;
}

/**
 * The section for these fixes, newest kept when they don't all fit in `maxChars`; empty when none fit (or there are none).
 * `earlier`: older fixes exist that were not read.
 */
export function feedbackFixesSection(fixes: readonly FeedbackFix[], maxChars: number, earlier = false): string {
  for (let shown = Math.min(fixes.length, FIXES_LISTED); shown > 0; shown -= 1) {
    const hidden = fixes.length - shown;
    const more = hidden > 0 ? [`- and ${hidden}${earlier ? " or more" : ""} earlier fix${hidden === 1 && !earlier ? "" : "es"}`] : earlier ? ["- and earlier fixes"] : [];
    const section = [START, HEADING, ...fixes.slice(-shown).map(fixLine), ...more, END].join("\n");
    if (section.length <= maxChars) return section;
  }
  return "";
}

/**
 * The description with its fixes section put in: replacing the earlier one in place (the START marker nearest before an
 * END marker, so a person's text around a stray marker is kept), or added at the end, within GitHub's limit. A stray
 * marker with no partner is removed. When no section fits any more, an earlier one is removed rather than left out of
 * date (`dropped`). `body` undefined: nothing changes.
 */
export function withFeedbackFixes(body: string, fixes: readonly FeedbackFix[], earlier = false): { body?: string; dropped: boolean } {
  // The first END that has a START after the END before it; the START nearest before it begins the section. A stray
  // START above the section, or a stray END above it, is then never taken for part of it.
  let startAt = -1;
  let endAt = body.indexOf(END);
  for (let previousEnd = 0; endAt !== -1; endAt = body.indexOf(END, previousEnd)) {
    const start = body.lastIndexOf(START, endAt);
    if (start !== -1 && start >= previousEnd) { startAt = start; break; }
    previousEnd = endAt + END.length;
  }
  const found = startAt !== -1;
  const strip = (text: string) => (text.includes(START) || text.includes(END) ? text.replaceAll(START, "").replaceAll(END, "").replace(/\n{3,}/gu, "\n\n") : text);
  const before = strip(found ? body.slice(0, startAt) : body).replace(/\s+$/u, "");
  const after = found ? strip(body.slice(endAt + END.length)).replace(/^\s+/u, "") : "";
  const separator = before === "" ? "" : "\n\n";
  const trailer = after === "" ? "" : `\n\n${after}`;
  if (fixes.length === 0 && !earlier && !found) return { dropped: false };
  const section = feedbackFixesSection(fixes, PULL_REQUEST_BODY_MAX_CHARS - before.length - separator.length - trailer.length, earlier);
  const next = section === "" ? `${before}${after === "" ? "" : `${before === "" ? "" : "\n\n"}${after}`}` : `${before}${separator}${section}${trailer}`;
  return { ...(next === body ? {} : { body: next }), dropped: section === "" && fixes.length > 0 };
}

/** The description's line when the reviewers saw only part of the change (workflowPullRequestStatusLines writes it). */
export const PULL_REQUEST_PARTIAL_REVIEW_LINE = "The change was too large to show the reviewers in full, so the reviews covered only part of it. Review the rest by hand.";

// AgentX's own lines, exactly in the shape it writes them; a line a person reworded no longer matches and is never touched.
const REVIEW_WORD = "(?:passed|passed after the owner accepted its findings)";
const CHECKS_LINE = /^Checks: (?:none recorded|.+ passed(?:, .+ passed)*)$/u;
const REVIEWS_LINE = new RegExp(`^Reviews: code review ${REVIEW_WORD}; security review ${REVIEW_WORD}(?:; \\d+ earlier issues? noted)?$`, "u");
const ACCEPTED_HEADER = /^Owner accepted \d+ review findings?:$/u;
const ACCEPTED_ITEM = /^- (?:\[(?:code|security)\] .* \u2014 accepted: .*|and \d+ more; see the task page)$/u;

/**
 * The description with its lines about the checks and reviews brought up to date with `lines` (workflowPullRequestStatusLines
 * for the code now on the pull request). Only AgentX's own lines change; everything else stays as the person left it.
 *
 * A description AgentX opened since this release has them between its markers: that block is AgentX's, and is replaced
 * whole, in place (one pair, START before END; otherwise nothing changes). An older one has no markers: its lines are
 * found by AgentX's exact shapes, outside the PR feedback section: a single Checks line and the Reviews line right after
 * it (or that Reviews line alone, for a review-only task), then any accepted-findings list and partial-review line that
 * follow, which describe the earlier code. They are replaced by `lines` only when exactly one of each is found and the
 * new lines have the same Checks line or none; otherwise nothing changes. Undefined when nothing changes.
 */
export function withStatusLines(body: string, lines: readonly string[]): string | undefined {
  const start = body.indexOf(PULL_REQUEST_STATUS_START);
  const end = body.indexOf(PULL_REQUEST_STATUS_END);
  if (start !== -1 || end !== -1) {
    // Exactly one pair, in order; anything else is not AgentX's block as it wrote it.
    if (start === -1 || end === -1 || end < start || body.indexOf(PULL_REQUEST_STATUS_START, start + 1) !== -1
      || body.indexOf(PULL_REQUEST_STATUS_END, end + 1) !== -1) return undefined;
    const next = `${body.slice(0, start)}${[PULL_REQUEST_STATUS_START, ...lines, PULL_REQUEST_STATUS_END].join("\n")}${body.slice(end + PULL_REQUEST_STATUS_END.length)}`;
    return next === body ? undefined : next;
  }
  // An older description: its lines outside the PR feedback section, which is AgentX's too but never holds these.
  const sectionStart = body.indexOf(START);
  const sectionEnd = body.indexOf(END);
  const outside = sectionStart !== -1 && sectionEnd > sectionStart ? body.slice(0, sectionStart) : body;
  const own = outside.split("\n");
  const checksAt = own.flatMap((line, index) => (CHECKS_LINE.test(line) ? [index] : []));
  const reviewsAt = own.flatMap((line, index) => (REVIEWS_LINE.test(line) ? [index] : []));
  const newChecks = lines.filter((line) => CHECKS_LINE.test(line));
  if (reviewsAt.length !== 1 || lines.filter((line) => REVIEWS_LINE.test(line)).length !== 1 || checksAt.length !== newChecks.length || checksAt.length > 1) return undefined;
  if (checksAt.length === 1 && checksAt[0]! + 1 !== reviewsAt[0]) return undefined;
  const from = checksAt[0] ?? reviewsAt[0]!;
  // AgentX's accepted-findings list and partial-review line under the Reviews line, about the earlier code.
  let to = reviewsAt[0]! + 1;
  if (ACCEPTED_HEADER.test(own[to] ?? "")) {
    to += 1;
    while (ACCEPTED_ITEM.test(own[to] ?? "")) to += 1;
  }
  if (own[to] === PULL_REQUEST_PARTIAL_REVIEW_LINE) to += 1;
  const replaced = [...own.slice(0, from), ...lines, ...own.slice(to)].join("\n");
  const next = `${replaced}${body.slice(outside.length)}`;
  return next === body ? undefined : next;
}
