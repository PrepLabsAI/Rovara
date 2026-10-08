// Spec 025 phase 25b: what the developer task routes may call on the broker. Types only; the
// broker builds it (createDeveloperTaskActions) over the existing handlers, so the routes never
// reach into broker.ts internals.
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { ChannelTurn, Operation, OperationRequest, ProjectCommand, PullRequestRequest, WorkflowFeedbackApprovalBinding, WorkflowReviewBase, WorkspaceInstance } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import type { StoredEvent } from "../developer/task-records.js";
import type { RegisteredProjectRecord } from "./broker.js";

export type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
/** Extra items a handler writes in its own transaction, built from the operation it accepted. */
export type ExtraItems = (operation: Operation) => TransactItems;
export interface StoredArtifact { id: string; operationId: string; name: string; mediaType: string; objectKey: string; size?: number }
export interface StoredPullRequest { repository: string; number: number; url: string; state: "open" | "closed" | "merged" }
export type TaskCancellationResult =
  | { outcome: "CANCEL_REQUESTED"; targetOperationId: string; cancelOperationId: string }
  | { outcome: "NOTHING_RUNNING" };

/**
 * The broker actions a developer task route may call. The handlers that take an identity check
 * the workspace's owner themselves; the reads, `deleteCompute` and `transact` do not, so callers
 * must load the owned task and check project access first.
 */
export interface DeveloperTaskActions {
  tableName: string;
  turnRecordsTableName?: string;
  /** The stack parameters: the limits when no admin setting exists (R7). */
  limitDefaults: { member: number; organization: number };
  latestProject(projectName: string): Promise<RegisteredProjectRecord | undefined>;
  /** One registered revision of a project, or undefined when it does not exist. Unchecked: callers must load the owned task and check project access first. */
  projectRevision(projectName: string, revision: number): Promise<RegisteredProjectRecord | undefined>;
  preparation(identity: AuthenticatedIdentity, project: RegisteredProjectRecord, requestId: string): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems }>;
  /** Unchecked: callers must load the owned task and check project access first. */
  workspace(workspaceId: string): Promise<WorkspaceInstance>;
  /** Every operation of the workspace, across all pages. Unchecked: callers must load the owned task and check project access first. */
  operations(workspaceId: string): Promise<Operation[]>;
  /** At most `limit` events, newest first. Unchecked: callers must load the owned task and check project access first. */
  eventsNewestFirst(operationId: string, limit: number): Promise<StoredEvent[]>;
  /** The operation's artifacts, across all pages. Unchecked: callers must load the owned task and check project access first. */
  artifacts(workspaceId: string, operationId: string): Promise<StoredArtifact[]>;
  /** The first `maxBytes` of an artifact. Unchecked: callers must load the owned task and check project access first. */
  readArtifact(objectKey: string, maxBytes: number): Promise<string>;
  /** The workspace's pull requests, across all pages. Unchecked: callers must load the owned task and check project access first. */
  pullRequests(workspaceId: string): Promise<StoredPullRequest[]>;
  /** `sharedTask`: the task is shared, so the worker's prompt gets the re-read line (25c note 1). */
  acceptTask(identity: AuthenticatedIdentity, workspaceId: string, request: OperationRequest, extra: ExtraItems, options?: { sharedTask?: boolean; workflowMode?: "PLAN" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW"; workflowPhase?: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"; readiness?: ProjectCommand[]; workflowFeedbackReview?: { taskId: string; workflowRevision: number; candidateDigest: string }; workflowFeedbackApproval?: WorkflowFeedbackApprovalBinding; workflowBase?: WorkflowReviewBase }): Promise<{ operation: Operation; duplicate: boolean }>;
  /**
   * `workflowCandidate`: the workflow's own draft publication of the tree its checks and reviews passed on, the only
   * pull request a workflow task's workspace accepts. The worker refuses a workspace that no longer has that tree, and
   * the broker checks the pushed commit's tree before opening the pull request.
   */
  acceptPullRequest(identity: AuthenticatedIdentity, workspaceId: string, request: PullRequestRequest, extra: ExtraItems, options?: { workflowCandidate?: { repositoryId: string; treeSha: string; candidateDigest: string; baseCommitSha?: string } }): Promise<{ operation: Operation; duplicate: boolean }>;
  /**
   * How many workflow publications of this repository's checked tree, for this candidate, ended without succeeding in
   * the workspace. Unchecked: callers must load the owned task first.
   */
  failedPublications(workspaceId: string, candidate: { repositoryId: string; candidateDigest: string; treeSha: string }): Promise<number>;
  cancelRunning(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, extra: ExtraItems): Promise<TaskCancellationResult>;
  startClose(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, requestId: string, extra: ExtraItems, discardUnpublished?: boolean): Promise<{ operationId: string; duplicate: boolean }>;
  /** Deletes the workspace's compute; the existing per-mode switch lives behind it (FR-024). Unchecked: callers must load the owned task and check project access first. */
  deleteCompute(workspace: WorkspaceInstance): Promise<void>;
  /** Writes items in one transaction. Unchecked: callers must load the owned task and check project access first. */
  transact(items: TransactItems): Promise<void>;
  /** C15: the shared thread's Slack turn records that name this task, newest first, at most `limit`. Unchecked: callers must load the owned task first. */
  channelTurns(threadSubject: string, taskId: string, limit: number): Promise<ChannelTurn[]>;
  /**
   * C14: who started this operation from the shared thread, if a teammate did, and at least how many
   * channel messages wait behind it (F18: a floor). Unchecked: callers must load the owned task first.
   */
  channelActivity(input: { taskId: string; operationId: string; threadSubject: string }): Promise<{ driver?: { slackUserId: string; name?: string }; waiting: number }>;
}
