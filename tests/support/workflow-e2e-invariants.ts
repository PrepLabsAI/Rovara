// The journey invariants every workflow E2E test must keep, checked after each test (registerJourneyInvariants) or on
// demand (assertJourneyInvariants). Each failure names its invariant:
//   INV-STATE  every task's workflow parses after a read in DynamoDB's own map order;
//   INV-CLICK  nothing changes code without an owner's click, and only publication and a fix's push get a push token;
//   INV-CODE   the code AgentX pushes is the reviewed code, the reviewed code is the checked code, a fix push is a
//              fast-forward on the same branch, and there is one pull request per branch;
//   INV-VOICE  a stopped or waiting task's thread holds the message for its current state, a failed feedback review has
//              its Retry review card, and no thread message uses jargon or runs past the brief limit;
//   INV-ONCE   one task per thread, one decision per request, one push per approved fix, no message posted twice in a row;
//   INV-DDB    the table refused no request (ValidationException), and no broker log line names one.
import { afterEach, beforeEach } from "vitest";
import { WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/contracts";
import { workflowMessageKey } from "../../packages/broker/src/developer/workflow-messages.js";
import { visibleSlackText } from "./strict-slack.js";

/** Words nothing AgentX shows in Slack may use (the suite's global constraint 5). */
export const JARGON = /\b(candidates?|revisions?|digests?|operations?|artifacts?|workflows?|SUCCEEDED|FAILED|INTERRUPTED|invalid json)\b/i;

/** One worker run, as the harness saw it start. */
export interface JourneyLedgerEntry {
  operationId: string;
  kind: string;
  mode?: string;
  /** The task owner's workflow decisions (gate, send back, findings) the task held when the run started. */
  ownerDecisions: number;
  /** The owner's approvals of PR feedback fixes the task held when the run started. */
  feedbackApprovals: number;
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
  github: {
    tokens: ReadonlyMap<string, "clone" | "push">;
    minted: ReadonlyArray<{ token: string; access: "clone" | "push"; during: string | undefined }>;
    pushLog: ReadonlyArray<{ branch: string; commit: string; tree: string; parents: readonly string[]; token: string; during: string | undefined }>;
    pullRequests: ReadonlyArray<{ number: number; headBranch: string }>;
  };
  slack: { posts: readonly SlackMessage[]; updates: readonly SlackMessage[] };
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

function checkClick(journey: JourneyView): string[] {
  const violations: string[] = [];
  let previous: JourneyLedgerEntry | undefined;
  let previousMaintain: JourneyLedgerEntry | undefined;
  for (const entry of journey.ledger) {
    if (entry.kind === "task" && entry.mode === "IMPLEMENT") {
      const clicks = entry.ownerDecisions + entry.feedbackApprovals;
      const before = previous === undefined ? 0 : previous.ownerDecisions + previous.feedbackApprovals;
      if (clicks <= before) violations.push(`INV-CLICK: coding run ${entry.operationId} started with no owner decision since the previous coding run`);
      previous = entry;
    }
    if (entry.kind === "maintain") {
      if (entry.feedbackApprovals <= (previousMaintain?.feedbackApprovals ?? 0)) violations.push(`INV-CLICK: fix push ${entry.operationId} started with no owner approval of a fix since the previous push`);
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

function checkCode(journey: JourneyView): string[] {
  const violations: string[] = [];
  const agentx = journey.github.pushLog.filter((push) => journey.github.tokens.has(push.token));
  const checked = new Set(journey.checkRuns.map((run) => run.tree));
  for (const push of agentx) {
    if (!journey.reviewedTrees.includes(push.tree)) violations.push(`INV-CODE: AgentX pushed tree ${push.tree} to ${push.branch}, which no review run was given`);
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
  return violations;
}

function threadMessages(journey: JourneyView, threadTs: string): SlackMessage[] {
  return [...journey.slack.posts, ...journey.slack.updates].filter((message) => message.threadTs === threadTs || message.ts === threadTs);
}

function hasAction(message: SlackMessage, actionId: string): boolean {
  return JSON.stringify(message.blocks ?? []).includes(`"action_id":"${actionId}"`);
}

function checkVoice(journey: JourneyView): string[] {
  const violations: string[] = [];
  for (const task of tasks(journey)) {
    const share = task.share as { threadTs?: string } | undefined;
    if (share?.threadTs === undefined || task.closedAt !== undefined) continue;
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    const taskId = String(task.taskId);
    // A workflow that does not parse is INV-STATE's; its feedback review is still read as stored.
    const workflow = parsed.success ? parsed.data : undefined;
    if (workflow !== undefined && (workflow.state === "BLOCKED" || workflow.state === "WAITING")) {
      const key = workflowMessageKey(workflow);
      const said = journey.db.get(`DEVTASK#${taskId}`, `NOTICE#${taskId}:said:${key}`);
      if (said?.deliveredAt === undefined) violations.push(`INV-VOICE: task ${taskId} is ${workflow.stage}/${workflow.state}, and its thread has no message for that (${key})`);
    }
    const review = (task.workflow as Partial<WorkflowSnapshot> | undefined)?.feedbackReview;
    if (review?.status === "PENDING" && review.reviewRef !== undefined) {
      const messages = threadMessages(journey, share.threadTs);
      if (review.reviewRef.status === "FAILED" && !messages.some((message) => hasAction(message, "agentx_feedback_review_retry"))) {
        violations.push(`INV-VOICE: task ${taskId}'s feedback review failed and its thread has no Retry review card`);
      }
      if (review.reviewRef.status === "COMPLETE" && !messages.some((message) => message.text.includes(`/review/${taskId}`))) {
        violations.push(`INV-VOICE: task ${taskId}'s feedback review is ready and its thread does not link it`);
      }
    }
  }
  for (const message of [...journey.slack.posts, ...journey.slack.updates]) {
    const visible = visibleSlackText(message.text);
    const jargon = JARGON.exec(visible);
    if (jargon !== null) violations.push(`INV-VOICE: a thread message uses "${jargon[0]}": ${visible.slice(0, 120)}`);
    if (journey.briefLimit !== undefined && visible.length > journey.briefLimit) violations.push(`INV-VOICE: a thread message runs to ${visible.length} characters, past the brief limit of ${journey.briefLimit}`);
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
    const fixPushes = journey.github.pushLog.filter((push) => push.during === "maintain" && journey.github.tokens.has(push.token)).length;
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
