// Rovara Code (Plan 6 Task 20), ported by lane L7a: the `merged` milestone and the state kept about a pull request that merged.
//
// The save that moves a task to MERGED adds these items to its transaction, so they exist exactly when the merge is recorded, once, whichever path recorded it (a webhook, the merge sweep, or a
// pushed fix found merged). The milestone lists every merged pull request and the session's bindings, which is what the notification lane's handlers read to close the tracker item and to
// post the chat line. Handlers are told after the commit (`CodeMilestones.deliver`).
import { createHash } from "node:crypto";
import { SessionIdSchema, mergeTrackingDecisionDigest, sessionEventId, type AuditSink, type CodeMilestone, type DocumentStore, type MergeTrackingItem, type OrgId, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import { change } from "@agentx/contracts";
import { mergedLines } from "./merged-lines.js";
import { githubPullRequestAddress, mergeCommitIndexStep } from "../proof/revert/merge-commit-index.js";
import type { CodeMilestones, SessionBindingsReader, SessionTimeline } from "./seams.js";
import { readMergeTracking, trackingWriteItem } from "./store.js";

/** The milestone's text holds at most this many characters. */
const TEXT_MAX = 500;
/** A task has one merged milestone. */
const MERGED_MILESTONE_NUMBER = 1;

const isMergedTask = (workflow: WorkflowSnapshot): boolean => workflow.stage === "MERGED" && workflow.state === "COMPLETE" && workflow.outcome === "MERGED";

/** The milestone's text: `Merged: <url>` for each pull request, cut at a line (with a count of the rest) when there are too many for 500 characters. */
function textOf(lines: readonly string[]): string {
  for (let kept = lines.length; kept > 0; kept -= 1) {
    const text = [...lines.slice(0, kept), ...(kept < lines.length ? [`and ${String(lines.length - kept)} more`] : [])].join("\n");
    if (text.length <= TEXT_MAX) return text;
  }
  return "Merged.";
}

/**
 * The items that record a task's merge as a milestone: none unless `after` is the move to MERGED (and `before` was not already there), and none for a task whose org is unknown. The
 * session's bindings are read now, and a read that fails is thrown, so the move to MERGED is not recorded without them (the save is tried again; a tracker close is never lost).
 */
export async function mergedMilestoneItems(
  deps: { milestones: CodeMilestones; bindings: SessionBindingsReader },
  task: { taskId: string; orgId?: OrgId | undefined; sessionId?: string | undefined },
  before: WorkflowSnapshot,
  after: WorkflowSnapshot,
  now: string,
): Promise<TransactItem[]> {
  if (!isMergedTask(after) || isMergedTask(before) || task.orgId === undefined) return [];
  const merged = (after.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "MERGED");
  const lines = mergedLines(merged);
  const session = SessionIdSchema.safeParse(task.sessionId);
  const bindings = session.success ? await deps.bindings.read(task.orgId, session.data) : [];
  const milestone: CodeMilestone = {
    kind: "merged", orgId: task.orgId, taskId: task.taskId, ...(session.success ? { sessionId: session.data } : {}), at: now, text: textOf(lines),
    ...(merged.length === 0 ? {} : { pullRequests: merged.map((pullRequest) => ({ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url })) }),
    ...(bindings.length === 0 ? {} : { bindings }),
  };
  return deps.milestones.items(milestone, MERGED_MILESTONE_NUMBER, { definitionVersion: after.definitionVersion });
}

export interface MergedStateTask { taskId: string; orgId?: OrgId | undefined; sessionId?: string | undefined; workspaceId?: string | undefined }
/** What the code host said of a pull request this save finds merged. */
export interface MergedObservation { repositoryId: string; number: number; mergedBy?: string | undefined; /** The commit the host says the pull request was merged as (SRL-3: indexed so a revert of it can be matched). */ mergeCommit?: string | undefined }
/**
 * A pull request record the caller already updates in the same transaction, and whose update already sets its state to "merged" (the pushed fix's save). A transaction may not name one item
 * twice, so the record is updated once, by the caller (C59).
 */
export interface MergedRecordWrittenByCaller { repositoryId: string; number: number }

/** A login a code host could have issued; anything else is left out of the timeline. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/u;

/** The key of a pull request's record in its workspace (the same key the task flow keeps it under). */
const pullRequestRecordKey = (workspaceId: string, repository: string, number: number) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `PULL_REQUEST#${repository}#${String(number).padStart(12, "0")}` });

const isMerged = (workflow: WorkflowSnapshot, repositoryId: string, number: number): boolean =>
  workflow.pullRequests?.some((pullRequest) => pullRequest.repositoryId === repositoryId && pullRequest.number === number && pullRequest.state === "MERGED") === true;

/**
 * The items that bring the merge-tracking row and the pull request record of each pull request this save moves to MERGED up to date, the merge commit's index row, and the timeline line for one
 * merged on the host with no approval recorded, and the `pull_request.merged` audit event (staged with the sink, so it commits with the merge or not at all; its id names the task and the pull request, so a
 * merge seen again records nothing twice). None for a pull request already merged in `before`, and nothing at all for one that closed without merging. Reads failing are logged and leave the merge recorded without them: recording the merge
 * never waits on this.
 */
export async function mergedStateItems(
  deps: { store: DocumentStore; timeline: SessionTimeline; audit: AuditSink; log?: (event: string, fields: Record<string, unknown>) => void },
  task: MergedStateTask, before: WorkflowSnapshot, after: WorkflowSnapshot, now: string, observed: readonly MergedObservation[] = [],
  recordsWrittenByCaller: readonly MergedRecordWrittenByCaller[] = [],
): Promise<TransactItem[]> {
  const newly = (after.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "MERGED" && !isMerged(before, pullRequest.repositoryId, pullRequest.number));
  if (newly.length === 0 || task.orgId === undefined) return [];
  const orgId = task.orgId;
  const items: TransactItem[] = [];
  let tracked: MergeTrackingItem[] = [];
  try {
    tracked = await readMergeTracking(deps.store, task.taskId, orgId);
  } catch (error) {
    deps.log?.("merged_state.tracking_unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
  const session = SessionIdSchema.safeParse(task.sessionId);
  // SRL-3 (L2): merges that got no index row, by reason. Counts only (no task, repository or commit), logged once per reason after the loop.
  const missed = { no_merge_commit: 0, bad_merge_commit: 0 };
  for (const pullRequest of newly) {
    const prior = tracked.find((item) => item.repositoryId === pullRequest.repositoryId && item.number === pullRequest.number);
    if (prior !== undefined && prior.state !== "merged") {
      const { version: _version, observedAt: _observedAt, decisionDigest: _digest, ...rest } = prior; // eslint-disable-line @typescript-eslint/no-unused-vars -- recomputed on purpose
      const fields = { ...rest, state: "merged" as const };
      items.push(trackingWriteItem(prior, { ...fields, decisionDigest: mergeTrackingDecisionDigest(fields), version: prior.version + 1, observedAt: now }));
    }
    if (task.workspaceId !== undefined && !recordsWrittenByCaller.some((written) => written.repositoryId === pullRequest.repositoryId && written.number === pullRequest.number)) {
      const key = pullRequestRecordKey(task.workspaceId, pullRequest.repositoryId, pullRequest.number);
      try {
        const stored = await deps.store.get(key);
        if (stored !== undefined && stored["state"] !== "merged") items.push({ kind: "update", key, ops: [change.set(["state"], "merged"), change.set(["updatedAt"], now)] });
      } catch (error) {
        deps.log?.("merged_state.record_unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
    // SRL-3: the index from the merge commit to this task, in the same transaction, so a revert of the commit is matched to the pull request. No commit, or an address the index cannot hold: no row (logged).
    const mergeCommit = observed.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number)?.mergeCommit;
    const address = githubPullRequestAddress(pullRequest.url);
    const indexed = mergeCommit === undefined || address === undefined ? undefined
      : mergeCommitIndexStep({ orgId, repositoryFullName: address.repositoryFullName, repositoryId: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url, taskId: task.taskId, mergeCommit, now }, deps.store.ttlAttribute);
    if (indexed !== undefined) items.push(indexed);
    else if (mergeCommit === undefined || address === undefined) missed[mergeCommit === undefined ? "no_merge_commit" : "bad_merge_commit"] += 1; // an address the index cannot hold (not GitHub-shaped) counts as a miss too
    else missed.bad_merge_commit += 1;
    // The audit fact that the merge was observed, in the same transaction as the move to MERGED. The actor is the system part that saw it; the host's login for who merged is a detail, never the actor.
    const observedBy = observed.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number);
    const repositoryKey = address?.repositoryFullName ?? pullRequest.repositoryId;
    items.push(...deps.audit.stage({
      eventId: createHash("sha256").update(`pull_request.merged\n${task.taskId}\n${pullRequest.repositoryId}\n${String(pullRequest.number)}`).digest("hex"),
      companyId: orgId, at: now, actor: { type: "system", id: "merge-tracking" }, action: "pull_request.merged", subject: { type: "change_request", id: `${repositoryKey}#${String(pullRequest.number)}` },
      details: {
        repository: repositoryKey, number: pullRequest.number, taskId: task.taskId,
        ...(mergeCommit === undefined ? {} : { mergeCommit }), ...(observedBy?.mergedBy !== undefined && LOGIN.test(observedBy.mergedBy) ? { mergedBy: observedBy.mergedBy } : {}),
      },
    }));
    // Merged on the host (not by Rovara's Merge, which claims the pull request first) with no approval that counts: a fact for the timeline, not an error.
    if (prior !== undefined && prior.mergeClaim === undefined && prior.approval === undefined && session.success) {
      const by = observed.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number)?.mergedBy;
      items.push(deps.timeline.statusLine({ orgId, sessionId: session.data }, {
        eventId: sessionEventId("merged_outside", `${task.taskId}\n${pullRequest.repositoryId}\n${String(pullRequest.number)}`), at: now,
        text: by !== undefined && LOGIN.test(by) ? `Merged on the code host by ${by}; no approval was recorded.` : "Merged on the code host; no approval was recorded.",
      }));
    }
  }
  for (const [reason, count] of Object.entries(missed)) if (count > 0) deps.log?.("merge_commit_index.missed", { level: "warn", reason, count });
  return items;
}
