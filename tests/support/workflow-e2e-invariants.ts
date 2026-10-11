// The journey invariants every workflow E2E test must keep, checked after each test (registerJourneyInvariants) or on
// demand (assertJourneyInvariants). Each failure names its invariant:
//   INV-STATE  every task's workflow parses after a read in DynamoDB's own map order;
//   INV-CLICK  nothing changes code without an owner's click that authorises code (the coding plan's approval, a send
//              back, a finding to fix, an approved PR feedback fix, or Retry coding), and only publication and a fix's
//              push get a push token;
//   INV-CODE   each push AgentX makes carries the task's current code at that moment, whose checks and both reviews
//              passed on exactly that code; a fix push is a fast-forward on the same branch; one pull request per task
//              and repository, and per branch;
//   INV-VOICE  a stopped or waiting task's newest workflow message in its thread is the message for its current state (as
//              the notifier words it), a failed feedback review has its Retry review card, and no thread message (text or
//              blocks) uses jargon or runs past the brief limit;
//   INV-ONCE   one task per thread, one decision per request, one push per approved fix, no message posted twice in a row;
//   INV-DDB    the table refused no request (ValidationException), and no broker log line names one.
import { afterEach, beforeEach } from "vitest";
import { WorkflowSnapshotSchema, openReviewFindings, type WorkflowSnapshot } from "@agentx/contracts";
import { FEEDBACK_REVIEW_RETRY_ACTION, workflowDocumentName, workflowDocumentType, workflowMessage, type WorkflowMessage, type WorkflowMessageContext } from "../../packages/broker/src/developer/workflow-messages.js";
import { briefLength, visibleSlackText } from "./strict-slack.js";

/**
 * Words nothing AgentX shows in Slack may use (the suite's global constraint 5). Internal nouns in any case; status words
 * only as the shouted constants they are ("failed" in a plain sentence is fine, "FAILED" is a status leaking through).
 */
export const JARGON = /\b(?:[Cc]andidates?|[Rr]evisions?|[Dd]igests?|[Oo]perations?|[Aa]rtifacts?|[Ww]orkflows?|[Ii]nvalid [Jj][Ss][Oo][Nn]|SUCCEEDED|FAILED|INTERRUPTED)\b/;

/** What the task had decided when a run started (its workflow at that moment). */
export type JourneyDecided = Pick<Partial<WorkflowSnapshot>, "decisions" | "feedbackDecisions" | "artifacts">;

/** One worker run, as the harness saw it start. */
export interface JourneyLedgerEntry {
  operationId: string;
  kind: string;
  mode?: string;
  /** The owning task's decisions (read through the workspace's task pointer) when the run started. */
  decided: JourneyDecided;
  /** A coding run the task owner asked for again with Retry coding (the broker's record of that press). */
  ownerRetry?: boolean;
}

/** A push AgentX made, with the task's workflow at the moment of the push. */
export interface JourneyPush {
  commit: string;
  workflow: WorkflowSnapshot | undefined;
}

type Item = Record<string, unknown>;
type SlackMessage = { channel: string; ts: string; threadTs?: string | undefined; text: string; blocks?: unknown[] | undefined };

/** What the checker reads of a journey: a WorkflowE2E has all of it, and a self-test can build it by hand. */
export interface JourneyView {
  db: { find(predicate: (item: Item) => boolean): Item[]; get(pk: string, sk: string): Item | undefined; reorder<T>(value: T): T; refusals: ReadonlyArray<{ command: string; message: string }> };
  invocations: ReadonlyArray<{ kind: string; operationId: string; payload: object }>;
  ledger: readonly JourneyLedgerEntry[];
  reviewedTrees: readonly string[];
  checkRuns: ReadonlyArray<{ tree: string }>;
  credentialAttempts: ReadonlyArray<{ during: string; status: number }>;
  /** Every push AgentX made (publish or a fix), with the task's workflow at that moment. */
  pushedWorkflows: readonly JourneyPush[];
  github: {
    tokens: ReadonlyMap<string, "clone" | "push">;
    minted: ReadonlyArray<{ token: string; access: "clone" | "push"; during: string | undefined }>;
    pushLog: ReadonlyArray<{ branch: string; commit: string; tree: string; parents: readonly string[]; token: string; during: string | undefined }>;
    /** GitHub's pull requests (one repository), with their state on GitHub. */
    pullRequests: ReadonlyArray<{ number: number; headBranch: string; state?: string }>;
  };
  slack: {
    posts: readonly SlackMessage[];
    updates: readonly SlackMessage[];
    /** Every post and edit in the order Slack received them. */
    timeline: ReadonlyArray<SlackMessage & { method: string }>;
  };
  /** The review pages' base (the notifier's `reviewUrlBase`), for the links a message carries. */
  reviewUrlBase?: string | undefined;
  /** The thread brief limit in force, if any. */
  briefLimit?: number | undefined;
}

export class JourneyInvariantError extends Error {
  constructor(readonly violations: string[]) {
    super(`journey invariants broken:\n${violations.map((violation) => `  ${violation}`).join("\n")}`);
    this.name = "JourneyInvariantError";
  }
}

/** Throws a JourneyInvariantError naming every broken invariant; `logs` are the broker's log lines, when captured. */
export function assertJourneyInvariants(journey: JourneyView, options: { logs?: readonly string[] } = {}): void {
  const violations = [...checkState(journey), ...checkClick(journey), ...checkCode(journey), ...checkVoice(journey), ...checkOnce(journey), ...checkDdb(journey, options.logs ?? [])];
  if (violations.length > 0) throw new JourneyInvariantError(violations);
}

function tasks(journey: JourneyView): Item[] {
  return journey.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("DEVTASK#") && item.sk === "META");
}

function checkState(journey: JourneyView): string[] {
  return tasks(journey).flatMap((task) => {
    if (task.workflow === undefined) return [];
    const parsed = WorkflowSnapshotSchema.safeParse(journey.db.reorder(structuredClone(task.workflow)));
    return parsed.success ? [] : [`INV-STATE: task ${String(task.taskId)}'s workflow does not parse when read back in DynamoDB's map order: ${parsed.error.issues[0]?.message ?? "invalid"}`];
  });
}

/**
 * The owner's decisions that authorise a code change: approving the coding plan (not requirements or design, and not a
 * request for changes), sending work back to coding, a finding sent back to fix, and an approved PR feedback fix.
 */
export function codeAuthorisations(decided: JourneyDecided): number {
  const plans = new Set((decided.artifacts ?? []).filter((artifact) => artifact.type === "plan").map((artifact) => artifact.sha256));
  const gate = (decided.decisions ?? []).filter((decision) => decision.actorRole === "TASK_OWNER" && (
    (decision.decision === "APPROVE" && (decision.source ?? "GATE") === "GATE" && decision.artifactDigest !== undefined && plans.has(decision.artifactDigest))
    || decision.source === "SEND_BACK"
    || (decision.source === "FINDINGS" && decision.decision === "REQUEST_CHANGES"))).length;
  const feedback = (decided.feedbackDecisions ?? []).filter((decision) => decision.actorRole === "TASK_OWNER" && decision.decision === "APPROVE").length;
  return gate + feedback;
}

function feedbackApprovals(decided: JourneyDecided): number {
  return (decided.feedbackDecisions ?? []).filter((decision) => decision.actorRole === "TASK_OWNER" && decision.decision === "APPROVE").length;
}

function checkClick(journey: JourneyView): string[] {
  const violations: string[] = [];
  let previous: JourneyLedgerEntry | undefined;
  let previousMaintain: JourneyLedgerEntry | undefined;
  for (const entry of journey.ledger) {
    if (entry.kind === "task" && entry.mode === "IMPLEMENT") {
      const before = previous === undefined ? 0 : codeAuthorisations(previous.decided);
      // A retry of coding that stopped re-runs the approved plan at the owner's own press.
      if (codeAuthorisations(entry.decided) <= before && entry.ownerRetry !== true) {
        violations.push(`INV-CLICK: coding run ${entry.operationId} started with no owner decision that authorises code since the previous coding run`);
      }
      previous = entry;
    }
    if (entry.kind === "maintain") {
      if (feedbackApprovals(entry.decided) <= (previousMaintain === undefined ? 0 : feedbackApprovals(previousMaintain.decided))) {
        violations.push(`INV-CLICK: fix push ${entry.operationId} started with no owner approval of a fix since the previous push`);
      }
      previousMaintain = entry;
    }
  }
  for (const minted of journey.github.minted) {
    if (minted.access === "push" && minted.during !== "publish" && minted.during !== "maintain") {
      violations.push(`INV-CLICK: a push token was minted during ${String(minted.during)}, not a publication or a fix push`);
    }
  }
  for (const invocation of journey.invocations) {
    if (invocation.kind === "task" && "repositoryGrant" in invocation.payload) violations.push(`INV-CLICK: task run ${invocation.operationId} was given a repository grant`);
  }
  for (const attempt of journey.credentialAttempts) {
    if (attempt.during === "task" && attempt.status >= 200 && attempt.status < 300) violations.push(`INV-CLICK: a task run got a repository credential (HTTP ${attempt.status})`);
  }
  return violations;
}

/** Why AgentX's push of `push` was not of the task's current, checked and reviewed code; undefined when it was. */
function pushedCodeProblem(push: { branch: string; commit: string; tree: string }, workflow: WorkflowSnapshot | undefined): string | undefined {
  const at = `AgentX pushed ${push.commit} (tree ${push.tree}) to ${push.branch}`;
  if (workflow === undefined) return `${at} for no task`;
  const candidate = workflow.candidate;
  if (candidate === undefined) return `${at} while the task had no current code`;
  if (!candidate.repositories.some((repository) => repository.treeSha === push.tree)) return `${at}, which is not the task's current code (${candidate.repositories.map((repository) => repository.treeSha).join(", ")})`;
  const verification = workflow.verification;
  if (verification?.candidateDigest !== candidate.digest) return `${at}, but the checks were not recorded on that code`;
  const reviewOnly = verification.reviewOnly === true;
  if (!reviewOnly && !verification.results.every((result) => result.status === "PASS")) return `${at}, but not every check passed on it`;
  for (const role of ["CRITIC", "SECURITY"] as const) {
    const reviews = (workflow.reviews ?? []).filter((review) => review.role === role && review.candidateDigest === candidate.digest);
    if (reviews.length === 0) return `${at}, but no ${role === "CRITIC" ? "code" : "security"} review was bound to that code`;
    if (reviews.some((review) => review.status !== "PASS" && review.status !== "FINDINGS")) return `${at}, but its ${role === "CRITIC" ? "code" : "security"} review did not finish`;
  }
  if (openReviewFindings(workflow).length > 0) return `${at}, but review findings on it were still open`;
  return undefined;
}

function checkCode(journey: JourneyView): string[] {
  const violations: string[] = [];
  const agentx = journey.github.pushLog.filter((push) => journey.github.tokens.has(push.token));
  const checked = new Set(journey.checkRuns.map((run) => run.tree));
  for (const push of agentx) {
    const pushed = journey.pushedWorkflows.find((entry) => entry.commit === push.commit);
    const problem = pushedCodeProblem(push, pushed?.workflow);
    if (problem !== undefined) violations.push(`INV-CODE: ${problem}`);
  }
  if (checked.size > 0) {
    for (const tree of journey.reviewedTrees) {
      if (!checked.has(tree)) violations.push(`INV-CODE: a review run was given tree ${tree}, on which no check ran`);
    }
  }
  const heads = new Map<string, string>();
  for (const push of journey.github.pushLog) {
    const previous = heads.get(push.branch);
    if (push.during === "maintain" && journey.github.tokens.has(push.token)) {
      if (previous === undefined) violations.push(`INV-CODE: a fix was pushed to ${push.branch}, a branch with no pull request head`);
      else if (push.parents.length !== 1 || push.parents[0] !== previous) violations.push(`INV-CODE: the fix push ${push.commit} to ${push.branch} is not a fast-forward of ${previous}`);
      if (!journey.github.pullRequests.some((pullRequest) => pullRequest.headBranch === push.branch)) violations.push(`INV-CODE: a fix was pushed to ${push.branch}, which has no pull request`);
    }
    heads.set(push.branch, push.commit);
  }
  const branches = journey.github.pullRequests.map((pullRequest) => pullRequest.headBranch);
  for (const branch of new Set(branches)) {
    if (branches.filter((entry) => entry === branch).length > 1) violations.push(`INV-CODE: branch ${branch} has more than one pull request`);
  }
  // GitHub's own pull requests, each with the task whose push opened its branch: one open or merged per task (a pull
  // request the product closed again, such as one that turned out not to hold the checked code, is allowed).
  const branchTasks = new Map<string, Set<string>>();
  for (const push of agentx) {
    const taskId = journey.pushedWorkflows.find((entry) => entry.commit === push.commit)?.workflow?.taskId;
    if (taskId !== undefined) branchTasks.set(push.branch, new Set([...(branchTasks.get(push.branch) ?? []), taskId]));
  }
  const live = journey.github.pullRequests.filter((pullRequest) => pullRequest.state !== "closed");
  for (const taskId of new Set([...branchTasks.values()].flatMap((ids) => [...ids]))) {
    const numbers = live.filter((pullRequest) => branchTasks.get(pullRequest.headBranch)?.has(taskId) === true).map((pullRequest) => pullRequest.number);
    if (numbers.length > 1) violations.push(`INV-CODE: task ${taskId} has ${numbers.length} pull requests on GitHub (${numbers.map((number) => `#${number}`).join(", ")})`);
  }
  for (const task of tasks(journey)) {
    const recorded = ((task.workflow as Partial<WorkflowSnapshot> | undefined)?.pullRequests ?? []);
    for (const repositoryId of new Set(recorded.map((pullRequest) => pullRequest.repositoryId))) {
      const numbers = new Set(recorded.filter((pullRequest) => pullRequest.repositoryId === repositoryId).map((pullRequest) => pullRequest.number));
      if (numbers.size > 1) violations.push(`INV-CODE: task ${String(task.taskId)} has ${numbers.size} pull requests in ${repositoryId}`);
    }
  }
  return violations;
}

/** Every visible string of a message: its text and the text of its blocks (sections, buttons, context). */
export function visibleStrings(message: { text: string; blocks?: unknown[] | undefined }): string[] {
  const strings = [visibleSlackText(message.text)];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "text" && typeof entry === "string") strings.push(visibleSlackText(entry));
      else if (key !== "value" && key !== "url" && key !== "action_id" && key !== "block_id") collect(entry);
    }
  };
  collect(message.blocks ?? []);
  return strings;
}

/** The buttons of a message's actions blocks. */
function buttons(message: { blocks?: unknown[] | undefined }): Array<{ action_id?: string; value?: string; text?: { text?: string } }> {
  return (message.blocks ?? []).flatMap((block) => ((block as { type?: string }).type === "actions" ? (block as { elements?: Array<{ action_id?: string; value?: string; text?: { text?: string } }> }).elements ?? [] : []));
}

const sameMessage = (left: { text: string; blocks?: unknown[] | undefined }, right: WorkflowMessage) => left.text === right.text && JSON.stringify(left.blocks ?? []) === JSON.stringify(right.blocks);
const PUBLISH_FAILURE_CATEGORIES = ["publication_failed", "interrupted", "worker_unavailable", "timed_out", "unknown"];

/**
 * Whether `message` is the thread post the notifier makes for the task's current state: workflowMessage for that state,
 * with the context the notifier gives it (the task page's links, the replies not yet given to a step). An approval card
 * links its document in a way only the notifier reads (a summary from storage), so a card must carry this document's
 * header and exactly the decision buttons for this revision and document.
 */
function isCurrentMessage(journey: JourneyView, task: Item, workflow: WorkflowSnapshot, message: SlackMessage): boolean {
  const taskId = String(task.taskId);
  const page = journey.reviewUrlBase === undefined ? undefined : `${journey.reviewUrlBase}/review/${taskId}/task`;
  const since = typeof task.threadNotesFedThrough === "string" ? task.threadNotesFedThrough : "";
  const newReplies = journey.db.find((item) => item.pk === `DEVTASK#${taskId}` && typeof item.sk === "string" && item.sk.startsWith("NOTE#")
    && typeof item.receivedAt === "string" && item.receivedAt > since && item.answeredAt === undefined).length;
  const context: WorkflowMessageContext = { taskId, ownerSlackUserId: typeof task.slackUserId === "string" ? task.slackUserId : undefined, workflow,
    ...(page === undefined ? {} : { findingsUrl: `${page}#findings`, taskPageUrl: page }), newReplies };
  if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
    const document = workflow.artifacts.filter((artifact) => artifact.type === workflowDocumentType(workflow)).at(-1);
    const name = workflowDocumentName(workflow);
    const header = `*${name.charAt(0).toUpperCase()}${name.slice(1)}${document === undefined ? "" : ` v${document.version}`} is ready for your approval.*`;
    const expected = workflowMessage({ ...context, structured: { claims: [], claimCount: 0, decisionCount: 0, tiny: false }, documentLink: { url: page ?? "https://agentx.invalid" } });
    const decisions = (value: { blocks?: unknown[] | undefined }) => JSON.stringify(buttons(value).filter((button) => button.action_id !== "agentx_open_review"));
    return expected !== undefined && message.text.startsWith(header) && decisions(message) === decisions(expected);
  }
  const variants: WorkflowMessageContext[] = [context];
  if (workflow.stage === "PULL_REQUEST") {
    for (const category of PUBLISH_FAILURE_CATEGORIES) for (const codeChanged of [false, true]) variants.push({ ...context, newReplies: 0, publishFailure: { category, codeChanged } });
  }
  // The merge step is said once per pull request state (workflowMessageKey), so its buttons keep the revision it was said at.
  const merge = workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING";
  // A closed pull request reopened: its step says so once (D3).
  if (merge) variants.push({ ...context, pullRequestReopened: (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN").map((pullRequest) => pullRequest.number) });
  const unrevised = (blocks: unknown[] | undefined) => JSON.stringify(blocks ?? []).replace(/\\"revision\\":\d+/g, "\\\"revision\\\":0");
  return variants.some((variant) => {
    const expected = workflowMessage(variant);
    if (expected === undefined) return false;
    return merge ? message.text === expected.text && unrevised(message.blocks) === unrevised(expected.blocks) : sameMessage(message, expected);
  });
}

/** A PR feedback review's own post (its ready link or its Retry review card), which follows the merge step's message. */
function isFeedbackReviewPost(message: SlackMessage, taskId: string): boolean {
  return buttons(message).some((button) => button.action_id?.startsWith("agentx_feedback") === true || button.action_id?.startsWith("agentx_workflow_feedback") === true)
    || new RegExp(`/review/${taskId}(?:[|>#?]|/api)`).test(message.text);
}

/** The PR feedback loop's own words while the task waits for its merge: a review starting or failing, its result, or an answer to it. */
function isFeedbackLoopPost(message: SlackMessage, taskId: string): boolean {
  const text = visibleSlackText(message.text);
  return isFeedbackReviewPost(message, taskId) || text.startsWith("Reviewing the feedback on ") || text.startsWith("I couldn't review the feedback on ")
    || text === "PR feedback dismissed. The pull request stays as it is." || text === "Got it. I saved your note for the next round of PR feedback; the pull request stays as it is.";
}

function checkVoice(journey: JourneyView): string[] {
  const violations: string[] = [];
  for (const task of tasks(journey)) {
    const share = task.share as { threadTs?: string; channelId?: string } | undefined;
    if (share?.threadTs === undefined || task.closedAt !== undefined) continue;
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    const taskId = String(task.taskId);
    const thread: Array<SlackMessage & { method: string }> = journey.slack.timeline.filter((message) => message.threadTs === share.threadTs || message.ts === share.threadTs);
    // A workflow that does not parse is INV-STATE's; its feedback review is still read as stored.
    const workflow = parsed.success ? parsed.data : undefined;
    if (workflow !== undefined && (workflow.state === "BLOCKED" || workflow.state === "WAITING") && workflowMessage({ taskId, workflow, newReplies: 0 }) !== undefined) {
      // A message as the thread shows it now: each post at its latest edit.
      const latest = (message: SlackMessage) => [...thread].reverse().find((entry) => entry.ts === message.ts) ?? message;
      const posts = thread.filter((message) => message.method === "chat.postMessage" && (message.blocks ?? []).length > 0);
      let ok: boolean;
      if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING") {
        // The merge step is said once per pull request state; the PR feedback loop then speaks in the same thread (a
        // review starting, its result, an answer to it). Its message must have been said, and only that loop since.
        const said = posts.map((message, index) => ({ message, index })).filter(({ message }) => isCurrentMessage(journey, task, workflow, message) || isCurrentMessage(journey, task, workflow, latest(message))).at(-1);
        ok = said !== undefined && posts.slice(said.index + 1).every((message) => isFeedbackLoopPost(message, taskId));
      } else {
        const newest = [...posts].reverse().find((message) => !isFeedbackReviewPost(message, taskId));
        ok = newest !== undefined && (isCurrentMessage(journey, task, workflow, newest) || isCurrentMessage(journey, task, workflow, latest(newest)));
      }
      if (!ok) {
        const expected = workflowMessage({ taskId, workflow, newReplies: 0 });
        const newest = posts.at(-1);
        violations.push(`INV-VOICE: task ${taskId} is ${workflow.stage}/${workflow.state} (revision ${workflow.revision}), and the newest workflow message in its thread is not the message for that: ${newest === undefined ? "none" : visibleSlackText(newest.text).slice(0, 120)} (expected: ${visibleSlackText(expected?.text ?? "").slice(0, 120)})`
          + (process.env.E2E_DEBUG_VOICE === undefined ? "" : `\n${posts.map((message) => `   [${message.method}] ${visibleSlackText(message.text).slice(0, 100)}`).join("\n")}`));
      }
    }
    const review = (task.workflow as Partial<WorkflowSnapshot> | undefined)?.feedbackReview;
    if (review?.status === "PENDING" && review.reviewRef !== undefined) {
      if (review.reviewRef.status === "FAILED" && !thread.some((message) => buttons(message).some((button) => button.action_id === FEEDBACK_REVIEW_RETRY_ACTION && button.text?.text === "Retry review"))) {
        violations.push(`INV-VOICE: task ${taskId}'s feedback review failed and its thread has no Retry review card`);
      }
      if (review.reviewRef.status === "COMPLETE" && !thread.some((message) => visibleStrings(message).some((text) => text.includes(`/review/${taskId}`)) || message.text.includes(`/review/${taskId}`))) {
        violations.push(`INV-VOICE: task ${taskId}'s feedback review is ready and its thread does not link it`);
      }
    }
  }
  for (const message of [...journey.slack.posts, ...journey.slack.updates]) {
    for (const visible of visibleStrings(message)) {
      const jargon = JARGON.exec(visible);
      if (jargon !== null) violations.push(`INV-VOICE: a thread message uses "${jargon[0]}": ${visible.slice(0, 120)}`);
    }
  }
  for (const message of journey.slack.timeline) {
    const length = briefLength(message);
    if (journey.briefLimit !== undefined && message.threadTs !== undefined && length > journey.briefLimit) violations.push(`INV-VOICE: a thread message runs to ${length} characters, past the brief limit of ${journey.briefLimit}`);
  }
  return violations;
}

function checkOnce(journey: JourneyView): string[] {
  const violations: string[] = [];
  const threads = tasks(journey).map((task) => (task.share as { threadTs?: string } | undefined)?.threadTs).filter((threadTs): threadTs is string => threadTs !== undefined);
  for (const threadTs of new Set(threads)) {
    if (threads.filter((entry) => entry === threadTs).length > 1) violations.push(`INV-ONCE: thread ${threadTs} started more than one task`);
  }
  for (const task of tasks(journey)) {
    const workflow = task.workflow as Partial<WorkflowSnapshot> | undefined;
    for (const [name, decisions] of [["decision", workflow?.decisions ?? []], ["feedback decision", workflow?.feedbackDecisions ?? []]] as const) {
      const ids = decisions.map((decision) => decision.requestId);
      for (const id of new Set(ids)) if (ids.filter((entry) => entry === id).length > 1) violations.push(`INV-ONCE: one request recorded more than one ${name} (${id})`);
    }
    const approvals = (workflow?.feedbackDecisions ?? []).filter((decision) => decision.decision === "APPROVE").length;
    // This task's fix pushes: AgentX's pushes made while the task's own fix was pushed.
    const fixPushes = journey.github.pushLog.filter((push) => push.during === "maintain" && journey.github.tokens.has(push.token)
      && journey.pushedWorkflows.find((entry) => entry.commit === push.commit)?.workflow?.taskId === task.taskId).length;
    if (fixPushes > approvals) violations.push(`INV-ONCE: ${fixPushes} fix pushes for ${approvals} approved fixes`);
  }
  const byThread = new Map<string, SlackMessage[]>();
  for (const post of journey.slack.posts) {
    const thread = post.threadTs ?? post.ts;
    byThread.set(thread, [...(byThread.get(thread) ?? []), post]);
  }
  for (const posts of byThread.values()) {
    for (let index = 1; index < posts.length; index += 1) {
      const [before, after] = [posts[index - 1]!, posts[index]!];
      if (before.text === after.text && JSON.stringify(before.blocks ?? []) === JSON.stringify(after.blocks ?? [])) {
        violations.push(`INV-ONCE: the same message was posted twice in a row: ${visibleSlackText(after.text).slice(0, 120)}`);
      }
    }
  }
  return violations;
}

function checkDdb(journey: JourneyView, logs: readonly string[]): string[] {
  return [
    ...journey.db.refusals.map((refusal) => `INV-DDB: DynamoDB refused a ${refusal.command}: ${refusal.message}`),
    ...logs.filter((line) => line.includes("ValidationException")).map((line) => `INV-DDB: a broker log line names a ValidationException: ${line.slice(0, 200)}`),
  ];
}

/** Every journey created since the current test started (createWorkflowE2E registers itself). */
const journeys = new Set<JourneyView & { deliverNotices?: () => Promise<void> }>();

/** Called by createWorkflowE2E. */
export function trackJourney(journey: JourneyView & { deliverNotices?: () => Promise<void> }): void {
  journeys.add(journey);
}

/**
 * Checks every journey a test creates once the test ends: queued notices are delivered first (no worker runs), then
 * assertJourneyInvariants. Call once at the top of a describe (or file); `logs` reads the broker's captured log lines.
 */
export function registerJourneyInvariants(options: { logs?: () => readonly string[] } = {}): void {
  beforeEach(() => { journeys.clear(); });
  afterEach(async () => {
    const created = [...journeys];
    journeys.clear();
    // Judged whether the test passed or not: a broken invariant is worth reading next to the test's own failure.
    for (const journey of created) {
      await journey.deliverNotices?.();
      assertJourneyInvariants(journey, { logs: options.logs?.() ?? [] });
    }
  });
}
