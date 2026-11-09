// Lane L6a, task flow core: accepting an operation. An operation is one job for a workspace's worker (a preparation, one step of the
// workflow). Accepting it writes the operation record and stages its dispatch message with the caller's own change, in one transaction
// (the transactional outbox), so an operation exists if and only if its message does.
import { agentXError, when, type Operation, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, operationRequestKey } from "./keys.js";
import { toDocument, type DispatchSpec, type MaintenanceExpectation, type OperationRecord, type PublicationExpectation, type WorkspaceRecord } from "./records.js";
import { dispatchQueueName, hashJson, iso, newId } from "./support.js";

export interface AcceptInput {
  workspace: Pick<WorkspaceRecord, "id" | "fence" | "ownerKey">;
  kind: "prepare" | "task" | "publish" | "maintain";
  requestId: string;
  operationId?: string;
  conversationId?: string;
  workflowMode?: Operation["workflowMode"];
  dispatch: DispatchSpec;
  requester?: OperationRecord["requester"];
  workflowRevision?: number;
  /** A publish operation's expectation, which its pull request callback is held to. */
  publication?: PublicationExpectation;
  /** A maintain operation's expectation, which its update callback is held to. */
  maintenance?: MaintenanceExpectation;
  now?: string;
  /** Whether to write the request's idempotency record (a start does not: the start's own record covers it). */
  recordRequest?: boolean;
}

/** The dispatch message's body. Small and secret-free: the dispatcher reads the operation and builds the invocation itself. */
export interface DispatchMessage {
  v: 1;
  workspaceId: string;
  operationId: string;
}

export function buildOperation(deps: TaskFlowDeps, input: AcceptInput): { operation: OperationRecord; items: TransactItem[] } {
  const now = input.now ?? iso(deps);
  const id = input.operationId ?? newId(deps);
  const operation: OperationRecord = {
    ...operationKey(input.workspace.id, id),
    entityType: "OPERATION",
    companyId: deps.companyId,
    eventSequence: 0,
    id,
    workspaceId: input.workspace.id,
    orgId: deps.companyId,
    kind: input.kind,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
    requestId: input.requestId,
    payloadHash: hashJson({ kind: input.kind, mode: input.workflowMode ?? null, requestId: input.requestId, dispatch: input.dispatch }),
    status: "ACCEPTED",
    fence: input.workspace.fence,
    createdAt: now,
    updatedAt: now,
    dispatch: input.dispatch,
    ...(input.workflowRevision === undefined ? {} : { workflowRevision: input.workflowRevision }),
    ...(input.requester === undefined ? {} : { requester: input.requester }),
    ...(input.publication === undefined ? {} : { publication: input.publication }),
    ...(input.maintenance === undefined ? {} : { maintenance: input.maintenance }),
  };
  const message: DispatchMessage = { v: 1, workspaceId: input.workspace.id, operationId: id };
  return {
    operation,
    items: [
      { kind: "put", item: toDocument(operation), condition: when.absent() },
      ...(input.recordRequest === false ? [] : [{
        kind: "put" as const,
        item: { ...operationRequestKey(input.workspace.ownerKey, input.workspace.id, input.requestId), entityType: "IDEMPOTENCY", operationId: id, payloadHash: operation.payloadHash },
        condition: when.absent(),
      }]),
      deps.outbox.stage({ id, companyId: deps.companyId, queue: dispatchQueueName(deps), body: { ...message }, attributes: { kind: input.kind } }),
    ],
  };
}

/** A prompt that is too long for the worker is refused here, before anything is written. */
export function assertPromptFits(prompt: string): void {
  if (prompt.length === 0) throw agentXError("CONFIG_INVALID", "the request is empty");
  if (Buffer.byteLength(prompt, "utf8") > 65_536) throw agentXError("CONFIG_INVALID", "the request is too long for the worker");
}
