import type { UnflushedPlan } from "./money-stop.js";
import type { TaskClosePreview } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { CloseSnapshot } from "./close-inspection.js";
import type { OperationRecord } from "./records.js";
import { currentOperation } from "../../developer/task-records.js";
import { hashJson, iso } from "./support.js";
import { USAGE_FLUSH_WAIT_MS } from "./money-stop.js";

/** Additive, versioned fields on OPERATION(kind=close), never inferred for old boolean-only closes. */
export interface CloseAcceptance {
  schemaVersion: 1;
  phase: "accepted" | "flushing" | "accounted" | "destroyed" | "closed" | "complete";
  intentHash: string;
  expectedPreviewDigest: string;
  discardUnpublished: boolean;
  actorId: string;
  taskId: string;
  acceptedAt: string;
  flushDeadline: string;
  preview: TaskClosePreview;
  inspection: CloseSnapshot["inspection"];
  original: {
    workspace: CloseSnapshot["workspace"];
    run?: OperationRecord;
    admissionReservationId?: string;
  };
  effectIds: { flush: string; cancel: string; account: string; terminate: string; finish: string };
  receipts: Record<string, string>;
  accounting?: { mode: "flushed" | "none" } | { mode: "unflushed"; plan: UnflushedPlan };
}

/** The identity a system closer (the abandoned-review sweep) accepts a close under: not a person, never a developer id. */
export const SYSTEM_CLOSE_PROVIDER = "system-close";
export const systemCloseActorId = (closer: string): string => `system:${closer}`;

export const closeOperationId = (companyId: string, taskId: string, requestId: string): string => {
  const hash = hashJson({ kind: "accepted-close", companyId, taskId, requestId });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

export function acceptedCloseRecord(deps: TaskFlowDeps, snapshot: CloseSnapshot, intent: { requestId: string; expectedPreviewDigest: string; discard_unpublished?: boolean | undefined }, actorId: string, intentHash: string): OperationRecord {
  const at = iso(deps), id = closeOperationId(deps.companyId, snapshot.task.taskId, intent.requestId);
  const run = currentOperation(snapshot.operations) as OperationRecord | undefined;
  return {
    ...snapshot.location.operationKey(id), entityType: "OPERATION", companyId: deps.companyId, orgId: deps.companyId,
    id, workspaceId: snapshot.workspace.id, kind: "close", status: "ACCEPTED", requestId: intent.requestId, payloadHash: intentHash,
    fence: snapshot.workspace.fence + 1, eventSequence: 0, createdAt: at, updatedAt: at,
    // Accepted closes are broker work; dispatch.ts preserves their resume delivery for the P4 consumer.
    dispatch: { kind: "task", projectRevision: snapshot.workspace.projectRevision, payload: {} },
    closeAcceptance: {
      schemaVersion: 1, phase: "accepted", intentHash, expectedPreviewDigest: intent.expectedPreviewDigest,
      discardUnpublished: intent.discard_unpublished === true, actorId, taskId: snapshot.task.taskId, acceptedAt: at,
      flushDeadline: new Date(Date.parse(at) + (deps.moneyStop?.flushWaitMs ?? USAGE_FLUSH_WAIT_MS)).toISOString(),
      preview: snapshot.preview, inspection: snapshot.inspection,
      original: { workspace: snapshot.workspace, ...(run === undefined ? {} : { run }), ...(snapshot.task.admissionReservationId === undefined ? {} : { admissionReservationId: snapshot.task.admissionReservationId }) },
      effectIds: { flush: `${id}:flush`, cancel: closeOperationId(deps.companyId, id, "cancel"), account: `${id}:account`, terminate: `${id}:terminate`, finish: `${id}:finish` }, receipts: {},
    },
  };
}
