// Lane L12: the files the checked code changes, for the pull request's description and the risk it shows.
//
// THE RULE (L12 review H3): a list the WORKER reports is never believed. The worker saves `workspace.diff` with each run, and nothing checks that it names what the commit holds; a worker that omits a
// sensitive file would lower the risk. So:
//   - the worker's list is kept only as "reported by the worker, not checked" (`reportedChangedFiles`) and shown as such;
//   - the risk and the description's list come from the CODE HOST, after the push: the files changed between the pull request's base and the pushed, checked head (`verifyPublishedChanges`);
//   - without a verified list the risk is HIGH (`riskUntilVerified`), never lower, and says why.
import { createHash } from "node:crypto";
import { change, when, type CodeHost, type HostScope, type WorkflowSnapshot } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import { flowIs } from "../task-flow/flow-guard.js";
import { boundCommits, readHeadFacts, tierFilesOfRead } from "../merge/change-tier-read.js";
import { changeRequestRef, readChangeRequestFiles } from "../merge/host-port.js";
import { recordGrowth, recordTier, tierFromDiff, type TierFile } from "../decisions/change-tier.js";
import { changedFilesFromHostFiles, parseChangedFiles } from "../proof/changed-files.js";
import { recomputeRisk, type ChangedFilesRead, type LessonsUsedSection } from "../proof/pull-request-body.js";
import { linearIssueKeyOfBindings } from "../proof/linear-close.js";
import { workflowPullRequestBody } from "../proof/workflow-pull-request-body.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceOperations } from "../task-flow/reads.js";
import { taskKey } from "../task-flow/keys.js";
import type { TaskRecord } from "../task-flow/records.js";
import { iso, log } from "../task-flow/support.js";
import { approvedCodingPlan } from "./plan-input.js";
import { pullRequestRecordKey, pullRequestRecordOf } from "./records.js";

export const WORKSPACE_DIFF_ARTIFACT = "workspace.diff";
const DIFF_READ_MAX_BYTES = 210_000;
/** The reason a risk carries while the changed files have not been read from the code host. */
export const RISK_UNVERIFIED_REASON = "Rovara has not yet checked which files changed against the code host.";

/** The row a worker's artifact is recorded under (`callbacks.ts` writes it; the key is the flow's own scheme). */
export const artifactRowKey = (workspaceId: string, operationId: string, name: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${operationId}#${name}` });
/** Where the list read from the code host is kept, for the code with this digest. */
export const verifiedFilesKey = (workspaceId: string, candidateDigest: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `VERIFIED_FILES#${candidateDigest}` });

/** The "Lessons used" section of a description on an install with no lessons: it says so, so the section is there and a reader knows why it is empty. */
export const NO_LESSONS_USED: LessonsUsedSection = { count: 0, taskUrl: "", entries: [], none: true };

/**
 * The "Lessons used" section of the description of the task's pull request in one repository. An install with no lessons says so (`NO_LESSONS_USED`); one with lessons asks them (`TaskFlowDeps.lessonsUsed`), which
 * counts what the task was given and names it only where the repository's readers may read it. A failure is no section: a description never waits on, or fails because of, lessons.
 */
export async function lessonsUsedOf(deps: Pick<TaskFlowDeps, "lessonsUsed">, task: { taskId: string; project: string; startingRevision: number }, repositoryId: string): Promise<LessonsUsedSection | undefined> {
  if (deps.lessonsUsed === undefined) return NO_LESSONS_USED;
  try { return await deps.lessonsUsed(task, repositoryId); } catch { return undefined; }
}

/** The workflow with its risk judged for the code, from the files the CODE HOST gave; with none (`undefined`) the risk is high and says why. */
export function riskFromFiles(workflow: WorkflowSnapshot, verified: ChangedFilesRead | undefined): WorkflowSnapshot {
  const judged = recomputeRisk(workflow, verified, {});
  if (verified !== undefined || judged.risk === undefined) return judged;
  return { ...judged, risk: { ...judged.risk, level: "high", reasons: [RISK_UNVERIFIED_REASON, ...judged.risk.reasons.filter((reason) => reason !== RISK_UNVERIFIED_REASON)].slice(0, 8) } };
}

/** What the worker reported it changed (its `workspace.diff`), NOT checked: shown as such and never used for the risk. Never throws. */
export async function reportedChangedFiles(deps: Pick<TaskFlowDeps, "store" | "artifacts">, workspaceId: string): Promise<ChangedFilesRead | undefined> {
  if (deps.artifacts === undefined) return undefined;
  try {
    const finished = (await workspaceOperations(deps, workspaceId)).filter((operation) => operation.status === "SUCCEEDED" && (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS")).reverse();
    for (const operation of finished) {
      const row = await deps.store.get(artifactRowKey(workspaceId, operation.id, WORKSPACE_DIFF_ARTIFACT));
      if (row === undefined || typeof row["objectKey"] !== "string" || typeof row["sha256"] !== "string") continue;
      const bytes = await deps.artifacts.get(row["objectKey"], DIFF_READ_MAX_BYTES);
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== row["sha256"]) continue;
      return parseChangedFiles(new TextDecoder().decode(bytes));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The files one change request changes between its base and its head, as the code host reports them (`changedFiles`), in the shape the risk rules read. The host's counts are kept; the flags the risk rules
 * read from the diff (a removed or skipped test, a changed test command, a route) come from the patch the host gave for the file, when it gave one. `complete` is false when the host's list was cut or a file had a path that cannot be listed.
 */
export async function hostChangedFiles(host: CodeHost, input: { repositoryId: string; repositoryUrl: string; number: number; scope: HostScope; beforeRequest?: (() => void) | undefined }): Promise<ChangedFilesRead> {
  const read = await readChangeRequestFiles(host, changeRequestRef(input.repositoryUrl, input.number), input.scope, input.beforeRequest);
  return changedFilesFromHostFiles(input.repositoryId, read.files, read.complete);
}

export type VerifyOutcome = "verified" | "already" | "not_applicable" | "unavailable";

/**
 * Reads the changed files of the task's pull requests from the code host and judges the risk from them, once for the code the pull requests hold. Only when every pull request is open, holds the checked candidate, and the
 * host shows the very head Rovara recorded (a pull request that moved is not what was checked). It then records the risk, keeps the verified list, and brings each pull request's description up to date (only a description nobody
 * edited since Rovara wrote it). `beforeRequest` is the caller's read allowance. Never throws for a host that cannot answer: the risk then stays high.
 */
export async function verifyPublishedChanges(deps: TaskFlowDeps, task: TaskRecord, beforeRequest?: () => void): Promise<VerifyOutcome> {
  const workflow = task.workflow;
  const candidate = workflow?.candidate;
  if (workflow === undefined || workflow.definitionVersion !== "1.1.0" || candidate === undefined || deps.codeHosts === undefined || task.closedAt !== undefined) return "not_applicable";
  const pullRequests = workflow.pullRequests ?? [];
  if (pullRequests.length === 0 || pullRequests.some((entry) => entry.candidateDigest !== candidate.digest || (entry.state !== "OPEN" && entry.state !== "UNKNOWN"))) return "not_applicable";
  if ((await deps.store.get(verifiedFilesKey(task.workspaceId, candidate.digest))) !== undefined) return "already";
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const all: ChangedFilesRead["files"][number][] = [];
  // The change tier is read from the same list the host gave: the files with the host's own patch text.
  const tierFiles: TierFile[] = [];
  let tierComplete = true;
  const tierTargets: Array<Parameters<typeof readHeadFacts>[0][number]> = [];
  let headFacts: Awaited<ReturnType<typeof readHeadFacts>> | undefined;
  let complete = true;
  const hosts: Array<{ host: CodeHost; url: string; number: number; repositoryId: string; url_: string }> = [];
  try {
    for (const pullRequest of pullRequests) {
      const definition = project?.definition.repositories.find((entry) => entry.name === pullRequest.repositoryId);
      if (definition === undefined) return "unavailable";
      const host = codeHostForRecord(deps.codeHosts, definition);
      beforeRequest?.();
      const remote = await host.getChangeRequest(changeRequestRef(definition.url, pullRequest.number), { orgId: deps.companyId });
      // The head the host shows must be the head Rovara recorded and checked.
      if (remote.state !== "open" || remote.headRevision !== pullRequest.headSha) return "unavailable";
      const raw = await readChangeRequestFiles(host, changeRequestRef(definition.url, pullRequest.number), { orgId: deps.companyId }, beforeRequest);
      const read = changedFilesFromHostFiles(pullRequest.repositoryId, raw.files, raw.complete);
      const tierRead = tierFilesOfRead(pullRequest.repositoryId, raw);
      all.push(...read.files);
      tierFiles.push(...tierRead.files);
      complete &&= read.complete;
      tierComplete &&= tierRead.complete;
      hosts.push({ host, url: definition.url, number: pullRequest.number, repositoryId: pullRequest.repositoryId, url_: pullRequest.url });
      tierTargets.push({ host, repositoryId: pullRequest.repositoryId, repositoryUrl: definition.url, number: pullRequest.number, headSha: pullRequest.headSha ?? "" });
    }
    // What the host knows of the code at the heads (the text of the documents, what the instruction files import, symbolic links). A host that cannot say leaves the tier unwritten and the risk high.
    headFacts = await readHeadFacts(tierTargets, tierFiles, { orgId: deps.companyId }, beforeRequest);
    // The head must not have moved while the files and the facts were read: the tier is for the code Rovara checked.
    for (const target of tierTargets) {
      beforeRequest?.();
      const again = await target.host.getChangeRequest(changeRequestRef(target.repositoryUrl, target.number), { orgId: deps.companyId });
      if (again.state === "open" && again.headRevision !== target.headSha) return "unavailable";
    }
  } catch (error) {
    // A host that cannot answer (a rate limit included) leaves the risk high; the caller's pause logic sees the rate limit again on its own read.
    if (error instanceof Error && error.name === "HostRateLimitError") throw error;
    log(deps, { event: "build_step.changed_files_unavailable", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return "unavailable";
  }
  const read: ChangedFilesRead = { files: all, complete };
  const judged = riskFromFiles(workflow, read);
  // The tier of the code the host shows, bound to the head commits Rovara checked and the base they were built on. It only goes up, and the growth after the build is recorded.
  const at = iso(deps);
  const fresh = tierFromDiff({ files: tierFiles, complete: tierComplete && hosts.length > 0 }, { ...boundCommits(pullRequests.map((entry) => ({ repositoryId: entry.repositoryId, headSha: entry.headSha ?? "", baseCommitSha: workflow.reviewBase?.find((base) => base.repositoryId === entry.repositoryId)?.baseCommitSha }))), at, ...(headFacts === undefined ? {} : { head: headFacts }) });
  const tiered = recordTier(workflow.flow, fresh);
  const previousLevel = workflow.flow?.tier?.level;
  const flow = tiered.grew && previousLevel !== undefined ? recordGrowth(tiered.flow, previousLevel, tiered.tier.level, at) : tiered.flow;
  const written = await deps.store.update({
    key: taskKey(task.taskId), ops: [change.set(["workflow", "risk"], JSON.parse(JSON.stringify(judged.risk)) as never), change.set(["workflow", "flow"], JSON.parse(JSON.stringify(flow)) as never)],
    // The revision does not move (a row of the step in flight waits for it); a writer that holds the whole older workflow is stopped by its own `flowIs` condition, and this write by the same one.
    condition: when.and(when.eq(["workflow", "revision"], workflow.revision), when.notExists("closedAt"), flowIs(workflow.flow)),
  });
  if (!written.applied) return "unavailable";
  await deps.store.put({ item: { ...verifiedFilesKey(task.workspaceId, candidate.digest), entityType: "VERIFIED_FILES", candidateDigest: candidate.digest, complete, verifiedAt: iso(deps), files: JSON.parse(JSON.stringify(all.slice(0, 200))) as never } });
  // The description says what changed, read from the host. A description a person edited is left as they left it.
  const plan = await approvedCodingPlan(deps.artifacts, workflow).catch(() => undefined);
  const proof = await deps.designReview?.proofContext?.(deps, task, workflow).catch(() => undefined);
  const secondLines = deps.secondReview?.prLines(task, candidate.digest, workflow.acceptedFindings) ?? [];
  const linearIssueKey = await ticketIssueKeyOf(deps, task);
  for (const entry of hosts) {
    try {
      // Each repository's description names the lessons that repository's readers may read.
      const lessonsUsed = await lessonsUsedOf(deps, task, entry.repositoryId);
      const body = workflowPullRequestBody(task, judged.risk === undefined ? workflow : { ...workflow, risk: judged.risk }, plan?.text, undefined, { changedFiles: read, ...(linearIssueKey === undefined ? {} : { linearIssueKey }), ...(lessonsUsed === undefined ? {} : { lessonsUsed }), ...(secondLines.length === 0 ? {} : { secondReviewLines: secondLines }), ...(proof === undefined ? {} : { proof }) });
      const record = await pullRequestRecordOf(deps, task.workspaceId, entry.repositoryId, entry.number);
      const ref = changeRequestRef(entry.url, entry.number);
      beforeRequest?.();
      if (record === undefined || (await entry.host.getChangeRequest(ref, { orgId: deps.companyId })).body !== record.body) continue;
      // Read again right before the write, so the time a person's edit could slip in between is as short as it can be made.
      beforeRequest?.();
      if ((await entry.host.getChangeRequest(ref, { orgId: deps.companyId })).body !== record.body) continue;
      await entry.host.updateChangeRequest({ repository: { url: entry.url }, id: String(entry.number), url: entry.url_ }, { body }, { orgId: deps.companyId });
      await deps.store.update({ key: pullRequestRecordKey(task.workspaceId, entry.repositoryId, entry.number), ops: [change.set("body", body), change.set("updatedAt", iso(deps))], condition: when.present() });
    } catch (error) {
      log(deps, { event: "build_step.description_not_updated", taskId: task.taskId, number: entry.number, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return "verified";
}

/** The list read from the code host for the task's current code, when one was. */
export async function verifiedChangedFiles(deps: Pick<TaskFlowDeps, "store">, workspaceId: string, candidateDigest: string | undefined): Promise<ChangedFilesRead | undefined> {
  if (candidateDigest === undefined) return undefined;
  const row = await deps.store.get(verifiedFilesKey(workspaceId, candidateDigest));
  if (row === undefined || !Array.isArray(row["files"])) return undefined;
  return { files: row["files"] as unknown as ChangedFilesRead["files"][number][], complete: row["complete"] === true };
}

/**
 * The Linear issue the task's session follows (the ticket intake started it from): the pull request's description then says `Fixes <KEY>`, which Linear's own GitHub integration closes the issue on when it merges.
 * A read that fails leaves the line out (the next rewrite of the description adds it). 51 gap: the closing line is Linear's; a second tracker would need its own behind the Tracker port.
 */
export async function ticketIssueKeyOf(deps: Pick<TaskFlowDeps, "sessionBindings" | "companyId">, task: Pick<TaskRecord, "sessionId">): Promise<string | undefined> {
  if (deps.sessionBindings === undefined || task.sessionId === undefined) return undefined;
  try {
    return linearIssueKeyOfBindings(await deps.sessionBindings.read(deps.companyId, task.sessionId));
  } catch {
    return undefined;
  }
}
