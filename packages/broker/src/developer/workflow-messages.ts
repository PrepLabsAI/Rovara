// Gaps 5, 12 and 10g: the one place a workflow task's thread post is worded. Each (stage, state) has one brief,
// plain message (at most 1,200 visible characters), and every blocked step carries its ways out as buttons. Every
// value from a record, the model or a reviewer is redacted where it is free text, cut short and escaped here.
import {
  WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE,
  WORKFLOW_KEEP_PULL_REQUESTS_NOTE, WORKFLOW_RESOLVE_FINDINGS_MAX, openReviewFindings, redactText, workflowKeepPullRequestsOffered, sendBackProblems, workflowIsReviewOnly, workflowReviewsSawPartialDiff, workflowCheckResultBroken, workflowSelectedChecks, workflowSendBackOffered, workflowApplicationEvidenceCodes, type WorkflowSnapshot,
} from "@agentx/contracts";
import { E2E_OWNER_SENTENCES } from "../e2e/owner-sentences.js";
import { WORKFLOW_ACTION_IDS } from "./workflow-actions.js";
import { isE2EPlanCorrectionBlockReason } from "./task-records.js";

export interface WorkflowMessageContext {
  taskId: string;
  /** E: default-off Task People control on Slack workflow cards. */
  peopleEnabled?: boolean | undefined;
  ownerSlackUserId?: string | undefined;
  workflow: WorkflowSnapshot;
  /** Where the full document reads (a Canvas, or the task page); absent when no link could be made. */
  documentLink?: { url: string } | undefined;
  documentSummary?: readonly string[] | undefined;
  /** The digest the Owner must include when approving a structured coding plan with a work breakdown. */
  workBreakdownDigest?: string | undefined;
  /**
   * A structured document's card: its top claims in rank order (for a tiny plan every claim, a child's text starting
   * with two spaces per level), how many claims and decisions it has in all, and whether it is tiny. Replaces `documentSummary`.
   */
  structured?: { claims: string[]; claimCount: number; decisionCount: number; tiny: boolean } | undefined;
  findingsUrl?: string | undefined;
  /** The task page, where every thread reply can be read. */
  taskPageUrl?: string | undefined;
  /** Thread replies saved and not yet given to a step. */
  newReplies?: number | undefined;
  /**
   * After Request changes that sent comments: how many of them the planner answered, and the version they were sent on. After
   * an Approve that sent comments, `approvedOn` names the approved document, the first comment answered (for the link) and
   * whether every comment was the owner's.
   */
  commentAnswers?: { answered: number; total: number; fromVersion: number; approvedOn?: { document: DocumentName; commentId?: string; allOwners: boolean } } | undefined;
  /** AgentX's own draft pull request did not open; `codeChanged` when the workspace no longer held the checked code. */
  publishFailure?: { category: string; codeChanged?: boolean | undefined } | undefined;
  /** The step a closed required pull request's reopening started (the numbers reopened; empty when not known). */
  pullRequestReopened?: ReadonlyArray<{ repositoryId: string; number: number }> | undefined;
}
export interface WorkflowMessage { text: string; blocks: Array<Record<string, unknown>> }

/** Every button `workflowSlackHandlers` answers. */
export { WORKFLOW_ACTION_IDS };

/** Escapes what Slack would read as markup: a mention, a link or a broadcast. */
export const slackText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const SECTION_TEXT_LIMIT = 2_800;
const SUMMARY_LINE_MAX = 160;
const FINDING_TEXT_MAX = 180;
const FINDINGS_SHOWN = 3;
const REGRESSED_TEST_MAX = 100;
/** Said after a failed feedback review or push: the pull request's merge is still tracked. */
const STILL_WATCHING = "I'm still watching the pull request and will finish this task when it's merged.";
const GENERIC_REASON = "Something went wrong on AgentX's side.";
/** Said once per reopening of a closed required pull request (D3) when which one is not known. */
export const PULL_REQUEST_REOPENED = "The pull request was reopened, so I'm following it again.";

/** Said once per reopening (D3): which pull requests were reopened, by name. */
function pullRequestReopened(workflow: WorkflowSnapshot, which: ReadonlyArray<{ repositoryId: string; number: number }>): string {
  const reopened = (workflow.pullRequests ?? []).filter((pullRequest) => which.some((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number));
  if (reopened.length === 0) return PULL_REQUEST_REOPENED;
  const names = pullRequestNames(reopened, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
  return reopened.length === 1 ? `${names} was reopened, so I'm following it again.` : `${names} were reopened, so I'm following them again.`;
}

type DocumentName = "coding plan" | "requirements" | "design";

/** The document an approval step is about, by the task's path and phase. */
export function workflowDocumentName(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): DocumentName {
  if (workflow.path !== "FULL") return "coding plan";
  return workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.reviewPhase === "DESIGN" ? "design" : "coding plan";
}

/** The saved document type behind each name. */
export function workflowDocumentType(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): "plan" | "requirements" | "design" {
  const name = workflowDocumentName(workflow);
  return name === "coding plan" ? "plan" : name;
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The approval modal's title and submit label, named after the document being decided on. */
export function workflowModalCopy(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">, decision: "APPROVE" | "REQUEST_CHANGES"): { title: string; submit: string } {
  if (decision === "REQUEST_CHANGES") return { title: "Request changes", submit: "Send changes" };
  const name = workflowDocumentName(workflow);
  return { title: `Approve ${name}`, submit: name === "coding plan" ? "Approve and start coding" : "Approve and continue" };
}

/** Block reasons written for people, shown word for word; matched exactly, never by prefix. */
const PLAIN_REASONS: ReadonlySet<string> = new Set([
  WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_HISTORY_REWRITTEN_MESSAGE,
  ...Object.values(WORKFLOW_BLOCK_REASONS),
]);

/** Block reasons stored before their wording changed, and what they read as now. */
const REWORDED_REASONS: ReadonlyMap<string, string> = new Map([
  ["No checks ran: this project has no required checks and the task selected no optional checks. Configure or select at least one check, then retry.", WORKFLOW_BLOCK_REASONS.noChecksConfigured],
  ...["failed", "interrupted", "cancelled"].map((status): [string, string] => [`PR feedback review operation ended ${status}`, WORKFLOW_BLOCK_REASONS.feedbackReviewFailed]),
  ["PR feedback review report was invalid, incomplete, or stale", WORKFLOW_BLOCK_REASONS.feedbackReviewFailed],
]);

/** Whether a pull request's feedback review failed, by the reason stored now or before its wording changed. */
export function isFeedbackReviewFailure(blockReason: string | undefined): boolean {
  return blockReason !== undefined && (blockReason === WORKFLOW_BLOCK_REASONS.feedbackReviewFailed || REWORDED_REASONS.get(blockReason) === WORKFLOW_BLOCK_REASONS.feedbackReviewFailed);
}

/** The broker's own reason a step stopped, in words the owner can act on; any other reason is internal. */
export function plainBlockReason(blockReason: string | undefined): string {
  if (blockReason === undefined) return GENERIC_REASON;
  if (isE2EPlanCorrectionBlockReason(blockReason)) return slackText(blockReason);
  const reworded = REWORDED_REASONS.get(blockReason);
  if (reworded !== undefined) return slackText(reworded);
  if (/operation ended (failed|interrupted|cancelled)$/.test(blockReason)) return "The run stopped unexpectedly.";
  if (/ was invalid, incomplete, or stale$/.test(blockReason)) return "The result couldn't be trusted, so nothing moved forward.";
  return PLAIN_REASONS.has(blockReason) ? slackText(blockReason) : GENERIC_REASON;
}

/** A review-only task's blocked verification, without advice to rerun checks it does not have. */
const REVIEW_ONLY_VERIFY_REASONS: Record<string, string> = {
  [WORKFLOW_BLOCK_REASONS.checksUnconfirmed]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.checkReportUnreadable]: "AgentX couldn't read its report on the final code.",
  [WORKFLOW_BLOCK_REASONS.checkRunnerFailed]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.noChecksConfigured]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.noCheckResults]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.repositoriesIncomplete]: "AgentX couldn't find every repository in the final code.",
  [WORKFLOW_BLOCK_REASONS.codeChangedAfterChecks]: "The code changed while AgentX was checking it.",
  [WORKFLOW_BLOCK_REASONS.startUnrecorded]: "AgentX could not record where this change started.",
  [WORKFLOW_BLOCK_REASONS.startChanged]: "The code's starting point changed.",
};

/** Why one review did not qualify, by its recorded reason; never the reviewer's own output. */
const REVIEW_FAILURES: Record<string, string> = {
  RESPONSE_MISSING: "the reviewer gave no answer",
  RESPONSE_TOO_LARGE: "its answer was too long",
  INVALID_JSON: "its answer wasn't in the expected format",
  INVALID_SHAPE: "its answer wasn't in the expected format",
  TIMEOUT: "it ran out of time",
  INTERRUPTED: "it was stopped",
  CANDIDATE_CHANGED: "the code changed during the review",
  SESSION_FAILED: "the reviewer couldn't start",
  USAGE_UNAVAILABLE: "its usage couldn't be recorded",
  BASE_UNAVAILABLE: "the task's starting point wasn't recorded",
  DIFF_UNAVAILABLE: "the change couldn't be compared with the task's starting point",
};
const plainReviewFailure = (reason: string | undefined, status: string) =>
  (reason === undefined ? undefined : REVIEW_FAILURES[reason]) ?? (status === "INTERRUPTED" ? "it was stopped" : "it gave no usable answer");

/** Why AgentX's draft pull request did not open, by the failure's category. */
const PUBLISH_FAILURES: Record<string, string> = {
  publication_failed: "GitHub didn't accept it",
  interrupted: "the run was stopped",
  worker_unavailable: "no worker was free to open it",
  timed_out: "it ran out of time",
};
const plainPublishFailure = (category: string) => PUBLISH_FAILURES[category] ?? "something went wrong on AgentX's side";

/**
 * One line of free text from a reviewer or the model: on one line, redacted, cut short, escaped, and never a link: a
 * zero-width joiner follows each `://` and the `www` of `www.`, so Slack does not turn a bare address into one.
 */
export function cleanLine(text: string, limit: number): string {
  const line = redactText(text).replace(/\s+/g, " ").trim()
    .replaceAll("://", "://‍")
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}‍.`);
  return slackText(line.length > limit ? `${line.slice(0, limit - 3).trimEnd()}...` : line);
}

/**
 * Up to `max` lines that say what a document is about: its first lines of prose or list items, with headings, code,
 * rules and Markdown markup left out, each redacted and at most 160 characters. Escaping is the caller's.
 */
export function documentSummaryLines(markdown: string, max = 3): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) { fenced = !fenced; continue; }
    if (fenced || trimmed === "" || /^#{1,6}(\s|$)/.test(trimmed) || /^([-*_=]\s*){3,}$/.test(trimmed) || trimmed.startsWith("|")) continue;
    const plain = trimmed
      .replace(/^>+\s*/, "")
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") continue;
    const redacted = redactText(plain);
    lines.push(redacted.length > SUMMARY_LINE_MAX ? `${redacted.slice(0, SUMMARY_LINE_MAX - 3).trimEnd()}...` : redacted);
    if (lines.length >= max) break;
  }
  return lines;
}

type Button = Record<string, unknown>;

/** The last owner decision, when it is what led to the current revision (it was recorded, then the step started). */
function leadingDecision(workflow: WorkflowSnapshot) {
  const latest = (workflow.decisions ?? []).at(-1);
  return latest !== undefined && latest.workflowRevision >= workflow.revision - 2 ? latest : undefined;
}

function checkCount(workflow: WorkflowSnapshot): number {
  return workflowSelectedChecks(workflow.checkPolicy).length;
}

/** Whether there are checks to retry: ones the task runs, or optional project checks the owner can choose. */
const checksConfigured = (workflow: WorkflowSnapshot) => checkCount(workflow) > 0 || (workflow.checkPolicy?.optional.length ?? 0) > 0;

/** The longest the plan card's line of proposed check labels may be, so the card stays brief. */
const PROPOSED_LINE_MAX = 400;

/**
 * The coding plan card's one line on checks: the labels of the checks AgentX proposed (escaped, as many as fit) and how
 * many the project requires, that none apply (review only, with the plan's reason, unless an optional check is chosen),
 * or that the proposal could not be read. Nothing for other documents or a task stored without a check policy.
 */
function planChecksLine(workflow: WorkflowSnapshot): string | undefined {
  const policy = workflow.checkPolicy;
  if (policy === undefined || workflowDocumentType(workflow) !== "plan") return undefined;
  if (policy.proposalNote !== undefined) return `${cleanLine(policy.proposalNote, 200)}.`;
  if (checkCount(workflow) === 0) {
    const reviewOnly = policy.optional.length > 0 ? "Review only unless you choose an optional check." : "Review only.";
    return policy.noneReason === undefined ? `No automated checks apply. ${reviewOnly}`
      : `No automated checks apply: ${cleanLine(policy.noneReason, 300).replace(/[.\s]+$/, "")}. ${reviewOnly}`;
  }
  const proposed = policy.proposed ?? [];
  const project = policy.required.length > 0 ? plural(policy.required.length, "project check") : "";
  if (proposed.length === 0) return `Checks: ${project}.`;
  const tail = project === "" ? "." : `; plus ${project}.`;
  // Room for ", and 8 more" when not every label fits.
  const reserve = ", and 8 more".length + tail.length;
  let line = "Checks proposed by AgentX: ";
  let listed = 0;
  for (const check of proposed) {
    const label = `${listed === 0 ? "" : ", "}${cleanLine(check.label, 80)}`;
    if (line.length + label.length + (listed + 1 < proposed.length ? reserve : tail.length) > PROPOSED_LINE_MAX) break;
    line += label;
    listed += 1;
  }
  return listed === proposed.length ? `${line}${tail}` : `${line}${listed === 0 ? "" : ","} and ${proposed.length - listed} more${tail}`;
}

/** The current code's reviews; older reviews describe code that is gone. */
function currentReviews(workflow: WorkflowSnapshot) {
  const current = workflow.candidate?.digest;
  return (workflow.reviews ?? []).filter((review) => current === undefined || review.candidateDigest === current);
}

function checkedAndPassing(workflow: WorkflowSnapshot): boolean {
  const current = workflow.candidate?.digest;
  return current !== undefined && workflow.verification?.candidateDigest === current
    && (workflow.verification.results ?? []).every((result) => result.status === "PASS");
}

/**
 * The owner's ways out of a step, as buttons, each naming the task and the revision it was offered at so a stale press
 * is refused. Close task is always last; it asks for confirmation before anything is discarded.
 */
function exitButtons(context: WorkflowMessageContext) {
  const { taskId, workflow } = context;
  const at = JSON.stringify({ taskId, revision: workflow.revision });
  const button = (actionId: string, label: string, options: { value?: string; primary?: boolean } = {}): Button => ({
    type: "button", action_id: actionId, text: { type: "plain_text", text: label }, value: options.value ?? at, ...(options.primary === true ? { style: "primary" } : {}),
  });
  const sendBack = (): Button[] => workflowSendBackOffered(workflow) ? [button("agentx_workflow_send_back", "Send back to coding", { primary: true })] : [];
  return {
    button,
    sendBack,
    /** Resolve findings opens the modal that answers each blocking review finding; it names the code the findings are about. */
    resolveFindings: (): Button[] => workflow.candidate === undefined ? []
      : [button("agentx_workflow_resolve_findings", "Resolve findings", { primary: true, value: JSON.stringify({ taskId, revision: workflow.revision, candidateDigest: workflow.candidate.digest }) })],
    close: button("agentx_workflow_close", "Close task"),
    retryChecks: (label = "Choose checks and retry"): Button[] => checksConfigured(workflow) ? [button("agentx_workflow_retry_checks", label)] : [],
    retryReviews: (): Button[] => checkedAndPassing(workflow)
      ? [button("agentx_workflow_retry_reviews", "Retry reviews", { value: JSON.stringify({ taskId, revision: workflow.revision, candidateDigest: workflow.candidate?.digest }) })] : [],
    retryPublish: button("agentx_workflow_retry_publish", "Retry opening the pull request"),
  };
}

const link = (url: string, label: string) => `<${slackText(url)}|${label}>`;

/** The visible characters of a Slack text, the way the brief limit counts them: `<url|label>` reads as its label. */
const visibleLength = (text: string) => text.replace(/<([^<>|]*)\|([^<>]*)>/g, "$2").replace(/<([^<>|]+)>/g, "$1").length;

/** A card is brief: at most this many visible characters, button labels included. */
const CARD_BRIEF_LIMIT = 1_200;
const CARD_CLAIMS_SHOWN = 3;
/** The shortest a claim is cut to; with less room than this the claim is left out. */
const CLAIM_MIN_VISIBLE = 24;

/** The page's address for a document: the task page at that document and version. Never a link to a version alone. */
export function planReviewLink(taskPageUrl: string, workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">, version: number): string {
  const anchor = workflowDocumentName(workflow).replace(" ", "-");
  return `${taskPageUrl}?doc=${anchor}&from=${version}#${anchor}`;
}

/** One claim as a quoted line, its indent kept (two spaces a level); escaped, one line, cut to `limit` characters. */
function claimLine(claim: string, limit: number): string {
  const indent = claim.length - claim.trimStart().length;
  return `>${" ".repeat(indent + 1)}${cleanLine(claim, limit)}`;
}

/**
 * The claims a structured card shows: as many of the ranked claims as fit in `room` visible characters (each cut to
 * 160), then "And N more claims." for those left out. The first claim is cut short before it is dropped.
 */
function structuredClaimLines(structured: NonNullable<WorkflowMessageContext["structured"]>, room: number): string[] {
  const candidates = structured.tiny ? structured.claims : structured.claims.slice(0, CARD_CLAIMS_SHOWN);
  const lines = candidates.map((claim) => claimLine(claim, SUMMARY_LINE_MAX));
  const moreLine = (shown: number) => (structured.claimCount > shown ? [`And ${plural(structured.claimCount - shown, "more claim")}.`] : []);
  const cost = (taken: string[], shown: number) => [...taken, ...moreLine(shown)].reduce((total, line) => total + visibleLength(line) + 1, 0);
  for (let shown = lines.length; shown > 0; shown -= 1) {
    const taken = lines.slice(0, shown);
    if (cost(taken, shown) <= room) return [...taken, ...moreLine(shown)];
  }
  // Not even one whole claim fits: cut the first to what is left, or leave claims out altogether.
  if (candidates.length > 0) {
    for (let limit = SUMMARY_LINE_MAX - 10; limit >= CLAIM_MIN_VISIBLE; limit -= 10) {
      const taken = [claimLine(candidates[0]!, limit)];
      if (cost(taken, 1) <= room) return [...taken, ...moreLine(1)];
    }
  }
  return moreLine(0).filter((line) => visibleLength(line) + 1 <= room);
}

function planReview(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow, structured } = context;
  const name = workflowDocumentName(workflow);
  const document = workflow.artifacts.filter((artifact) => artifact.type === workflowDocumentType(workflow)).at(-1);
  const needsE2ECorrection = isE2EPlanCorrectionBlockReason(workflow.blockReason);
  const header = needsE2ECorrection
    ? `*${capitalized(name)}${document === undefined ? "" : ` v${document.version}`} needs changes before approval.* ${plainBlockReason(workflow.blockReason)}`
    : `*${capitalized(name)}${document === undefined ? "" : ` v${document.version}`} is ready for your approval.* ${workflow.candidate === undefined ? "No code has changed yet." : "The existing candidate is retained while this plan is reviewed."}`;
  const decide = (decision: "APPROVE" | "REQUEST_CHANGES") => JSON.stringify({ taskId: context.taskId, revision: workflow.revision, digest: document?.sha256, decision,
    ...(decision === "APPROVE" && context.workBreakdownDigest !== undefined ? { workBreakdownDigest: context.workBreakdownDigest } : {}) });
  const decisions = document === undefined ? [exits.close] : needsE2ECorrection ? [
    exits.button("agentx_workflow_changes", "Request changes", { value: decide("REQUEST_CHANGES") }), exits.close,
  ] : [
    exits.button("agentx_workflow_approve", `Approve ${name}`, { value: decide("APPROVE"), primary: true }),
    exits.button("agentx_workflow_changes", "Request changes", { value: decide("REQUEST_CHANGES") }),
    exits.close,
  ];
  const tail: string[] = [];
  const checks = planChecksLine(workflow);
  if (checks !== undefined) tail.push(checks);
  if ((context.newReplies ?? 0) > 0) tail.push(`${plural(context.newReplies!, "thread reply", "thread replies")} since the last step will be included.`);
  const answered = context.commentAnswers;
  if (answered?.approvedOn !== undefined) {
    // Comments sent with the Approve of the document before: said only when the planner replied to some, linked to the first reply.
    if (answered.answered > 0) {
      const { document: approved, commentId, allOwners } = answered.approvedOn;
      const comments = `${allOwners ? "your " : ""}${plural(answered.total, "comment")}`;
      const line = `AgentX replied to ${answered.answered === answered.total ? "" : `${answered.answered} of `}${comments} on the ${approved}.`;
      tail.push(context.taskPageUrl === undefined || commentId === undefined ? line : link(`${context.taskPageUrl}?doc=${approved.replace(" ", "-")}#comment-${commentId}`, line));
    }
  } else if (answered !== undefined && answered.total > 0) tail.push(`AgentX answered ${answered.answered} of ${plural(answered.total, "comment")} from v${answered.fromVersion}.`);
  // The owner can always reach the plan: when the document could not be shown or linked, the task page is, and an
  // administrator is named only when no task page exists at all.
  const unlinked = context.taskPageUrl === undefined
    ? `I couldn't link the full ${name}; ask an AgentX admin to check the task page.`
    : `I couldn't show the plan summary here. ${link(context.taskPageUrl, "Open the task page to read the plan")}`;
  if (structured === undefined) {
    // A Markdown document: its first lines, and where the whole text reads.
    const lines = [header];
    for (const line of (context.documentSummary ?? []).slice(0, 3)) lines.push(`> ${cleanLine(line, SUMMARY_LINE_MAX)}`);
    lines.push(...tail, context.documentLink === undefined ? unlinked : link(context.documentLink.url, `Read the full ${name}`));
    return { text: lines.join("\n"), buttons: decisions };
  }
  // FR-036: what Approve in Slack takes. A tiny plan (FR-037) is approved in Slack as it is, so its card is unchanged.
  if (structured.decisionCount > 0) {
    tail.unshift(`Approve here uses AgentX's answers for ${plural(structured.decisionCount, "decision")} and includes the open comments (up to 25) from the task page.`);
  } else if (!structured.tiny) tail.unshift("Approve here includes the open comments (up to 25) from the task page.");
  tail.push(context.documentLink === undefined ? unlinked : link(context.documentLink.url, structured.tiny ? `Open the ${name}` : `Open the full ${name}`));
  const buttons: Button[] = context.documentLink === undefined ? decisions
    : [{ type: "button", action_id: "agentx_open_review", text: { type: "plain_text", text: "Open review" }, url: context.documentLink.url }, ...decisions];
  // What is fixed (the buttons' labels count toward the limit too), then the claims that fit in what is left.
  const labels = buttons.reduce((total, button) => total + (button["text"] as { text: string }).text.length, 0);
  const fixed = [header, ...tail].reduce((total, line) => total + visibleLength(line) + 1, 0) + labels;
  return { text: [header, ...structuredClaimLines(structured, CARD_BRIEF_LIMIT - fixed), ...tail].join("\n"), buttons };
}

function reviewBlocked(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const reviews = currentReviews(context.workflow);
  // The blocking findings still open: the change introduced them, they are not advisory, and the owner has not accepted them.
  const introduced = openReviewFindings(context.workflow);
  if (introduced.length > 0) {
    const older = reviews.reduce((total, review) => total + (review.findings ?? []).filter((finding) => typeof finding !== "string" && finding.origin === "PRE_EXISTING").length, 0);
    const lines = [`Reviews found ${plural(introduced.length, "issue")} in this change.`,
      ...introduced.slice(0, FINDINGS_SHOWN).map((finding) => {
        const where = finding.file === undefined ? "" : ` (${cleanLine(finding.file, 120)}${finding.line === undefined ? "" : `:${finding.line}`})`;
        return `• [${finding.role === "SECURITY" ? "security" : "code"}] ${cleanLine(finding.text, FINDING_TEXT_MAX)}${where}`;
      })];
    if (introduced.length > FINDINGS_SHOWN) lines.push(`And ${introduced.length - FINDINGS_SHOWN} more.`);
    if (older > 0) lines.push(`${older} older ${older === 1 ? "issue was" : "issues were"} noted but ${older === 1 ? "doesn't" : "don't"} block.`);
    if (workflowReviewsSawPartialDiff(context.workflow)) lines.push(PARTIAL_REVIEW);
    if (context.findingsUrl !== undefined) lines.push(link(context.findingsUrl, "See all findings"));
    // Resolve findings answers up to 20 at once; with more open, only sending the whole change back to coding is left.
    const first = introduced.length <= WORKFLOW_RESOLVE_FINDINGS_MAX ? exits.resolveFindings() : exits.sendBack();
    return { text: lines.join("\n"), buttons: [...first, ...exits.retryReviews(), exits.close] };
  }
  const unfinished = reviews.filter((review) => ["UNKNOWN", "FAILED", "INTERRUPTED"].includes(review.status));
  const text = unfinished.length > 0
    ? `A review couldn't finish (${unfinished.map((review) => `${review.role === "SECURITY" ? "security" : "code"} review: ${plainReviewFailure(review.failureReason, review.status)}`).join("; ")}). Nothing was sent to GitHub.`
    : `${context.workflow.verification?.reviewOnly === true && workflowIsReviewOnly(context.workflow.checkPolicy) ? "No automated check applied, and" : "The checks passed, but"} the reviews couldn't finish. ${plainBlockReason(context.workflow.blockReason)} Nothing was sent to GitHub.`;
  return { text, buttons: [...exits.retryReviews(), exits.close] };
}

function verifyBlocked(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow } = context;
  const e2eFailure = sendBackProblems(workflow).some((problem) => problem.source === "check"
    && problem.text.startsWith("required E2E verification failed for the current round"));
  if (e2eFailure && workflowSendBackOffered(workflow)) {
    return { text: "The required end-to-end verification failed for the current code. Send it back to coding, or close the task.",
      buttons: [...exits.sendBack(), exits.close] };
  }
  const verification = workflow.candidate !== undefined && workflow.verification?.candidateDigest === workflow.candidate.digest ? workflow.verification : undefined;
  const results = verification?.results ?? [];
  const failed = results.filter((result) => result.status === "FAILED");
  if (failed.length > 0) {
    const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
    const labelOf = (result: { checkId: string }) => cleanLine(checks.find((check) => check.id === result.checkId)?.label ?? result.checkId, 80);
    // A check whose command could not run is not the code failing: rerunning or coding again won't help, so the owner
    // can remove that check or close the task.
    const allBroken = failed.filter(workflowCheckResultBroken);
    // A check whose process never started is not broken: it may start on a retry, so no project admin is needed.
    const unstarted = allBroken.filter((result) => result.neverStarted === true);
    const broken = allBroken.filter((result) => result.neverStarted !== true);
    const real = failed.filter((result) => !workflowCheckResultBroken(result));
    // A required project check can't be unticked: only a project admin can fix it, or the task is closed.
    const requiredIds = new Set((workflow.checkPolicy?.required ?? []).map((check) => check.id));
    const notInstalledFor = (group: typeof broken) => [...new Set(group.filter((result) => result.programNotFound === true)
      .flatMap((result) => checks.filter((check) => check.id === result.checkId).map((check) => cleanLine(check.command.executable, 80))))]
      .map((program) => ` ${program} is not installed on the AgentX worker.`).join("");
    const brokenRequired = broken.filter((result) => requiredIds.has(result.checkId));
    const brokenOther = broken.filter((result) => !requiredIds.has(result.checkId));
    const requiredNote = brokenRequired.length === 0 ? ""
      : `${brokenRequired.map((result) => `${labelOf(result)} is a project check and couldn't run; ask a project admin to fix it, or close the task.`).join(" ")}${notInstalledFor(brokenRequired)}`;
    const brokenLabels = brokenOther.map(labelOf).join(", ");
    const unstartedNote = unstarted.length === 0 ? ""
      : `${unstarted.map(labelOf).join(", ")} couldn't start on the AgentX worker this time. Choose checks and retry to run ${unstarted.length === 1 ? "it" : "them"} again, or close the task.`;
    if (real.length === 0) {
      const optional = brokenOther.length === 0 ? ""
        : `These checks couldn't run because the check itself is broken: ${brokenLabels}.${notInstalledFor(brokenOther)} Untick them with Choose checks and retry, or close the task.`;
      return { text: [optional, requiredNote, unstartedNote].filter((part) => part !== "").join(" "), buttons: [...exits.retryChecks(), exits.close] };
    }
    const brokenNote = brokenOther.length === 0 ? "" : ` Couldn't run because the check itself is broken: ${brokenLabels}.${notInstalledFor(brokenOther)}`;
    return { text: `${real.length} of ${plural(results.length, "check")} didn't pass: ${real.map(labelOf).join(", ")}.${brokenNote}${requiredNote === "" ? "" : ` ${requiredNote}`}${unstartedNote === "" ? "" : ` ${unstartedNote}`} Nothing was sent to GitHub.`,
      buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
  }
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.regressionFound) {
    const regressed = workflow.regressedChecks ?? [];
    const what = regressed.length === 0 ? plainBlockReason(workflow.blockReason)
      : `${regressed.length === 1 ? "This test passed before this change and fails" : "These tests passed before this change and fail"} now: ${regressed.map((test) => cleanLine(test, REGRESSED_TEST_MAX)).join(", ")}. Send it back to coding, or close the task.`;
    return { text: `${what} Nothing was sent to GitHub.`, buttons: [...exits.sendBack(), exits.close] };
  }
  // Rewritten history can't be checked again: a new task is the way on.
  if (workflow.blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE) {
    return { text: `The code is written, but I couldn't run the checks. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.close] };
  }
  if (workflow.e2e?.required === true && workflow.e2e.currentRoundId !== undefined
    && workflow.blockReason?.startsWith("admitted E2E evidence is incomplete or unknown") === true) {
    // RUN-2: when every group ended with a code that has a fixed sentence, say why in those sentences (each distinct one once, three at most), and offer Send back where the candidate
    // is the cause (`workflowSendBackOffered`). Any reason that is not exactly `group: code` keeps the one fixed text: nothing the worker said is ever repeated.
    const codes = [...new Set(workflowApplicationEvidenceCodes(workflow.blockReason) ?? [])];
    const sentences = codes.map((code) => E2E_OWNER_SENTENCES.groupSentence(code));
    if (codes.length > 0 && sentences.every((sentence) => sentence !== undefined)) {
      return { text: `The required browser and API checks could not finish. ${sentences.slice(0, 3).join(" ")} Nothing was sent to GitHub.`,
        buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
    }
    return { text: "The required E2E evidence is incomplete or unavailable. Some required runtime checks may not have run. Nothing was sent to GitHub.",
      buttons: [...exits.retryChecks(), exits.close] };
  }
  // Review only: no check runs, so the way on is coding again, or a check the owner chooses when the project has one.
  if (workflowIsReviewOnly(workflow.checkPolicy)) {
    const reason = REVIEW_ONLY_VERIFY_REASONS[workflow.blockReason ?? ""] ?? plainBlockReason(workflow.blockReason);
    return { text: `The code is written, but I couldn't pass it to review. ${reason} Send it back to coding, or close the task.`,
      buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
  }
  return { text: `The code is written, but I couldn't run the checks. ${plainBlockReason(workflow.blockReason)}`,
    buttons: [...exits.retryChecks(), exits.close] };
}

function publishFailed(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>, failure: { category: string; codeChanged?: boolean | undefined }): { text: string; buttons: Button[] } {
  if (failure.codeChanged === true) {
    // Review only: there is no check to run again, so coding again is the way on.
    if (workflowIsReviewOnly(context.workflow.checkPolicy) && !checksConfigured(context.workflow)) {
      return { text: "The code changed after its reviews passed, so I didn't open the pull request. Send it back to coding, or close the task.",
        buttons: [...exits.sendBack(), exits.close] };
    }
    // Retrying the same publication would fail the same way: the way on is coding again, or checking the current code.
    return { text: "The code changed after its checks and reviews passed, so I didn't open the pull request. Send it back to coding, or run the checks again on the current code.",
      buttons: [...exits.sendBack(), ...((context.workflow.pullRequests?.length ?? 0) === 0 ? exits.retryChecks("Run checks again") : []), exits.close] };
  }
  return { text: `Checks and reviews passed, but I couldn't open the draft pull request (${plainPublishFailure(failure.category)}). The checked code is kept.`,
    buttons: [exits.retryPublish, exits.close] };
}

/** The owner's PR-feedback decision that led to this revision, when it kept the pull request as it is. */
function freshFeedbackAnswer(workflow: WorkflowSnapshot) {
  const latest = (workflow.feedbackDecisions ?? []).at(-1);
  return latest !== undefined && latest.decision !== "APPROVE" && latest.workflowRevision === workflow.revision - 1 ? latest : undefined;
}

function waitingForMerge(workflow: WorkflowSnapshot): string | undefined {
  const answer = freshFeedbackAnswer(workflow);
  if (answer?.decision === "REQUEST_CHANGES") return "Got it. I saved your note for the next round of PR feedback; the pull request stays as it is.";
  if (answer?.decision === "DISMISS" && answer.ownerNote === WORKFLOW_KEEP_PULL_REQUESTS_NOTE) return "Got it. The pull request stays as it is; I'll finish this task when it's merged.";
  if (answer?.decision === "DISMISS") return "PR feedback dismissed. The pull request stays as it is.";
  const required = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required);
  if (required.length === 0) return undefined;
  const name = (pullRequest: { url: string; number: number }) => link(pullRequest.url, `PR #${pullRequest.number}`);
  const merged = required.filter((pullRequest) => pullRequest.state === "MERGED").length;
  if (merged === 0) {
    // After approved PR feedback, AgentX pushed the fixed code to the same pull requests.
    if (workflow.pullRequestUpdatedAt !== undefined) {
      return required.length === 1
        ? `Pushed the fix to ${name(required[0]!)}. Review it and merge it on GitHub; I'll finish this task when it's merged.`
        : `Pushed the fix to ${pullRequestNames(required, name)}. Review them and merge them on GitHub; I'll finish this task when they're all merged.`;
    }
    return required.length === 1
      ? `Draft pull request opened: ${name(required[0]!)}. Review it and merge it on GitHub; I'll finish this task when it's merged.`
      : `Draft pull requests opened: ${required.map(name).join(", ")}. Review them and merge them on GitHub; I'll finish this task when they're all merged.`;
  }
  const remaining = required.filter((pullRequest) => pullRequest.state !== "MERGED")
    .map((pullRequest) => `${name(pullRequest)} is still ${pullRequest.state === "CLOSED" ? "closed" : "open"}.`).join(" ");
  return `GitHub update: ${merged} of ${plural(required.length, "pull request")} merged. ${remaining}`.trim();
}

/** "PR #3", or "PRs #3 and #4" (and "PRs #3, #4 and #5"), each named by `name`. */
function pullRequestNames(pullRequests: ReadonlyArray<{ url: string; number: number }>, name: (pullRequest: { url: string; number: number }) => string): string {
  const sorted = [...pullRequests].sort((left, right) => left.number - right.number);
  if (sorted.length === 1) return name(sorted[0]!);
  const names = sorted.map((pullRequest) => name(pullRequest).replace("PR #", "#"));
  return `PRs ${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/**
 * Said while a review of the pull requests' feedback starts: which pull requests, and how many different comments. The
 * same author posting the same text again counts once. Nothing is said once the owner has approved a fix.
 */
function feedbackReviewStarted(workflow: WorkflowSnapshot): string | undefined {
  const review = workflow.feedbackReview;
  if (review?.status !== "COLLECTING" || workflow.feedbackDispatchApproval !== undefined) return undefined;
  const comments = new Set(review.bundleRefs.flatMap((bundle) => bundle.comments.map((comment) => `${comment.author}\n${comment.bodyDigest}`)));
  if (comments.size === 0) return undefined;
  const opened = workflow.pullRequests ?? [];
  // A pull request the task opened is linked; one it did not open is named only.
  const pullRequests = review.bundleRefs.map((bundle) => ({ number: bundle.number,
    url: opened.find((pullRequest) => pullRequest.repositoryId === bundle.repositoryId && pullRequest.number === bundle.number)?.url ?? "" }));
  const names = pullRequestNames(pullRequests, (pullRequest) => (pullRequest.url === "" ? `PR #${pullRequest.number}` : link(pullRequest.url, `PR #${pullRequest.number}`)));
  return `Reviewing the feedback on ${names} (${plural(comments.size, "comment")}). I'll propose a fix here before changing any code.`;
}


/** The Retry review button of a failed PR feedback review's card. */
export const FEEDBACK_REVIEW_RETRY_ACTION = "agentx_feedback_review_retry";

/**
 * Why a PR feedback review failed, in the owner's words, by the check its stored reason names. The reason holds only
 * AgentX's own words, and this never shows it: an unknown reason reads as an answer that couldn't be read.
 */
export function feedbackReviewFailurePlainReason(blockReason: string | undefined, status?: string): string {
  const reason = blockReason ?? "";
  if (status === "INTERRUPTED" || /^review was cancelled/.test(reason)) return "the review was stopped before it finished";
  if (reason === "review timed out") return "the review timed out";
  if (/^candidate changed (?:before|during) review$/.test(reason)) return "the code changed during the review";
  if (reason === "review could not verify the exact candidate") return "the review couldn't check the code";
  if (/not accounted for|answered more than once|names a comment or bundle that was not supplied/.test(reason)) return "the reviewer didn't answer every comment";
  if (/^reviewer output: fixProposal\.(?:replacementChecks|obsoleteChecks)/.test(reason)) return "the reviewer proposed a check change AgentX can't use";
  if (/^reviewer output: .*fixProposal/.test(reason)) return "the reviewer's proposal was incomplete";
  // An answer that was read but broke a rule is named by the rule; only an answer that could not be read says so.
  if (/^reviewer output: finding \d+ is uncertain but not left for the owner$/.test(reason)) return "the reviewer was unsure but didn't leave the choice to you";
  if (/^reviewer output: (?:finding \d+ (?:field .+ is missing or invalid|does not have the required fields)|finding IDs are not unique)$/.test(reason)) return "the reviewer's answer was missing details";
  return "the reviewer's answer couldn't be read";
}

/**
 * A failed PR feedback review, said once by its report: which pull requests, why in plain words, and the owner's ways
 * on (Retry review here, or merge or close on GitHub). The button names the task, the step and the failed report, so a
 * stale press is refused.
 */
export function feedbackReviewFailedMessage(input: {
  taskId: string; revision: number; reviewDigest: string; blockReason: string | undefined;
  /** The report's status: anything but complete (failed, blocked, interrupted). */
  status?: string;
  pullRequests: ReadonlyArray<{ number: number; url: string }>;
}): WorkflowMessage {
  const names = pullRequestNames(input.pullRequests, (pullRequest) => (pullRequest.url === "" ? `PR #${pullRequest.number}` : link(pullRequest.url, `PR #${pullRequest.number}`)));
  const which = input.pullRequests.length === 1 ? "the pull request" : "the pull requests";
  const text = `I couldn't review the feedback on ${names}: ${feedbackReviewFailurePlainReason(input.blockReason, input.status)}. You can retry the review, or merge or close ${which} on GitHub.`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [{ type: "button", action_id: FEEDBACK_REVIEW_RETRY_ACTION, style: "primary", text: { type: "plain_text", text: "Retry review" },
        value: JSON.stringify({ taskId: input.taskId, revision: input.revision, reviewDigest: input.reviewDigest }) }] },
    ],
  };
}
/**
 * Why pushing the fix failed, in the owner's words, by its recorded cause, and what follows: the merge is still followed,
 * except after the pull request changed on GitHub (a merge of someone else's head never completes the task).
 */
const PULL_REQUEST_UPDATE_CAUSES: Record<string, { cause: string; then: string }> = {
  HEAD_MOVED: { cause: "it changed on GitHub since I opened it", then: "I've stopped following it, so merge or close it on GitHub and then close this task." },
  PUSH_REFUSED: { cause: "GitHub refused the push", then: STILL_WATCHING },
};

/** The approved fix could not be pushed to the pull requests: which, and why, when AgentX knows. */
function pullRequestUpdateFailed(workflow: WorkflowSnapshot): string {
  const failure = workflow.pullRequestUpdateFailure;
  if (failure?.cause === "WORKER_OUTDATED") return `I couldn't push the fix because this AgentX worker is out of date. Ask an admin to run agentx upgrade. ${STILL_WATCHING}`;
  const failed = (workflow.pullRequests ?? []).filter((pullRequest) => failure?.numbers.includes(pullRequest.number) === true);
  if (failed.length === 0) return `${plainBlockReason(workflow.blockReason)} ${STILL_WATCHING}`;
  const cause = failure?.cause === undefined ? undefined : PULL_REQUEST_UPDATE_CAUSES[failure.cause];
  const names = pullRequestNames(failed, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
  return `I couldn't push the fix to ${names}${cause === undefined ? "" : `: ${cause.cause}`}. ${cause?.then ?? STILL_WATCHING}`;
}

/** The pull requests the fix is being pushed to: those already open that hold earlier code. */
function pushingFixTo(workflow: WorkflowSnapshot): string | undefined {
  const pending = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.candidateDigest !== workflow.candidate?.digest
    && (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN"));
  return pending.length === 0 ? undefined : pullRequestNames(pending, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
}

function implementRunning(context: WorkflowMessageContext): string {
  const { workflow } = context;
  const decision = leadingDecision(workflow);
  const feedback = (workflow.feedbackDecisions ?? []).at(-1);
  if (feedback?.decision === "APPROVE" && feedback.workflowRevision >= workflow.revision - 2 && (decision === undefined || feedback.at >= decision.at)) {
    return "PR feedback approved. Updating the code now; the checks and reviews run again after.";
  }
  if (decision?.source === "SEND_BACK" || decision?.source === "FINDINGS") {
    const problems = sendBackProblems(workflow);
    const issues = problems.filter((problem) => problem.source !== "check").length;
    const checks = problems.length - issues;
    const what = [...(issues > 0 ? [plural(issues, "review issue")] : []), ...(checks > 0 ? [plural(checks, "failed check")] : [])].join(" and ");
    return `Sent back to coding with ${what === "" ? "your note" : what}. Checks and reviews will run again after.`;
  }
  if (decision?.decision === "APPROVE") {
    const count = checkCount(workflow);
    return `Coding plan approved${approvedBy(context, decision)}. Writing the code now${count > 0 ? `; then I'll run ${plural(count, "check")}` : ""}.`;
  }
  return "Trying the coding step again.";
}

/**
 * An approved PR feedback fix left the pull request's code as it was: nothing was pushed. The owner retries the fix, keeps
 * the pull request as it is (when its checked code is still the task's, the task simply waits for the merge again), or
 * closes the task. Either way the merge is still followed.
 */
function fixChangedNothing(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow } = context;
  const open = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN");
  const names = open.length === 0 ? "the pull request" : pullRequestNames(open, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
  const keep = workflowKeepPullRequestsOffered(workflow);
  return {
    text: `The approved fix didn't change any code, so nothing was pushed to ${names}. ${keep
      ? "Retry coding, keep the pull request as it is, or close the task."
      : `Retry coding, or close the task. ${STILL_WATCHING}`}`,
    buttons: [exits.button("agentx_workflow_retry_implementation", "Retry coding"),
      ...(keep ? [exits.button("agentx_workflow_keep_pull_requests", "Keep the pull request as it is")] : []), exits.close],
  };
}

/** " by @owner" when the task's owner made this approval and their Slack user is known; otherwise nothing. */
function approvedBy(context: WorkflowMessageContext, decision: { actorRole: string }): string {
  return context.ownerSlackUserId === undefined || decision.actorRole !== "TASK_OWNER" ? "" : ` by <@${context.ownerSlackUserId}>`;
}

function planRunning(context: WorkflowMessageContext): string {
  const { workflow } = context;
  const name = workflowDocumentName(workflow);
  const decision = leadingDecision(workflow);
  if (decision?.decision === "REQUEST_CHANGES") return `Got it. Revising the ${name} with your changes.`;
  if (decision?.decision === "APPROVE" && workflow.path === "FULL") {
    const previous = workflow.reviewPhase === "DESIGN" ? "requirements" : "design";
    return `${capitalized(previous)} approved${approvedBy(context, decision)}. Writing the ${name} next.`;
  }
  return `Working on the ${name}. I'll post it here for your approval; nothing changes in the code until you approve.`;
}

function copyOf(context: WorkflowMessageContext): { text: string; buttons: Button[] } | undefined {
  const { workflow } = context;
  const exits = exitButtons(context);
  const plain = (text: string | undefined) => (text === undefined ? undefined : { text, buttons: [] as Button[] });
  const passed = workflow.verification?.results.length;
  // Review only: no automated check applied, so nothing "passed".
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  const allPassed = reviewOnly ? "No automated check applied." : passed === undefined ? "The checks passed." : passed === 1 ? "The check passed." : `All ${passed} checks passed.`;
  const checksAndReviewsPassed = reviewOnly ? "Reviews passed (no automated check applied)." : "Checks and reviews passed.";
  if (context.publishFailure !== undefined && workflow.stage === "PULL_REQUEST") return publishFailed(context, exits, context.publishFailure);
  switch (`${workflow.stage}/${workflow.state}`) {
    case "PLAN/RUNNING": return plain(planRunning(context));
    case "PLAN/BLOCKED": return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.planUnreadable
      ? `AgentX couldn't read the ${workflowDocumentName(workflow)} it wrote.`
      : `I couldn't finish the ${workflowDocumentName(workflow)}. ${plainBlockReason(workflow.blockReason)}`,
      buttons: [exits.button("agentx_workflow_retry_plan", "Retry planning"), exits.close] };
    case "PLAN_REVIEW/WAITING": return planReview(context, exits);
    // Only a task view shows this (never stored): the saved document failed its digest check, so it can't be approved.
    case "PLAN_REVIEW/BLOCKED": return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.documentUnverified
      ? `The saved ${workflowDocumentName(workflow)} couldn't be checked, so I stopped. Close this task and start again.`
      : `I stopped before your approval of the ${workflowDocumentName(workflow)}. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.close] };
    case "IMPLEMENT/RUNNING": return plain(implementRunning(context));
    case "IMPLEMENT/BLOCKED": if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.fixChangedNothing) return fixChangedNothing(context, exits);
      return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.noCodeChanged ? WORKFLOW_BLOCK_REASONS.noCodeChanged
      : `Coding stopped before it finished. ${plainBlockReason(workflow.blockReason)}`,
      // Rewritten history can't be coded on again: a new task is the way on.
      buttons: workflow.blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE ? [exits.close] : [exits.button("agentx_workflow_retry_implementation", "Retry coding"), exits.close] };
    case "VERIFY/RUNNING": return plain("Running the selected checks again on the current code. No code is being changed.");
    case "VERIFY/BLOCKED": return verifyBlocked(context, exits);
    case "REVIEW/WAITING": return plain(`${allPassed} Starting the code and security reviews.`);
    case "REVIEW/RUNNING": return plain(`${allPassed} Code and security reviews are running on the ${reviewOnly ? "current" : "checked"} code.`);
    case "REVIEW/BLOCKED": return reviewBlocked(context, exits);
    // The pull requests are already open after approved PR feedback: the fix is pushed to them. While it runs, nothing new is said.
    case "PULL_REQUEST/READY": case "PULL_REQUEST/RUNNING": {
      const pushing = pushingFixTo(workflow);
      if (pushing === undefined && workflow.state === "RUNNING") return undefined;
      return plain(`${checksAndReviewsPassed} ${pushing === undefined ? "Opening a draft pull request." : `Pushing the fix to ${pushing}.`}${partialReviewNote(workflow)}`);
    }
    case "PULL_REQUEST/BLOCKED": return { text: `${checksAndReviewsPassed} ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.retryPublish, exits.close] };
    // The owner can close the task while its pull request is open (the pull request stays on GitHub).
    case "WAIT_FOR_MERGE/WAITING": {
      const text = context.pullRequestReopened !== undefined ? pullRequestReopened(workflow, context.pullRequestReopened) : waitingForMerge(workflow);
      return text === undefined ? undefined : { text, buttons: [exits.close] };
    }
    // The feedback review runs before anything is proposed; no button, as nothing is waiting on the owner yet.
    case "WAIT_FOR_MERGE/RUNNING": return plain(feedbackReviewStarted(workflow));
    // Nothing on GitHub is retried from here: the owner closes the task (its pull request stays on GitHub). Only a changed
    // pull request ends the following; a failed feedback review or push leaves the merge still tracked.
    case "WAIT_FOR_MERGE/BLOCKED": return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestChanged
      ? `I stopped following the pull request. ${plainBlockReason(workflow.blockReason)}`
      : workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestClosed ? plainBlockReason(workflow.blockReason)
      : workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed ? pullRequestUpdateFailed(workflow)
        : `${plainBlockReason(workflow.blockReason)} ${STILL_WATCHING}`, buttons: [exits.close] };
    case "MERGED/COMPLETE": {
      const total = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required).length;
      return plain(total <= 1 ? "The pull request is merged. This task is complete." : `All ${total} pull requests are merged. This task is complete.`);
    }
    case "CLOSED/COMPLETE": return plain(workflow.outcome === "REJECTED" ? "Closed without changes." : "This task is closed.");
    default: return undefined;
  }
}

/** Slack section blocks hold 3,000 characters; a long text is split at a line break where it can be. */
export function slackSectionTexts(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > SECTION_TEXT_LIMIT) {
    // At a line break whenever one fits, so a line (a check's command, say) is never split; only a single line too long
    // for one section is split, at a safe place.
    const lineBreak = remaining.lastIndexOf("\n", SECTION_TEXT_LIMIT);
    const splitAt = lineBreak > 0 ? lineBreak : safeSplit(remaining, SECTION_TEXT_LIMIT);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Where to split one over-long line at or before `limit`: never inside an escaped character ("&lt;") and, when it can,
 * not inside a code span (before its opening backtick instead).
 */
function safeSplit(line: string, limit: number): number {
  let splitAt = limit;
  const amp = line.lastIndexOf("&", splitAt - 1);
  if (amp >= 0 && amp > splitAt - 10 && /^&[A-Za-z#0-9]{1,8};/.test(line.slice(amp)) && line.indexOf(";", amp) >= splitAt) splitAt = amp;
  const ticks = (line.slice(0, splitAt).match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const opening = line.lastIndexOf("`", splitAt - 1);
    if (opening > 0) splitAt = opening;
  }
  return splitAt > 0 ? splitAt : limit;
}

/**
 * A card someone answered: its text kept, its buttons gone, and `note` (who chose what) beneath it. The text is the
 * card's own, already written for Slack; only a broadcast (`<!channel>`, `<!here>`) in it is made inert.
 */
export function answeredWorkflowCard(text: string, note: string): Array<Record<string, unknown>> {
  const inert = text.replaceAll("<!", "&lt;!");
  return [
    ...slackSectionTexts(inert).map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
    { type: "context", elements: [{ type: "mrkdwn", text: note }] },
  ];
}

/**
 * What makes two posts the same post, so the thread hears it once: by default the step's revision. The merge step is
 * keyed by what it says (each required pull request's head and state), so a later revision that left them as they
 * were says nothing; opening the pull requests is said once per checked code.
 */
export function workflowMessageKey(workflow: WorkflowSnapshot): string {
  if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING" && freshFeedbackAnswer(workflow) === undefined) {
    return `merge:${(workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required)
      .map((pullRequest) => `${pullRequest.repositoryId}#${pullRequest.number}@${pullRequest.headSha ?? pullRequest.candidateDigest}=${pullRequest.state === "MERGED" ? "merged" : pullRequest.state === "CLOSED" ? "closed" : "open"}`)
      .join(",")}`;
  }
  // Pushing a fix to the pull requests already open says the same as getting ready to: said once per checked code.
  if (workflow.stage === "PULL_REQUEST" && (workflow.state === "READY" || workflow.state === "RUNNING")) return `opening:${workflow.candidate?.digest ?? workflow.revision}`;
  return `revision:${workflow.revision}`;
}

/** Said when a review saw only part of the change: its diff was too large to show in full. */
const PARTIAL_REVIEW = "The change was too large to show the reviewers in full, so they reviewed only part of it.";
const partialReviewNote = (workflow: WorkflowSnapshot) => (workflowReviewsSawPartialDiff(workflow) ? ` ${PARTIAL_REVIEW}` : "");

/**
 * Replies posted after the plan reach only a planning or coding step. Where none is next (the draft pull request is
 * open, or a step stopped), the post says they came in and where to read them; a step's own Send back, where it has
 * one, stays offered and gives them to the coder.
 */
function laterRepliesLine(context: WorkflowMessageContext): string | undefined {
  const { workflow } = context;
  const count = context.newReplies ?? 0;
  if (count === 0 || !(workflow.state === "BLOCKED" || (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING"))) return undefined;
  const page = context.taskPageUrl === undefined ? "see the task page" : `see ${link(context.taskPageUrl, "the task page")}`;
  return `${plural(count, "thread reply", "thread replies")} came in after the plan; ${page}.`;
}

/** The thread post for the task's current step, or undefined when this step has nothing to say. */
export function workflowMessage(context: WorkflowMessageContext): WorkflowMessage | undefined {
  const copy = copyOf(context);
  if (copy === undefined) return undefined;
  const replies = laterRepliesLine(context);
  const text = replies === undefined ? copy.text : `${copy.text}\n${replies}`;
  const buttons = context.peopleEnabled === true
    ? [...copy.buttons, { type: "button", action_id: "agentx_task_people", text: { type: "plain_text", text: "People" }, value: JSON.stringify({ taskId: context.taskId }) }]
    : copy.buttons;
  return {
    text,
    blocks: [
      ...slackSectionTexts(text).map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
      ...(buttons.length === 0 ? [] : [{ type: "actions", elements: buttons }]),
    ],
  };
}
