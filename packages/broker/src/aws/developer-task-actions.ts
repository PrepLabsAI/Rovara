// Spec 025 phase 25b: what the developer task routes may call on the broker. Types only; the
// broker builds it (createDeveloperTaskActions) over the existing handlers, so the routes never
// reach into broker.ts internals.
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { Operation, OperationRequest, PullRequestRequest, WorkspaceInstance } from "@agentx/contracts";
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

export interface DeveloperTaskActions {
  tableName: string;
  turnRecordsTableName?: string;
  /** The stack parameters: the limits when no admin setting exists (R7). */
  limitDefaults: { member: number; organization: number };
  latestProject(projectName: string): Promise<RegisteredProjectRecord | undefined>;
  preparation(identity: AuthenticatedIdentity, project: RegisteredProjectRecord, requestId: string): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems }>;
  workspace(workspaceId: string): Promise<WorkspaceInstance>;
  operations(workspaceId: string): Promise<Operation[]>;
  eventsNewestFirst(operationId: string, limit: number): Promise<StoredEvent[]>;
  artifacts(workspaceId: string, operationId: string): Promise<StoredArtifact[]>;
  readArtifact(objectKey: string, maxBytes: number): Promise<string>;
  pullRequests(workspaceId: string): Promise<StoredPullRequest[]>;
  acceptTask(identity: AuthenticatedIdentity, workspaceId: string, request: OperationRequest, extra: ExtraItems): Promise<{ operation: Operation; duplicate: boolean }>;
  acceptPullRequest(identity: AuthenticatedIdentity, workspaceId: string, request: PullRequestRequest, extra: ExtraItems): Promise<{ operation: Operation; duplicate: boolean }>;
  cancelRunning(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, extra: ExtraItems): Promise<TaskCancellationResult>;
  startClose(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, requestId: string, extra: ExtraItems): Promise<{ operationId: string; duplicate: boolean }>;
  /** Deletes the workspace's compute; the existing per-mode switch lives behind it (FR-024). */
  deleteCompute(workspace: WorkspaceInstance): Promise<void>;
  transact(items: TransactItems): Promise<void>;
}
