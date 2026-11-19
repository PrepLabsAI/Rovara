// The pull request's description as the task flow publishes it (Cloud: `aws/developer-tasks/pull-request-body.ts`, the part that builds the text). A Rovara Code (version 2) task gets `rovaraPullRequestBody`; a
// version 1 task's description is exactly what it was. Inputs the broker used to read from the task record are context fields now (`secondReviewLines`, `reviewSameModel`): the caller (the task flow, lane L6a,
// and the second-review module, lane L9) computes them. Selecting the approved plan, reading the proof inputs and publishing stay with the task flow.
import { planApprovalSkipped } from "../task-flow/stage-selection.js";
import {
  attributionBodyLines,
  prVerdictForCheck,
  workflowReviewsSawPartialDiff,
  hideEmailAddresses,
  redactText,
  type RovaraCheckVerdict,
  type WorkflowSnapshot,
  workflowIsReviewOnly,
  planSummaryLines,
  workflowFindingAccepted,
  reviewCleared,
} from "@agentx/contracts";
import { GENERAL_FAKE_MADE_NOTE } from "@agentx/contracts";
import { PULL_REQUEST_PARTIAL_REVIEW_LINE, PULL_REQUEST_STATUS_END, PULL_REQUEST_STATUS_START, ROVARA_STATUS_END, ROVARA_STATUS_START } from "../../developer/pull-request-feedback-section.js";
import type { LoadedDocument } from "../../developer/plan-document-reader.js";
import { documentSummaryLines } from "../../developer/workflow-messages.js";
import { breakLinearKeys, normalizeIssueKey, sealLinearText } from "./linear-close.js";
import { inertPlanLine } from "./inert-text.js";
import { reviewSameModelOf } from "./review-model-lines.js";
import { ROVARA_PULL_REQUEST_CLOSING, ROVARA_PULL_REQUEST_CLOSING_NO_APPROVAL, lessonsUsedLines, requiredReviewDidNotClear, rovaraPullRequestBody, rovaraPullRequestVerdict, rovaraStatusLines, type PullRequestBodyContext } from "./pull-request-body.js";

/** The task as the description needs it. */
export interface PullRequestBodyTask {
  title: string;
  /** Whether the reviews of this code ran on the build's own model (the task record's `reviewSameModel`). */
  reviewSameModel?: { candidateDigest: string } | undefined;
}

const WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES = 30_000;
/** The closing drawer of a version 2 description, which holds the plan summary and the record (pull-request-body.ts). */
const RECORD_DRAWER_START = "<details>";
const RECORD_DRAWER_END = "</details>";
const WORKFLOW_PLAN_SUMMARY_LINE_MAX = 500;
/** At most this many accepted findings are listed in the pull request description. */
const WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED = 20;

/**
 * The draft pull request's description: what the owner-approved plan set out to do, which checks and reviews passed
 * (or, first, that no automated check applied and why), where the task lives, and that a human merges it. At most
 * 30,000 bytes.
 */
export function workflowPullRequestBody(task: PullRequestBodyTask, workflow: WorkflowSnapshot, plan: LoadedDocument | string | undefined, pageUrl: string | undefined, context?: PullRequestBodyContext, proofLines: readonly string[] = []): string {
  // S3 (C59): the description is read by everyone who can see the repository, and the plan, the findings and the title are a model's and a person's words. No email address is written on GitHub; layout is kept, so a code block still renders.
  const built = buildWorkflowPullRequestBody(task, workflow, plan, pageUrl, context, proofLines);
  // A small change's plan went to coding with no approval (the lighter flow): the description never calls it approved.
  const honest = planApprovalSkipped(workflow) ? built.replace(ROVARA_PULL_REQUEST_CLOSING, ROVARA_PULL_REQUEST_CLOSING_NO_APPROVAL).replace("after the owner-approved plan", "after the plan (no approval needed: small change)") : built;
  const body = hideEmailAddresses(honest);
  return fitPullRequestBody(body);
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
/** Cut on a character boundary: a split multi-byte character decodes as U+FFFD, which is dropped. */
const cutBytes = (text: string, max: number): string => Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/\uFFFD+$/u, "");

/**
 * The body within the cap. A body that is over it (hiding an address can lengthen a line) first loses the plan of the closing "Plan and record" drawer (a version 2 description) or the end of its summary in front of the marked
 * block (a version 1 description), before anything is cut from the end: the block's end marker, the closing line, and for version 2 the quote, the heading and the six lines stay, so the status updates and the Linear close line
 * can still find the block.
 */
export function fitPullRequestBody(body: string): string {
  if (byteLength(body) <= WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES) return body;
  const rovaraEnd = body.indexOf(ROVARA_STATUS_END);
  const drawerAt = rovaraEnd === -1 ? -1 : body.indexOf(RECORD_DRAWER_START, rovaraEnd);
  if (drawerAt !== -1) {
    const closeAt = body.indexOf(RECORD_DRAWER_END, drawerAt);
    if (closeAt !== -1) {
      const stub = `${RECORD_DRAWER_START}\n<summary>Plan and record</summary>\n\nThe plan and the record are on the task page.\n\n`;
      const shortened = `${body.slice(0, drawerAt)}${stub}${body.slice(closeAt)}`;
      if (byteLength(shortened) <= WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES) return shortened;
      body = shortened;
    }
  }
  const markers = [PULL_REQUEST_STATUS_START, ROVARA_STATUS_START].map((marker) => body.indexOf(marker)).filter((index) => index > 0);
  const start = markers.length === 0 ? -1 : Math.min(...markers);
  if (start > 0) {
    const overflow = byteLength(body) - WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES;
    const head = body.slice(0, start);
    // Keep at least a short head: the summary's first lines.
    if (byteLength(head) > overflow + 200) return `${cutBytes(head, byteLength(head) - overflow - 5).trimEnd()}...\n\n${body.slice(start)}`;
  }
  return cutBytes(body, WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES);
}

/** The title of the pull request Rovara opens: the task's title made inert, without an email address, and (for Rovara Code) without a Linear issue key. At most 256 characters. */
export function pullRequestTitle(taskTitle: string, rovaraV2: boolean): string {
  const inert = inertTaskTitle(hideEmailAddresses(taskTitle));
  return `${rovaraV2 ? "Rovara" : "AgentX"}: ${rovaraV2 ? breakLinearKeys(inert) : inert}`.slice(0, 256);
}

/** The context a version 2 description is built from: the caller's, plus the proof lines and what the task record says (the one place the description and the Check's verdict take it from). */
function rovaraContextOf(task: PullRequestBodyTask, workflow: WorkflowSnapshot, context: PullRequestBodyContext | undefined, proofLines: readonly string[]): PullRequestBodyContext {
  const secondLines = context?.secondReviewLines ?? [];
  return { ...(context ?? {}), ...(proofLines.length === 0 ? {} : { proofLines }), ...(reviewSameModelOf(task, workflow) ? { reviewSameModel: true } : {}), ...(secondLines.length === 0 ? {} : { secondReviewLines: secondLines }) };
}

/**
 * L4-PRP: the verdict of the code the description is about, as the "Rovara" Check takes it (`RovaraCheckInput.verdict`): the heading, the six lines and the list of things to check, the same lines the description's block says
 * (`rovaraPullRequestVerdict` over the same context; the same last guards: Linear words sealed, no email address). Only a Rovara Code (version 2) task has one; any other gives undefined and the Check is what it was.
 */
export function workflowPullRequestCheckVerdict(task: PullRequestBodyTask, workflow: WorkflowSnapshot, plan: LoadedDocument | string | undefined, context?: PullRequestBodyContext, proofLines: readonly string[] = []): RovaraCheckVerdict | undefined {
  void plan;
  if (workflow.definitionVersion !== "1.1.0") return undefined;
  // The versioned PR verdict has only passed and passed-after-accepted review states. It cannot honestly describe a review that did not run.
  if (requiredReviewDidNotClear(workflow)) return undefined;
  const merged = rovaraContextOf(task, workflow, context, proofLines);
  const verdict = rovaraPullRequestVerdict(workflow, merged, (listed) => workflowReviewLines(workflow, listed, context?.acceptedBy));
  const forCheck = prVerdictForCheck(verdict);
  const sealed = sealLinearText([forCheck.heading, ...forCheck.body], normalizeIssueKey(merged.linearIssueKey)).map((line) => hideEmailAddresses(line));
  return { resultKind: forCheck.resultKind, heading: sealed[0]!, body: sealed.slice(1) };
}

function buildWorkflowPullRequestBody(task: PullRequestBodyTask, workflow: WorkflowSnapshot, plan: LoadedDocument | string | undefined, pageUrl: string | undefined, context?: PullRequestBodyContext, proofLines: readonly string[] = []): string {
  // SH34: the second review of this code (none for a shadow opinion), kept beside the workflow and never part of the first review's lines. Both versions show it.
  const secondLines = context?.secondReviewLines ?? [];
  // Rovara Code version 2 has its own description (sections, test results and a risk level); a version 1 task's is exactly as it was.
  if (workflow.definitionVersion === "1.1.0") {
    return rovaraPullRequestBody({
      summary: typeof plan === "object" && plan.format === "structured" ? planSummaryLines(plan.plan) : documentSummaryLines(typeof plan === "string" ? plan : plan?.markdown ?? ""),
      fallbackTitle: task.title, workflow, context: rovaraContextOf(task, workflow, context, proofLines), reviewLines: (listed) => workflowReviewLines(workflow, listed, context?.acceptedBy), pageUrl,
    });
  }
  // A structured plan's summary is its top claims; a legacy one's is its first lines (task 18: the same as the plan's
  // Slack message). Either way each line is made inert for GitHub first.
  const summary = (typeof plan === "object" && plan.format === "structured"
    ? planSummaryLines(plan.plan).map(inertPlanLine)
    : documentSummaryLines((typeof plan === "string" ? plan : plan?.markdown ?? "").split("\n").map(inertPlanLine).join("\n")))
    .map((line) => line.slice(0, WORKFLOW_PLAN_SUMMARY_LINE_MAX));
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  const reviewDidNotClear = requiredReviewDidNotClear(workflow);
  // Model-written: one line, redacted and made inert like a plan line.
  const noneReason = workflow.checkPolicy?.noneReason === undefined ? "" : inertPlanLine(redactText(workflow.checkPolicy.noneReason).replace(/\s+/gu, " ")).trim();
  const lines = [
    ...(reviewOnly ? ["Not verified by automated checks (review only).", ...(noneReason === "" ? [] : [`Why: ${noneReason}`]), ""] : []),
    ...(summary.length > 0 ? summary : [inertTaskTitle(task.title)]),
    "",
    // Between markers, so a pushed PR feedback fix can bring them up to date and leave the rest as the person left it.
    PULL_REQUEST_STATUS_START,
    // R1 (re-check round 1): the lessons used belong in the description a version 1 task OPENS with, not only in one a pushed fix rewrites.
    ...workflowPullRequestStatusLines(workflow, { ...(context?.lessonsUsed === undefined ? {} : { lessonsUsed: context.lessonsUsed }), ...(secondLines.length === 0 ? {} : { secondReviewLines: secondLines }), ...(context?.acceptedBy === undefined ? {} : { acceptedBy: context.acceptedBy }), ...(context?.browserEvidenceLines === undefined ? {} : { browserEvidenceLines: context.browserEvidenceLines }) }, proofLines),
    PULL_REQUEST_STATUS_END,
    ...attributionBodyLines(context?.attribution),
    ...(pageUrl === undefined ? [] : [`AgentX task: ${pageUrl}`]),
    "",
    ...(reviewDidNotClear ? ["The required reviews did not finish. Nothing was sent to GitHub. See the task page for review results."]
      : [`Opened as a draft by AgentX after the owner-approved plan${reviewOnly ? " and reviews" : ", checks and reviews"} passed${!reviewOnly && workflow.verification?.results.some((result) => result.madeByRovara === true) === true ? " (" + GENERAL_FAKE_MADE_NOTE + ")" : ""}. Merge it on GitHub.`]),
  ];
  return fitPullRequestBody(lines.join("\n"));
}

/**
 * The pull request description's lines about the current code: which checks passed on it (none for review only), how
 * its reviews went, the review findings the owner accepted, and whether the reviews saw only part of the change. Each
 * line is one line, redacted and made inert for GitHub. Rewritten after a pushed PR feedback fix, so it is always about
 * the code on the pull request.
 */
export function workflowPullRequestStatusLines(workflow: WorkflowSnapshot, context?: PullRequestBodyContext, proofLines: readonly string[] = []): string[] {
  // Rovara Code version 2 rewrites its whole block (what changed, tests, reviews and risk); version 1's lines are as they were.
  if (workflow.definitionVersion === "1.1.0") {
    if (requiredReviewDidNotClear(workflow)) return ["The required reviews did not finish. Nothing was sent to GitHub. See the task page for review results."];
    return rovaraStatusLines(workflow, proofLines.length === 0 ? context ?? {} : { ...context, proofLines }, (listed) => workflowReviewLines(workflow, listed, context?.acceptedBy)).map((line) => hideEmailAddresses(line));
  }
  const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
  const passed = (workflow.verification?.results ?? []).filter((result) => result.status === "PASS")
    // A proposed check's label is model-written: one line, redacted and made inert like a plan line, as every label is.
    .map((result) => `${inertPlanLine(redactText(checks.find((check) => check.id === result.checkId)?.label ?? result.checkId).replace(/\s+/gu, " "))} passed${result.madeByRovara === true ? ` (${GENERAL_FAKE_MADE_NOTE})` : ""}`);
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  // S3: also the path the status block is rewritten by after a pushed fix, so no line reaches GitHub with an email address.
  return [
    ...(reviewOnly ? [] : [`Checks: ${passed.length > 0 ? passed.join(", ") : "none recorded"}`]),
    ...workflowReviewLines(workflow, WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED, context?.acceptedBy),
    ...(context?.secondReviewLines ?? []),
    ...proofLines,
    // TE-H1: the browser evidence lines (text only), under the proof lines, as version 1 lists them.
    ...(context?.browserEvidenceLines ?? []),
    // Approve by exception (DECISIONS 24): version 1 descriptions list the lessons used too (same visibility rule as version 2).
    ...lessonsUsedLines(context?.lessonsUsed, 10),
  ].map((line) => hideEmailAddresses(line));
}

/**
 * The lines about the reviews of the current code: how they went, the findings the owner accepted (at most `listed` of them named) and whether the reviewers saw only part of the change. Each line is one line,
 * redacted and made inert for GitHub.
 */
function workflowReviewLines(workflow: WorkflowSnapshot, listed: number, acceptedBy?: Readonly<Record<string, string>>): string[] {
  // The issues noted are those nobody had to resolve: the findings the owner accepted are listed on their own.
  const noted = (workflow.reviews ?? []).reduce((count, review) => count + review.findings.filter((finding) => !workflowFindingAccepted(workflow, review.role, finding)).length, 0);
  const reviewWord = (role: "CRITIC" | "SECURITY") => {
    const review = (workflow.reviews ?? []).find((entry) => entry.role === role && entry.candidateDigest === workflow.candidate?.digest);
    if (review === undefined || !reviewCleared(review, workflow.acceptedFindings)) return review?.status === "FINDINGS" ? "did not pass" : "could not finish";
    return review.status === "FINDINGS" ? "passed after the owner accepted its findings" : "passed";
  };
  const accepted = (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === workflow.candidate?.digest);
  const partial = workflowReviewsSawPartialDiff(workflow);
  const reviewDidNotClear = requiredReviewDidNotClear(workflow);
  return [
    `Reviews: code review ${reviewWord("CRITIC")}; security review ${reviewWord("SECURITY")}${noted > 0 ? `; ${noted} earlier issue${noted === 1 ? "" : "s"} noted` : ""}`,
    ...(reviewDidNotClear ? ["The required reviews did not finish. Nothing was sent to GitHub. See the task page for review results."] : []),
    ...(accepted.length === 0 ? [] : [
      `Owner accepted ${accepted.length} review finding${accepted.length === 1 ? "" : "s"}:`,
      // Reviewer text and the owner's reason, each on one line, redacted and made inert for GitHub like a plan line.
      ...accepted.slice(0, listed).map((finding) => `- [${finding.role === "SECURITY" ? "security" : "code"}] ${inertPlanLine(redactText(finding.text).replace(/\s+/gu, " "))} \u2014 accepted: ${inertPlanLine(redactText(finding.reason).replace(/\s+/gu, " "))}${acceptedBy?.[finding.fingerprint] === undefined ? "" : ` (by ${inertPlanLine(acceptedBy[finding.fingerprint]!)})`}`),
      ...(accepted.length > listed ? [`- and ${accepted.length - listed} more; see the task page`] : []),
    ]),
    ...(partial ? [PULL_REQUEST_PARTIAL_REVIEW_LINE] : []),
  ];
}

/**
 * A task's title made inert for GitHub: Slack's markup (links, channel and user mentions) is taken out, white space collapsed, and what is left goes through `inertPlanLine`. The title is the requester's words, so
 * nothing in it may mention anyone or link anywhere on GitHub.
 */
export function inertTaskTitle(title: string): string {
  const plain = title
    .replace(/<(?:https?|mailto):[^|>]*\|([^>]*)>/giu, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/gu, "#$1")
    .replace(/<[@#!][^>]*>/gu, "")
    .replace(/\s+/gu, " ");
  return inertPlanLine(plain);
}
