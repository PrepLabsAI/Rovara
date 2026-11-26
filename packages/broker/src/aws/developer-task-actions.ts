// Spec 025 phase 25b: what the developer task routes may call on the broker. Types only; the
// broker builds it (createDeveloperTaskActions) over the existing handlers, so the routes never
// reach into broker.ts internals.
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { ChannelTurn, Operation, WorkspaceInstance } from "@agentx/contracts";
import type { StoredEvent } from "../developer/task-records.js";
import type { RegisteredProjectRecord } from "./broker.js";

export type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
/** Extra items a handler writes in its own transaction, built from the operation it accepted. */
export type ExtraItems = (operation: Operation) => TransactItems;
export interface StoredArtifact { id: string; operationId: string; name: string; mediaType: string; objectKey: string; size?: number }
export interface StoredPullRequest { repository: string; number: number; url: string; state: "open" | "closed" | "merged" }

/**
 * The broker actions a developer task route may call. The handlers that take an identity check
 * the workspace's owner themselves; the reads, `deleteCompute` and `transact` do not, so callers
 * must load the owned task and check project access first.
 */
export interface DeveloperTaskActions {
  tableName: string;
  turnRecordsTableName?: string;
  latestProject(projectName: string): Promise<RegisteredProjectRecord | undefined>;
  /** One registered revision of a project, or undefined when it does not exist. Unchecked: callers must load the owned task and check project access first. */
  projectRevision(projectName: string, revision: number): Promise<RegisteredProjectRecord | undefined>;
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
  /** Deletes the workspace's compute; the existing per-mode switch lives behind it (FR-024). Unchecked: callers must load the owned task and check project access first. */
  deleteCompute(workspace: WorkspaceInstance): Promise<void>;
  /** Whether deleteCompute can delete this workspace's compute (a retired storage mode cannot be); the per-mode check lives behind it (FR-024). */
  canDeleteCompute?(workspace: WorkspaceInstance): boolean;
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
