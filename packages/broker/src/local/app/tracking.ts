// Lane L12, slice 1: merge tracking on a laptop. Cloud wakes a task's tracking row with a webhook and sweeps the rest on a schedule; a laptop has no public address, so `rovara up` POLLS: a timer reads the
// due tracking rows (`WORKFLOW_MERGE_RECOVERY`, `kind: "tracking"`, written by the publish step) and calls the core's `reconcileTrackingTask` for each, with the seams of the merge core filled:
//
//   settings   Code's fixed settings (self-approval on: one owner)         milestones  a row for each milestone + a line on the task's session (`fixing`, `stuck`, `pr_ready`, `approved`, `merged`)
//   people     the sole owner                                              timeline    the session's event log
//   links      the reverse link the publish step wrote                     repository  the repository the project pins, on the code host its record names (the registry's `code-host` point)
//
// Merge tracking never presses merge (owner decision 1): it may take a draft out of draft and ask for the project's reviewers, and only for a task waiting for its merge (the pass checks that), and the
// deciders of L7b ask for a coding run (a CI fix) or a merge of the base. A person merges, in the code host or with their proof.
//
// Rate limits (the laptop's token has the owner's own allowance, 5,000 an hour on GitHub): a pass has a request allowance (`trackingRequestCap`), a sweep has one too, and a row waits longer each time nothing changed
// (60 s, doubling to 5 min) or a pass failed (60 s times the failures, up to 15 min). A code host that says "slow down" (`HostRateLimitError`) pauses every row until the time it names.
//
// Decision 51: nothing here names a provider; the code host is whatever the repository's record names, and a host that cannot read a merge (`mergeObservation`) is simply never seen merged.
import {
  blockWorkflow, INDEX_EXPIRY_ATTRIBUTE, TRACKING_GATE_SECONDS, TRACKING_HEARTBEAT_MINUTES, change, hostRateLimitRetryAt, observeWorkflowPullRequest, queryAll, when,
  type OrgId, type ReadBudget, type RegistryView, type TransactItem,
} from "@agentx/contracts";
import { SWEEP_INTERVAL_MS, type MergeRecoveryResult } from "../../core/merge/budget.js";
import { fixedCodeSettings } from "../../core/merge/defaults.js";
import { changeRequestRef } from "../../core/merge/host-port.js";
import { storeLinkedChangeRequests } from "../../core/merge/linked.js";
import { mergedMilestoneItems, mergedStateItems } from "../../core/merge/merged.js";
import { createDocumentMilestones, type DocumentMilestones } from "../../core/milestones/milestones.js";
import { reconcileTrackingTask, type MergeTrackingDependencies, type TrackingReconcileDependencies } from "../../core/merge/merge-tracking.js";
import { soleOwnerPeople } from "../../core/merge/people.js";
import { registryRepositoryResolver } from "../../core/merge/resolver.js";
import type { CodeMilestones, MergeTask, SessionTimeline } from "../../core/merge/seams.js";
import { recoveryRowKey, workflowUpdateItem } from "../../core/merge/store.js";
import { sessionBindingsOf } from "../../core/sessions/bindings.js";
import { sessionEventItem } from "../../core/sessions/store.js";
import { verifyPublishedChanges } from "../../core/build-step/changed-files.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { readTask } from "../../core/task-flow/reads.js";
import { recordedHeadOf } from "../../core/build-step/head-check.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

/** The first wait after a pass, and the wait the quiet rows grow to. */
export const TRACKING_POLL_MS = TRACKING_GATE_SECONDS * 1_000;
export const TRACKING_QUIET_MAX_MS = SWEEP_INTERVAL_MS;
/** What a failing pass waits: its failures times one gate, up to the heartbeat. */
export const TRACKING_FAILURE_MAX_MS = TRACKING_HEARTBEAT_MINUTES * 60_000;
/** One sweep: at most this many rows, this many requests to the code host and this long. */
export const SWEEP_MAX_ROWS = 10;
export const SWEEP_MAX_REQUESTS = 256;
export const SWEEP_MAX_MS = 20_000;
/** What the task says when its pull request ended at a head Rovara did not check. */
export const MERGED_OUTSIDE = "The pull request was merged with commits Rovara did not check, so this is not a merge of the code Rovara checked. Look at what was merged, then close this task.";
export const CLOSED_OUTSIDE = "The pull request was closed on the code host with commits Rovara did not check. Look at it there, then close this task.";

type Log = (entry: Record<string, unknown>) => void;

// ---- the session timeline and the milestone hook

/** The session's event log is the timeline: a status line is one event of the system, written once for the same id. */
export function sessionTimeline(): SessionTimeline {
  return {
    statusLine: (session, event) => sessionEventItem({ orgId: session.orgId, sessionId: session.sessionId }, { eventId: event.eventId, at: event.at, type: "status", actor: { kind: "system" }, text: event.text }),
  };
}

/**
 * The milestone hook for a laptop (Cloud's `milestones.ts` on the document store, `core/milestones`): the items of one milestone are a row in the task's partition (written only if absent, so a
 * repeat of the same occurrence adds nothing) and a line on the task's session, in the transaction of the change that caused it. `deliver` tells the handlers an adapter registered after the commit; none are registered by
 * default (a `channel` adapter reads the session's change, `core/notify`), and the sweep (`deliverDue`, run by the app's tick) tells again a handler that was not told.
 */
export function createLocalMilestones(options: Parameters<typeof createDocumentMilestones>[0]): DocumentMilestones {
  return createDocumentMilestones(options);
}

// ---- the task as the merge core reads it

/** The part of the task record the merge core reads. A task of another company reads as absent. */
function mergeTaskOf(record: TaskRecord, companyId: OrgId): (MergeTask & { orgId: OrgId }) | undefined {
  if (record.companyId !== companyId) return undefined;
  return {
    taskId: record.taskId, orgId: companyId, project: record.project, startingRevision: record.startingRevision, workspaceId: record.workspaceId,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }), ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
    ...(record.releasedAt === undefined ? {} : { releasedAt: record.releasedAt }), ...(record.workflow === undefined ? {} : { workflow: record.workflow }),
    ownerId: record.workflow?.ownerId ?? record.ownerKey, ownerName: record.developerName ?? "the owner", creatorId: record.developerId,
  };
}

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
          const exhausted = new Error("the sweep used its request allowance");
          exhausted.name = "GithubBudgetExhaustedError";
          throw exhausted;
        }
        requests += 1;
      },
    },
  };
}

/** The repository of a task's project, on the code host its record names (and the runner that reads that host's build logs, when one is registered). */
export function createRepositoryResolver(flow: Pick<TaskFlowDeps, "projects">, registry: RegistryView): ReturnType<typeof registryRepositoryResolver> {
  return registryRepositoryResolver(registry, {
    async pinned(project, revision, repositoryId) {
      const found = (await flow.projects.revision(project, revision))?.definition.repositories.find((entry) => entry.name === repositoryId);
      return found === undefined ? undefined : { url: found.url, ...((found as { host?: { kind: string } }).host === undefined ? {} : { host: (found as { host: { kind: string } }).host }) };
    },
    // The runner that reads this host's build logs, built for the repository it serves (a laptop registers none by default: a CI fix is then told which check failed, without the log).
    checkRunner: (kind, repository) => registry.get("check-runner", kind)?.create({ allowedRepositories: [repository.url] }),
  });
}

export interface LocalTrackingOptions {
  flow: TaskFlowDeps;
  registry: RegistryView;
  companyId: OrgId;
  milestones: CodeMilestones;
  timeline?: SessionTimeline;
  /** Milliseconds since the epoch. The app's clock, so a test can move it. */
  now: () => number;
  log?: Log;
  /** Overrides, for tests: the rows' first wait and the quiet cap. */
  pollMs?: number;
  quietMaxMs?: number;
}

export interface LocalTracking {
  /** The dependencies of one tracking pass (the same a test may call `trackPullRequest` with). */
  readonly deps: TrackingReconcileDependencies;
  /** One sweep: the due tracking rows, at most `SWEEP_MAX_ROWS`, each reconciled once. Never throws; one sweep at a time. */
  sweep(): Promise<{ attempted: number }>;
  /** Makes a task's tracking row due now (a push of Rovara's, the owner's Retry). Does nothing for a task with no row. */
  wake(taskId: string): Promise<void>;
  /** When every row is paused until, if the code host asked Rovara to slow down (milliseconds since the epoch). */
  readonly pausedUntil: () => number | undefined;
  /** Pauses every row (and the comment poll) until the time a code host named when it asked Rovara to slow down. */
  pauseUntil(retryAt: number): void;
  /** Waits for a sweep that is running. */
  idle(): Promise<void>;
}

export function createLocalTracking(options: LocalTrackingOptions): LocalTracking {
  const { flow, registry, companyId, milestones, now } = options;
  const store = flow.store;
  const log = options.log ?? (() => undefined);
  const timeline = options.timeline ?? sessionTimeline();
  const pollMs = options.pollMs ?? TRACKING_POLL_MS;
  const quietMaxMs = options.quietMaxMs ?? TRACKING_QUIET_MAX_MS;

  const loadTask = async (taskId: string): Promise<(MergeTask & { orgId: OrgId }) | undefined> => {
    const record = await readTask(flow, taskId);
    return record === undefined ? undefined : mergeTaskOf(record, companyId);
  };

  const resolver = createRepositoryResolver(flow, registry);

  const base: MergeTrackingDependencies = {
    store, now,
    settings: fixedCodeSettings(), milestones, timeline, people: soleOwnerPeople, links: storeLinkedChangeRequests(store),
    scope: (orgId) => ({ orgId }),
    loadTask,
    repositoryUrl: async (project, revision, repositoryId) => (await flow.projects.revision(project, revision))?.definition.repositories.find((entry) => entry.name === repositoryId)?.url,
    repository: resolver,
    // A pull request seen "changed outside Rovara" has no recorded head, so its head reads as someone else's and it is never called ready.
    recordedHead: recordedHeadOf(flow),
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
        const recorded = await store.transact([workflowUpdateItem(taskId, outside, workflow.revision), ...stuck]);
        if (recorded.applied) await milestones.deliver(taskId).catch(() => undefined);
        return recorded.applied ? { kind: "TERMINAL", release: "confirmed" } : { kind: "OBSERVED" };
      }
      const next = observeWorkflowPullRequest(workflow, { repositoryId: pullRequest.repositoryId, number: pullRequest.number, candidateDigest: pullRequest.candidateDigest, state, source: "CODE_HOST", observedAt: at }, at);
      const items: TransactItem[] = [
        workflowUpdateItem(taskId, next, workflow.revision),
        ...await mergedMilestoneItems({ milestones, bindings: { read: (orgId, sessionId) => sessionBindingsOf(store, orgId, sessionId) } }, task, workflow, next, at),
        ...await mergedStateItems({ store, timeline, log: (event, fields) => log({ component: "merge_tracking", event, ...fields }) }, task, workflow, next, at,
          state === "MERGED" ? [{ repositoryId: pullRequest.repositoryId, number: pullRequest.number, ...(details.mergedBy === undefined ? {} : { mergedBy: details.mergedBy }), ...(details.mergeRevision === undefined ? {} : { mergeCommit: details.mergeRevision }) }] : []),
      ];
      const written = await store.transact(items);
      if (written.applied) await milestones.deliver(taskId).catch(() => undefined);
      // Every pull request merged: the task is over and its row goes. Otherwise the next pull request is seen on the next pass, from the workflow as it now is.
      return written.applied && next.stage === "MERGED" ? { kind: "TERMINAL", release: "confirmed" } : { kind: "OBSERVED" };
    }
    return { kind: "OBSERVED" };
  };

  const deps: TrackingReconcileDependencies = { ...base, observeMerge };

  // ---- the sweep

  let cooldownUntil: number | undefined;
  const COOLDOWN_KEY = { pk: "WORKFLOW_MERGE_SWEEP", sk: "COOLDOWN" };
  /** The pause a code host asked for is kept, so a restart of `rovara up` inside it does not ask the host again at once. */
  const remember = (until: number | undefined): void => {
    void (until === undefined ? store.delete({ key: COOLDOWN_KEY }) : store.put({ item: { ...COOLDOWN_KEY, entityType: "WORKFLOW_MERGE_SWEEP", until, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(until / 1000) + 86_400 } })).catch(() => undefined);
  };
  let cooldownRead = false;
  let sweeping: Promise<{ attempted: number }> | undefined;

  const dueRows = async (): Promise<Array<{ taskId: string; attempts: number; quiet: number }>> => {
    const rows = await queryAll(store, { pk: "WORKFLOW_MERGE_RECOVERY", sk: { op: "beginsWith", prefix: "TASK#" } });
    const at = now();
    return rows
      .filter((row) => row["kind"] === "tracking" && typeof row["taskId"] === "string" && typeof row["nextAttemptAt"] === "number" && row["nextAttemptAt"] <= at)
      .sort((left, right) => (left["nextAttemptAt"] as number) - (right["nextAttemptAt"] as number))
      .slice(0, SWEEP_MAX_ROWS)
      .map((row) => ({ taskId: row["taskId"] as string, attempts: typeof row["attempts"] === "number" ? row["attempts"] : 0, quiet: typeof row["quiet"] === "number" ? row["quiet"] : 0 }));
  };

  const settle = async (row: { taskId: string; attempts: number; quiet: number }, result: MergeRecoveryResult, changed: boolean): Promise<void> => {
    const key = recoveryRowKey(row.taskId);
    const at = now();
    const set = (fields: Record<string, number | string>, remove: string[] = []) => store.update({
      key, ops: [...Object.entries(fields).map(([name, value]) => change.set(name, value)), ...remove.map((name) => change.remove(name))], condition: when.present(),
    }).catch(() => undefined);
    switch (result.kind) {
      case "OBSERVED": {
        // Quiet rows wait longer (60 s, doubling to the cap); anything that changed, or a hint of the pass that says when the answer will, starts again.
        const quiet = changed ? 0 : row.quiet + 1;
        const wait = Math.min(quietMaxMs, pollMs * 2 ** Math.min(quiet, 10));
        const hinted = result.nextAt === undefined ? at + wait : Math.min(at + wait, Math.max(at + pollMs, result.nextAt));
        await set({ nextAttemptAt: hinted, attempts: 0, quiet, updatedAt: new Date(at).toISOString(), lastObservedAt: at });
        return;
      }
      case "RETRY": {
        const attempts = row.attempts + 1;
        if (result.scope === "github-global") { cooldownUntil = Math.max(cooldownUntil ?? 0, result.retryAt); remember(cooldownUntil); }
        await set({ nextAttemptAt: Math.max(result.retryAt, at + Math.min(pollMs * attempts, TRACKING_FAILURE_MAX_MS)), attempts, updatedAt: new Date(at).toISOString() });
        return;
      }
      case "TERMINAL": case "MISSING":
        // The task is over (merged, closed, gone): no more passes. The row goes; the task's history stays on the task.
        await store.delete({ key, condition: when.present() }).catch(() => undefined);
        return;
    }
  };

  const runSweep = async (): Promise<{ attempted: number }> => {
    if (!cooldownRead) {
      cooldownRead = true;
      const kept = await store.get(COOLDOWN_KEY).catch(() => undefined);
      if (typeof kept?.["until"] === "number") cooldownUntil = Math.max(cooldownUntil ?? 0, kept["until"]);
    }
    if (cooldownUntil !== undefined && now() < cooldownUntil) return { attempted: 0 };
    if (cooldownUntil !== undefined) remember(undefined);
    cooldownUntil = undefined;
    let rows: Awaited<ReturnType<typeof dueRows>>;
    try {
      rows = await dueRows();
    } catch (error) {
      log({ component: "merge_tracking", event: "sweep.read_failed", error: error instanceof Error ? error.name : "unknown" });
      return { attempted: 0 };
    }
    if (rows.length === 0) return { attempted: 0 };
    const { budget, stop } = createReadBudget(now);
    let attempted = 0;
    try {
      for (const row of rows) {
        // A code host that said "slow down" in this sweep pauses the rest of it.
        if (cooldownUntil !== undefined || budget.signal.aborted) break;
        attempted += 1;
        const versionBefore = await trackingVersions(row.taskId);
        let result: MergeRecoveryResult;
        let unverified = false;
        try {
          // The changed files are read from the code host once for the code the pull requests hold (review H3): until then the risk is high. A host that cannot answer now is asked again soon.
          const task = await readTask(flow, row.taskId);
          if (task !== undefined) unverified = (await verifyPublishedChanges(flow, task, budget.beforeRequest)) === "unavailable";
          result = await reconcileTrackingTask(deps, row.taskId, budget);
        } catch (error) {
          const limitedUntil = hostRateLimitRetryAt(error);
          result = limitedUntil !== undefined ? { kind: "RETRY", retryAt: limitedUntil, scope: "github-global" } : { kind: "RETRY", retryAt: now() + pollMs, scope: "task" };
          if (limitedUntil === undefined) log({ component: "merge_tracking", event: "sweep.row_failed", taskId: row.taskId, error: error instanceof Error ? error.name : "unknown" });
        }
        // Did the pass change anything? Its tracking item's version moves whenever it wrote.
        await settle(row, result, unverified || await trackingVersions(row.taskId) !== versionBefore);
        if (result.kind === "RETRY" && result.scope === "github-global") break;
      }
    } finally {
      stop();
    }
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
    sweep() {
      // One sweep at a time: a second call while one runs is the same sweep.
      sweeping ??= runSweep().finally(() => { sweeping = undefined; });
      return sweeping;
    },
    async wake(taskId) {
      await store.update({ key: recoveryRowKey(taskId), ops: [change.set("nextAttemptAt", now()), change.set("quiet", 0)], condition: when.and(when.present(), when.eq("kind", "tracking")) }).catch(() => undefined);
    },
    pauseUntil(retryAt) { cooldownUntil = Math.max(cooldownUntil ?? 0, retryAt); remember(cooldownUntil); },
    pausedUntil: () => (cooldownUntil !== undefined && now() < cooldownUntil ? cooldownUntil : undefined),
    async idle() { await sweeping?.catch(() => undefined); },
  };
}

