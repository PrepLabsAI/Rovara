// Lane L6a, task flow core: the records the flow keeps in the document store, and the plain-JSON conversion that goes with them.
import type {
  DocumentKey,
  JsonValue,
  Operation,
  StoredDocument,
  WorkspaceStatus,
} from "@agentx/contracts";
import type { DeveloperTaskPointerRecord, DeveloperTaskRecord } from "../../developer/task-records.js";
import type { WorkspaceCharge } from "./keys.js";

/** The task record: Cloud's `DEVTASK#<id>/META` item. `provider` is the identity adapter's name (a string), not Cloud's closed sign-in list. */
export type TaskRecord = Omit<DeveloperTaskRecord, "provider" | "charge"> & {
  provider: string;
  charge: WorkspaceCharge;
  companyId: string;
  /** The admission reservation the start took; whoever closes the task gives it back. */
  admissionReservationId?: string;
  /** The task's session (lane L6b), created in the same transaction as the task when the install wires sessions. */
  sessionId?: string;
};

/** Cloud's `WORKSPACE#<id>/DEVELOPER_TASK` pointer: how a worker callback finds the task. The requester names the identity adapter, not a closed sign-in list. */
export type TaskPointerRecord = Omit<DeveloperTaskPointerRecord, "requester"> & { requester: { kind: "developer"; developerId: string; provider: string } };

/** `WORKSPACE#<id>/META`: where a task's worker runs. `machine` is set once a worker machine was started for it. */
export interface WorkspaceRecord {
  pk: string;
  sk: "META";
  entityType: "WORKSPACE";
  id: string;
  companyId: string;
  orgId: string;
  ownerKey: string;
  projectName: string;
  projectRevision: number;
  status: WorkspaceStatus;
  /** The one operation that holds the workspace (single writer); null when none does. */
  activeOperationId: string | null;
  /** Raised when a newer holder takes over; every operation and callback carries the fence it was issued under. */
  fence: number;
  machine?: { machineId: string; machineKey: string };
  /** The admission reservation taken when the machine was first started; whoever stops the machine settles or releases it. */
  machineReservationId?: string;
  /** How many machines this workspace has had; the admission key of the next start is made from it, so each machine is admitted once. */
  machineGeneration?: number;
  preparationManifest?: string;
  /** The sparse by-project index keys (WORKSPACE_PROJECT_INDEX). */
  workspaceProject: string;
  workspaceCreatedAt: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/** What a dispatch needs to build the worker's invocation. It never holds a secret: the grant and the capability are issued at delivery. */
export interface DispatchSpec {
  kind: "prepare" | "task";
  projectRevision: number;
  /** The invocation payload without `project` and `repositoryGrant` (a prepare gets those at delivery). */
  payload: Record<string, JsonValue>;
  /** Callback actions beyond the three every operation has (`artifacts`, `events`, `result`). */
  extraActions?: readonly string[];
  /** Optional worker features this operation cannot run without; a worker that does not list them fails the operation. */
  requires?: readonly string[];
}

export interface OperationRecord extends Operation {
  pk: string;
  sk: string;
  entityType: "OPERATION";
  companyId: string;
  eventSequence: number;
  dispatch: DispatchSpec;
  /** The workflow revision this operation runs at (set for a workflow step); a result for a revision the owner has moved past is ignored. */
  workflowRevision?: number;
  /** Who asked for it (the identity adapter's person id and name for itself); Cloud's closed `requestedBy` list cannot hold a Code principal. */
  requester?: { personId: string; provider: string };
  /** The worker machine and delivery time, once the operation was handed to a machine. */
  deliveredAt?: string;
  machineId?: string;
}

/** `WORKFLOW_DISPATCH` rows: the intent to start the next workflow step with no one asking, written in the transaction that made it due. */
export type DispatchKind = "UNDERSTAND" | "PLAN";

export interface DispatchRowRecord {
  pk: string;
  sk: string;
  entityType: "WORKFLOW_DISPATCH";
  companyId: string;
  taskId: string;
  workflowRevision: number;
  kind: DispatchKind;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  /** The due-time index keys. */
  dispatchDuePk: string;
  dispatchDueSk: string;
  indexExpiresAt: number;
  lastError?: string;
}

/** A record as the store keeps it: plain JSON, with undefined fields dropped. */
export function toDocument<T extends object>(record: T): StoredDocument {
  return JSON.parse(JSON.stringify(record)) as StoredDocument;
}

export function fromDocument<T>(document: StoredDocument | undefined): T | undefined {
  return document === undefined ? undefined : (document as unknown as T);
}

export const keyOf = (document: DocumentKey): DocumentKey => ({ pk: document.pk, sk: document.sk });
