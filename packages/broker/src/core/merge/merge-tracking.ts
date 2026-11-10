// Rovara Code (Plan 6 Task 14): following a task's pull requests from GitHub's own answers.
//
// What GitHub says about a pull request (its checks, reviews, draft state, head and branch) is read through the App by `trackPullRequest` and kept as one tracking item
// per pull request (`DEVTASK#<taskId>` / `MERGE_TRACKING#<repositoryId>#<number>`), with its own version. A webhook is only a nudge: it wakes the task's tracking row
// (workflow-merge-recovery.ts), and the pass that follows decides from its own read, never from the webhook's body. The item is written only when what a decision depends
// on changes (`decisionDigest`), so a pass that saw nothing new writes nothing, and the workflow snapshot changes only when a decision changes the workflow.
//
// Merge tracking never presses merge: a person always does (owner decision 1). It marks a draft ready and asks for reviewers; fixes and syncs are other tasks' deciders.
import { createHash } from "node:crypto";
import { providerOf } from "../../plugins/routing.js";
import {
  TRACKING_REQUESTS_BASE,
  TRACKING_REQUESTS_PER_EXTRA_PR,
  agentXError,
  codeMilestoneKey,
  mergeTrackingDecisionDigest,
  sessionEventId,
  sessionLink,
  DocumentStoreError,
  change,
  when,
  type AgentXError,
  type Autonomy,
  type ChangeRequestStatus,
  type HostAccountKind,
  type CodeSettings,
  type DocumentStore,
  type HostScope,
  type MergeTrackingItem,
  type OrgId,
  type TransactItem,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import {
  MERGE_ACTION_ORDER, type FailingCheck, type MergeActionContext, type MergeActionDecider, type MergeActionRequest, type MergeActionSlot, type MergeDispatchKind, type RegisterMergeActionDecider,
} from "../branch-sync/merge-action.js";
import { noteBranchHead } from "../branch-sync/branch-writers.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import { SWEEP_INTERVAL_MS, type MergeReadBudget, type MergeRecoveryResult } from "./budget.js";
import { humanApprovalOf, latestReviewers, linkedAmong, nonWritersAmong, requesterHostIds, type RepositoryPermission } from "./approval.js";
import { approvalReviewsOf, changeRequestRef, rateLimitRetryAt, type RepositoryResolver } from "./host-port.js";
import { requireRepositoryKey } from "./repository-key.js";
import type { CodeMilestones, CodeSettingsReader, LinkedChangeRequestFinder, MergePassHooks, MergeTask, SessionTimeline } from "./seams.js";
import type { MergePeople } from "./people.js";
import { prHeadItems, publicTrackingItem, readMergeTracking, readTrackingItem, recoveryRowKey, trackingItemOf, trackingWriteItem, workflowUpdateItem } from "./store.js";

/** The default row for a decider's dispatch: the task-flow core's row. Its runner knows UNDERSTAND and PLAN today; IMPLEMENT and SYNC rows are written as the decider asked and wait for the runner that learns them. */
function defaultDispatchRow(request: { companyId: OrgId; taskId: string; kind: MergeDispatchKind; workflowRevision: number; at: string }, now: string): TransactItem {
  return dispatchRowItem({ companyId: request.companyId }, request.taskId, request.workflowRevision, request.kind, now, request.at);
}

export { MERGE_ACTION_ORDER };
export { publicTrackingItem, readMergeTracking, trackingItemOf, trackingWriteItem };

/** The definition version whose tasks are tracked (Rovara Code version 2). Version 1 tasks keep their kind-less merge-recovery rows and today's behaviour. */
export const TRACKED_DEFINITION_VERSION = "1.1.0";
/** How long after Rovara's push "no checks yet" may be read as "no CI": a full sweep interval. */
export const NO_CI_GRACE_MS = SWEEP_INTERVAL_MS;
/** How many reviewers' permissions one pass looks up; more than this and the approval is not trusted. */
export const PERMISSION_LOOKUPS_MAX = 8;
/** The message Rovara sends once when someone else pushed to a pull request (exact text), and the one that withdraws it. */
export const SOMEONE_ELSE_PUSHED_MESSAGE = "Someone else pushed to this pull request, so I'll stop changing it. I'll keep watching for reviews and the merge.";
export const PUSH_WAS_MINE_MESSAGE = "That push was mine after all. I'll carry on.";

/** A person's standing on a repository, read live: the permission, and the account kind the host names (`person`, `bot`, `other`), when it names one. */
export interface RepositoryStanding {
  permission: "admin" | "write" | "read" | "none";
  accountType?: HostAccountKind | undefined;
}

/** The part of the task record tracking reads (see seams.ts). */
export type TrackedTask = MergeTask;

export interface MergeTrackingDependencies {
  store: DocumentStore;
  now: () => number;
  /** Settings of the project (self-approval, merge method, reviewers). */
  settings: CodeSettingsReader;
  /** The milestone hook and the session timeline (the notification and sessions lanes). */
  milestones: CodeMilestones;
  timeline: SessionTimeline;
  /** Who a person is on the code host (see people.ts). */
  people: MergePeople;
  /** The reverse link from a change request to its task. */
  links: LinkedChangeRequestFinder;
  /** The token scope of the task's org (`githubScope`): an org's own scope on a cloud install, which checks the installation is bound to the org on every mint. */
  scope(orgId: OrgId): HostScope;
  /** The task, read fresh. */
  loadTask(taskId: string): Promise<TrackedTask | undefined>;
  /** The repository's URL as the task's project pins it. */
  repositoryUrl(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<string | undefined>;
  /**
   * The repository as the task's project pins it, with the code host its record names (task P7; an unknown kind is refused) and the runner that reads its builds. Everything a pass reads or does
   * at the host goes through this host's port.
   */
  repository: RepositoryResolver;
  /** The head Rovara last pushed to the pull request, from the pull request's record. */
  recordedHead?(workspaceId: string, repositoryId: string, number: number): Promise<string | undefined>;
  /** The org's autonomy for Rovara Code, for the deciders; `prepare` when not given. */
  autonomy?(task: TrackedTask): Promise<Autonomy> | Autonomy;
  /**
   * The autonomy and the digest of the frozen recipe that gave it, read together (one read, so the two cannot disagree): an automatic feedback decision is bound to both (Plan 6 Task 16).
   * Preferred over `autonomy` where given.
   */
  autonomyBinding?(task: TrackedTask): Promise<{ autonomy: Autonomy; recipeDigest?: string | undefined }>;
  /**
   * Whether the waiting feedback round can be fixed on its own: its stored report and comments are read and found sound, every fix is one to make, and the checks it changes are acceptable (Plan 6
   * Task 16). Without it nothing is decided on Rovara's own.
   */
  feedbackRoundCheck?(task: TrackedTask & { workflow: WorkflowSnapshot; orgId: OrgId }): Promise<boolean>;
  /** Sends the replies a landed push of an automatic comment fix left to send (Plan 6 Task 16): best effort, at the end of a pass; a failure is logged and tried again by the next. */
  sendFeedbackReplies?(task: TrackedTask & { orgId: OrgId }, budget?: MergeReadBudget): Promise<unknown>;
  /** Every request counts against this (the sweep's budget); each task's pass is held to its own cap inside it. */
  budget?: MergeReadBudget;
  /** The origin session links are made from (the control plane's own): the approved milestone links to the session with it. Without it the milestone says no link. */
  origin?: string | undefined;
  log?(event: string, fields: Record<string, unknown>): void;
  /** The write of the task's next workflow snapshot, guarded by the revision read. The task-flow lane owns the record, so it can say how it is written; the default is `workflowUpdateItem`. */
  workflowWrite?(taskId: string, next: WorkflowSnapshot, expectedRevision: number): TransactItem;
  /** Turns a decider's dispatch request into the row the task-flow core runs (default: its `dispatchRowItem`). */
  dispatchRow?(request: { companyId: OrgId; taskId: string; kind: MergeDispatchKind; workflowRevision: number; at: string }, now: string): TransactItem;
  /** Hooks at the end of a pass (the track record, the reviewers' reminders): best effort, outside the merge core. */
  hooks?: MergePassHooks;
}

export class TrackingRequestCapError extends Error {
  constructor() {
    super("a tracking pass used its GitHub request allowance");
    this.name = "TrackingRequestCapError";
  }
}

/** The requests one task's pass may make: a base amount, and more for each pull request beyond the first. */
export function trackingRequestCap(pullRequests: number): number {
  return TRACKING_REQUESTS_BASE + TRACKING_REQUESTS_PER_EXTRA_PR * Math.max(0, pullRequests - 1);
}

/** A budget that passes requests to `parent` until `cap` have been made, then refuses with `TrackingRequestCapError`. */
export function rowBudget(parent: MergeReadBudget, cap: number): MergeReadBudget {
  let used = 0;
  return {
    signal: parent.signal,
    beforeRequest: () => {
      if (used >= cap) throw new TrackingRequestCapError();
      used += 1;
      parent.beforeRequest();
    },
  };
}

// ---- which tasks are tracked

/** Whether a task is followed by tracking: Rovara Code version 2, with a pull request, not yet finished. */
export function tracksMerge(workflow: WorkflowSnapshot | undefined): workflow is WorkflowSnapshot {
  return workflow !== undefined && workflow.definitionVersion === TRACKED_DEFINITION_VERSION && (workflow.pullRequests ?? []).length > 0
    && workflow.stage !== "MERGED" && workflow.stage !== "CLOSED";
}

// ---- the checks

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "cancelled", "startup_failure", "error", "stale"]);

export interface CiReading {
  ci: MergeTrackingItem["ci"];
  ciBasis: MergeTrackingItem["ciBasis"];
  failingChecks: string[];
  /** The failing checks that count, one for each name (the first of a name that failed twice), at most ten. */
  failingDetails: FailingCheck[];
  /** When the answer will change by itself (the wait for "no CI" ends), so the row is looked at again then. */
  recheckAt?: number;
}

/**
 * What the head's checks say. The checks that count are the base branch's required ones when it has any, else all of them (`ciBasis`). A required check that has not
 * reported is pending, not passing. "No CI" (`none`) is read only when nothing has ever reported on the pull request, Rovara's push is a full sweep interval old and
 * the head holds no workflow files: anything less is `pending`, so a slow start is never read as "nothing to wait for".
 */
export function readCi(status: ChangeRequestStatus, input: { checksEverSeen: boolean; lastRovaraPushAt: number | undefined; now: number }): CiReading {
  const ciBasis = status.targetHasRequiredChecks ? "required" as const : "all_checks" as const;
  // Checks that could not be read are not known: nothing may say they passed.
  if (status.checksUnavailable === true) return { ci: "pending", ciBasis, failingChecks: [], failingDetails: [] };
  const required = status.requiredChecks;
  // A required check is met by a check of that name, from the named source when the host's rule names one (a check with no source cannot meet a requirement that names one).
  const meets = (entry: ChangeRequestStatus["requiredChecks"][number], check: ChangeRequestStatus["checks"][number]): boolean =>
    check.name === entry.name && (entry.source === undefined || check.source === entry.source);
  if (status.checks.length === 0) {
    const settled = input.lastRovaraPushAt !== undefined && input.now - input.lastRovaraPushAt >= NO_CI_GRACE_MS;
    if (!input.checksEverSeen && !status.headDefinesChecks && required.length === 0 && settled) return { ci: "none", ciBasis, failingChecks: [], failingDetails: [] };
    const waitEnds = !input.checksEverSeen && !status.headDefinesChecks && required.length === 0 && input.lastRovaraPushAt !== undefined ? input.lastRovaraPushAt + NO_CI_GRACE_MS : undefined;
    return { ci: "pending", ciBasis, failingChecks: [], failingDetails: [], ...(waitEnds === undefined || waitEnds <= input.now ? {} : { recheckAt: waitEnds }) };
  }
  // A check counts when the host says the target requires it for this change request, or when a protection rule names it (the name is the fallback when `isRequired` says nothing).
  const counted = ciBasis === "required" ? status.checks.filter((check) => check.required || required.some((entry) => meets(entry, check))) : status.checks;
  const failing = counted.filter((check) => check.state === "completed" && check.conclusion !== undefined && FAILED_CONCLUSIONS.has(check.conclusion));
  if (failing.length > 0) {
    const names = [...new Set(failing.map((check) => check.name))].slice(0, 10);
    const failingDetails = names.map((name) => failing.find((check) => check.name === name)!).map((check): FailingCheck => ({
      name: check.name, conclusion: check.conclusion ?? "failure", url: check.url, ...(check.runId === undefined ? {} : { jobId: check.runId }), ...(check.source === undefined ? {} : { source: check.source }),
      ...(check.logReadable === true ? { logReadable: true } : {}),
    }));
    return { ci: "failing", ciBasis, failingChecks: names, failingDetails };
  }
  // Every required check has to have reported: one that has not is not in the list yet, and nothing has passed for it.
  if (required.some((entry) => !status.checks.some((check) => meets(entry, check)))) return { ci: "pending", ciBasis, failingChecks: [], failingDetails: [] };
  if (counted.length === 0) return { ci: "pending", ciBasis, failingChecks: [], failingDetails: [] };
  const waiting = counted.some((check) => check.state !== "completed" || check.conclusion === "action_required");
  return { ci: waiting ? "pending" : "passing", ciBasis, failingChecks: [], failingDetails: [] };
}

// ---- the reviews

export interface ReviewReading {
  review: MergeTrackingItem["review"];
  approval?: NonNullable<MergeTrackingItem["approval"]>;
}

/**
 * Where the reviews stand: each reviewer's latest review of approving, requesting changes or dismissal (comments say nothing, m2), counted only for a person (not a bot)
 * whose live permission on the repository is write or above. A reviewer who cannot be looked up throws (the pass tries again); more reviewers than
 * `PERMISSION_LOOKUPS_MAX` are not trusted, so nothing is read as approved.
 */
export async function readReviews(
  status: ChangeRequestStatus,
  input: { requested: boolean; permission(login: string): Promise<"admin" | "write" | "read" | "none"> },
): Promise<ReviewReading> {
  // A list cut at the page limit is not the whole story (a later review may withdraw an approval): nothing is read as approved from it.
  if (status.reviewsIncomplete === true) return { review: "requested" };
  const latest = new Map<string, ReturnType<typeof approvalReviewsOf>[number]>();
  const ordered = [...approvalReviewsOf(status.reviews)].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  for (const review of ordered) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.hostUserId, review);
  }
  const candidates = [...latest.values()].filter((review) => review.state !== "DISMISSED" && review.accountType === "person");
  const asked = input.requested || candidates.length > 0;
  if (candidates.length > PERMISSION_LOOKUPS_MAX) return { review: "requested" };
  const counted: typeof candidates = [];
  for (const review of candidates) {
    const permission = await input.permission(review.login);
    if (permission === "admin" || permission === "write") counted.push(review);
  }
  if (counted.some((review) => review.state === "CHANGES_REQUESTED")) return { review: "changes_requested" };
  const approvals = counted.filter((review) => review.state === "APPROVED");
  const newest = approvals[approvals.length - 1];
  if (newest !== undefined) return { review: "approved", approval: { hostUserId: newest.hostUserId, login: newest.login, commitId: newest.commitId } };
  return { review: asked ? "requested" : "not_requested" };
}

// ---- the branch and the head

/** The branch against its base: conflicting (the host says so), behind, up to date, or not yet known. */
export function readBranch(status: ChangeRequestStatus): MergeTrackingItem["branch"] {
  if (status.mergeable === false || status.mergeableState === "conflicted") return "conflicted";
  if (status.mergeableState === "behind") return "behind";
  if (status.mergeableState === "unknown" || status.behindBy === undefined) return "unknown";
  return status.behindBy > 0 ? "behind" : "up_to_date";
}

/**
 * Whether the head is Rovara's (Finding 16): true when it is one Rovara recorded (the workflow's, or the pull request record's, which the push's result moves first);
 * left as it was while a Rovara push is running or has no recorded result (its own `synchronize` arrives before its result); false only for a head that is neither.
 */
export function readHeadByRovara(input: { prior: boolean | undefined; head: string; recorded: ReadonlyArray<string | undefined>; pushPending: boolean }): boolean {
  if (input.recorded.includes(input.head)) return true;
  if (input.pushPending) return input.prior ?? true;
  return false;
}

/** Whether a Rovara push to the task's pull requests is running or its result is not recorded: the workflow is not simply waiting for the merge. */
export function rovaraPushPending(workflow: WorkflowSnapshot): boolean {
  return workflow.stage !== "WAIT_FOR_MERGE" || workflow.state === "RUNNING" || workflow.state === "READY";
}

// ---- the item

export interface TrackingInputs {
  task: TrackedTask & { workflow: WorkflowSnapshot; orgId: OrgId };
  pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number];
  status: ChangeRequestStatus;
  prior: MergeTrackingItem | undefined;
  recordedHead: string | undefined;
  reviews: ReviewReading;
  now: number;
}

/** The tracking item for what GitHub says now, without its version, digest and read time. Everything the pass does not decide (nudges, syncs, the merge claim, ...) is kept from `prior`. */
export function deriveTrackingFields(input: TrackingInputs): Omit<MergeTrackingItem, "version" | "decisionDigest" | "observedAt"> {
  const { task, pullRequest, status, prior, now } = input;
  const headByRovara = readHeadByRovara({ prior: prior?.headByRovara, head: status.headRevision, recorded: [pullRequest.headSha, input.recordedHead], pushPending: rovaraPushPending(task.workflow) });
  const newRovaraHead = headByRovara && (prior === undefined || prior.headSha !== status.headRevision);
  const updatedAt = task.workflow.pullRequestUpdatedAt === undefined ? undefined : Date.parse(task.workflow.pullRequestUpdatedAt);
  const lastRovaraPushAt = newRovaraHead
    ? (updatedAt !== undefined && Number.isFinite(updatedAt) && updatedAt <= now && updatedAt > Date.parse(prior?.lastRovaraPushAt ?? "1970-01-01T00:00:00.000Z") ? updatedAt : now)
    : prior?.lastRovaraPushAt === undefined ? undefined : Date.parse(prior.lastRovaraPushAt);
  const checksEverSeen = prior?.checksEverSeen === true || status.checks.length > 0;
  const ci = readCi(status, { checksEverSeen, lastRovaraPushAt, now });
  const today = new Date(now).toISOString().slice(0, 10);
  const reAsked = (prior?.review === "changes_requested" || prior?.review === "approved") && input.reviews.review === "requested";
  return {
    orgId: task.orgId, taskId: task.taskId, repositoryId: pullRequest.repositoryId, number: pullRequest.number,
    headSha: status.headRevision, draft: status.draft, state: status.state, baseBranch: status.targetBranch,
    ci: ci.ci, ciBasis: ci.ciBasis, checksEverSeen, failingChecks: ci.failingChecks,
    review: input.reviews.review, ...(input.reviews.approval === undefined ? {} : { approval: input.reviews.approval }),
    branch: readBranch(status), headByRovara,
    ...(lastRovaraPushAt === undefined ? {} : { lastRovaraPushAt: new Date(lastRovaraPushAt).toISOString() }),
    ...(prior?.readyAt === undefined ? {} : { readyAt: prior.readyAt }),
    // A decision withdrawn (a dismissed review) puts the pull request back to waiting: the review is asked for again, so the reminders' clock starts over (Task 18).
    ...(reAsked ? { reviewersRequestedAt: new Date(now).toISOString() } : prior?.reviewersRequestedAt === undefined ? {} : { reviewersRequestedAt: prior.reviewersRequestedAt }),
    nudges: prior?.nudges ?? { count: 0 },
    syncs: prior?.syncs ?? { day: today, count: 0 },
    ...(prior?.mergeClaim === undefined ? {} : { mergeClaim: prior.mergeClaim }),
  };
}

function withDigest(fields: Omit<MergeTrackingItem, "version" | "decisionDigest" | "observedAt">): Omit<MergeTrackingItem, "version" | "observedAt"> {
  return { ...fields, decisionDigest: mergeTrackingDecisionDigest(fields) };
}

// ---- the actions
//
// The shapes a pass hands the deciders and what they hand back are lane L7b's (`branch-sync/merge-action.ts`): a decider returns DATA (the next workflow, the steps it owns, the dispatch the
// new state is due for, the milestones), and THIS pass turns it into rows and commits all of it with the tracking item in one transaction.
export type MergeAction =
  | MergeActionRequest
  | {
    slot: "none";
    reason: "not_open" | "someone_else_pushed" | "in_flight" | "owner_card" | "no_action";
    /** While an owner's card waits: the failing checks seen, for the card to show (the feedback slot folds them into it). */
    ciFailures?: string[];
  };

/** What this pass adds to the deciders' context for the slots that need more (the feedback slot's standing lookups and its soundness check). The deciders of L7b read the base `MergeActionContext`. */
export interface MergeActionPassContext extends MergeActionContext {
  /** Who the person is on the repository, read live and counted in the pass's allowance (once a pass for each person). */
  standingOf?: ((login: string, repositoryId: string) => Promise<RepositoryStanding>) | undefined;
  /** The digest of the recipe that gave the task its autonomy. */
  recipeDigest?: string | undefined;
  /** Whether the waiting feedback round's stored report and comments are sound enough to fix on Rovara's own decision. Undefined: not known, so it is the owner's. */
  feedbackRoundCheck?: (() => Promise<boolean>) | undefined;
  /** Says this pass ran out of its allowance while deciding, so the pass settles as a retry once its item is written. */
  noteCapped?: (() => void) | undefined;
}

const deciders = new Map<MergeActionSlot, MergeActionDecider>();

/** Fills a slot (CI fix, conflict and sync are L7b's; feedback is a later lane's). Returns the function that empties it again. One decider per slot. */
export const registerMergeActionDecider: RegisterMergeActionDecider = (slot, decide) => {
  if (deciders.has(slot)) throw new Error(`the ${slot} slot already has a decider`);
  deciders.set(slot, decide);
  return () => { if (deciders.get(slot) === decide) deciders.delete(slot); };
};

/** Whether the owner has a feedback card waiting (being prepared, or waiting for their decision). */
export function ownerCardPending(workflow: WorkflowSnapshot): boolean {
  return workflow.feedbackReview?.status === "PENDING" || workflow.feedbackReview?.status === "COLLECTING";
}

/**
 * The one thing to do next about the task, in one order: a conflict, then failing CI, then feedback, then a branch sync. Nothing starts while the pull request is not open,
 * while someone else's push stands, while the task is doing something else (a fix or push in flight, or not waiting for the merge), or while the owner's card waits (it
 * blocks every action, a conflict included). Each slot is filled by its own task; an empty slot decides nothing.
 */
export async function nextMergeAction(item: MergeTrackingItem, workflow: WorkflowSnapshot, autonomy: Autonomy, now: number = Date.now(), context?: MergeActionPassContext): Promise<MergeAction> {
  if (item.state !== "open") return { slot: "none", reason: "not_open" };
  if (!item.headByRovara) return { slot: "none", reason: "someone_else_pushed" };
  // A head the pull request record has and the workflow has not recorded yet (a push whose result is still to be judged) is not acted on: nothing is fixed, merged or asked about it until the workflow knows it.
  const recorded = context === undefined ? undefined : workflow.pullRequests?.find((entry) => entry.repositoryId === context.repositoryId && entry.number === context.pullRequestNumber);
  if (context !== undefined && recorded?.headSha !== undefined && recorded.headSha !== context.headSha) return { slot: "none", reason: "in_flight" };
  if (workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING") return { slot: "none", reason: "in_flight" };
  if (ownerCardPending(workflow)) {
    // The owner's card blocks every action but its own: the feedback slot may add the failing checks to the card, or decide a card that waits (Plan 6 Task 16).
    const request = await deciders.get("feedback")?.({ item, workflow, autonomy, now, ...(context === undefined ? {} : { context }) });
    if (request !== undefined) return request;
    return { slot: "none", reason: "owner_card", ...(item.failingChecks.length === 0 ? {} : { ciFailures: item.failingChecks }) };
  }
  for (const slot of MERGE_ACTION_ORDER) {
    const request = await deciders.get(slot)?.({ item, workflow, autonomy, now, ...(context === undefined ? {} : { context }) });
    if (request !== undefined) return request;
  }
  return { slot: "none", reason: "no_action" };
}

// ---- one pass

export type TrackResult = "changed" | "unchanged" | "gone";

export interface TrackOutcome {
  result: TrackResult;
  /** When the task must be looked at again if nothing wakes it sooner. */
  recheckAt?: number;
  /** Whether any pull request is no longer open on GitHub, so the merge observation should run. */
  anyNotOpen: boolean;
}

const COMMIT_ATTEMPTS = 3;
const isAgentXError = (error: unknown): error is AgentXError => error instanceof Error && error.name === "AgentXError";

/** One line for a milestone or a session: no @-mentions, no control characters. */
const inertLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}@]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200);

/**
 * Follows every pull request of the task once: reads GitHub, keeps the tracking items, marks a draft ready for review and asks for the project's reviewers, and runs
 * `nextMergeAction`. Returns `gone` for a task that is closed, finished, not tracked or has no org, `changed` when an item or the workflow was written, else `unchanged`.
 */
export async function trackPullRequest(deps: MergeTrackingDependencies, taskId: string): Promise<TrackResult> {
  return (await trackTask(deps, taskId)).result;
}

export async function trackTask(deps: MergeTrackingDependencies, taskId: string): Promise<TrackOutcome> {
  const first = await deps.loadTask(taskId);
  if (first === undefined || first.closedAt !== undefined || first.releasedAt !== undefined || first.orgId === undefined || !tracksMerge(first.workflow)) {
    return { result: "gone", anyNotOpen: false };
  }
  const orgId = first.orgId;
  const settings = await deps.settings.read(orgId, first.project);
  const listed = [...(first.workflow.pullRequests ?? [])].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);
  // A pass that ran out of requests part-way starts the next one at the pull request it stopped at, so the rest is reached, not read again from the first.
  const rowKey = recoveryRowKey(taskId);
  const row = await deps.store.get(rowKey);
  const cursor = typeof row?.["trackingCursor"] === "number" && Number.isInteger(row["trackingCursor"]) && row["trackingCursor"] >= 0 && row["trackingCursor"] < listed.length ? row["trackingCursor"] : 0;
  // The pass that resumes reads only from the pull request it stopped at to the end: the ones before it were read by the pass that stopped.
  const pullRequests = listed.slice(cursor);
  const budget = deps.budget === undefined ? undefined : rowBudget(deps.budget, trackingRequestCap(pullRequests.length));
  const standings = new Map<string, Promise<RepositoryStanding>>();
  const setCursor = async (value: number): Promise<void> => {
    if (row === undefined || (row["trackingCursor"] ?? 0) === value) return;
    await deps.store.update({ key: rowKey, ops: [change.set(["trackingCursor"], value)], condition: when.present() }).catch(() => undefined);
  };
  let changed = false;
  let anyNotOpen = false;
  let recheckAt: number | undefined;
  for (const [position, listedPullRequest] of pullRequests.entries()) {
    const task = await deps.loadTask(taskId);
    if (task === undefined || task.closedAt !== undefined || task.releasedAt !== undefined || task.orgId !== orgId || !tracksMerge(task.workflow)) return { result: changed ? "changed" : "gone", anyNotOpen };
    const pullRequest = task.workflow.pullRequests?.find((entry) => entry.repositoryId === listedPullRequest.repositoryId && entry.number === listedPullRequest.number);
    if (pullRequest === undefined) continue;
    let one: Awaited<ReturnType<typeof trackOne>>;
    const seen: PassSeen = {};
    try {
      one = await trackOne(deps, { ...task, orgId, workflow: task.workflow }, pullRequest, settings, budget, standings, seen);
    } catch (error) {
      if (error instanceof TrackingRequestCapError) await setCursor(cursor + position);
      throw error;
    }
    changed ||= one.changed;
    anyNotOpen ||= one.notOpen;
    if (one.recheckAt !== undefined) recheckAt = recheckAt === undefined ? one.recheckAt : Math.min(recheckAt, one.recheckAt);
    // Reminders for the reviewers (Task 18): from what this pass read, with no GitHub request of their own; a failure there is theirs and never fails the pass.
    if (seen.item !== undefined) {
      const reminded = await deps.hooks?.remind?.({
        task: { ...task, orgId, workflow: task.workflow }, pullRequest: { repositoryId: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }, item: seen.item, requested: seen.requestedReviewerIds ?? [],
      }).catch((error: unknown) => {
        deps.log?.("merge_tracking.remind_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
        return undefined;
      });
      if (reminded?.recheckAt !== undefined) recheckAt = recheckAt === undefined ? reminded.recheckAt : Math.min(recheckAt, reminded.recheckAt);
    }
    // An action changed the workflow: the other pull requests are decided on the next pass, from the workflow as it now is.
    if (one.acted) break;
  }
  await setCursor(0);
  // The replies a landed push of an automatic comment fix left to send: a courtesy, so a failure is logged and never fails the pass (a rate limit goes up to the sweep).
  if (deps.sendFeedbackReplies !== undefined) {
    const fresh = await deps.loadTask(taskId);
    if (fresh !== undefined && fresh.closedAt === undefined && fresh.orgId === orgId) {
      await deps.sendFeedbackReplies({ ...fresh, orgId }, budget).catch((error: unknown) => {
        if (rateLimitRetryAt(error) !== undefined) throw error;
        deps.log?.("merge_tracking.replies_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
      });
    }
  }
  return { result: changed ? "changed" : "unchanged", anyNotOpen, ...(recheckAt === undefined ? {} : { recheckAt }) };
}

/** What a pass saw of one pull request that the reminders of reviewers (nudges.ts) need: the tracking item as it is stored when the pass ends, and who GitHub lists as asked for a review. */
interface PassSeen {
  item?: MergeTrackingItem;
  requestedReviewerIds?: string[];
}

async function trackOne(
  deps: MergeTrackingDependencies,
  task: TrackedTask & { workflow: WorkflowSnapshot; orgId: OrgId },
  pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number],
  settings: CodeSettings,
  budget: MergeReadBudget | undefined,
  standings: Map<string, Promise<RepositoryStanding>>,
  seen: PassSeen,
): Promise<{ changed: boolean; notOpen: boolean; acted: boolean; recheckAt?: number }> {
  // The code host is the one the repository's record names (an unknown kind is refused here, before anything is read).
  const home = await deps.repository(task.project, task.startingRevision, pullRequest.repositoryId, task.orgId);
  if (home === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not in the task's project");
  const { url, codeHost } = home;
  const repositoryKey = requireRepositoryKey(providerOf(codeHost), url);
  // The pull request must be the one Rovara linked to this task, in this repository of the pinned project: nothing a webhook or a read says moves it.
  const linked = await deps.links.find({ hostKind: providerOf(codeHost), connectionKind: codeHost.kind, repositoryAddress: url, id: String(pullRequest.number) });
  if (linked === undefined || linked.taskId !== task.taskId || linked.repositoryId !== pullRequest.repositoryId || linked.url !== pullRequest.url) {
    throw agentXError("CONFIG_INVALID", "the pull request is not linked to this task");
  }
  const scope = deps.scope(task.orgId);
  const ref = changeRequestRef(url, pullRequest.number);
  const status = await codeHost.changeRequestStatus(ref, scope, budget);
  if (status.id !== String(pullRequest.number)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub answered for another pull request");
  seen.requestedReviewerIds = status.requestedReviewerIds ?? [];
  const prior = trackingItemOf(await readTrackingItem(deps.store, task.taskId, pullRequest.repositoryId, pullRequest.number), task.orgId, task.taskId);
  // One lookup for each person a pass asks about, whoever asks (the reviews, or the rule for a feedback round): the answer carries the permission and, where GitHub says it, the kind of account.
  const standingOn = async (repositoryId: string, login: string): Promise<RepositoryStanding> => {
    // The repository of this pull request is known; another repository of the task is looked up as the task's project pins it.
    const on = repositoryId === pullRequest.repositoryId ? home : await deps.repository(task.project, task.startingRevision, repositoryId, task.orgId);
    if (on === undefined) throw agentXError("CONFIG_INVALID", "the repository is not in the task's project");
    const key = `${requireRepositoryKey(providerOf(on.codeHost), on.url)}:${login.toLowerCase()}`;
    let found = standings.get(key);
    if (found === undefined) {
      found = on.codeHost.standing({ url: on.url }, { login }, scope, budget).then((read): RepositoryStanding => ({ permission: read.permission, accountType: read.accountType }));
      standings.set(key, found);
    }
    return found;
  };
  const standing = (login: string): Promise<RepositoryStanding> => standingOn(pullRequest.repositoryId, login);
  const permission = async (login: string): Promise<"admin" | "write" | "read" | "none"> => (await standing(login)).permission;
  const recordedHead = await deps.recordedHead?.(task.workspaceId, pullRequest.repositoryId, pullRequest.number);
  const now = deps.now();
  // Owner decision D1 (branch writers): a head that is NOT one of the commits Rovara itself recorded pushing makes the branch a person's, for good. The fact is strict (the workflow's recorded head or the
  // pull request record's), never `headByRovara`, which reads "mine" while a Rovara push is pending. It is written before anything else is decided from the pass, and a failure to write it fails the
  // pass (it is tried again): a branch whose person-push was not recorded could be force-pushed over later.
  if (status.headRevision !== pullRequest.headSha && (recordedHead === undefined || status.headRevision !== recordedHead)) {
    const details = await codeHost.getChangeRequest(ref, scope);
    await noteBranchHead(deps.store, { orgId: task.orgId, repositoryId: pullRequest.repositoryId, branch: details.sourceBranch }, { headIsRecordedRovaraPush: false, now: new Date(now).toISOString() });
  }
  const reviewsOf = (reviews: ReviewReading) => deriveTrackingFields({ task, pullRequest, status, prior, recordedHead, reviews, now });
  // What does not depend on the reviews comes first: whether to mark ready needs only the checks and the head. The effects come before the reviews' permission lookups so
  // that a pass that runs out of requests there has already done what it could.
  const early = reviewsOf({ review: "not_requested" });
  const ci = readCi(status, { checksEverSeen: early.checksEverSeen, lastRovaraPushAt: early.lastRovaraPushAt === undefined ? undefined : Date.parse(early.lastRovaraPushAt), now });

  // Ready for review (question 8): a draft whose counted checks pass (or that has none to wait for), on a head that is Rovara's, is taken out of draft, and the project's
  // reviewers are asked unless GitHub already lists some. A pull request that was never a draft is treated alike: the reviewers are asked and `readyAt` says when.
  // GitHub refusing one of the two (a missing permission, an error) leaves that step undone and the item still written; a rate limit or a spent allowance goes on up.
  // Only while the task waits for the merge with nothing being changed or checked: a pull request whose code is being fixed, or merged with its base and not yet checked and reviewed again (lane L10, owner
  // decision b), is not called ready, whatever its CI says.
  const wantsReady = status.state === "open" && early.readyAt === undefined && early.headByRovara && (ci.ci === "passing" || ci.ci === "none")
    && task.workflow.stage === "WAIT_FOR_MERGE" && task.workflow.state === "WAITING";
  let readyNow = false;
  let asked = false;
  let markedReady = false;
  const attempt_ = async (step: () => Promise<unknown>, what: string): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch (error) {
      if (!isAgentXError(error) || error.code === "CONFIG_INVALID") throw error;
      deps.log?.("merge_tracking.step_refused", { taskId: task.taskId, step: what, code: error.code });
      return false;
    }
  };
  if (wantsReady) {
    // A host that cannot take a change request out of draft leaves it a draft: it is never read as ready.
    const markReady = codeHost.markReady?.bind(codeHost);
    const drafted = !status.draft || (markReady !== undefined && await attempt_(() => markReady(ref, scope, budget), "mark_ready"));
    if (drafted) {
      markedReady = status.draft;
      if (settings.codeReviewers.length > 0 && status.requestedReviewers === 0 && early.reviewersRequestedAt === undefined) {
        const requestReviewers = codeHost.requestReviewers?.bind(codeHost);
        asked = requestReviewers !== undefined && await attempt_(() => requestReviewers(ref, settings.codeReviewers, scope, budget), "request_reviewers");
      }
      readyNow = true;
    }
  }

  // The reviews: each reviewer's permission is looked up (once a pass); a pass that runs out of requests here reads the reviews as asked-for and not decided (never approved),
  // writes the item, and then tries again.
  let capped = false;
  const reviews = await readReviews(status, {
    requested: status.requestedReviewers > 0 || asked || prior?.reviewersRequestedAt !== undefined, permission,
  }).catch((error: unknown) => {
    if (!(error instanceof TrackingRequestCapError)) throw error;
    capped = true;
    return { review: "requested" as const };
  });
  const fields = reviewsOf(reviews);
  if (markedReady) fields.draft = false;

  // Track record (best effort, after the item is written, never changes the pass): what this pass saw of the code the candidate published (its head; its checks on that head), a person's first
  // request for changes (about the candidate whose head the review is on), and a round of fixes started from people's comments. A close is not scored here (it may be reopened), and a merge is scored
  // where it is recorded (the webhook path), which also has the merge commit.
  const observeOutcomes = async (): Promise<void> => {
    if (deps.hooks?.observe === undefined) return;
    try {
      await deps.hooks.observe({ task, pullRequest, fields, prior, now, permissionOf: permission, status, ci: ci.ci });
    } catch (error) {
      deps.log?.("outcomes.observe_failed", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  };

  // Plan 6 Task 19: an approval that counts (a person with write access who is a member and not a requester, unless the org allows self-approval, on the head) is announced once,
  // once for each approval of each head. It is judged on every pass, because an approval that did not count can start to (the org allows self-approval, the reviewer is linked to a member), and
  // the milestone's own key says whether it was said already. It uses the permissions the pass has just read, so it asks GitHub for nothing more.
  let announce: { login: string; n: number } | undefined;
  if (fields.approval !== undefined && !capped) {
    const approvalReviews = approvalReviewsOf(status.reviews);
    const reviewers = latestReviewers(approvalReviews);
    const known = new Map<string, RepositoryPermission>();
    for (const reviewer of reviewers) known.set(reviewer.login, await permission(reviewer.login));
    const counted = humanApprovalOf({
      reviews: approvalReviews, headSha: status.headRevision, syncedFrom: pullRequest.syncedFrom, ciPassingOnHead: ci.ci === "passing" || ci.ci === "none", permissions: known,
      requesterHostUserIds: await requesterHostIds(deps.people, task.orgId, task), linkedHostUserIds: await linkedAmong(deps.people, task.orgId, reviewers.map((reviewer) => reviewer.hostUserId)),
      excludedHostUserIds: await nonWritersAmong(deps.people, task.orgId, reviewers.map((reviewer) => reviewer.hostUserId)),
      allowSelfApproval: settings.allowSelfApproval,
    });
    if (counted.approved) {
      const n = Number.parseInt(createHash("sha256").update(`${pullRequest.repositoryId}\n${String(pullRequest.number)}\n${counted.commitId}\n${counted.by.hostUserId}`).digest("hex").slice(0, 6), 16) % 1_000_000;
      const said = await deps.store.get(codeMilestoneKey(task.taskId, "approved", n));
      if (said === undefined) announce = { login: counted.by.login, n };
    }
  }
  const approvedItems = (stamp: string): TransactItem[] => {
    if (announce === undefined) return [];
    const where = deps.origin !== undefined && task.sessionId !== undefined ? `: ${sessionLink(deps.origin, task.sessionId)}` : ".";
    return deps.milestones.items({
      kind: "approved", orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: stamp,
      text: `Approved by ${inertLine(announce.login)}. Ready to merge${where}`, pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }],
    }, announce.n, { definitionVersion: task.workflow.definitionVersion });
  };

  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    const current = attempt === 0 ? prior : trackingItemOf(await readTrackingItem(deps.store, task.taskId, pullRequest.repositoryId, pullRequest.number), task.orgId, task.taskId);
    const stamp = new Date(now).toISOString();
    const base = { ...fields, ...(readyNow && current?.readyAt === undefined ? { readyAt: stamp } : current?.readyAt === undefined ? {} : { readyAt: current.readyAt }) };
    const nextFields = asked && base.reviewersRequestedAt === undefined ? { ...base, reviewersRequestedAt: stamp } : base;
    // What the item says about the parts only other tasks' writes change is whatever is stored now.
    const merged = { ...nextFields, nudges: current?.nudges ?? nextFields.nudges, syncs: current?.syncs ?? nextFields.syncs, ...(current?.mergeClaim === undefined ? {} : { mergeClaim: current.mergeClaim }) };
    const digested = withDigest(merged);
    const justReady = readyNow && current?.readyAt === undefined;
    const flipped = current !== undefined && current.headByRovara !== merged.headByRovara;
    const unchanged = current !== undefined && current.decisionDigest === digested.decisionDigest && !justReady;
    const nextItem: MergeTrackingItem = { ...digested, version: (current?.version ?? 0) + 1, observedAt: stamp };
    seen.item = unchanged && current !== undefined ? current : nextItem;
    const items: TransactItem[] = [];
    let action: MergeActionRequest | undefined;
    // The end of a build's log is read by the host's check runner (GitHub Actions for GitHub); a host with none has no log to read.
    const runner = home.checkRunner;
    const readLog = runner === undefined ? undefined : (jobId: string) => runner.logTail(
      { kind: "change-request", ref }, status.checks.find((check) => check.runId === jobId) ?? { name: "job", state: "completed", conclusion: "failure", required: false, url: "", runId: jobId }, scope, budget,
    );
    const bound = deps.autonomyBinding !== undefined ? await deps.autonomyBinding(task) : { autonomy: await (deps.autonomy?.(task) ?? "prepare") };
    const recipeDigest = bound.recipeDigest;
    let ranOut = false;
    const decision = await nextMergeAction(unchanged && current !== undefined ? current : nextItem, task.workflow, bound.autonomy, now, {
      ...(deps.store.ttlAttribute === undefined ? {} : { ttlAttribute: deps.store.ttlAttribute }), orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
      repositoryId: pullRequest.repositoryId, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url, headSha: status.headRevision, failing: ci.failingDetails,
      behindRequired: status.mergeableState === "behind",
      ...(readLog === undefined ? {} : { readJobLog: readLog }),
      ...(deps.log === undefined ? {} : { log: (event: string, fields: Record<string, unknown>) => deps.log?.(event, fields) }),
      standingOf: (login, repositoryId) => standingOn(repositoryId, login),
      ...(recipeDigest === undefined ? {} : { recipeDigest }),
      ...(deps.feedbackRoundCheck === undefined ? {} : { feedbackRoundCheck: () => deps.feedbackRoundCheck!({ ...task, orgId: task.orgId, workflow: task.workflow }) }),
      noteCapped: () => { ranOut = true; },
    });
    if (ranOut) capped = true;
    if (decision.slot !== "none") action = decision;
    if (unchanged && action === undefined) {
      // Nothing GitHub said changed, but an approval that stood unannounced now counts: the milestone is all there is to write.
      if (announce !== undefined) {
        const only = approvedItems(stamp);
        // A transaction that lost its race (the milestone was said meanwhile) is not an error.
        if (only.length > 0 && (await deps.store.transact(only)).applied) await deps.milestones.deliver(task.taskId).catch(() => undefined);
      }
      await observeOutcomes();
      if (capped) throw new TrackingRequestCapError();
      return { changed: false, notOpen: status.state !== "open", acted: false, ...(ci.recheckAt === undefined ? {} : { recheckAt: ci.recheckAt }) };
    }
    // An action that uses the day's count of merges of the base (Plan 6 Task 17) keeps it on this item, in this transaction: the item is written even when nothing GitHub said changed.
    const written: MergeTrackingItem = action?.syncs === undefined ? nextItem : { ...withDigest({ ...merged, syncs: action.syncs }), version: nextItem.version, observedAt: stamp };
    if (!unchanged || action?.syncs !== undefined) {
      items.push(trackingWriteItem(current, written));
      // The index a check or status event finds the task by: kept up to date whenever the item is, for a head that is Rovara's.
      if (merged.headByRovara) items.push(...prHeadItems({ orgId: task.orgId, repositoryKey, headSha: status.headRevision, taskId: task.taskId, repositoryId: pullRequest.repositoryId, number: pullRequest.number }, now, deps.store.ttlAttribute).slice(0, 1));
    }
    if (action !== undefined) {
      items.push((deps.workflowWrite ?? workflowUpdateItem)(task.taskId, action.workflow, task.workflow.revision), ...action.steps);
      // The dispatch the new workflow state is due for becomes a row through the task-flow core, and its milestones rows through the milestone hook: all in this one commit.
      if (action.dispatch !== undefined) items.push((deps.dispatchRow ?? defaultDispatchRow)({ companyId: task.orgId, taskId: task.taskId, ...action.dispatch }, stamp));
      for (const requested of action.milestones) items.push(...deps.milestones.items(requested.milestone, requested.n, { definitionVersion: action.workflow.definitionVersion }));
    }
    if (justReady) {
      const index = Math.max(0, (task.workflow.pullRequests ?? []).findIndex((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number));
      items.push(...deps.milestones.items({
        kind: "pr_ready", orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: stamp,
        text: `Rovara marked ${inertLine(pullRequest.repositoryId)} pull request ${String(pullRequest.number)} ready for review.`,
        pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }],
      }, index, { definitionVersion: task.workflow.definitionVersion }));
    }
    items.push(...approvedItems(stamp));
    if (flipped && task.sessionId !== undefined) {
      items.push(deps.timeline.statusLine({ orgId: task.orgId, sessionId: task.sessionId }, {
        eventId: sessionEventId("merge_tracking", `${task.taskId}\n${pullRequest.repositoryId}\n${String(pullRequest.number)}\n${String(nextItem.version)}`),
        at: stamp, text: merged.headByRovara ? PUSH_WAS_MINE_MESSAGE : SOMEONE_ELSE_PUSHED_MESSAGE,
      }));
    }
    // A write that lost a race (the version, the workflow's revision) is a failed condition, not a fault: read again and try again.
    const committed = await deps.store.transact(items).catch((error: unknown) => {
      // A transaction that lost its race with another writer after the store's own retries is the same as a failed condition.
      if (error instanceof DocumentStoreError && error.code === "conflict") return { applied: false as const };
      throw error;
    });
    if (!committed.applied) {
      if (attempt + 1 < COMMIT_ATTEMPTS) continue;
      throw agentXError("RUNTIME_UNAVAILABLE", "the tracking item was changed by another writer");
    }
    if (justReady || announce !== undefined || (action?.milestones.length ?? 0) > 0) {
      // After the commit: the handlers are told (a failure is theirs, and the sweep tells them again).
      await deps.milestones.deliver(task.taskId).catch(() => undefined);
    }
    await observeOutcomes();
    if (capped) throw new TrackingRequestCapError();
    return { changed: true, notOpen: status.state !== "open", acted: action !== undefined, ...(ci.recheckAt === undefined ? {} : { recheckAt: ci.recheckAt }) };
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the tracking item stayed busy");
}

// ---- the sweep's reconcile

export interface TrackingReconcileDependencies extends MergeTrackingDependencies {
  /** Today's merge observation for the task (the merge pass's reconcile): the workflow learns of a merge or a close from it. */
  observeMerge(taskId: string, budget: MergeReadBudget): Promise<MergeRecoveryResult>;
}

const RETRY_SOON_MS = 60_000;

/**
 * What the tracking pass runs for one tracking row: the tracking read, then today's merge observation, which runs when a pull request is no longer open and otherwise at
 * most once per merge sweep interval (so a missed webhook still ends in the merge being recorded, at the cadence it always had). A pass over its request allowance
 * settles as a retry and finishes on the next; a GitHub rate limit is the shared one.
 */
export async function reconcileTrackingTask(deps: TrackingReconcileDependencies, taskId: string, budget: MergeReadBudget): Promise<MergeRecoveryResult> {
  const rowKey = recoveryRowKey(taskId);
  const retry = (): MergeRecoveryResult => ({ kind: "RETRY", retryAt: deps.now() + RETRY_SOON_MS, scope: "task" });
  const limited = (error: unknown): MergeRecoveryResult | undefined =>
    rateLimitRetryAt(error) !== undefined ? { kind: "RETRY", retryAt: rateLimitRetryAt(error)!, scope: "github-global" } : undefined;
  // Tracking and the merge observation are independent: whatever tracking does (a refusal from GitHub, a permission an installation has not accepted, an answer that does
  // not parse), the observation that records a merge a webhook missed still runs when it is due. Only GitHub's rate limit and a spent sweep budget stop both.
  let outcome: TrackOutcome | undefined;
  let failure: MergeRecoveryResult | undefined;
  try {
    outcome = await trackTask({ ...deps, budget }, taskId);
  } catch (error) {
    const shared = limited(error);
    if (shared !== undefined) return shared;
    if (!(error instanceof TrackingRequestCapError)) deps.log?.("merge_tracking.pass_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
    failure = retry();
    if (error instanceof Error && error.name === "GithubBudgetExhaustedError") return failure;
  }
  try {
    const row = await deps.store.get(rowKey);
    const observedAt = typeof row?.["mergeObservedAt"] === "number" ? row["mergeObservedAt"] : undefined;
    const stale = observedAt === undefined || deps.now() - observedAt >= SWEEP_INTERVAL_MS;
    if (stale || (outcome !== undefined && (outcome.result === "gone" || outcome.anyNotOpen))) {
      const observed = await deps.observeMerge(taskId, budget);
      if (observed.kind !== "OBSERVED") return observed;
      await deps.store.update({ key: rowKey, ops: [change.set(["mergeObservedAt"], deps.now())], condition: when.present() }).catch(() => undefined);
    }
  } catch (error) {
    return limited(error) ?? failure ?? retry();
  }
  return failure ?? { kind: "OBSERVED", ...(outcome?.recheckAt === undefined ? {} : { nextAt: outcome.recheckAt }) };
}
