// Lane L6a, task flow core: the admission and audit seams (owner decision 53). The flow asks `Admission` before work that spends and puts what
// it answers into the same document-store transaction as the change, and writes an audit record with the change through `AuditSink`. Code's
// defaults allow everything and write nothing; Cloud fills the seams with budgets and its ledger.
import {
  agentXError,
  type AdmissionDecision,
  type AdmissionRequest,
  type AgentXError,
  type AgentXErrorCode,
  type AuditEvent,
  type TransactItem,
} from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { iso, log } from "./support.js";

type Refused = Extract<AdmissionDecision, { allowed: false }>;

/** The refusal codes Cloud's start already speaks (`start.ts` ADMISSION_REFUSALS). Any other refusal reads as FORBIDDEN, never as success. */
const REFUSAL_CODES: Readonly<Record<string, AgentXErrorCode>> = {
  budget_exhausted: "BUDGET_EXCEEDED",
  budget_exceeded: "BUDGET_EXCEEDED",
  org_budget_exceeded: "ORG_BUDGET_EXCEEDED",
  project_budget_exceeded: "PROJECT_BUDGET_EXCEEDED",
  agent_budget_exceeded: "AGENT_BUDGET_EXCEEDED",
  machine_time_exceeded: "MACHINE_TIME_EXCEEDED",
  trial_locked: "TRIAL_LOCKED",
};

/** The error a refused admission becomes. The message is the adapter's own sentence for the person; the code is for callers. */
export function admissionRefusal(decision: Refused): AgentXError {
  return agentXError(REFUSAL_CODES[decision.code.toLowerCase()] ?? "FORBIDDEN", decision.message);
}

export interface StagedAdmission {
  items: readonly TransactItem[];
  reservationId?: string;
}

/** A refused admission is an answer, not a fault: an adapter that throws is a fault and propagates as it is. */
export interface AdmissionRefused {
  refusal: AgentXError;
}

/**
 * Asks admission for an action and returns the steps that commit with the caller's transaction, or the refusal (before anything is written).
 * A caller whose transaction then did not commit must call `releaseAdmission` with the reservation, and must not when it cannot tell.
 */
export async function stageAdmission(deps: TaskFlowDeps, request: Omit<AdmissionRequest, "companyId">): Promise<StagedAdmission | AdmissionRefused> {
  const { decision, items } = await deps.admission.stage({ ...request, companyId: deps.companyId });
  if (!decision.allowed) return { refusal: admissionRefusal(decision) };
  return { items, ...(decision.reservationId === undefined ? {} : { reservationId: decision.reservationId }) };
}

/** Decides on its own, for an action with no transaction of its own (a machine start). */
export async function admit(deps: TaskFlowDeps, request: Omit<AdmissionRequest, "companyId">): Promise<{ reservationId?: string } | AdmissionRefused> {
  const decision = await deps.admission.admit({ ...request, companyId: deps.companyId });
  if (!decision.allowed) return { refusal: admissionRefusal(decision) };
  return decision.reservationId === undefined ? {} : { reservationId: decision.reservationId };
}

/** Gives a reservation back after the transaction that would have used it failed. Never throws: the allowance expires on its own at worst. */
export async function releaseAdmission(deps: TaskFlowDeps, reservationId: string | undefined): Promise<void> {
  if (reservationId === undefined) return;
  try {
    await deps.admission.release(reservationId);
  } catch (error) {
    log(deps, { event: "task_flow.admission_release_failed", error: error instanceof Error ? error.message : "unknown" });
  }
}

/** The steps that record an event with the caller's transaction (none for a sink that writes elsewhere). */
export function stageAudit(deps: TaskFlowDeps, event: Omit<AuditEvent, "companyId" | "at">): readonly TransactItem[] {
  return deps.audit.stage({ ...event, companyId: deps.companyId, at: iso(deps) });
}

/** Records an event that has no transaction of its own (a refused start). A sink that fails does not turn a refusal into a different error. */
export async function recordAudit(deps: TaskFlowDeps, event: Omit<AuditEvent, "companyId" | "at">): Promise<void> {
  try {
    await deps.audit.record({ ...event, companyId: deps.companyId, at: iso(deps) });
  } catch (error) {
    log(deps, { event: "task_flow.audit_failed", action: event.action, error: error instanceof Error ? error.message : "unknown" });
  }
}
