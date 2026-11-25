import { readFeedbackReport } from "../core/pr-feedback/validate.js";
import { installFeedbackDecider } from "../core/pr-feedback/merge-action.js";
import { sendPrFeedbackReplies } from "../core/pr-feedback/replies.js";
import { collectTrackedFeedback } from "../core/pr-feedback/service.js";
// Merge tracking as a host-neutral service. Merge tracking asks the code host about the pull requests of tasks waiting for their merge and calls the core's `reconcileTrackingTask` for each (the status of the pull
// request, the CI fix, the branch sync, ready for review) with the seams of the merge core filled. A host composes it over its own adapters:
//
//   settings   the project's code settings (a reader the host passes)    milestones  a row for each milestone + a line on the task's session (`fixing`, `stuck`, `pr_ready`, `approved`, `merged`)
//   people     who a person is on the code host (a reader the host passes)   timeline    the session's event log
//   links      the reverse link the publish step wrote                       repository  the repository the project pins, on the code host its record names (the registry's `code-host` point)
//
// Nothing here knows who the people are or what the settings say: a host with one owner passes `soleOwnerPeople` and `fixedCodeSettings()` (the laptop does, `local/app/tracking.ts`); a host with members passes readers
// over its own identity and settings. The service reads the due tracking rows (`WORKFLOW_MERGE_RECOVERY`, `kind: "tracking"`, written by the publish step) when its `sweep` is called; the host decides what calls it (a timer, a
// webhook that calls `wake`, a schedule).
//
// Merge tracking never presses merge: it may take a draft out of draft and ask for the project's reviewers, and only for a task waiting for its merge (the pass checks that), and the deciders ask for a coding run (a CI
// fix) or a merge of the base. A person merges, in the code host or with their proof.
//
// Rate limits: a pass has a request allowance (`trackingRequestCap`), a sweep has one too, and a row waits longer each time nothing changed (60 s, doubling to 5 min) or a pass failed (60 s times the failures, up to
// 15 min). A code host that says "slow down" (`HostRateLimitError`) pauses every row until the time it names.
//
// Nothing here names a provider; the code host is whatever the repository's record names, and a host that cannot read a merge (`mergeObservation`) is simply never seen merged.
import {
  IMPLICIT_COMPANY_ID, OrgIdSchema, companyScoped, blockWorkflow, INDEX_EXPIRY_ATTRIBUTE, TRACKING_GATE_SECONDS, TRACKING_HEARTBEAT_MINUTES, change, hostRateLimitRetryAt, observeWorkflowPullRequest, queryAll, when,
  type Condition, type OrgId, type ReadBudget, type RegistryView, type TransactItem, type UpdateOp, type WorkflowSnapshot,
} from "@agentx/contracts";
import { SWEEP_INTERVAL_MS, type MergeRecoveryResult } from "../core/merge/budget.js";
import type { RepositoryResolver } from "../core/merge/host-port.js";
import { changeRequestRef } from "../core/merge/host-port.js";
import { storeLinkedChangeRequests } from "../core/merge/linked.js";
import { mergedMilestoneItems, mergedStateItems } from "../core/merge/merged.js";
import { setupUpdateOfferItems } from "../core/setup-agent/plan-update.js";
import { createDocumentMilestones, type DocumentMilestones } from "../core/milestones/milestones.js";
import { reconcileTrackingTask, registerMergeActionDecider, rowBudget, type MergeTrackingDependencies, type TrackingReconcileDependencies } from "../core/merge/merge-tracking.js";
import type { MergePeople } from "../core/merge/people.js";
import { outOfOrderMilestoneItems } from "../core/merge/order-watch.js";
import { registryRepositoryResolver } from "../core/merge/resolver.js";
import type { SummaryCheckSource } from "../core/merge/summary-check.js";
import { createPullRequestVerdictSource } from "../core/build-step/pull-request-verdict.js";
import type { CodeMilestones, CodeSettingsReader, HumanEditSink, MergeTask, SessionTimeline } from "../core/merge/seams.js";
import { readMergeTracking, recoveryRowKey, workflowUpdateItem } from "../core/merge/store.js";
import { engineStampKey } from "../core-host/engine-stamp.js";
import { sessionBindingsOf } from "../core/sessions/bindings.js";
import { sessionEventItem } from "../core/sessions/store.js";
import { verifyPublishedChanges } from "../core/build-step/changed-files.js";
import { runTierChecks } from "../core/build-step/tier-checks.js";
import { scopeHoldOf } from "../core/build-step/scope-question.js";
import { skippedPlanning } from "../core/decisions/change-tier.js";
import { growthOwedOf, owedLevelOf } from "../core/merge/grown-owed.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { readTask } from "../core/task-flow/reads.js";
import { announceTaskEnd, completedByMerge } from "../core/task-flow/task-end.js";
import { recordedHeadOf } from "../core/build-step/head-check.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { flowWorkEventItems } from "../core/work-events/flow-events.js";

/** The first wait after a pass, and the wait the quiet rows grow to. */
export const TRACKING_POLL_MS = TRACKING_GATE_SECONDS * 1_000;
export const TRACKING_QUIET_MAX_MS = SWEEP_INTERVAL_MS;
/** What a failing pass waits: its failures times one gate, up to the heartbeat. */
export const TRACKING_FAILURE_MAX_MS = TRACKING_HEARTBEAT_MINUTES * 60_000;
/** One sweep: at most this many rows, this many requests to the code host and this long. */
export const SWEEP_MAX_ROWS = 10;
export const SWEEP_MAX_REQUESTS = 256;
export const SWEEP_MAX_MS = 20_000;
/** The sweep's reads end this long before the pass deadline (a smaller share of a short pass), so its settle writes always fit. */
export const SETTLE_RESERVE_MS = 3_000;
export const SETTLE_RESERVE_SHARE = 0.15;
/** One row's time is split in phases that never take each other's time: verify takes this share of it, feedback takes `FEEDBACK_SHARE` of what is left, reconcile takes the rest. */
export const VERIFY_SHARE = 0.45;
export const FEEDBACK_SHARE = 0.4;
/** The sweep owns the GitHub requests of a background pass only: it stops while less than this share of the rate limit (and never fewer than the minimum) is left, so a person's own action has requests to use. */
export const RATE_RESERVE_SHARE = 0.05;
export const RATE_RESERVE_MIN = 200;
/** Owned due rows of one page read before the fairness order picks `SWEEP_MAX_ROWS` of them. */
export const DUE_CANDIDATES_MAX = 3 * SWEEP_MAX_ROWS;
/** One task's lighter-flow checks: their own allowance of requests, and at most this much of a pass's time (the reviewer calls are bounded on their own). */
export const TIER_CHECKS_MAX_REQUESTS = 256;
export const TIER_CHECKS_MAX_MS = 4 * 60_000;
/** One tier pass, all tasks together: the rest wait for the next pass (they are taken oldest run first). */
export const TIER_PASS_MAX_MS = 10 * 60_000;
/** How long a task may wait for a tier pass before the install says loudly that none runs. */
export const TIER_STALL_MS = 30 * 60_000;
/** What the task says when its pull request ended at a head Rovara did not check. */
export const MERGED_OUTSIDE = "The pull request was merged with commits Rovara did not check, so this is not a merge of the code Rovara checked. Look at what was merged, then close this task.";
export const CLOSED_OUTSIDE = "The pull request was closed on the code host with commits Rovara did not check. Look at it there, then close this task.";

type Log = (entry: Record<string, unknown>) => void;

/** What a row's last pass could not finish, kept on its recovery row for whoever looks: the pull request's files were not all read from the code host, or its feedback was not collected. Cleared by a pass that finished. */
type ReadState = "github_read_incomplete" | "feedback_incomplete";
/** A due row of the recovery index, as one sweep reads it. */
interface DueRow { taskId: string; attempts: number; quiet: number; nextAttemptAt: number; lastAttemptAt: number; lastHintAt: number }
interface RowOutcome { result: MergeRecoveryResult; readState?: ReadState }
/** Fairness: the fewest failed attempts first, then the longest since the last attempt (round robin), then the earliest due. */
const dueOrder = (left: DueRow, right: DueRow): number => left.attempts - right.attempts || left.lastAttemptAt - right.lastAttemptAt || left.nextAttemptAt - right.nextAttemptAt || (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);

// ---- the session timeline and the milestone hook

/** The session's event log is the timeline: a status line is one event of the system, written once for the same id. */
export function sessionTimeline(): SessionTimeline {
  return {
    statusLine: (session, event) => sessionEventItem({ orgId: session.orgId, sessionId: session.sessionId }, { eventId: event.eventId, at: event.at, type: "status", actor: { kind: "system" }, text: event.text }),
  };
}

/**
 * The milestone hook over the document store (`core/milestones`): the items of one milestone are a row in the task's partition (written only if absent, so a repeat of the same occurrence adds nothing) and a line on
 * the task's session, in the transaction of the change that caused it. `deliver` tells the handlers an adapter registered after the commit; none are registered by default (a `channel` adapter reads the session's
 * change, `core/notify`), and `deliverDue`, run by the host's tick, tells again a handler that was not told.
 */
export function createMilestoneService(options: Parameters<typeof createDocumentMilestones>[0]): DocumentMilestones {
  return createDocumentMilestones(options);
}

// ---- the task as the merge core reads it

/** The part of the task record the merge core reads. A task of another company reads as absent. */
export function mergeTaskOf(record: TaskRecord, companyId: OrgId): (MergeTask & { orgId: OrgId }) | undefined {
  if (record.companyId !== companyId) return undefined;
  return {
    taskId: record.taskId, orgId: companyId, project: record.project, startingRevision: record.startingRevision, workspaceId: record.workspaceId,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }), ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
    ...(record.releasedAt === undefined ? {} : { releasedAt: record.releasedAt }), ...(record.workflow === undefined ? {} : { workflow: record.workflow }),
    ownerId: record.workflow?.ownerId ?? record.ownerKey, ownerName: record.developerName ?? "the owner", creatorId: record.developerId,
    ...(record.secondOpinion === undefined ? {} : { secondOpinion: record.secondOpinion }), ...(record.secondReviewAcknowledged === undefined ? {} : { secondReviewAcknowledged: record.secondReviewAcknowledged }),
  };
}

/** The number a recovery row holds in `name`, or `fallback`. */
const numberOf = (row: Record<string, unknown> | undefined, name: string, fallback = 0): number => typeof row?.[name] === "number" ? row[name] : fallback;

/**
 * Makes a tracking row due sooner (the service's `wake`), for a caller that has no service at hand: the hosted Merge button, right after a merge, so the next sweep records the merge in the task's workflow (MERGED,
 * with its milestone), and when the merge core asks for a branch to be brought up to date; and a webhook, which only nudges. Does nothing for a task with no tracking row. Best effort.
 *
 * A wake records WHEN it came (`lastHintAt`, never moved back), so a sweep that is reading the row right now cannot overwrite it. It only LOWERS `nextAttemptAt`, and a row that is failing (`attempts` above 0) is never made due
 * before its failure wait is over (its last attempt plus the failures times one gate, up to the heartbeat): a busy pull request's events cannot make a stalling read run every few seconds. A caller that acts for a person (a
 * Merge press) passes `bypassBackoff`.
 */
export async function wakeMergeTracking(store: Pick<TaskFlowDeps["store"], "get" | "update">, taskId: string, now: number, options: { pollMs?: number; bypassBackoff?: boolean } = {}): Promise<void> {
  const key = recoveryRowKey(taskId);
  try {
    const row = await store.get(key);
    if (row === undefined || row["kind"] !== "tracking") return;
    const attempts = numberOf(row, "attempts");
    const lastAttemptAt = numberOf(row, "lastAttemptAt", typeof row["updatedAt"] === "string" ? Date.parse(row["updatedAt"]) || 0 : 0);
    const failureWait = attempts > 0 && options.bypassBackoff !== true ? lastAttemptAt + Math.min((options.pollMs ?? TRACKING_POLL_MS) * attempts, TRACKING_FAILURE_MAX_MS) : 0;
    const nextAttemptAt = Math.min(numberOf(row, "nextAttemptAt", Number.MAX_SAFE_INTEGER), Math.max(now, failureWait));
    await store.update({ key, ops: [change.set("nextAttemptAt", nextAttemptAt), change.set("quiet", 0), change.set("lastHintAt", Math.max(numberOf(row, "lastHintAt"), now))], condition: when.and(when.present(), when.eq("kind", "tracking")) });
  } catch { /* best effort: the sweep finds the row on its own time */ }
}

/** A wake for a person's own action (the Merge press, a branch the press found behind): never delayed by a failing row's wait. Only background wakes (a webhook) respect it. */
export const wakeMergeTrackingForPerson = (store: Pick<TaskFlowDeps["store"], "get" | "update">, taskId: string, now: number): Promise<void> =>
  wakeMergeTracking(store, taskId, now, { bypassBackoff: true });

const budgetExhausted = (): Error => {
  const exhausted = new Error("the sweep used its request allowance");
  exhausted.name = "GithubBudgetExhaustedError";
  return exhausted;
};

/** A budget for one sweep: a request allowance and a deadline shared by everything it reads. `stop` ends its timer. */
export function createReadBudget(now: () => number, limits: { requests: number; ms: number } = { requests: SWEEP_MAX_REQUESTS, ms: SWEEP_MAX_MS }): { budget: ReadBudget; stop: () => void } {
  const controller = new AbortController();
  const startedAt = now();
  let requests = 0;
  const timer = setTimeout(() => controller.abort(), limits.ms);
  timer.unref();
  return {
    stop: () => clearTimeout(timer),
    budget: {
      signal: controller.signal,
      beforeRequest: () => {
        if (controller.signal.aborted || now() >= startedAt + limits.ms || requests >= limits.requests) {
          controller.abort();
          throw budgetExhausted();
        }
        requests += 1;
      },
    },
  };
}

/**
 * One phase of one row (verify, feedback or reconcile): its OWN timer and signal, so a phase that stalls ends at its own time (the signal also ends the GitHub requests in flight, through the request context) and never takes
 * the time of the phase after it. It shares only the request count of its `parent`, and ends with the parent.
 */
export function createPhaseBudget(now: () => number, parent: ReadBudget, ms: number): { budget: ReadBudget; stop: () => void } {
  const own = new AbortController();
  const startedAt = now();
  const timer = setTimeout(() => own.abort(), Math.max(1, ms));
  timer.unref();
  const signal = AbortSignal.any([parent.signal, own.signal]);
  return {
    stop: () => clearTimeout(timer),
    budget: {
      signal,
      beforeRequest: () => {
        if (signal.aborted || now() >= startedAt + ms) { own.abort(); throw budgetExhausted(); }
        parent.beforeRequest();
      },
    },
  };
}

/** What a host wraps around each phase so the GitHub requests made inside it end with the phase, are logged with their timing and report the rate limit (the GitHub plugin's request context). Default: nothing. */
export interface SweepRequestScope {
  <T>(context: { signal: AbortSignal; log: (entry: Record<string, unknown>) => void; onRateLimit: (state: { remaining: number; limit: number; resetAt: number }) => void }, work: () => Promise<T>): Promise<T>;
}

/** The repository of a task's project, on the code host its record names (and the runner that reads that host's build logs, when one is registered). */
export function createRepositoryResolver(flow: Pick<TaskFlowDeps, "projects">, registry: RegistryView): ReturnType<typeof registryRepositoryResolver> {
  return registryRepositoryResolver(registry, {
    async pinned(project, revision, repositoryId) {
      const found = (await flow.projects.revision(project, revision))?.definition.repositories.find((entry) => entry.name === repositoryId);
      return found === undefined ? undefined : { url: found.url, ...((found as { host?: { kind: string } }).host === undefined ? {} : { host: (found as { host: { kind: string } }).host }) };
    },
    // The runner that reads this host's build logs, built for the repository it serves (a host may register none: a CI fix is then told which check failed, without the log).
    checkRunner: (kind, repository) => registry.get("check-runner", kind)?.create({ allowedRepositories: [repository.url] }),
  });
}

export interface MergeTrackingServiceOptions {
  flow: TaskFlowDeps;
  registry: RegistryView;
  companyId: OrgId;
  milestones: CodeMilestones;
  /** Who a person is on the code host, and whether their approval counts. Not defaulted: a host with one owner passes `soleOwnerPeople`, a host with members passes a reader over its own identity (`createIdentityMergePeople`). */
  people: MergePeople;
  /** The project's code settings (self-approval, merge method, reviewers). Not defaulted: a host with fixed settings passes `fixedCodeSettings(...)`. */
  settings: CodeSettingsReader;
  timeline?: SessionTimeline;
  /** Deployed hosts inject a company-scoped resolver; no provider is constructed here. */
  repository?: RepositoryResolver;
  /** Retained by a short-lived pass composer, per company; never stored or shared between companies. */
  scan?: { cursor: string | undefined; complete?: boolean };
  ciMode?: MergeTrackingDependencies["ciMode"];
  /** TE-E0 / L4-EVCI: the project's CI evidence settings (the checks the customer marked, and their own eval check), read per pass; the host stores them. Absent: nothing is marked or named and a pass is what it always was. */
  ciEvidence?: MergeTrackingDependencies["ciEvidence"];
  /** TE-E0 option B: the host's per-test report parser. Absent: no per-test report is read. */
  reportParser?: MergeTrackingDependencies["reportParser"];
  /**
   * TE-B4: the one "Rovara" Check on each head. The host decides whether it is written and where it points (`enabled`, `facts`, `detailsUrl`, `personName`); the service adds the verdict: unless the host gives its own `verdict`, the
   * Check's title and text carry the same verdict sentence as the pull request's description (`createPullRequestVerdictSource`, L4-PRP). Absent: no Check is written, as before.
   */
  summaryCheck?: SummaryCheckSource;
  /** MR3b: the dependency facts between a task's repositories (`createRepositoryEdgesSeam`). Absent: a pull request merged out of order is not warned about, and no pull request is held for the order. */
  repositoryEdges?: ((task: MergeTask) => unknown) | undefined;
  /** L4-LM1c: told when a pass sees a head a person pushed (learning from people's edits to Rovara's pull requests). Absent: nothing is told. */
  humanEdit?: HumanEditSink | undefined;
  /** Milliseconds since the epoch. The host's clock, so a test can move it. */
  now: () => number;
  log?: Log;
  /** Wraps each phase of a row (`SweepRequestScope`): the host passes the GitHub plugin's request context. Absent: the phases still have their own budgets and signals, but no request is timed, logged or ended by the signal. */
  requestScope?: SweepRequestScope;
  /** Overrides, for tests: the rows' first wait and the quiet cap. */
  pollMs?: number;
  quietMaxMs?: number;
}

export interface MergeTrackingService {
  /** The dependencies of one tracking pass (the same a test may call `trackPullRequest` with). */
  readonly deps: TrackingReconcileDependencies;
  /** One sweep: the due tracking rows, at most `SWEEP_MAX_ROWS`, each reconciled once. Never throws; one sweep at a time. */
  sweep(options?: { budgetMs: number }): Promise<{ attempted: number }>;
  /** Makes a task's tracking row due now (a push of Rovara's, the owner's Retry). Does nothing for a task with no row. */
  wake(taskId: string): Promise<void>;
  /** When every row is paused until, if the code host asked Rovara to slow down (milliseconds since the epoch). */
  readonly pausedUntil: () => number | undefined;
  /** Pauses every row (and the comment poll) until the time a code host named when it asked Rovara to slow down. */
  pauseUntil(retryAt: number): void;
  /** Waits for a sweep that is running. */
  idle(): Promise<void>;
  /** The lighter flow's checks for the tasks the sweeps found owing them, each in its own allowance (model calls take long; the sweep never waits for them). Answers how many ran. */
  tierChecks(): Promise<number>;
}

export function createMergeTrackingService(options: MergeTrackingServiceOptions): MergeTrackingService {
  const { flow, registry, companyId, milestones, now, people, settings } = options;
  if (!OrgIdSchema.safeParse(companyId).success) throw new Error("the merge tracking company is invalid");
  const store = flow.store;
  const log = options.log ?? (() => undefined);
  const timeline = options.timeline ?? sessionTimeline();
  const pollMs = options.pollMs ?? TRACKING_POLL_MS;
  const quietMaxMs = options.quietMaxMs ?? TRACKING_QUIET_MAX_MS;

  const loadTask = async (taskId: string): Promise<(MergeTask & { orgId: OrgId }) | undefined> => {
    // D1-2 (ruling g): a task with no core mark is the retired old workflow's. It reads as absent here, so the sweep, the observation and the hooks never touch its row (no read of GitHub, no
    // settle, no delete): its WORKFLOW_MERGE_RECOVERY row stays exactly as it is.
    if (await store.get(engineStampKey(taskId)) === undefined) return undefined;
    const record = await readTask(flow, taskId);
    return record === undefined ? undefined : mergeTaskOf(record, companyId);
  };

  const givenResolver = options.repository ?? createRepositoryResolver(flow, registry);
  const resolver: RepositoryResolver = (project, revision, repositoryId, orgId) => {
    if (orgId !== companyId) return Promise.resolve(undefined);
    return givenResolver(project, revision, repositoryId, companyId);
  };

  installFeedbackDecider(registerMergeActionDecider);
  const verdictSource = createPullRequestVerdictSource(flow);
  const base: MergeTrackingDependencies = {
    store, now,
    feedbackRoundCheck: async task => {
      try {
        const record = await readTask(flow, task.taskId);
        if (record === undefined || record.companyId !== companyId) return false;
        return (await readFeedbackReport(flow, record)).status === "COMPLETE";
      } catch { return false; }
    },
    sendFeedbackReplies: sendPrFeedbackReplies,
    ...(options.ciMode === undefined ? {} : { ciMode: options.ciMode }),
    ...(options.ciEvidence === undefined ? {} : { ciEvidence: options.ciEvidence }),
    ...(options.reportParser === undefined ? {} : { reportParser: options.reportParser }),
    settings, milestones, timeline, people, links: storeLinkedChangeRequests(store),
    scope: (orgId) => ({ orgId }),
    loadTask,
    repositoryUrl: async (project, revision, repositoryId) => (await flow.projects.revision(project, revision))?.definition.repositories.find((entry) => entry.name === repositoryId)?.url,
    repository: resolver,
    // A pull request seen "changed outside Rovara" has no recorded head, so its head reads as someone else's and it is never called ready.
    recordedHead: recordedHeadOf(flow),
    // A small change that grew to risky stays a draft until a person keeps it and the risky reviews pass.
    readyHold: (task, current) => scopeHoldOf(flow, task, current),
    ...(options.repositoryEdges === undefined ? {} : { repositoryEdges: options.repositoryEdges }),
    // Slice A4: a change this pass makes to the workflow writes its work events in the same transaction, when the flow writes them (the same switch as the flow's own).
    ...(flow.workEvents === true ? { workEvents: (task: { taskId: string; orgId: OrgId; project: string }, before: WorkflowSnapshot, after: WorkflowSnapshot, room: number) => flowWorkEventItems({ enabled: true, orgId: task.orgId, project: task.project, before, after, room }) } : {}),
    // L4-PRP: the verdict of a pull request, the words of its description: for the Check (when the host asks for one) and for the "ready for review" line.
    verdict: verdictSource,
    ...(options.summaryCheck === undefined ? {} : { summaryCheck: { ...options.summaryCheck, verdict: options.summaryCheck.verdict ?? verdictSource } }),
    ...(options.humanEdit === undefined ? {} : { humanEdit: options.humanEdit }),
    log: (event, fields) => log({ component: "merge_tracking", event, ...fields }),
  };

  // The merge observation: what a webhook would have told. A pull request the host says merged (or closed) is recorded in the workflow with the milestone and the state it leaves, in one commit, only when the head
  // the host shows is the head Rovara recorded; any other head is not the reviewed code, and is left for the owner to see on the pull request.
  const observeMerge = async (taskId: string, budget: ReadBudget): Promise<MergeRecoveryResult> => {
    const task = await loadTask(taskId);
    if (task === undefined) return { kind: "MISSING" };
    const workflow = task.workflow;
    if (task.closedAt !== undefined || task.releasedAt !== undefined || workflow === undefined || workflow.stage === "MERGED" || workflow.stage === "CLOSED") return { kind: "TERMINAL", release: "confirmed" };
    for (const pullRequest of workflow.pullRequests ?? []) {
      if (pullRequest.state === "MERGED") continue;
      const home = await resolver(task.project, task.startingRevision, pullRequest.repositoryId, companyId);
      if (home === undefined || home.codeHost.mergeObservation === undefined) continue;
      const ref = changeRequestRef(home.url, pullRequest.number);
      const details = await home.codeHost.mergeObservation(ref, { orgId: companyId }, budget);
      const state = details.state === "merged" ? "MERGED" as const : details.state === "closed" ? "CLOSED" as const : "OPEN" as const;
      // Only a change the workflow does not know: a merge, a close, or a closed pull request opened again. An open pull request the workflow has as open (or does not know yet) is left as it is, so a fix
      // being coded or pushed is never moved back to waiting by a read.
      if (state === "OPEN" && pullRequest.state !== "CLOSED") continue;
      const at = new Date(now()).toISOString();
      if (state !== "OPEN" && details.headRevision !== pullRequest.headSha) {
        // Merged or closed at a head Rovara did not check (a reviewer's fix-up, say): that is not the merge of the checked code and the workflow does not say it is. The task stops waiting, with the fact in
        // plain words on its page and its session, and the tracking row ends.
        const outside = blockWorkflow(workflow, state === "MERGED" ? MERGED_OUTSIDE : CLOSED_OUTSIDE, at);
        const stuck = milestones.items({
          kind: "stuck", orgId: companyId, taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at, text: state === "MERGED" ? MERGED_OUTSIDE : CLOSED_OUTSIDE,
          pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }],
        }, outside.revision, { definitionVersion: workflow.definitionVersion });
        const recorded = await store.transact([workflowUpdateItem(taskId, outside, workflow.revision, workflow), ...stuck]);
        if (recorded.applied) await milestones.deliver(taskId).catch(() => undefined);
        return recorded.applied ? { kind: "TERMINAL", release: "confirmed" } : { kind: "OBSERVED" };
      }
      const next = observeWorkflowPullRequest(workflow, { repositoryId: pullRequest.repositoryId, number: pullRequest.number, candidateDigest: pullRequest.candidateDigest, state, source: "CODE_HOST", observedAt: at }, at);
      const items: TransactItem[] = [
        workflowUpdateItem(taskId, next, workflow.revision, workflow),
        ...await mergedMilestoneItems({ milestones, bindings: { read: (orgId, sessionId) => sessionBindingsOf(store, orgId, sessionId) } }, task, workflow, next, at),
        // L4-SC (DEC 254z c): a merged plan's setup change leaves ONE "Update setup" offer, in the merge's own transaction. Never blocks the merge: a plan that cannot be read adds nothing.
        ...await setupUpdateOfferItems(flow, task, workflow, next, at).catch((): TransactItem[] => []),
        ...await mergedStateItems({ store, timeline, audit: flow.audit, log: (event, fields) => log({ component: "merge_tracking", event, ...fields }) }, task, workflow, next, at,
          state === "MERGED" ? [{ repositoryId: pullRequest.repositoryId, number: pullRequest.number, ...(details.mergedBy === undefined ? {} : { mergedBy: details.mergedBy }), ...(details.mergeRevision === undefined ? {} : { mergeCommit: details.mergeRevision }) }] : []),
      ];
      // MR3b: a pull request merged by hand ahead of the one it depends on is said once, on the session and in the chat, naming every pull request of the task.
      if (state === "MERGED") {
        // Informational: a fault while building the warning never stops the merge from being recorded (a host's "slow down" still goes up to the sweep).
        try {
          items.push(...await outOfOrderMilestoneItems({
            milestones, repositoryEdges: options.repositoryEdges, log: (event, fields) => log({ component: "merge_tracking", event, ...fields }),
            providerState: async (repositoryId) => {
              const provider = workflow.pullRequests?.find((entry) => entry.repositoryId === repositoryId && entry.required);
              const providerHome = provider === undefined ? undefined : await resolver(task.project, task.startingRevision, repositoryId, companyId);
              if (provider === undefined || providerHome?.codeHost.mergeObservation === undefined) return "unknown";
              // A provider closed without merging is not "waiting to merge": it is not said about.
              const read = (await providerHome.codeHost.mergeObservation(changeRequestRef(providerHome.url, provider.number), { orgId: companyId }, budget)).state;
              return read === "merged" ? "merged" : read === "open" ? "not_merged" : "unknown";
            },
          }, { ...task, orgId: companyId, workflow: next }, workflow, next, at));
        } catch (error) {
          if (hostRateLimitRetryAt(error) !== undefined) throw error;
          log({ component: "merge_tracking", event: "merge_tracking.order_warning_failed", error: error instanceof Error ? error.name : "unknown" });
        }
      }
      const written = await store.transact(items);
      if (written.applied) await milestones.deliver(taskId).catch(() => undefined);
      // The merge completed the task: the host is told it ended, right after the merge's own commit and once (a later close does not tell it again, and a merge seen twice commits once).
      if (written.applied && completedByMerge(workflow, next)) await announceTaskEnd(flow, taskId, "merged");
      // Every pull request merged: the task is over and its row goes. Otherwise the next pull request is seen on the next pass, from the workflow as it now is.
      return written.applied && next.stage === "MERGED" ? { kind: "TERMINAL", release: "confirmed" } : { kind: "OBSERVED" };
    }
    return { kind: "OBSERVED" };
  };

  const deps: TrackingReconcileDependencies = { ...base, observeMerge };

  // ---- the sweep

  let cooldownUntil: number | undefined;
  const COOLDOWN_KEY = companyId === IMPLICIT_COMPANY_ID
    ? { pk: "WORKFLOW_MERGE_SWEEP", sk: "COOLDOWN" }
    : { pk: companyScoped(companyId, "WORKFLOW_MERGE_SWEEP"), sk: "COOLDOWN" };
  /** The pause a code host asked for is kept, so a restart of `rovara up` inside it does not ask the host again at once. */
  const remember = async (until: number | undefined): Promise<void> => {
    await (until === undefined ? store.delete({ key: COOLDOWN_KEY }) : store.put({ item: { ...COOLDOWN_KEY, entityType: "WORKFLOW_MERGE_SWEEP", until, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(until / 1000) + 86_400 } })).catch(() => undefined);
  };
  let cooldownRead = false;
  let sweeping: Promise<{ attempted: number }> | undefined;

  const scan = options.scan ?? { cursor: undefined as string | undefined, complete: false };
  /** A due row as the sweep reads it from the recovery index (fields of the row only; its task's ownership is checked before it is counted). */
  const dueRowOf = (row: Record<string, unknown>): DueRow | undefined => {
    if (row["kind"] !== "tracking" || typeof row["taskId"] !== "string" || typeof row["nextAttemptAt"] !== "number" || row["nextAttemptAt"] > now()) return undefined;
    return { taskId: row["taskId"], attempts: numberOf(row, "attempts"), quiet: numberOf(row, "quiet"), nextAttemptAt: row["nextAttemptAt"], lastAttemptAt: numberOf(row, "lastAttemptAt"), lastHintAt: numberOf(row, "lastHintAt") };
  };
  /**
   * The due rows of this pass: the owned due rows of the pages read (at most `DUE_CANDIDATES_MAX`), the fewest failed attempts first and, among those, the one tried longest ago (round robin), and of those the first
   * `SWEEP_MAX_ROWS`. A pull request that keeps failing waits behind every healthy one, and a lower key never decides who is read.
   */
  const dueRows = async (deadline: number): Promise<DueRow[]> => {
    const due: DueRow[] = [];
    let read = 0;
    do {
      if (now() >= deadline || read >= 1000 || due.length >= DUE_CANDIDATES_MAX) break;
      const page = await store.query({ pk: "WORKFLOW_MERGE_RECOVERY", sk: { op: "beginsWith", prefix: "TASK#" }, limit: Math.min(100, 1000 - read), ...(scan.cursor === undefined ? {} : { cursor: scan.cursor }) });
      for (const row of page.items) {
        if (now() >= deadline || read >= 1000) break;
        read += 1;
        const candidate = dueRowOf(row);
        // Shared recovery index: establish ownership BEFORE reading tracking state, calling a host, or settling/deleting a row.
        if (candidate === undefined || await loadTask(candidate.taskId) === undefined) continue;
        due.push(candidate);
        if (due.length >= DUE_CANDIDATES_MAX) break;
      }
      // A full candidate batch may end inside this page: revisit it next pass, never skip unprocessed due rows.
      if (due.length < DUE_CANDIDATES_MAX) scan.cursor = page.cursor;
      else break;
      // The page's due rows are what the order picks from: the pass's own reads (each owned row costs a read of its task) stay bounded, so the next page is read only when this one had none.
      if (due.length > 0) break;
    } while (scan.cursor !== undefined);
    scan.complete = scan.cursor === undefined && due.length < SWEEP_MAX_ROWS && now() < deadline;
    return due.sort(dueOrder).slice(0, SWEEP_MAX_ROWS);
  };

  /** One write to a row of the recovery index: true when it applied, false when its condition failed, undefined when it threw (logged, never swallowed). */
  const writeRow = async (taskId: string, ops: UpdateOp[], condition: Condition): Promise<boolean | undefined> => {
    try {
      return (await store.update({ key: recoveryRowKey(taskId), ops, condition })).applied;
    } catch (error) {
      log({ component: "merge_tracking", event: "sweep.settle_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  };

  /** What a finished row writes back: the wait for the next pass and the row's read state. Every outcome moves `lastAttemptAt`; a failed pass advances `attempts`. */
  const settleFields = (row: DueRow, result: Exclude<MergeRecoveryResult, { kind: "TERMINAL" | "MISSING" }>, changed: boolean, at: number): Record<string, number | string> => {
    if (result.kind === "OBSERVED") {
      // Quiet rows wait longer (60 s, doubling to the cap); anything that changed, or a hint of the pass that says when the answer will, starts again.
      const quiet = changed ? 0 : row.quiet + 1;
      const wait = Math.min(quietMaxMs, pollMs * 2 ** Math.min(quiet, 10));
      const hinted = result.nextAt === undefined ? at + wait : Math.min(at + wait, Math.max(at + pollMs, result.nextAt));
      return { nextAttemptAt: hinted, attempts: 0, quiet, updatedAt: new Date(at).toISOString(), lastObservedAt: at, lastAttemptAt: at };
    }
    const attempts = row.attempts + 1;
    return { nextAttemptAt: Math.max(result.retryAt, at + Math.min(pollMs * attempts, TRACKING_FAILURE_MAX_MS)), attempts, updatedAt: new Date(at).toISOString(), lastAttemptAt: at };
  };

  const settle = async (row: DueRow, result: MergeRecoveryResult, changed: boolean, readState?: ReadState): Promise<void> => {
    const key = recoveryRowKey(row.taskId);
    if (result.kind === "TERMINAL" || result.kind === "MISSING") {
      // The task is over (merged, closed, gone): no more passes. The row goes; the task's history stays on the task.
      try { await store.delete({ key, condition: when.present() }); } catch (error) { log({ component: "merge_tracking", event: "sweep.settle_failed", taskId: row.taskId, error: error instanceof Error ? error.name : "unknown" }); }
      return;
    }
    const at = now();
    if (result.kind === "RETRY" && result.scope === "github-global") { cooldownUntil = Math.max(cooldownUntil ?? 0, result.retryAt); await remember(cooldownUntil); }
    const fields = settleFields(row, result, changed, at);
    const ops = (values: Record<string, number | string>): UpdateOp[] => [...Object.entries(values).map(([name, value]) => change.set(name, value)), ...(readState === undefined ? [change.remove("readState")] : [change.set("readState", readState)])];
    // A hint (a wake) that came after the pass chose this row is merged, never overwritten: the write applies only while the row's `lastHintAt` is the one the pass saw.
    const applied = await writeRow(row.taskId, ops(fields), when.and(when.present(), when.or(when.notExists("lastHintAt"), when.lte("lastHintAt", row.lastHintAt))));
    if (applied !== false) return;
    // Hinted during the pass: keep the hint's due time (a pass that saw no change is due again now; a failing one keeps its wait), and the failure facts.
    await writeRow(row.taskId, ops(result.kind === "OBSERVED" ? { ...fields, nextAttemptAt: at, quiet: 0 } : fields), when.present());
  };

  /**
   * The tasks the sweep found owing the lighter flow's checks are kept as rows (`TIER_CHECKS_DUE`), so a host that only sweeps (or a short-lived one) still runs the tier pass later. The pass takes them oldest
   * run first (round robin), each with its own allowance and a share of the pass's time; a row goes only once its task was checked (or owes nothing), never before a code host's pause is honoured.
   */
  const tierDueKey = (taskId: string) => companyId === IMPLICIT_COMPANY_ID
    ? { pk: "TIER_CHECKS_DUE", sk: `TASK#${taskId}` }
    : { pk: companyScoped(companyId, "TIER_CHECKS_DUE"), sk: `TASK#${taskId}` };
  const markTierDue = async (taskId: string): Promise<void> => {
    await store.put({ item: { ...tierDueKey(taskId), entityType: "TIER_CHECKS_DUE", companyId, taskId, lastRunAt: 0, dueAt: now() }, condition: when.absent() }).catch(() => undefined);
    // A host that sweeps but never runs the tier pass (`tierChecks`) leaves every lighter-flow task held: say so loudly, once per task and hour.
    const row = await store.get(tierDueKey(taskId)).catch(() => undefined);
    const dueAt = typeof row?.["dueAt"] === "number" ? row["dueAt"] : now();
    const lastRunAt = typeof row?.["lastRunAt"] === "number" ? row["lastRunAt"] : 0;
    if (now() - Math.max(dueAt, lastRunAt) > TIER_STALL_MS && (stallLogged.get(taskId) ?? 0) + 3_600_000 < now()) {
      stallLogged.set(taskId, now());
      console.error(JSON.stringify({ component: "merge_tracking", event: "tier_checks.not_running", level: "error", taskId, waitingMs: now() - Math.max(dueAt, lastRunAt), words: "No tier pass has run for this task: its pull request stays held. Call MergeTrackingService.tierChecks() on a schedule." }));
    }
  };
  /** A task that ran its whole plan owes the tier pass only while the higher level's reviews are owed on its open pull requests' heads and can still run (not once they are on the record, nor after a verdict a new version alone changes). */
  const growthReviewsDue = async (task: NonNullable<Awaited<ReturnType<typeof readTask>>>): Promise<boolean> => {
    if (owedLevelOf(task.workflow) === undefined) return false;
    const owed = growthOwedOf(task.workflow, await readMergeTracking(store, task.taskId, task.companyId).catch(() => []));
    return owed !== undefined && (owed.state === "reviewing" || owed.cap === true);
  };
  const stallLogged = new Map<string, number>();
  let tierRunning: Promise<number> | undefined;
  const runTierPass = async (): Promise<number> => {
    const rows = (await queryAll(store, companyId === IMPLICIT_COMPANY_ID
      ? { pk: "TIER_CHECKS_DUE", sk: { op: "beginsWith", prefix: "TASK#" }, filter: when.or(when.eq("companyId", companyId), when.notExists("companyId")) }
      : { pk: companyScoped(companyId, "TIER_CHECKS_DUE"), sk: { op: "beginsWith", prefix: "TASK#" }, filter: when.eq("companyId", companyId) }).catch(() => []))
      .sort((left, right) => Number(left["lastRunAt"] ?? 0) - Number(right["lastRunAt"] ?? 0));
    const passEnds = now() + TIER_PASS_MAX_MS;
    let ran = 0;
    for (const row of rows) {
      if (cooldownUntil !== undefined && now() < cooldownUntil) break;
      const left = passEnds - now();
      if (left <= 0) break;
      const taskId = typeof row["taskId"] === "string" ? row["taskId"] : "";
      // Fail closed on legacy, malformed, or foreign rows before reading a task or touching the queue item.
      // Rows written before tier rows carried a company exist only in the implicit company's shared partition: read them as implicit there (as reads.ts does), never elsewhere.
      const rowCompany = row["companyId"] === undefined && companyId === IMPLICIT_COMPANY_ID ? IMPLICIT_COMPANY_ID : row["companyId"];
      if (rowCompany !== companyId) {
        log({ component: "merge_tracking", event: "tier_checks.unowned_item", companyId, taskId });
        continue;
      }
      if (taskId === "") continue;
      const taskRecord = await readTask(flow, taskId).catch(() => undefined);
      const task = taskRecord?.companyId === companyId ? taskRecord : undefined;
      if (task === undefined || task.closedAt !== undefined) { await store.delete({ key: tierDueKey(taskId) }).catch(() => undefined); continue; }
      // Each task's share: its own requests, and at most a fixed part of the pass's time, so one slow task cannot hold the others back.
      const { budget, stop } = createReadBudget(now, { requests: TIER_CHECKS_MAX_REQUESTS, ms: Math.min(TIER_CHECKS_MAX_MS, left) });
      let outcome: Awaited<ReturnType<typeof runTierChecks>> | undefined;
      try {
        outcome = await runTierChecks(flow, task, budget.beforeRequest);
        ran += 1;
      } catch (error) {
        const limitedUntil = hostRateLimitRetryAt(error);
        if (limitedUntil !== undefined) { cooldownUntil = Math.max(cooldownUntil ?? 0, limitedUntil); await remember(cooldownUntil); break; }
        log({ component: "merge_tracking", event: "tier_checks.failed", taskId, error: error instanceof Error ? error.name : "unknown" });
      } finally {
        stop();
      }
      if (outcome === "checked" || outcome === "not_owed") await store.delete({ key: tierDueKey(taskId) }).catch(() => undefined);
      else await store.update({ key: tierDueKey(taskId), ops: [change.set("lastRunAt", now())], condition: when.present() }).catch(() => undefined);
    }
    return ran;
  };

  // Unread verification is a failed pass, even if reconciliation wrote. Preserve pauses and terminal results.
  const verificationResult = (unverified: boolean, result: MergeRecoveryResult): MergeRecoveryResult =>
    unverified && result.kind === "OBSERVED" ? { kind: "RETRY", retryAt: now() + pollMs, scope: "task" } : result;

  /** The rate limit as the sweep's requests saw it: the latest time GitHub's window resets, once less than the reserve was left. */
  const rateWatch = { resetAt: undefined as number | undefined };
  const onRateLimit = (state: { remaining: number; limit: number; resetAt: number }): void => {
    if (state.remaining < Math.max(RATE_RESERVE_MIN, Math.ceil(state.limit * RATE_RESERVE_SHARE)) && state.resetAt > now()) rateWatch.resetAt = Math.max(rateWatch.resetAt ?? 0, state.resetAt);
  };

  /** Runs one phase of a row on its own budget: a share of the row's time left, its own signal, the host's request scope around it. */
  const inPhase = async <T>(parent: ReadBudget, rowEnd: number, share: number, work: (budget: ReadBudget) => Promise<T>): Promise<T> => {
    const { budget, stop } = createPhaseBudget(now, parent, Math.floor(Math.max(1, rowEnd - now()) * share));
    try {
      const run = () => work(budget);
      return await (options.requestScope === undefined ? run() : options.requestScope({ signal: budget.signal, log: (entry) => log(entry), onRateLimit }, run));
    } finally { stop(); }
  };

  /** Collects the row's PR feedback. Feedback never gates merge tracking: a failure (a host's rate limit excepted) is logged and answers "not finished", and feedback catches up on a later pass. */
  const feedbackUnfinished = async (taskId: string, budget: ReadBudget): Promise<boolean> => {
    try {
      const task = await readTask(flow, taskId);
      return task !== undefined && await collectTrackedFeedback({ flow, registry, repository: resolver, now }, task, budget) === "retry";
    } catch (error) {
      if (hostRateLimitRetryAt(error) !== undefined) throw error;
      log({ component: "merge_tracking", event: "sweep.feedback_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
      return true;
    }
  };

  /** One row: verify, then feedback, then reconcile, each in its own phase (a phase that stalls cannot take the time of the next), so the tracking item is written even when the first two did not finish. */
  const trackRow = async (taskId: string, taskBudget: ReadBudget, requests: number, rowEnd: number): Promise<RowOutcome> => {
    const task = await readTask(flow, taskId);
    // The changed files are read from the code host once for the code the pull requests hold (review H3): until then the risk is high. A host that cannot answer now is asked again soon.
    const verifyBudget = rowBudget(taskBudget, Math.floor(requests / 2));
    const verified = task === undefined ? undefined : await inPhase(verifyBudget, rowEnd, VERIFY_SHARE, (budget) => verifyPublishedChanges(flow, task, budget.beforeRequest));
    const unverified = verified === "unavailable";
    // A task whose planning steps were skipped owes the lighter flow's checks on its current head. They take model calls, so they run in a pass of their own with an allowance of their own (`tierChecks`), never inside this sweep.
    // A task that ran its whole plan owes the same pass once its change grew (the verify phase above is what records the growth, so the task is read again): the higher level's code and security reviews on the current head.
    // Only when it is due: the task is read again only when the verify phase wrote (it is what records growth), and a grown task is scheduled only while the reviews are still owed or can run again.
    const checked = task === undefined ? undefined : verified === "verified" ? await readTask(flow, taskId).catch(() => task) : task;
    if (checked?.workflow !== undefined && (skippedPlanning(checked.workflow.flow) || await growthReviewsDue(checked))) await markTierDue(taskId);
    const unfinished = await inPhase(taskBudget, rowEnd, FEEDBACK_SHARE, (budget) => feedbackUnfinished(taskId, budget));
    const reconciled = verificationResult(unverified, await inPhase(taskBudget, rowEnd, 1, (budget) => reconcileTrackingTask(deps, taskId, budget)));
    // Feedback that did not finish asks for another look in one poll; it is not a failure of the pull request's tracking (no growing wait).
    const result: MergeRecoveryResult = unfinished && reconciled.kind === "OBSERVED" ? { kind: "OBSERVED", nextAt: Math.min(now() + pollMs, reconciled.nextAt ?? Number.MAX_SAFE_INTEGER) } : reconciled;
    return { result, ...(unverified ? { readState: "github_read_incomplete" as const } : unfinished ? { readState: "feedback_incomplete" as const } : {}) };
  };

  const attemptRow = async (row: DueRow, taskBudget: ReadBudget, requests: number, rowEnd: number): Promise<RowOutcome> => {
    try {
      return await trackRow(row.taskId, taskBudget, requests, rowEnd);
    } catch (error) {
      const limitedUntil = hostRateLimitRetryAt(error);
      if (limitedUntil === undefined) log({ component: "merge_tracking", event: "sweep.row_failed", taskId: row.taskId, error: error instanceof Error ? error.name : "unknown" });
      return { result: limitedUntil !== undefined ? { kind: "RETRY", retryAt: limitedUntil, scope: "github-global" } : { kind: "RETRY", retryAt: now() + pollMs, scope: "task" } };
    }
  };

  /** Stops the background sweep until GitHub's window resets when its requests saw the reserve used (a person's own actions share the installation's limit). */
  const pauseForRateReserve = async (): Promise<boolean> => {
    if (rateWatch.resetAt === undefined) return false;
    cooldownUntil = Math.max(cooldownUntil ?? 0, rateWatch.resetAt);
    log({ component: "merge_tracking", event: "sweep.rate_reserve", resetAt: cooldownUntil });
    rateWatch.resetAt = undefined;
    await remember(cooldownUntil);
    return true;
  };

  const runSweep = async (budgetMs: number): Promise<{ attempted: number }> => {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { attempted: 0 };
    const total = Math.min(budgetMs, SWEEP_MAX_MS);
    const deadline = now() + total;
    scan.complete = false;
    if (!cooldownRead) {
      cooldownRead = true;
      const kept = await store.get(COOLDOWN_KEY).catch(() => undefined);
      if (typeof kept?.["until"] === "number") cooldownUntil = Math.max(cooldownUntil ?? 0, kept["until"]);
    }
    if (cooldownUntil !== undefined && now() < cooldownUntil) return { attempted: 0 };
    if (cooldownUntil !== undefined) await remember(undefined);
    cooldownUntil = undefined;
    rateWatch.resetAt = undefined;
    let rows: DueRow[];
    try {
      rows = await dueRows(deadline);
    } catch (error) {
      log({ component: "merge_tracking", event: "sweep.read_failed", error: error instanceof Error ? error.name : "unknown" });
      return { attempted: 0 };
    }
    if (rows.length === 0) return { attempted: 0 };
    // Reads end before the pass does: the settle writes (the row's attempts, wait and read state) always have time.
    const readsEnd = deadline - Math.min(SETTLE_RESERVE_MS, Math.floor(total * SETTLE_RESERVE_SHARE));
    const left = readsEnd - now();
    if (left <= 0) return { attempted: 0 };
    const { budget, stop } = createReadBudget(now, { requests: SWEEP_MAX_REQUESTS, ms: left });
    let attempted = 0;
    let reached = 0;
    try {
      for (const row of rows) {
        // A code host that said "slow down" in this sweep pauses the rest of it.
        if (cooldownUntil !== undefined || budget.signal.aborted || now() >= readsEnd) { scan.complete = false; break; }
        reached += 1;
        if (await loadTask(row.taskId) === undefined) continue;
        attempted += 1;
        const versionBefore = await trackingVersions(row.taskId);
        // A row owns a bounded share of the requests and an equal share of the time left (a row that stalls cannot take the time of the rows after it).
        const requests = Math.floor(SWEEP_MAX_REQUESTS / rows.length);
        const rowEnd = now() + Math.floor((readsEnd - now()) / (rows.length - reached + 1));
        const outcome = await attemptRow(row, rowBudget(budget, requests), requests, rowEnd);
        // Did the pass change anything? Its tracking item's version moves whenever it wrote.
        await settle(row, outcome.result, await trackingVersions(row.taskId) !== versionBefore, outcome.readState);
        if (outcome.result.kind === "RETRY" && outcome.result.scope === "github-global") break;
        if (await pauseForRateReserve()) { scan.complete = false; break; }
      }
    } finally {
      stop();
    }
    if (reached < rows.length) log({ component: "merge_tracking", event: "sweep.rows_deferred", deferred: rows.length - reached });
    return { attempted };
  };

  /** The versions of the task's tracking items and its workflow, as one string: it changes whenever a pass wrote something. */
  const trackingVersions = async (taskId: string): Promise<string> => {
    const items = await queryAll(store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "MERGE_TRACKING#" } }).catch(() => []);
    const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }).catch(() => undefined);
    const workflow = task?.["workflow"] as { revision?: number } | undefined;
    return `${String(workflow?.revision ?? "")}|${JSON.stringify((workflow as { risk?: { level?: string } } | undefined)?.risk?.level)}|${items.map((item) => `${String(item["sk"])}:${JSON.stringify(item["version"])}`).join(",")}`;
  };

  return {
    deps,
    sweep(sweepOptions) {
      // One sweep at a time: a second call while one runs is the same sweep.
      sweeping ??= runSweep(sweepOptions?.budgetMs ?? SWEEP_MAX_MS).finally(() => { sweeping = undefined; });
      return sweeping;
    },
    wake: (taskId) => wakeMergeTracking(store, taskId, now(), { pollMs }),
    pauseUntil(retryAt) { cooldownUntil = Math.max(cooldownUntil ?? 0, retryAt); void remember(cooldownUntil); },
    pausedUntil: () => (cooldownUntil !== undefined && now() < cooldownUntil ? cooldownUntil : undefined),
    async idle() { await sweeping?.catch(() => undefined); await tierRunning?.catch(() => undefined); },
    tierChecks() {
      // One pass at a time; a task's checks never run twice at once in this process.
      tierRunning ??= runTierPass().finally(() => { tierRunning = undefined; });
      return tierRunning;
    },
  };
}

