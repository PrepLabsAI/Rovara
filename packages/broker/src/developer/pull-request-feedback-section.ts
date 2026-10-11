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

export interface FeedbackFix { summary: string; comments: string[] }

/**
 * A reviewer's line made inert on GitHub: one line, images dropped, links reduced to their text, tags dropped, and a
 * zero-width joiner after every @, `://`, `www` and `#` before a digit, so nothing mentions, links or cross-references.
 */
function inertLine(line: string): string {
  return line
    .replace(/\s+/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?|mailto):[^>]*)>/giu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replaceAll("@", "@‍")
    .replaceAll("://", "://‍")
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}‍.`)
    .replace(/#(?=\d)/gu, "#‍")
    .trim();
}

/** A GitHub feedback item's own link on its pull request (`discussion:12` is the conversation comment 12). */
export function feedbackCommentUrl(pullRequestUrl: string, commentId: string): string | undefined {
  const match = /^(discussion|review_comment|review):(\d+)$/u.exec(commentId);
  if (match === null) return undefined;
  const anchor = match[1] === "discussion" ? "issuecomment-" : match[1] === "review_comment" ? "discussion_r" : "pullrequestreview-";
  return `${pullRequestUrl}#${anchor}${match[2]}`;
}

/**
 * The approved fixes, oldest first, from each approval's report: every selected finding's proposed fix and the comments it
 * answers (links on the task's pull requests). An approval the owner set aside (Keep the pull request as it is) changed
 * nothing and is left out, as is a report that cannot be read or whose digest does not match.
 */
export async function approvedFeedbackFixes(
  workflow: WorkflowSnapshot,
  readReport: (objectKey: string, maxBytes: number) => Promise<string | undefined>,
  reportPrefix: string,
): Promise<FeedbackFix[]> {
  const decisions = workflow.feedbackDecisions ?? [];
  const keptAsIs = new Set(decisions.filter((decision) => decision.decision === "DISMISS" && decision.ownerNote === WORKFLOW_KEEP_PULL_REQUESTS_NOTE).map((decision) => decision.reviewDigest));
  const refs = [...(workflow.feedbackReviewHistory ?? []), ...(workflow.feedbackReview?.reviewRef === undefined ? [] : [workflow.feedbackReview.reviewRef])];
  const fixes: FeedbackFix[] = [];
  for (const decision of decisions.filter((entry) => entry.decision === "APPROVE" && !keptAsIs.has(entry.reviewDigest))) {
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
      const pullRequest = (workflow.pullRequests ?? []).find((entry) => entry.repositoryId === binding?.repositoryId && entry.number === binding?.number);
      const comments = pullRequest === undefined ? [] : finding.commentIds.flatMap((id) => feedbackCommentUrl(pullRequest.url, id) ?? []);
      fixes.push({ summary: finding.fixProposal?.summary ?? finding.rationale, comments });
    }
  }
  return fixes;
}

function fixLine(fix: FeedbackFix): string {
  const text = inertLine(redactText(fix.summary));
  const summary = text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
  if (fix.comments.length === 0) return `- ${summary}`;
  const links = fix.comments.slice(0, LINKS_LISTED).map((url, index) => `[comment ${index + 1}](${url})`);
  const more = fix.comments.length > LINKS_LISTED ? ` and ${fix.comments.length - LINKS_LISTED} more` : "";
  return `- ${summary} (for ${fix.comments.length === 1 ? `[this comment](${fix.comments[0]})` : `${links.join(", ")}${more}`})`;
}

/** The section for these fixes, newest kept when they don't all fit in `maxChars`; empty when none fit (or there are none). */
export function feedbackFixesSection(fixes: readonly FeedbackFix[], maxChars: number): string {
  for (let shown = Math.min(fixes.length, FIXES_LISTED); shown > 0; shown -= 1) {
    const hidden = fixes.length - shown;
    const lines = [START, HEADING, ...fixes.slice(-shown).map(fixLine), ...(hidden > 0 ? [`- and ${hidden} earlier fix${hidden === 1 ? "" : "es"}; see the task page`] : []), END];
    const section = lines.join("\n");
    if (section.length <= maxChars) return section;
  }
  return "";
}

/**
 * The description with its fixes section put in (replacing an earlier one in place, or added at the end), within
 * GitHub's limit. Undefined when nothing changes.
 */
export function withFeedbackFixes(body: string, fixes: readonly FeedbackFix[]): string | undefined {
  const start = body.indexOf(START);
  const end = start === -1 ? -1 : body.indexOf(END, start);
  const before = (start === -1 || end === -1 ? body : body.slice(0, start)).replace(/\s+$/u, "");
  const after = start === -1 || end === -1 ? "" : body.slice(end + END.length).replace(/^\s+/u, "");
  const separator = before === "" ? "" : "\n\n";
  const trailer = after === "" ? "" : `\n\n${after}`;
  const section = feedbackFixesSection(fixes, PULL_REQUEST_BODY_MAX_CHARS - before.length - separator.length - trailer.length);
  if (section === "") return undefined;
  const next = `${before}${separator}${section}${trailer}`;
  return next === body ? undefined : next;
}
