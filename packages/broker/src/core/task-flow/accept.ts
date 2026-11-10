// Lane L6a, task flow core: accepting an operation. An operation is one job for a workspace's worker (a preparation, one step of the
// workflow). Accepting it writes the operation record and stages its dispatch message with the caller's own change, in one transaction
// (the transactional outbox), so an operation exists if and only if its message does.
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, when, type DesignReviewBinding, type Operation, type TransactItem, type WorkflowDependencyInvocation } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, operationRequestKey } from "./keys.js";
import type { SecondReviewOperationPlan } from "../second-review/store.js";
import { toDocument, type DispatchSpec, type MaintenanceExpectation, type OperationRecord, type PublicationExpectation, type WorkspaceRecord } from "./records.js";
import { dispatchQueueName, hashJson, iso, newId } from "./support.js";

export interface AcceptInput {
  workspace: Pick<WorkspaceRecord, "id" | "fence" | "ownerKey">;
  kind: "prepare" | "task" | "publish" | "maintain";
  requestId: string;
  operationId?: string;
  conversationId?: string;
  workflowMode?: Operation["workflowMode"];
  /** The program step the operation runs (the plan check's). */
  programStepId?: string;
  dispatch: DispatchSpec;
  requester?: OperationRecord["requester"];
  workflowRevision?: number;
  /** A publish operation's expectation, which its pull request callback is held to. */
  publication?: PublicationExpectation;
  /** A maintain operation's expectation, which its update callback is held to. */
  maintenance?: MaintenanceExpectation;
  /** An ordered coding run's binding (spec 059): the graph, the approval and the checkpoints it resumes from. Kept on the operation record; every checkpoint and the result are read against it. */
  workflowDependencies?: WorkflowDependencyInvocation;
  /** A line for the operation's timeline, written with it as its first event (the worker's own events follow it). */
  firstEvent?: string;
  /** A REVIEW operation's second-review plan (or the fixed reason none could run), recorded on the operation. */
  secondReviewPlan?: SecondReviewOperationPlan;
  /** Design review: the binding the broker stored for the round, kept on the operation (the packets and keys are served only for its slots), and the source that serves its model. */
  designReview?: DesignReviewBinding;
  modelSourceId?: string;
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

/** An operation's events are kept this long (the same as the callback's own events). */
const FIRST_EVENT_KEEP_SECONDS = 14 * 86_400;

export function buildOperation(deps: TaskFlowDeps, input: AcceptInput): { operation: OperationRecord; items: TransactItem[] } {
  const now = input.now ?? iso(deps);
  const id = input.operationId ?? newId(deps);
  const operation: OperationRecord = {
    ...operationKey(input.workspace.id, id),
    entityType: "OPERATION",
    companyId: deps.companyId,
    eventSequence: input.firstEvent === undefined ? 0 : 1,
    id,
    workspaceId: input.workspace.id,
    orgId: deps.companyId,
    kind: input.kind,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
    ...(input.programStepId === undefined ? {} : { programStepId: input.programStepId }),
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
    ...(input.workflowDependencies === undefined ? {} : { workflowDependencies: input.workflowDependencies }),
    ...(input.secondReviewPlan === undefined ? {} : { secondReviewPlan: input.secondReviewPlan }),
    ...(input.designReview === undefined ? {} : { designReview: input.designReview }),
    ...(input.modelSourceId === undefined ? {} : { modelSourceId: input.modelSourceId }),
  };
  const message: DispatchMessage = { v: 1, workspaceId: input.workspace.id, operationId: id };
  const first: TransactItem[] = input.firstEvent === undefined ? [] : [{
    kind: "put",
    item: {
      pk: `WORKSPACE#${input.workspace.id}`, sk: `EVENT#${id}#${String(1).padStart(10, "0")}`, entityType: "OPERATION_EVENT", operationId: id, sequence: 1,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(now) / 1000) + FIRST_EVENT_KEEP_SECONDS, type: "progress", timestamp: now, payload: { message: input.firstEvent },
    },
    condition: when.absent(),
  }];
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
      ...first,
    ],
  };
}

/** A prompt that is too long for the worker is refused here, before anything is written. */
export function assertPromptFits(prompt: string): void {
  if (prompt.length === 0) throw agentXError("CONFIG_INVALID", "the request is empty");
  if (Buffer.byteLength(prompt, "utf8") > 65_536) throw agentXError("CONFIG_INVALID", "the request is too long for the worker");
}
