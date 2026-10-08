// Gaps 5, 12 and 10g: the one place a workflow task's thread post is worded. Each (stage, state) has one brief,
// plain message (at most 1,200 visible characters), and every blocked step carries its ways out as buttons. Every
// value from a record, the model or a reviewer is redacted where it is free text, cut short and escaped here.
import {
  WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE,
  redactText, sendBackProblems, workflowReviewsSawPartialDiff, workflowSendBackOffered, type WorkflowSnapshot,
} from "@agentx/contracts";
import { WORKFLOW_ACTION_IDS } from "./workflow-actions.js";

export interface WorkflowMessageContext {
  taskId: string;
  ownerSlackUserId?: string | undefined;
  workflow: WorkflowSnapshot;
  /** Where the full document reads (a Canvas, or the task page); absent when no link could be made. */
  documentLink?: { url: string } | undefined;
  documentSummary?: readonly string[] | undefined;
  findingsUrl?: string | undefined;
  /** The task page, where every thread reply can be read. */
  taskPageUrl?: string | undefined;
  /** Thread replies saved and not yet given to a step. */
  newReplies?: number | undefined;
  /** AgentX's own draft pull request did not open; `codeChanged` when the workspace no longer held the checked code. */
  publishFailure?: { category: string; codeChanged?: boolean | undefined } | undefined;
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
const GENERIC_REASON = "Something went wrong on AgentX's side.";

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

/** The broker's own reason a step stopped, in words the owner can act on; any other reason is internal. */
export function plainBlockReason(blockReason: string | undefined): string {
  if (blockReason === undefined) return GENERIC_REASON;
  if (/operation ended (failed|interrupted|cancelled)$/.test(blockReason)) return "The run stopped unexpectedly.";
  if (/ was invalid, incomplete, or stale$/.test(blockReason)) return "The result couldn't be trusted, so nothing moved forward.";
  return PLAIN_REASONS.has(blockReason) ? slackText(blockReason) : GENERIC_REASON;
}

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

/** One line of free text from a reviewer or the model: on one line, redacted, cut short, escaped. */
function cleanLine(text: string, limit: number): string {
  const line = redactText(text).replace(/\s+/g, " ").trim();
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
  return (workflow.checkPolicy?.required.length ?? 0) + (workflow.checkPolicy?.selectedOptionalIds.length ?? 0);
}

const checksConfigured = (workflow: WorkflowSnapshot) => (workflow.checkPolicy?.required.length ?? 0) + (workflow.checkPolicy?.optional.length ?? 0) > 0;

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
    close: button("agentx_workflow_close", "Close task"),
    retryChecks: (label = "Choose checks and retry"): Button[] => checksConfigured(workflow) ? [button("agentx_workflow_retry_checks", label)] : [],
    retryReviews: (): Button[] => checkedAndPassing(workflow)
      ? [button("agentx_workflow_retry_reviews", "Retry reviews", { value: JSON.stringify({ taskId, revision: workflow.revision, candidateDigest: workflow.candidate?.digest }) })] : [],
    retryPublish: button("agentx_workflow_retry_publish", "Retry opening the pull request"),
  };
}

const link = (url: string, label: string) => `<${slackText(url)}|${label}>`;

function planReview(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow } = context;
  const name = workflowDocumentName(workflow);
  const document = workflow.artifacts.filter((artifact) => artifact.type === workflowDocumentType(workflow)).at(-1);
  const lines = [`*${capitalized(name)}${document === undefined ? "" : ` v${document.version}`} is ready for your approval.* No code has changed yet.`];
  for (const line of (context.documentSummary ?? []).slice(0, 3)) lines.push(`> ${cleanLine(line, SUMMARY_LINE_MAX)}`);
  if ((context.newReplies ?? 0) > 0) lines.push(`${plural(context.newReplies!, "thread reply", "thread replies")} since the last step will be included.`);
  lines.push(context.documentLink === undefined ? `I couldn't link the full ${name}; ask an AgentX admin to check the task page.` : link(context.documentLink.url, `Read the full ${name}`));
  const decide = (decision: "APPROVE" | "REQUEST_CHANGES") => JSON.stringify({ taskId: context.taskId, revision: workflow.revision, digest: document?.sha256, decision });
  const buttons = document === undefined ? [exits.close] : [
    exits.button("agentx_workflow_approve", `Approve ${name}`, { value: decide("APPROVE"), primary: true }),
    exits.button("agentx_workflow_changes", "Request changes", { value: decide("REQUEST_CHANGES") }),
    exits.close,
  ];
  return { text: lines.join("\n"), buttons };
}

function reviewBlocked(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const reviews = currentReviews(context.workflow);
  const introduced = reviews.flatMap((review) => (review.findings ?? [])
    .filter((finding) => typeof finding === "string" || finding.origin === "INTRODUCED")
    .map((finding) => typeof finding === "string" ? { role: review.role, text: finding } : { role: review.role, text: finding.text, file: finding.file, line: finding.line }));
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
    return { text: lines.join("\n"), buttons: [...exits.sendBack(), ...exits.retryReviews(), exits.close] };
  }
  const unfinished = reviews.filter((review) => ["UNKNOWN", "FAILED", "INTERRUPTED"].includes(review.status));
  const text = unfinished.length > 0
    ? `A review couldn't finish (${unfinished.map((review) => `${review.role === "SECURITY" ? "security" : "code"} review: ${plainReviewFailure(review.failureReason, review.status)}`).join("; ")}). Nothing was sent to GitHub.`
    : `The checks passed, but the reviews couldn't finish. ${plainBlockReason(context.workflow.blockReason)} Nothing was sent to GitHub.`;
  return { text, buttons: [...exits.retryReviews(), exits.close] };
}

function verifyBlocked(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow } = context;
  const verification = workflow.candidate !== undefined && workflow.verification?.candidateDigest === workflow.candidate.digest ? workflow.verification : undefined;
  const results = verification?.results ?? [];
  const failed = results.filter((result) => result.status === "FAILED");
  if (failed.length > 0) {
    const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.optional ?? [])];
    const labels = failed.map((result) => cleanLine(checks.find((check) => check.id === result.checkId)?.label ?? result.checkId, 80)).join(", ");
    return { text: `${failed.length} of ${plural(results.length, "check")} didn't pass: ${labels}. Nothing was sent to GitHub.`,
      buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
  }
  // Rewritten history can't be checked again: a new task is the way on.
  return { text: `The code is written, but I couldn't run the checks. ${plainBlockReason(workflow.blockReason)}`,
    buttons: workflow.blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE ? [exits.close] : [...exits.retryChecks(), exits.close] };
}

function publishFailed(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>, failure: { category: string; codeChanged?: boolean | undefined }): { text: string; buttons: Button[] } {
  if (failure.codeChanged === true) {
    // Retrying the same publication would fail the same way: the way on is coding again, or checking the current code.
    return { text: "The code changed after its checks and reviews passed, so I didn't open the pull request. Send it back to coding, or run the checks again on the current code.",
      buttons: [...exits.sendBack(), ...((context.workflow.pullRequests?.length ?? 0) === 0 ? exits.retryChecks("Run checks again") : []), exits.close] };
  }
  return { text: `Checks and reviews passed, but I couldn't open the draft pull request (${plainPublishFailure(failure.category)}). The checked code is kept.`,
    buttons: [exits.retryPublish, exits.close] };
}

function waitingForMerge(workflow: WorkflowSnapshot): string | undefined {
  const required = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required);
  if (required.length === 0) return undefined;
  const name = (pullRequest: { url: string; number: number }) => link(pullRequest.url, `PR #${pullRequest.number}`);
  const merged = required.filter((pullRequest) => pullRequest.state === "MERGED").length;
  if (merged === 0) {
    return required.length === 1
      ? `Draft pull request opened: ${name(required[0]!)}. Review it and merge it on GitHub, then close this task here.`
      : `Draft pull requests opened: ${required.map(name).join(", ")}. Review them and merge them on GitHub, then close this task here.`;
  }
  const remaining = required.filter((pullRequest) => pullRequest.state !== "MERGED")
    .map((pullRequest) => `${name(pullRequest)} is still ${pullRequest.state === "CLOSED" ? "closed" : "open"}.`).join(" ");
  return `GitHub update: ${merged} of ${required.length} pull requests merged. ${remaining}`.trim();
}

function implementRunning(context: WorkflowMessageContext): string {
  const { workflow } = context;
  const decision = leadingDecision(workflow);
  if (decision?.source === "SEND_BACK") {
    const problems = sendBackProblems(workflow);
    const issues = problems.filter((problem) => problem.source !== "check").length;
    const checks = problems.length - issues;
    const what = [...(issues > 0 ? [plural(issues, "review issue")] : []), ...(checks > 0 ? [plural(checks, "failed check")] : [])].join(" and ");
    return `Sent back to coding with ${what === "" ? "your note" : what}. Checks and reviews will run again after.`;
  }
  if (decision?.decision === "APPROVE") {
    const by = context.ownerSlackUserId === undefined ? "" : ` by <@${context.ownerSlackUserId}>`;
    const count = checkCount(workflow);
    return `Coding plan approved${by}. Writing the code now${count > 0 ? `; then I'll run ${plural(count, "check")}` : ""}.`;
  }
  return "Trying the coding step again.";
}

function planRunning(workflow: WorkflowSnapshot): string {
  const name = workflowDocumentName(workflow);
  const decision = leadingDecision(workflow);
  if (decision?.decision === "REQUEST_CHANGES") return `Got it. Revising the ${name} with your changes.`;
  if (decision?.decision === "APPROVE" && workflow.path === "FULL") {
    const previous = workflow.reviewPhase === "DESIGN" ? "requirements" : "design";
    return `${capitalized(previous)} approved. Writing the ${name} next.`;
  }
  return `Working on the ${name}. I'll post it here for your approval; nothing changes in the code until you approve.`;
}

function copyOf(context: WorkflowMessageContext): { text: string; buttons: Button[] } | undefined {
  const { workflow } = context;
  const exits = exitButtons(context);
  const plain = (text: string | undefined) => (text === undefined ? undefined : { text, buttons: [] as Button[] });
  const passed = workflow.verification?.results.length;
  const allPassed = passed === undefined ? "The checks passed." : passed === 1 ? "The check passed." : `All ${passed} checks passed.`;
  if (context.publishFailure !== undefined && workflow.stage === "PULL_REQUEST") return publishFailed(context, exits, context.publishFailure);
  switch (`${workflow.stage}/${workflow.state}`) {
    case "PLAN/RUNNING": return plain(planRunning(workflow));
    case "PLAN/BLOCKED": return { text: `I couldn't finish the ${workflowDocumentName(workflow)}. ${plainBlockReason(workflow.blockReason)}`,
      buttons: [exits.button("agentx_workflow_retry_plan", "Retry planning"), exits.close] };
    case "PLAN_REVIEW/WAITING": return planReview(context, exits);
    // Only a task view shows this (never stored): the saved document failed its digest check, so it can't be approved.
    case "PLAN_REVIEW/BLOCKED": return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.documentUnverified
      ? `The saved ${workflowDocumentName(workflow)} couldn't be checked, so I stopped. Close this task and start again.`
      : `I stopped before your approval of the ${workflowDocumentName(workflow)}. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.close] };
    case "IMPLEMENT/RUNNING": return plain(implementRunning(context));
    case "IMPLEMENT/BLOCKED": return { text: `Coding stopped before it finished. ${plainBlockReason(workflow.blockReason)}`,
      // Rewritten history can't be coded on again: a new task is the way on.
      buttons: workflow.blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE ? [exits.close] : [exits.button("agentx_workflow_retry_implementation", "Retry coding"), exits.close] };
    case "VERIFY/RUNNING": return plain("Running the selected checks again on the current code. No code is being changed.");
    case "VERIFY/BLOCKED": return verifyBlocked(context, exits);
    case "REVIEW/WAITING": return plain(`${allPassed} Starting the code and security reviews.`);
    case "REVIEW/RUNNING": return plain(`${allPassed} Code and security reviews are running on the checked code.`);
    case "REVIEW/BLOCKED": return reviewBlocked(context, exits);
    case "PULL_REQUEST/READY": return plain(`Checks and reviews passed. Opening a draft pull request.${partialReviewNote(workflow)}`);
    case "PULL_REQUEST/BLOCKED": return { text: `Checks and reviews passed. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.retryPublish, exits.close] };
    // AgentX does not follow the pull request on GitHub: the owner closes the task once it is merged (it stays on GitHub).
    case "WAIT_FOR_MERGE/WAITING": {
      const text = waitingForMerge(workflow);
      return text === undefined ? undefined : { text, buttons: [exits.close] };
    }
    // Nothing on GitHub is retried from here: the owner closes the task (its pull request stays on GitHub).
    case "WAIT_FOR_MERGE/BLOCKED": return { text: `I stopped following the pull request. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.close] };
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
    let splitAt = remaining.lastIndexOf("\n", SECTION_TEXT_LIMIT);
    if (splitAt < SECTION_TEXT_LIMIT / 2) splitAt = SECTION_TEXT_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
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
  if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING") {
    return `merge:${(workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required)
      .map((pullRequest) => `${pullRequest.repositoryId}#${pullRequest.number}@${pullRequest.headSha ?? pullRequest.candidateDigest}=${pullRequest.state === "MERGED" ? "merged" : pullRequest.state === "CLOSED" ? "closed" : "open"}`)
      .join(",")}`;
  }
  if (workflow.stage === "PULL_REQUEST" && workflow.state === "READY") return `opening:${workflow.candidate?.digest ?? workflow.revision}`;
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
  return {
    text,
    blocks: [
      ...slackSectionTexts(text).map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
      ...(copy.buttons.length === 0 ? [] : [{ type: "actions", elements: copy.buttons }]),
    ],
  };
}
