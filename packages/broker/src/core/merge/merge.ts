// Rovara Code (Plan 6 Task 19), ported by lane L7a: a person approves, and a person presses Merge. Rovara never merges by itself (owner decision 1; confirmed 2026-10-27: no automatic merge).
//
// What is Cloud's, unchanged: `mergeReadiness` says whether every required pull request of a task may be merged, in the exact words of `MERGE_NOT_READY`; the single merge path
// (`mergeTask`) re-reads every pull request and every reviewer from the code host (never the stored items), re-checks readiness for the exact heads, and only then claims each pull request
// on its tracking item and merges it, in repository order, with the checked head as the revision.
//
// What is different in Code:
//  - The proof of a person is W0's `Approvers` seam, not a browser session and a confirmation page. `prepareMerge` makes the `ApprovalRequest` (bound to the task's workflow revision and to a digest
//    of the exact pull requests, heads, merge method and risk level the person sees); the surface collects an `ApprovalProof` (the local owner's session, or a repository collaborator's comment);
//    `pressMerge` verifies it with `Approvers.verify` and only then merges. A proof is used once: it is stored under `approvalProofKey` in the claim's transaction.
//  - The merge core trusts `Approvers.verify` and the adapter's `requirement` (the methods it accepts and `minApprovers`, which this core enforces). It does NOT know who is calling: Cloud's rule "a token
//    (the CLI, an AI tool) never merges" is not enforced here. Keeping the local session secret away from tokens and agent tools is the job of the surface that collects the proof (lane L8, see
//    DEFERRED-CHECKS.md). Lane P3 (items A1, A3): a HIGH-risk merge needs a strong method, by the same rule as the decision gate (`strictMethodsFor`: what the adapter names in `strongMethods`, else the local session; a
//    comment method never counts) and, when the adapter sets `signIn` (a company setting), a sign-in that satisfies it.
//  - The audit fact commits with the claim through W0's `AuditSink.stage`, as Cloud's ledger row did.
//  - Everything provider-specific is behind the `CodeHost` port; people, settings, the task record, the timeline and the milestones are seams (seams.ts).
import { createHash } from "node:crypto";
import { providerOf } from "../../plugins/routing.js";
import {
  MERGE_CLAIM_SECONDS,
  MERGE_NOT_READY_MESSAGES as M,
  MERGE_VIEW_MESSAGE_MAX,
  MergePressBodySchema,
  WORKFLOW_BLOCK_REASONS,
  agentXError,
  approvalProofKey,
  change,
  companyScoped,
  isBranchSyncBlockReason,
  isCiFixBlockReason,
  mergeTrackingKey,
  sessionEventId,
  withoutEmailAddresses,
  when,
  type ApprovalProof,
  type ApprovalRequest,
  type ApprovalRequirement,
  type Approvers,
  type AuditSink,
  checkApprovalSignIn,
  type ChangeRequestStatus,
  type CodeHost,
  type CodeSettings,
  type DocumentStore,
  type HostScope,
  type IdentityProvider,
  type MergeResult,
  type MergeRisk,
  type MergeTrackingItem,
  type MergeView,
  type OrgId,
  type TransactItem,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { LOCAL_SESSION_METHOD } from "../../ports/policy-defaults.js";
import {
  canonicalPatchText, needsReviewerFloor, patchDigestOf, planningLevelOf, skippedPlanning, raiseTier, recordGrowth, recordTier, reviewerFloorRecorded, tierFromDiff, tierGrew, tierGrowthSentence, tierRank, tierReviewRecorded, type TierLevel,
} from "../decisions/change-tier.js";
import { strictMethodsFor } from "../decisions/strong-methods.js";
import { scopeHoldOf } from "../build-step/scope-question.js";
import { inertLine } from "../proof/inert-text.js";
import { flowIs } from "../task-flow/flow-guard.js";
import { humanApprovalOf, latestReviewers, linkedAmong, nonWritersAmong, requesterHostIds, type HumanApproval, type ApprovalRefusal, type RepositoryPermission } from "./approval.js";
import { codeOwnerVerdict, type CodeOwnerVerdict } from "./code-owners.js";
import { boundCommits, readTierInput, type TierReadTarget } from "./change-tier-read.js";
import { approvalReviewsOf, changeRequestRef, changedPathsOf, isHostRateLimit, type ConsumerRepository, type RepositoryResolver } from "./host-port.js";
import { DEFAULT_CI_MODE, PERMISSION_LOOKUPS_MAX, ciAllowsMerge, ciCountsAsPassing, readBranch, readCi, tracksMerge, unreadableSinceOf, type ProjectCiMode } from "./merge-tracking.js";
import type { MergePeople } from "./people.js";
import { requireRepositoryKey } from "./repository-key.js";
import type { CodeMilestones, CodeSettingsReader, LinkedChangeRequestFinder, MergeTask, SessionTimeline } from "./seams.js";
import { plain, readMergeTracking, taskRecordKey } from "./store.js";

/** The kind of approval a merge asks for (`ApprovalRequest.kind`). */
export const MERGE_APPROVAL_KIND = "merge";

type PullRequestEntry = NonNullable<WorkflowSnapshot["pullRequests"]>[number];

// ---- whether the pull requests may be merged

/** What readiness needs of one pull request: from the tracking item (a view) or from a fresh read of GitHub (the press and the handler). */
export interface MergePullRequestFacts {
  repositoryId: string;
  number: number;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  ci: MergeTrackingItem["ci"];
  branch: "up_to_date" | "behind" | "conflicted" | "unknown";
  /** GitHub itself calls the branch behind (it does so only for a base that requires up-to-date branches). */
  behindRequired: boolean;
}

export interface ReadinessWorkflow {
  stage: string;
  state: string;
  blockReason?: string | undefined;
  fixSource?: unknown;
  branchSync?: unknown;
  feedbackReview?: { status?: string | undefined } | undefined;
  /** Whether the task's changes need browser or API checks: its branch is not brought up to date by Rovara, which could not check the merged code again. */
  e2e?: { required?: boolean | undefined } | undefined;
}

export interface ReadinessInput {
  /** Every required pull request of the task, in repository order. */
  pullRequests: readonly MergePullRequestFacts[];
  /** Each pull request's counted approval, by `repositoryId#number`; a missing one is none. */
  approvals: ReadonlyMap<string, HumanApproval>;
  workflow: ReadinessWorkflow;
  /** The base branch each pull request was opened against, by `repositoryId#number`. */
  recordedBases: ReadonlyMap<string, string>;
  /** `hostUserId` is the presser's account; `otherHostUserIds` are the rest of the accounts the same person has linked (a person with two accounts cannot be the "other" approver by using the second). */
  presser: { hostUserId: string | undefined; otherHostUserIds?: readonly string[] };
  /**
   * Whether whoever presses Merge must have a linked code-host account (Cloud: always, controller ruling 2026-10-26, so the approval of the presser can be told from a reviewer's). Code has
   * one owner who proves themselves by a session or a collaborator's comment, so its install turns this off. Default true.
   */
  requirePresserAccount?: boolean;
  allowSelfApproval: boolean;
  /** The name the person who asked is called by, for the words of an approval that must come from someone else. */
  requesterName: string;
  /** Whether a code owner approved, by `repositoryId#number`, where the repository has a CODEOWNERS file that covers the changed paths (read fresh; absent where nothing was read). */
  codeOwners?: ReadonlyMap<string, CodeOwnerVerdict> | undefined;
  /** SR-1: the words of the refusal while an `on` second review that did not run waits for the task owner to acknowledge it (`secondReviewMergeWait`). Absent: nothing waits. */
  secondReviewWait?: string | undefined;
}

export type Readiness = { ready: true } | { ready: false; message: string };
export const pullRequestKey = (pr: { repositoryId: string; number: number }): string => `${pr.repositoryId}#${String(pr.number)}`;
const notReady = (message: string): Readiness => ({ ready: false, message });

function approvalMessage(reason: ApprovalRefusal, repository: string, input: Pick<ReadinessInput, "allowSelfApproval" | "requesterName">): string {
  switch (reason) {
    case "none": return input.allowSelfApproval ? M.needsWriteApproval(repository) : M.needsOtherApproval(input.requesterName);
    case "no_write": return M.needsWriteApproval(repository);
    case "self_only": return M.needsOtherApproval(input.requesterName);
    case "unlinked_requester": return M.linkGithub;
    case "stale": return M.staleApproval;
    case "changes_requested": return M.changesRequested;
  }
}

function codeOwnerRefusal(verdict: CodeOwnerVerdict | undefined): string | undefined {
  if (verdict === undefined || verdict.ok) return undefined;
  return "unreadable" in verdict ? M.codeOwnersUnreadable : M.needsCodeOwner(verdict.owners);
}

function workflowRefusal(workflow: ReadinessWorkflow): string | undefined {
  if (workflow.stage === "MERGED" || workflow.stage === "CLOSED") return M.taskClosed;
  // The base branch was merged in and the merged code needs its checks and reviews again: the owner's Retry checks, not "still changing".
  if (workflow.stage === "VERIFY" && workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.baseMergedRecheck) return M.baseMerged;
  if (workflow.stage !== "WAIT_FOR_MERGE") return M.changing;
  if (workflow.state === "BLOCKED") {
    if (isCiFixBlockReason(workflow.blockReason)) return M.checks;
    if (isBranchSyncBlockReason(workflow.blockReason)) return workflow.blockReason;
    return M.changing;
  }
  const card = workflow.feedbackReview?.status;
  if (workflow.state !== "WAITING" || workflow.fixSource !== undefined || workflow.branchSync !== undefined || card === "PENDING" || card === "COLLECTING") return M.changing;
  return undefined;
}

/**
 * Ready needs, for every required pull request that is not merged yet: it is open, on the base it was opened against, not a draft, with CI passing (or none to wait for), a branch
 * that does not conflict and is not behind a base that requires it up to date, and a counted approval; and the task is waiting for the merge with nothing being changed. With
  * the presser must have a linked GitHub account and, with self-approval off, must not be the only approver of any pull request. With several pull requests a refusal names the repository.
 */
export function mergeReadiness(input: ReadinessInput): Readiness {
  const refusal = workflowRefusal(input.workflow);
  if (refusal !== undefined) return notReady(refusal);
  const open = input.pullRequests.filter((pr) => pr.state !== "merged");
  if (open.length === 0) return notReady(M.taskClosed);
  if (input.secondReviewWait !== undefined) return notReady(input.secondReviewWait);
  const several = input.pullRequests.length > 1;
  for (const pr of open) {
    const key = pullRequestKey(pr);
    const approval = input.approvals.get(key) ?? { approved: false as const, reason: "none" as const };
    const owner = codeOwnerRefusal(input.codeOwners?.get(key));
    const reason = pr.state !== "open" ? M.notOpen
      : input.recordedBases.get(key) !== pr.baseBranch ? M.baseChanged(pr.baseBranch)
      : pr.ci === "unreadable" ? M.ciNotReadable
      : pr.draft ? (pr.ci === "none" ? M.draftNoCi : M.draft)
      : !ciAllowsMerge(pr.ci) ? M.checks
      : pr.branch === "conflicted" ? M.conflicted(pr.baseBranch)
      : !approval.approved ? approvalMessage(approval.reason, pr.repositoryId, input)
      : owner !== undefined ? owner
      // Only a branch that is approved is brought up to date (an approval none counts needs no up-to-date branch yet).
      : pr.branch === "behind" && pr.behindRequired ? (input.workflow.e2e?.required === true ? M.behindByHand(pr.baseBranch) : M.behind(pr.baseBranch))
      : undefined;
    if (reason !== undefined) return notReady(several ? M.repository(pr.repositoryId, reason) : reason);
  }
  // Whoever presses Merge must have a linked GitHub account, whether the org allows self-approval or not (controller ruling 2026-10-26).
  // With self-approval off the presser must be known, whatever `requirePresserAccount` says: otherwise "the only approver cannot press" could not be checked.
  if (input.presser.hostUserId === undefined && (input.requirePresserAccount !== false || !input.allowSelfApproval)) return notReady(M.linkGithub);
  if (!input.allowSelfApproval && input.presser.hostUserId !== undefined) {
    const presserAccounts = [input.presser.hostUserId, ...(input.presser.otherHostUserIds ?? [])];
    for (const pr of open) {
      const approval = input.approvals.get(pullRequestKey(pr));
      if (approval?.approved === true && approval.approvers.length === 1 && presserAccounts.includes(approval.approvers[0]!.hostUserId)) return notReady(M.presserApproved);
    }
  }
  return { ready: true };
}


// ---- what the merge needs of its surroundings

export interface CodeMergeHost {
  /**
   * The repository as the task's project pins it, with the code host its record names (an unknown kind is refused). Reads and the merge go through that host's port: the change request's status,
   * a person's standing, the CODEOWNERS file, the changed paths and `merge`. A host without `merge` or without code owners is not asked for them.
   */
  repository: RepositoryResolver;
  scope(orgId: OrgId): HostScope;
  loadTask(taskId: string): Promise<MergeTask | undefined>;
  /** The base branch the pull request was opened against, from Rovara's own record of it. */
  recordedBase(workspaceId: string, repositoryId: string, number: number): Promise<string | undefined>;
  /** Wakes the tracking pass so a branch the host needs up to date is brought up to date (the sync slot). Only the press calls it. */
  requireSyncForMerge?(task: MergeTask): Promise<void>;
  log?(event: string, fields: Record<string, unknown>): void;
}

export interface MergeDependencies {
  store: DocumentStore;
  host: CodeMergeHost;
  approvers: Approvers;
  audit: AuditSink;
  people: MergePeople;
  /** The identity adapter, for its capabilities: a sign-in rule of `any-active` is honoured only when `capabilities.companySignIn` is true (lane P3, decision 62). Absent: it is not. */
  identity?: Pick<IdentityProvider, "capabilities">;
  settings: CodeSettingsReader;
  milestones: CodeMilestones;
  timeline: SessionTimeline;
  links: LinkedChangeRequestFinder;
  now: () => number;
  /** Whether whoever presses Merge must have a linked code-host account (see `ReadinessInput.requirePresserAccount`). Default true; Code's install turns it off. */
  requirePresserAccount?: boolean;
  /** The words of a refusal while something outside the merge core holds the merge (a second review that did not run and waits for the owner). Absent: nothing waits. */
  mergeWait?(task: MergeTask): string | undefined;
  /** TE-B2: the project's real-check mode (see `ProjectCiMode`); `DEFAULT_CI_MODE` when absent. It decides whether an approval of the head before a clean sync carries over on "No CI". */
  ciMode?(task: MergeTask): Promise<ProjectCiMode> | ProjectCiMode;
}

const byRepository = <T extends { repositoryId: string; number: number }>(list: readonly T[]): T[] =>
  [...list].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);

/** The pull requests the task needs merged, in repository order (the merged ones stay: they are skipped, not forgotten). */
export function requiredPullRequests(workflow: WorkflowSnapshot): PullRequestEntry[] {
  return byRepository((workflow.pullRequests ?? []).filter((pr) => pr.required));
}

/** Who asked, for the words of a refusal: never an email address (C60; the display name without it, else "the person who asked"). */
const requesterNameForWords = (name: string): string => {
  const shown = withoutEmailAddresses(name.replace(/[\p{Cc}\p{Cf}]/gu, " ")).trim();
  return /[\p{L}\p{N}]/u.test(shown) ? shown.slice(0, 80).trim() : "the person who asked";
};
const requesterNameOf = (task: MergeTask): string => requesterNameForWords(task.ownerName);

// ---- readiness from what tracking stored (the press and the view)

export function factsFromItem(item: MergeTrackingItem, behindRequired = false): MergePullRequestFacts {
  return { repositoryId: item.repositoryId, number: item.number, headSha: item.headSha, state: item.state, draft: item.draft, baseBranch: item.baseBranch, ci: item.ci, branch: item.branch, behindRequired };
}

/** The approval merge tracking stored for a pull request, judged by the same rules: it holds only the latest approval of a person with write access. */
async function approvalOfItem(
  deps: MergeDependencies, orgId: OrgId, item: MergeTrackingItem, pullRequest: PullRequestEntry | undefined,
  ctx: { requesters: string[] | "unlinked"; allowSelfApproval: boolean; ciMode: ProjectCiMode },
): Promise<HumanApproval> {
  if (item.review === "changes_requested") return { approved: false, reason: "changes_requested" };
  if (item.approval === undefined) return { approved: false, reason: "none" };
  const { hostUserId, login, commitId } = item.approval;
  return humanApprovalOf({
    reviews: [{ hostUserId, login, accountType: "person", state: "APPROVED", commitId, submittedAt: item.observedAt }],
    headSha: item.headSha, syncedFrom: pullRequest?.syncedFrom, ciPassingOnHead: ciCountsAsPassing(item.ci, ctx.ciMode),
    permissions: new Map([[login, "write" as const]]), requesterHostUserIds: ctx.requesters, linkedHostUserIds: await linkedAmong(deps.people, orgId, [hostUserId]),
    excludedHostUserIds: await nonWritersAmong(deps.people, orgId, [hostUserId]),
    allowSelfApproval: ctx.allowSelfApproval,
  });
}

interface StoredReadiness { readiness: Readiness; items: MergeTrackingItem[]; settings: CodeSettings; entries: PullRequestEntry[] }

/** Every code-host account of the presser: `hostAccountsOf` when the people seam has it, else the one `hostAccountOf` gives. */
async function presserAccountsOf(people: MergePeople, orgId: OrgId, personId: string): Promise<string[]> {
  const first = await people.hostAccountOf(orgId, personId);
  const all = (await people.hostAccountsOf?.(orgId, personId)) ?? [];
  return [...new Set([...(first === undefined ? [] : [first]), ...all])];
}
const presserOf = (accounts: readonly string[] | undefined): ReadinessInput["presser"] =>
  accounts === undefined || accounts.length === 0 ? { hostUserId: undefined } : { hostUserId: accounts[0], otherHostUserIds: accounts.slice(1) };

async function readinessFromItems(
  deps: MergeDependencies, task: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, items: readonly MergeTrackingItem[], presserPersonId: string | undefined,
  options: { behindRequired?: ReadonlyMap<string, boolean> } = {},
): Promise<StoredReadiness> {
  const settings = await deps.settings.read(task.orgId, task.project);
  const entries = requiredPullRequests(task.workflow).filter((entry) => entry.state !== "MERGED");
  const itemOf = new Map(items.map((item) => [pullRequestKey(item), item]));
  const requesters = await requesterHostIds(deps.people, task.orgId, task);
  const ciMode = await (deps.ciMode?.(task) ?? DEFAULT_CI_MODE);
  const presser = presserOf(presserPersonId === undefined ? undefined : await presserAccountsOf(deps.people, task.orgId, presserPersonId));
  const facts: MergePullRequestFacts[] = [];
  const approvals = new Map<string, HumanApproval>();
  const bases = new Map<string, string>();
  for (const entry of entries) {
    const key = pullRequestKey(entry);
    const item = itemOf.get(key);
    // Tracking has not read this pull request yet: nothing is known of it.
    if (item === undefined) return { readiness: notReady(M.notTrackedYet), items: [...items], settings, entries };
    facts.push(factsFromItem(item, options.behindRequired?.get(key) ?? false));
    approvals.set(key, await approvalOfItem(deps, task.orgId, item, entry, { requesters, allowSelfApproval: settings.allowSelfApproval, ciMode }));
    const base = await deps.host.recordedBase(task.workspaceId, entry.repositoryId, entry.number);
    if (base !== undefined) bases.set(key, base);
  }
  const wait = deps.mergeWait?.(task);
  const readiness = mergeReadiness({
    pullRequests: facts, approvals, workflow: task.workflow, recordedBases: bases, presser, requirePresserAccount: deps.requirePresserAccount ?? true,
    allowSelfApproval: settings.allowSelfApproval, requesterName: requesterNameOf(task), ...(wait === undefined ? {} : { secondReviewWait: wait }),
  });
  return { readiness, items: [...items], settings, entries };
}

/** The task view's `merge`: whether the viewer pressing Merge now would be allowed to, from what tracking last read. Undefined where nothing is tracked. */
export async function mergeViewOf(deps: MergeDependencies, task: MergeTask, items: readonly MergeTrackingItem[], viewerPersonId: string | undefined): Promise<MergeView | undefined> {
  if (items.length === 0 || task.orgId === undefined || !tracksMerge(task.workflow)) return undefined;
  const { readiness } = await readinessFromItems(deps, task as MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, items, viewerPersonId);
  return { ...mergeViewFromReadiness(readiness), risk: riskOfTask(task.workflow, items) };
}

/**
 * The risk the Merge section shows (owner decision 2026-10-27): the level and reasons recorded for the pull request's code. When none is recorded, when it was judged for other code than the workflow's
 * current candidate, or when someone else pushed to a pull request since, the code Rovara would merge is not the code it judged, so the level is at least medium and says so.
 */
export function riskOfTask(workflow: WorkflowSnapshot | undefined, items: ReadonlyArray<{ headByRovara: boolean }>): MergeRisk {
  const recorded = workflow?.risk;
  if (recorded === undefined) return { level: "medium", reasons: ["Rovara hasn't judged the risk of this change yet."] };
  const current = workflow?.candidate?.digest;
  if (current !== undefined && current !== recorded.candidateDigest) return { level: "medium", reasons: ["The risk was judged for earlier code, not the code that would be merged."] };
  if (items.some((item) => !item.headByRovara)) {
    return { level: recorded.level === "low" ? "medium" : recorded.level, reasons: ["Someone else pushed to this pull request after Rovara judged its risk.", ...recorded.reasons].slice(0, 8) };
  }
  return { level: recorded.level, reasons: [...recorded.reasons] };
}

/**
 * The view's `merge` for a readiness. The words of a refusal can carry a repository ID (up to 200 characters) and a branch name (up to 255), so with several pull requests they can pass the
 * 500 the view allows; a view that is too long fails the task view of every client that reads it, so it is cut here, with an ellipsis. The press itself still says the words in full.
 */
export function mergeViewFromReadiness(readiness: Readiness): MergeView {
  if (readiness.ready) return { ready: true };
  if (readiness.message.length <= MERGE_VIEW_MESSAGE_MAX) return { ready: false, message: readiness.message };
  const kept = readiness.message.slice(0, MERGE_VIEW_MESSAGE_MAX - 1);
  // Never end on half of a surrogate pair.
  const last = kept.charCodeAt(kept.length - 1);
  return { ready: false, message: `${last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept}\u2026` };
}


// ---- pressing Merge

/** A code host that does not offer `merge` (the port's `merge` is optional): Rovara never merges there, a person does on the host. */
const HOST_WILL_NOT_MERGE = "Rovara can't merge on this repository's code host. Merge it there.";
const NOT_APPROVED = "Nobody approved this merge, so nothing was merged.";
const SIGN_IN_NOT_FRESH = "This high-risk merge needs a recent sign-in. Sign in again and press Merge, so nothing was merged.";
const NEEDS_MORE_APPROVERS = "This merge needs more than one approver, which Rovara Code can't collect yet, so nothing was merged.";
const PROOF_USED = "This approval was already used. Ask for a new one.";

export interface MergeSubject {
  taskId: string;
  pullRequests: Array<{ repositoryId: string; number: number; headSha: string }>;
}

/** What `prepareMerge` answers: the request a person approves, and what the approving adapter needs from them. */
export interface PreparedMerge {
  request: ApprovalRequest;
  requirement: ApprovalRequirement;
  subject: MergeSubject;
  /** The words a surface shows the person: each pull request and how it will be merged. */
  changes: string[];
  /** The merge method the digest was made with: the press merges by this one or not at all. */
  mergeMethod: CodeSettings["mergeMethod"];
  risk: MergeRisk;
  /** The change tier the task carried when the request was made (absent when it carries none): the tier the person approves at. The press refuses when the change has grown past it. */
  tier?: TierLevel | undefined;
}

/** The digest a proof is bound to: the exact pull requests and heads, the merge method and the risk level the person is shown. A change to any of them is a new question. */
export function mergeArtifactDigest(subject: MergeSubject, method: CodeSettings["mergeMethod"], risk: MergeRisk["level"], tier?: TierLevel): string {
  // The tier is in the digest only when the task carries one, so the digest of every task from before the change tier is the one it always was.
  return createHash("sha256").update(JSON.stringify({ kind: MERGE_APPROVAL_KIND, taskId: subject.taskId, method, risk, ...(tier === undefined ? {} : { tier }), pullRequests: byRepository(subject.pullRequests) })).digest("hex");
}

const changeText = (repository: string, number: number, method: string): string => `Merge ${repository} pull request ${String(number)} (${method})`;

/**
 * Checks that the task may be merged now, from what tracking stored (the merge re-reads the host), and makes the request a person approves. A branch the host needs up to date is brought up to
 * date first (the press, and only the press, asks for the sync). Not ready, it throws `MERGE_NOT_READY` with the words of the refusal and writes nothing.
 *
 * `expectedHeads` are the heads the person was SHOWN (a surface carries them): when given, the request is refused unless exactly those heads are what would be merged now.
 */
export async function prepareMerge(
  deps: MergeDependencies,
  input: { taskId: string; requestId: string; presserPersonId?: string | undefined; expectedHeads?: ReadonlyArray<{ repositoryId: string; number: number; headSha: string }> | undefined },
): Promise<PreparedMerge> {
  const body = MergePressBodySchema.safeParse({ requestId: input.requestId });
  if (!body.success) throw agentXError("CONFIG_INVALID", "requestId: must be a uuid");
  const task = await deps.host.loadTask(input.taskId);
  if (task === undefined || task.orgId === undefined) throw agentXError("NOT_FOUND", "task not found");
  if (task.closedAt !== undefined || task.releasedAt !== undefined) throw agentXError("MERGE_NOT_READY", M.taskClosed);
  if (!tracksMerge(task.workflow)) throw agentXError("CONFIG_INVALID", "This task's pull requests are merged on the code host.");
  const tracked = task as MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot };
  // A small change that grew to risky is merged only once a person kept it and the risky reviews passed, whatever the code host says about its draft.
  if (await scopeHoldOf({ store: deps.store }, tracked)) throw agentXError("MERGE_NOT_READY", SCOPE_HELD);
  const items = await readMergeTracking(deps.store, tracked.taskId, tracked.orgId);

  // The heads the person was shown must be the heads Rovara would merge: checked first, so a push since never reads as some other problem and never merges.
  if (input.expectedHeads !== undefined) {
    const now = new Set(items.filter((item) => item.state !== "merged").map((pr) => `${pr.repositoryId}#${String(pr.number)}@${pr.headSha}`));
    const seenHeads = new Set(input.expectedHeads.map((pr) => `${pr.repositoryId}#${String(pr.number)}@${pr.headSha}`));
    if (now.size !== seenHeads.size || [...now].some((key) => !seenHeads.has(key))) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  }
  // A branch that is behind may be one the host wants up to date before it merges: only the host says so, so it is asked for those alone.
  const behindRequired = new Map<string, boolean>();
  const scope = deps.host.scope(tracked.orgId);
  for (const item of items.filter((candidate) => candidate.branch === "behind")) {
    const entry = requiredPullRequests(tracked.workflow).find((pr) => pr.repositoryId === item.repositoryId && pr.number === item.number);
    const home = entry === undefined ? undefined : await deps.host.repository(tracked.project, tracked.startingRevision, entry.repositoryId, tracked.orgId);
    if (home === undefined) continue;
    behindRequired.set(pullRequestKey(item), (await home.codeHost.changeRequestStatus(changeRequestRef(home.url, item.number), scope)).mergeableState === "behind");
  }
  const checked = await readinessFromItems(deps, tracked, items, input.presserPersonId, { behindRequired });
  if (!checked.readiness.ready) {
    const behind = items.find((item) => behindRequired.get(pullRequestKey(item)) === true);
    if (behind !== undefined && checked.readiness.message.includes(M.behind(behind.baseBranch))) await deps.host.requireSyncForMerge?.(task);
    throw agentXError("MERGE_NOT_READY", checked.readiness.message);
  }
  const open = checked.entries.filter((entry) => entry.state !== "MERGED");
  const heads = new Map(items.map((item) => [pullRequestKey(item), item.headSha]));
  const subject: MergeSubject = {
    taskId: tracked.taskId,
    pullRequests: byRepository(open.map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number, headSha: heads.get(pullRequestKey(entry))! }))),
  };
  const risk = riskOfTask(tracked.workflow, items);
  const tier = tracked.workflow.flow?.tier?.level;
  const request: ApprovalRequest = {
    companyId: tracked.orgId, requestId: input.requestId, kind: MERGE_APPROVAL_KIND, subject: { type: "task", id: tracked.taskId }, projectName: tracked.project,
    revision: tracked.workflow.revision, artifactDigest: mergeArtifactDigest(subject, checked.settings.mergeMethod, risk.level, tier), risk: risk.level,
  };
  return {
    request, requirement: await deps.approvers.requirement(request), subject, risk, mergeMethod: checked.settings.mergeMethod, ...(tier === undefined ? {} : { tier }),
    changes: subject.pullRequests.map((pr) => changeText(pr.repositoryId, pr.number, checked.settings.mergeMethod)),
  };
}

export type MergePressResult = { status: "MERGED"; pullRequests: Array<{ repositoryId: string; number: number }> };

/**
 * A person presses Merge with their proof. The request is made again from what tracking stored NOW (so the digest the proof is bound to is the digest of what would be merged now), the proof is
 * verified by `Approvers.verify`, and only then does the single merge path run, with the code host re-read for every pull request. A proof that does not verify merges nothing and claims nothing.
 */
export async function pressMerge(
  deps: MergeDependencies,
  input: { taskId: string; requestId: string; proof: ApprovalProof; presserPersonId?: string | undefined; expectedHeads?: ReadonlyArray<{ repositoryId: string; number: number; headSha: string }> | undefined },
): Promise<MergePressResult> {
  const prepared = await prepareMerge(deps, input);
  // What the approver adapter requires is enforced here, before the proof is looked at: a method it does not list is no approval, and more than one approver cannot be collected yet.
  if (!prepared.requirement.methods.includes(input.proof.method)) throw agentXError("FORBIDDEN", NOT_APPROVED);
  const strong = strictMethodsFor("approve", prepared.risk.level, prepared.requirement);
  if (strong !== undefined && !strong.includes(input.proof.method)) throw agentXError("FORBIDDEN", NOT_APPROVED);
  if (prepared.requirement.minApprovers !== 1) throw agentXError("FORBIDDEN", NEEDS_MORE_APPROVERS);
  const verdict = await deps.approvers.verify(prepared.request, input.proof);
  if (!verdict.approved) {
    // A proof for what the person saw, when what would be merged is something else now, is "it changed", not "nobody approved": the person checks and approves again.
    if (verdict.reason === "other_content" || verdict.reason === "other_revision") throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    if (verdict.reason === "proof_already_used") throw agentXError("FORBIDDEN", PROOF_USED);
    throw agentXError("FORBIDDEN", NOT_APPROVED);
  }
  if (!prepared.requirement.methods.includes(verdict.method)) throw agentXError("FORBIDDEN", NOT_APPROVED);
  if (strong !== undefined && !strong.includes(verdict.method)) throw agentXError("FORBIDDEN", NOT_APPROVED);
  // The company's sign-in rule (decision 62): a high-risk merge needs the approver's sign-in to satisfy it. Fails closed on a missing sign-in time.
  if (prepared.risk.level === "high" && prepared.requirement.signIn !== undefined && !checkApprovalSignIn(prepared.requirement.signIn, verdict.approver, deps.now(), { companySignIn: deps.identity?.capabilities.companySignIn === true }).ok) throw agentXError("FORBIDDEN", SIGN_IN_NOT_FRESH);
  const task = await deps.host.loadTask(input.taskId);
  if (task === undefined || task.orgId === undefined || !tracksMerge(task.workflow)) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  if (task.closedAt !== undefined || task.releasedAt !== undefined) throw agentXError("MERGE_NOT_READY", M.taskClosed);
  // The task must still be at the revision the person approved, and merged by the method they were shown.
  if (task.workflow.revision !== prepared.request.revision) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  // Read again right before the merge: the hold may have come back (a new push asked the question again).
  if (await scopeHoldOf({ store: deps.store }, task)) throw agentXError("MERGE_NOT_READY", SCOPE_HELD);
  const merged = await mergeTask(deps, task as MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, prepared.subject, {
    decidedBy: verdict.approver.personId, occurrence: input.requestId, proof: input.proof, method: verdict.method, mergeMethod: prepared.mergeMethod, requestId: input.requestId, tier: prepared.tier,
  });
  return { status: "MERGED", pullRequests: merged };
}

// ---- merging it

const REFUSAL_REASONS = {
  head_changed: "the pull request changed", not_mergeable: "the code host would not merge it", closed: "it is closed", forbidden: "the code host did not allow Rovara to merge it",
} as const;

/** Why the host would not merge, in the words Rovara has for it and, where the host gave one, its own reason (branch protection, a required check, a ruleset), already cleaned. */
function refusalWords(result: Extract<MergeResult, { outcome: "refused" }>): string {
  const base = REFUSAL_REASONS[result.reason];
  return result.hostMessage === undefined ? base : `${base} (the host says: ${result.hostMessage})`;
}

async function mergeableNow(
  deps: MergeDependencies, task: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, subject: MergeSubject, presserPersonId: string, shownTier?: TierLevel,
): Promise<{ plan: Array<{ entry: PullRequestEntry; url: string; codeHost: CodeHost; headSha: string }>; settings: CodeSettings; alreadyMerged: boolean; mergedBefore: string[]; entries: PullRequestEntry[] }> {
  // The request lists the pull requests that were unmerged when it was made. Those that merged since (a half merge being finished) are not in the way; one that is new is.
  const required = requiredPullRequests(task.workflow);
  const entries = required.filter((entry) => entry.state !== "MERGED");
  const mergedByWorkflow = required.filter((entry) => entry.state === "MERGED").map((entry) => entry.repositoryId);
  const wanted = byRepository(subject.pullRequests);
  if (entries.length !== wanted.length || entries.some((entry, index) => entry.repositoryId !== wanted[index]!.repositoryId || entry.number !== wanted[index]!.number)) {
    throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  }
  const settings = await deps.settings.read(task.orgId, task.project);
  const scope = deps.host.scope(task.orgId);
  const requesters = await requesterHostIds(deps.people, task.orgId, task);
  const ciMode = await (deps.ciMode?.(task) ?? DEFAULT_CI_MODE);
  const permissions = new Map<string, Promise<RepositoryPermission>>();
  const facts: MergePullRequestFacts[] = [];
  const approvals = new Map<string, HumanApproval>();
  const bases = new Map<string, string>();
  const codeOwners = new Map<string, CodeOwnerVerdict>();
  const plan: Array<{ entry: PullRequestEntry; url: string; codeHost: CodeHost; headSha: string }> = [];
  const tierTargets: Array<TierReadTarget & { headSha: string }> = [];
  const items = new Map((await readMergeTracking(deps.store, task.taskId, task.orgId)).map((item) => [pullRequestKey(item), item]));
  for (const [index, entry] of entries.entries()) {
    const key = pullRequestKey(entry);
    const home = await deps.host.repository(task.project, task.startingRevision, entry.repositoryId, task.orgId);
    if (home === undefined) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    const { url } = home;
    // The pull request must be the one Rovara linked to this task: nothing a stored field says moves it to another.
    const linked = await deps.links.find({ hostKind: providerOf(home.codeHost), connectionKind: home.codeHost.kind, repositoryAddress: url, id: String(entry.number) });
    if (linked === undefined || linked.taskId !== task.taskId || linked.repositoryId !== entry.repositoryId || linked.url !== entry.url) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    const status = await home.codeHost.changeRequestStatus(changeRequestRef(url, entry.number), scope);
    if (status.id !== String(entry.number)) throw agentXError("RUNTIME_UNAVAILABLE", "The code host answered for another pull request");
    if (status.state !== "merged" && status.headRevision !== wanted[index]!.headSha) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    const item = items.get(key);
    const ci = readCi(status, { checksEverSeen: item?.checksEverSeen ?? status.checks.length > 0, lastRovaraPushAt: item?.lastRovaraPushAt === undefined ? undefined : Date.parse(item.lastRovaraPushAt), now: deps.now(), unreadableSince: unreadableSinceOf(item, status.headRevision) });
    facts.push({
      repositoryId: entry.repositoryId, number: entry.number, headSha: status.headRevision, state: status.state, draft: status.draft, baseBranch: status.targetBranch,
      ci: ci.ci, branch: readBranch(status), behindRequired: status.mergeableState === "behind",
    });
    const approval = await approvalFromStatus(deps, { home, scope, orgId: task.orgId, status, syncedFrom: entry.syncedFrom, ciPassing: ciCountsAsPassing(ci.ci, ciMode), requesters, allowSelfApproval: settings.allowSelfApproval, permissions });
    approvals.set(key, approval);
    // Where the repository names code owners for the changed paths, one of them has to have approved (read fresh, and only once an approval counts: the approval words come first).
    if (approval.approved && status.state === "open") codeOwners.set(key, await codeOwnersOf({ home, scope, baseBranch: status.targetBranch, number: entry.number, approval }));
    const base = await deps.host.recordedBase(task.workspaceId, entry.repositoryId, entry.number);
    if (base !== undefined) bases.set(key, base);
    plan.push({ entry, url, codeHost: home.codeHost, headSha: status.headRevision });
    tierTargets.push({ host: home.codeHost, repositoryId: entry.repositoryId, repositoryUrl: url, number: entry.number, headSha: status.headRevision });
  }
  const mergedBefore = [...mergedByWorkflow, ...facts.filter((fact) => fact.state === "merged").map((fact) => fact.repositoryId)];
  if (facts.every((fact) => fact.state === "merged")) return { plan: [], settings, alreadyMerged: true, mergedBefore, entries };
  const presser = presserOf(await presserAccountsOf(deps.people, task.orgId, presserPersonId));
  const wait = deps.mergeWait?.(task);
  const readiness = mergeReadiness({
    pullRequests: facts, approvals, workflow: task.workflow, recordedBases: bases, presser, requirePresserAccount: deps.requirePresserAccount ?? true,
    allowSelfApproval: settings.allowSelfApproval, requesterName: requesterNameOf(task), codeOwners, ...(wait === undefined ? {} : { secondReviewWait: wait }),
  });
  if (!readiness.ready) throw agentXError("MERGE_NOT_READY", readiness.message);
  // The change tier is computed again, from the host's view of the change as it is now: a change that has grown past the tier the person approved at is not merged.
  // Never skipped: a task with no recorded tier (one that was in flight before the tier existed, or that never had a plan) is judged as if approved at the lowest tier, so anything above small is a growth.
  await tierGate(deps, task, tierTargets.filter((_, index) => facts[index]!.state !== "merged"), scope, shownTier);
  return { plan: plan.filter((_, index) => facts[index]!.state !== "merged"), settings, alreadyMerged: false, mergedBefore, entries };
}

const SCOPE_HELD = "This change grew from small to risky, so it waits for a person to keep, remove or stop it, and for the code and security reviews to pass.";
const FLOOR_OWED = "A reviewer has not yet answered the security questions for the current version of this change, so it can't be merged yet.";
const HEAD_UNBOUND = "Rovara couldn't tell exactly which version of the code this is, so nothing was merged.";
const TIER_UNREADABLE = "Rovara couldn't read the changed files from the code host just now, so nothing was merged. Try again in a moment.";

/**
 * Recomputes the change tier at merge, from the code host's view of the change (never from the stored tier or an agent's word). The tier never goes down: the recorded tier and the new one are raised together. The merge is refused,
 * in plain words naming what grew, when the result is higher than EITHER the tier the person approved at (`shown`; none recorded counts as small) OR the tier the planning steps were chosen at (the estimate, when steps were skipped).
 * A growth is STICKY: it is recorded (`grewAfterBuild`), and from then on the merge needs the review steps of the higher tier to have run on the CURRENT head (`tierReviewRecorded`); a second press does not clear it, and a push
 * makes the record stale. The record is written under `flowIs`, so a lost race is refused, and a whole-workflow writer that read the task earlier carries the stored record forward (flow-guard.ts). A host that cannot be read
 * refuses the merge too, and records nothing. When the lighter flow skipped planning steps (`flow.skippedSteps`), a small change also needs the reviewer's questions on the record for the current head and patch; a task that ran the whole plan does not.
 */
/** Exported for the tests of its refusals (a head that cannot be bound); `pressMerge` is the one caller. */
export async function tierGate(
  deps: MergeDependencies, task: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, targets: ReadonlyArray<TierReadTarget & { headSha: string }>, scope: HostScope, shown: TierLevel | undefined,
): Promise<void> {
  let input: Awaited<ReturnType<typeof readTierInput>>;
  try {
    input = await readTierInput(targets, scope);
  } catch (error) {
    if (isHostRateLimit(error)) throw error;
    deps.host.log?.("merge.tier_unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    throw agentXError("MERGE_NOT_READY", TIER_UNREADABLE);
  }
  // The head must not have moved while the files were read: the tier is for the code that would be merged.
  try {
    for (const target of targets) {
      const status = await target.host.changeRequestStatus(changeRequestRef(target.repositoryUrl, target.number), scope);
      if (status.state !== "merged" && status.headRevision !== target.headSha) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    }
  } catch (error) {
    if (isHostRateLimit(error) || (error instanceof Error && "code" in error && (error as { code?: string }).code === "MERGE_NOT_READY")) throw error;
    deps.host.log?.("merge.tier_head_unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    throw agentXError("MERGE_NOT_READY", TIER_UNREADABLE);
  }
  const at = new Date(deps.now()).toISOString();
  const bound = boundCommits(targets.map((target) => ({ repositoryId: target.repositoryId, headSha: target.headSha, baseCommitSha: task.workflow.reviewBase?.find((base) => base.repositoryId === target.repositoryId)?.baseCommitSha })));
  // A tier that cannot be bound to the head is not a tier: records of reviews are for a head, and there is none to compare.
  if (bound.headSha === undefined) throw agentXError("MERGE_NOT_READY", HEAD_UNBOUND);
  const patchDigest = patchDigestOf(canonicalPatchText(input.diff.files));
  const fresh = tierFromDiff(input.diff, { ...bound, at, head: input.head });
  const approvedAt: TierLevel = shown ?? "small";
  // What the record says is judged against the task as it is NOW: a growth is written until it is on the record, however often another writer got in first.
  let current: WorkflowSnapshot = task.workflow;
  let verdict: "ok" | "grew" | "owed" | "floor" = "ok";
  let raised = raiseTier(current.flow?.tier, fresh);
  for (let attempt = 0; attempt < GROWTH_WRITE_ATTEMPTS; attempt += 1) {
    const flow = current.flow;
    raised = raiseTier(flow?.tier, fresh);
    const planned = planningLevelOf(flow);
    // The checks of the higher tier have run on this very head: nothing is owed.
    const covered = tierReviewRecorded(flow, raised.level, bound.headSha);
    const grew = !covered && (tierGrew(approvedAt, raised) || (planned !== undefined && tierGrew(planned, raised)));
    const owed = !covered && !grew && flow?.grewAfterBuild !== undefined && !tierReviewRecorded(flow, flow.grewAfterBuild.to, bound.headSha);
    const floor = !grew && !owed && skippedPlanning(flow) && needsReviewerFloor(raised) && !reviewerFloorRecorded(flow, bound.headSha, patchDigest);
    verdict = grew ? "grew" : owed ? "owed" : floor ? "floor" : "ok";
    const recorded = recordTier(flow, { ...fresh, source: "merge" });
    const from: TierLevel = planned !== undefined && tierRank(planned) < tierRank(approvedAt) ? planned : approvedAt;
    const next = grew ? recordGrowth(recorded.flow, from, recorded.tier.level, at) : recorded.flow;
    // Under the revision and the record this tier was computed against. The revision does not move: a row of the step in flight waits for it.
    const written = await deps.store.update({
      key: taskRecordKey(task.taskId),
      ops: [change.set(["workflow", "flow"], plain(next) as never)],
      condition: when.and(when.eq(["workflow", "revision"], current.revision), when.notExists("closedAt"), flowIs(flow)),
    }).then((result) => result.applied).catch(() => false);
    if (written || verdict !== "grew") break;
    // The growth did not land (another writer got in first): read the task again and write it again.
    const again = await deps.host.loadTask(task.taskId).catch(() => undefined);
    if (again?.workflow === undefined) break;
    current = again.workflow;
  }
  if (verdict === "grew" || verdict === "owed") throw agentXError("MERGE_NOT_READY", tierGrowthSentence(raised, (path) => inertLine(path, 80)));
  if (verdict === "floor") throw agentXError("MERGE_NOT_READY", FLOOR_OWED);
}

/** How many times a growth is written before the refusal is given without it. */
const GROWTH_WRITE_ATTEMPTS = 5;

/**
 * Whether a code owner approved, for one pull request: nothing is asked of the host when it does not read code owners or the repository has no CODEOWNERS file. Anything unreadable fails closed.
 * The code owners (read by the host itself) and the changed paths come from the code host's port; team membership is outside the port today (`ConsumerRepository.isTeamMember`), and a host that cannot tell is "unknown".
 */
async function codeOwnersOf(
  ctx: { home: ConsumerRepository; scope: HostScope; baseBranch: string; number: number; approval: Extract<HumanApproval, { approved: true }> },
): Promise<CodeOwnerVerdict> {
  const { codeHost, url } = ctx.home;
  if (!codeHost.capabilities.codeOwners || codeHost.codeOwners === undefined) return { ok: true };
  try {
    const owners = await codeHost.codeOwners({ url }, ctx.baseBranch, ctx.scope);
    if (owners === undefined) return { ok: true };
    const changed = await changedPathsOf(codeHost, changeRequestRef(url, ctx.number), ctx.scope);
    // A list cut short could hide a path a code owner owns.
    if (!changed.complete) return { ok: false, unreadable: true };
    return await codeOwnerVerdict({
      codeOwners: owners, paths: changed.paths, approverLogins: ctx.approval.approvers.map((approver) => approver.login),
      teamMember: async (team, login) => (await ctx.home.isTeamMember?.(team, login, ctx.scope)) ?? "unknown",
    });
  } catch {
    return { ok: false, unreadable: true };
  }
}

/** The approval a fresh read of the host gives: each reviewer's permission is looked up now (once), and a reviewer's link to a person is read now. */
async function approvalFromStatus(
  deps: MergeDependencies,
  ctx: {
    home: ConsumerRepository; scope: HostScope; orgId: OrgId; status: ChangeRequestStatus; syncedFrom: string | undefined; ciPassing: boolean; requesters: string[] | "unlinked";
    allowSelfApproval: boolean; permissions: Map<string, Promise<RepositoryPermission>>;
  },
): Promise<HumanApproval> {
  const { status } = ctx;
  if (status.reviewsIncomplete === true) return { approved: false, reason: "none" };
  const reviews = approvalReviewsOf(status.reviews);
  const reviewers = latestReviewers(reviews);
  if (reviewers.length > PERMISSION_LOOKUPS_MAX) return { approved: false, reason: "none" };
  const permissions = new Map<string, RepositoryPermission>();
  for (const review of reviewers) {
    const key = `${ctx.home.url}:${review.login.toLowerCase()}`;
    let asked = ctx.permissions.get(key);
    if (asked === undefined) {
      asked = ctx.home.codeHost.standing({ url: ctx.home.url }, { login: review.login }, ctx.scope).then((standing) => standing.permission);
      ctx.permissions.set(key, asked);
    }
    permissions.set(review.login, await asked);
  }
  return humanApprovalOf({
    reviews, headSha: status.headRevision, syncedFrom: ctx.syncedFrom, ciPassingOnHead: ctx.ciPassing, permissions,
    requesterHostUserIds: ctx.requesters, linkedHostUserIds: await linkedAmong(deps.people, ctx.orgId, reviewers.map((review) => review.hostUserId)),
    excludedHostUserIds: await nonWritersAmong(deps.people, ctx.orgId, reviewers.map((review) => review.hostUserId)), allowSelfApproval: ctx.allowSelfApproval,
  });
}

/** Where a used proof is kept: one item for each proof, keyed by what the proof is (method, token, request), so a token cannot be used again under a fresh proof id. */
const proofUseKey = (companyId: string, proof: ApprovalProof): { pk: string; sk: string } => ({ pk: companyScoped(companyId, "MERGE_PROOF"), sk: approvalProofKey(proof) });
/** Where a proof is used up by what it is (method and token), not by the request it is presented for. */
const tokenUseKey = (companyId: string, proof: ApprovalProof): { pk: string; sk: string } => ({
  pk: companyScoped(companyId, "MERGE_PROOF_TOKEN"), sk: createHash("sha256").update(JSON.stringify([proof.method, proof.token])).digest("hex"),
});

type ClaimResult = { claimed: true; at: string } | { claimed: false; reason: "held" | "proof_used" };

/**
 * Claims the merge of one pull request on its tracking item: only when nobody holds it, or the holder's claim is older than `MERGE_CLAIM_SECONDS`. The claim bumps the item's version. The audit
 * fact commits with the claim (a claim that was lost leaves none and a claim that was made always leaves one), and so does the use of the proof (`useProof`, the first claim of a press).
 */
async function claimMerge(
  deps: MergeDependencies, task: { taskId: string; orgId: OrgId }, pr: { repositoryId: string; number: number; url: string; repositoryKey: string }, headSha: string, by: string,
  audit: { occurrence: string; method: string; proofMethod: string; proof: ApprovalProof | undefined; requestId: string },
  useProof: boolean,
): Promise<ClaimResult> {
  const now = deps.now();
  const at = new Date(now).toISOString();
  const eventId = createHash("sha256").update(`pull_request.merge_requested\n${audit.occurrence}\n${pr.repositoryId}\n${String(pr.number)}`).digest("hex");
  const staged = deps.audit.stage({
    eventId, companyId: task.orgId, at, actor: { type: "person", id: by }, action: "pull_request.merge_requested", subject: { type: "change_request", id: `${pr.repositoryKey}#${String(pr.number)}` },
    // Which approval merged: its request and proof ids and its method. Never the token.
    details: { repository: pr.repositoryKey, number: pr.number, method: audit.method, approvedBy: audit.proofMethod, requestId: audit.requestId, ...(audit.proof === undefined ? {} : { proofId: audit.proof.proofId }) },
  });
  // The use of the proof, in the claim's transaction. A local session is a standing secret by design and is used again and again; a proof whose token names one act (a comment id) is also
  // used up by what it IS, whatever request it is presented for, so the same comment cannot approve a second request (a new head, another task).
  const useRows: TransactItem[] = [];
  if (useProof && audit.proof !== undefined) {
    useRows.push({ kind: "put", item: plain({ ...proofUseKey(task.orgId, audit.proof), entityType: "MERGE_PROOF", requestId: audit.proof.requestId, taskId: task.taskId, usedAt: at }), condition: when.absent() });
    if (audit.proof.method !== LOCAL_SESSION_METHOD) useRows.push({ kind: "put", item: plain({ ...tokenUseKey(task.orgId, audit.proof), entityType: "MERGE_PROOF_TOKEN", requestId: audit.proof.requestId, taskId: task.taskId, usedAt: at }), condition: when.absent() });
  }
  const items: TransactItem[] = [
    {
      kind: "update", key: mergeTrackingKey(task.taskId, pr.repositoryId, pr.number), ops: [change.set(["mergeClaim"], { headSha, by, at }), change.add(["version"], 1)],
      condition: when.and(
        when.present(), when.eq("orgId", task.orgId), when.eq("taskId", task.taskId),
        when.or(when.notExists("mergeClaim"), when.lte(["mergeClaim", "at"], new Date(now - MERGE_CLAIM_SECONDS * 1000).toISOString())),
      ),
    },
    ...useRows,
    ...staged,
  ];
  const result = await deps.store.transact(items);
  if (result.applied) return { claimed: true, at };
  // The step that failed says why: the claim (index 0) was held by someone else or the item is not there; a use row (the next ones) says the proof was used before. Anything else is a fault.
  if (result.failed.includes(0)) return { claimed: false, reason: "held" };
  if (result.failed.some((index) => index >= 1 && index <= useRows.length)) return { claimed: false, reason: "proof_used" };
  throw agentXError("RUNTIME_UNAVAILABLE", "The merge could not be recorded.");
}

/**
 * Lets go of the claim after the host said no (nothing was merged, so nobody else needs to wait for the claim to age): only the claim this run made, found by who and when, so a claim somebody
 * else took since stays. Best effort: a claim that stays only costs the next press the wait it always cost. A host failure whose outcome is unknown keeps its claim (the next run finds out).
 */
async function releaseMergeClaim(deps: MergeDependencies, task: { taskId: string; orgId: OrgId }, pr: { repositoryId: string; number: number }, claim: { by: string; at: string }): Promise<void> {
  await deps.store.update({
    key: mergeTrackingKey(task.taskId, pr.repositoryId, pr.number), ops: [change.remove(["mergeClaim"]), change.add(["version"], 1)],
    condition: when.and(when.present(), when.eq("orgId", task.orgId), when.eq("taskId", task.taskId), when.eq(["mergeClaim", "by"], claim.by), when.eq(["mergeClaim", "at"], claim.at)),
  }).catch(() => undefined);
}

const hashNumber = (seed: string): number => Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 1_000_000;

/**
 * The single merge path: re-reads every pull request, every reviewer and the code owners from the host, checks readiness for the exact heads, claims each pull request on its tracking item (the
 * audit fact in the claim's transaction) and merges in repository order with the checked head as the revision. Returns the pull requests that are merged when it ends.
 */
async function mergeTask(
  deps: MergeDependencies, tracked: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, subject: MergeSubject,
  who: { decidedBy: string; occurrence: string; proof: ApprovalProof; method: string; mergeMethod: CodeSettings["mergeMethod"]; requestId: string; tier?: TierLevel | undefined },
): Promise<Array<{ repositoryId: string; number: number }>> {
  const { plan, settings, alreadyMerged, mergedBefore, entries } = await mergeableNow(deps, tracked, subject, who.decidedBy, who.tier);
  // The method the person was shown is the method used: a setting changed since is a new question.
  if (settings.mergeMethod !== who.mergeMethod) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  if (alreadyMerged) return entries.map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number }));
  const scope = deps.host.scope(tracked.orgId);
  // A host that does not let Rovara merge is found before any claim is made or anything is merged: the person merges on the host itself.
  if (plan.some((step) => step.codeHost.merge === undefined)) throw agentXError("MERGE_NOT_READY", HOST_WILL_NOT_MERGE);
  // What an earlier run of this handler already merged counts, so a rerun that finds the second pull request refused still says the first merged.
  const merged: string[] = [...mergedBefore];
  let proofUsed = false;
  for (const step of plan) {
    const { entry, url, headSha } = step;
    const claim = await claimMerge(
      deps, tracked, { repositoryId: entry.repositoryId, number: entry.number, url, repositoryKey: requireRepositoryKey(providerOf(step.codeHost), url) }, headSha, who.decidedBy,
      { occurrence: who.occurrence, method: settings.mergeMethod, proofMethod: who.method, proof: who.proof, requestId: who.requestId }, !proofUsed,
    );
    if (!claim.claimed) {
      if (claim.reason === "proof_used") throw agentXError("FORBIDDEN", PROOF_USED);
      // Another run holds the claim, or tracking has no item for the pull request yet: whichever it is, a later run finds out (the pull request merged, the claim gone stale).
      throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is already merging this pull request.");
    }
    proofUsed = true;
    const result = await step.codeHost.merge!(changeRequestRef(url, entry.number), { revision: headSha, method: settings.mergeMethod }, scope);
    if (result.outcome === "merged" || result.outcome === "already_merged") {
      merged.push(entry.repositoryId);
      if (result.outcome === "merged" && result.fellBack && tracked.sessionId !== undefined) {
        const other = result.method === "merge" ? "squash" : "merge";
        await deps.store.transact([deps.timeline.statusLine({ orgId: tracked.orgId, sessionId: tracked.sessionId }, {
          eventId: sessionEventId("merge_method", `${tracked.taskId}\n${entry.repositoryId}\n${String(entry.number)}`), at: new Date(deps.now()).toISOString(),
          text: `Merged ${entry.repositoryId} pull request ${String(entry.number)} using ${result.method}, because ${other} isn't allowed in that repository.`,
        })]).catch(() => undefined);
      }
      continue;
    }
    // The host said no: nothing merged, so the claim goes at once and a second press right after is not told Rovara is already merging.
    await releaseMergeClaim(deps, tracked, entry, { by: who.decidedBy, at: claim.at });
    const why = refusalWords(result);
    if (merged.length === 0) {
      throw agentXError("MERGE_NOT_READY", result.reason === "head_changed" ? M.changedAfterConfirm : M.notMerged(entry.repositoryId, why));
    }
    // A merge that fails after an earlier pull request merged stops: a person finishes it, and is told.
    const text = M.halfMerged(merged.join(", "), entry.repositoryId, why);
    const at = new Date(deps.now()).toISOString();
    const stuck = deps.milestones.items({
      kind: "stuck", orgId: tracked.orgId, taskId: tracked.taskId, ...(tracked.sessionId === undefined ? {} : { sessionId: tracked.sessionId }), at, text,
      pullRequests: plan.map((p) => ({ repository: p.entry.repositoryId, number: p.entry.number, url: p.entry.url })).slice(0, 32),
    }, hashNumber(who.occurrence), { definitionVersion: tracked.workflow.definitionVersion });
    if (stuck.length > 0) await deps.store.transact(stuck).catch(() => undefined);
    await deps.milestones.deliver(tracked.taskId).catch(() => undefined);
    throw agentXError("MERGE_NOT_READY", text);
  }
  return byRepository([...mergedBeforeEntries(tracked), ...plan.map((step) => ({ repositoryId: step.entry.repositoryId, number: step.entry.number }))]);
}

/** The pull requests the workflow already holds as merged (a half merge being finished): they are part of what the press answers. */
const mergedBeforeEntries = (task: { workflow: WorkflowSnapshot }): Array<{ repositoryId: string; number: number }> =>
  requiredPullRequests(task.workflow).filter((entry) => entry.state === "MERGED").map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number }));

