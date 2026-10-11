// D2: the "Fixes from PR feedback" section of a workflow pull request's description. After an approved PR feedback fix
// is pushed, the description lists briefly what was changed for which comments, from each approved proposal's summary,
// and is kept up to date across rounds. The summaries come from a reviewer reading untrusted comments: each is redacted
// and made inert for GitHub (no mention, link or cross-reference) before it is written.
import { PULL_REQUEST_BODY_MAX_CHARS, WORKFLOW_KEEP_PULL_REQUESTS_NOTE, WorkflowFeedbackReviewReportSchema, redactText, type WorkflowFeedbackReviewReport, type WorkflowSnapshot } from "@agentx/contracts";
import { createHash } from "node:crypto";

const START = "<!-- agentx:pr-feedback-fixes -->";
const END = "<!-- /agentx:pr-feedback-fixes -->";
const HEADING = "### Fixes from PR feedback";
/** The newest fixes listed; older ones are counted in one line. */
const FIXES_LISTED = 20;
const SUMMARY_MAX = 300;
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

function fixLine(fix: FeedbackFix): string {
  const text = inertGitHubText(redactText(fix.summary));
  // Cut on a whole character, never inside an escape.
  let summary = text;
  if (text.length > SUMMARY_MAX) {
    summary = text.slice(0, SUMMARY_MAX - 1);
    if (/(^|[^\\])(\\\\)*\\$/u.test(summary)) summary = summary.slice(0, -1);
    summary = `${summary}\u2026`;
  }
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
  const endAt = body.indexOf(END);
  const startAt = endAt === -1 ? -1 : body.lastIndexOf(START, endAt);
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
