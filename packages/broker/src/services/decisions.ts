// The decision service: the one approval gate over the workflow document of a task (the plan, the requirements or the design waiting for a person), and the actions the surfaces call (`decidePlan`, `decideDesign`, a
// pull request comment's `decide`). A host composes it over its own approvers and audit sink; the core's gate decides who may approve and the service never does.
//
//   - the tier of the document waiting now is read from the document itself (the files it names, the claims nothing proves), so a plan nobody could grade is never graded low;
//   - the work breakdown of a plan is bound by every surface that approves (the graph in the stored document the approval's digest names);
//   - an approved plan starts coding with no one asking (a dispatch row, like every automatic step), an approved design leaves its approval record for the pull request's Proof section.
//
// Who decides as the task's owner is the host's rule: `workflowSubject` carries it (`ownerProvider`, `collaboratorsMayDecide`, `actorFor`); the defaults are one owner who decides everything. A host adds its own
// kinds of decision (a test environment, a setup run) with `subjects`.
import { SubjectRefusal } from "../core/decisions/approval-gate.js";
import { SPEND_UNKNOWN } from "../core/task-flow/owner-round.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { WorkflowArtifactSchema, type Approvers, type AuditSink, type DocumentStore, type IdentityProvider, type ObjectStorage, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { createDecisionGate, type DecisionGate, type DecisionGatePolicy, type DecisionSubject } from "../core/decisions/approval-gate.js";
import { createDecisionActions } from "../core/decisions/local-actions.js";
import { WORKFLOW_DOCUMENT_KIND, createWorkflowDocumentSubject, currentDocumentType, type WorkflowSubjectOptions } from "../core/decisions/workflow-subject.js";
import { checkDesignApproval, designApprovalRecordItems, gradeApprovalRisk } from "../core/design-review/decision.js";
import { loadPlanDocument, planFactsOf } from "../core/plan/document.js";
import { pressedRowItem } from "../core/task-flow/dispatch-rows.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { planFeedbackKey } from "../core/task-flow/stage-machine.js";
import { breakdownForApproval } from "../core/work-breakdown/plan-graph.js";
import { confirmPlanFeature } from "../core/report/confirm-plan-feature.js";
import { loadWorkflowDocument } from "../developer/plan-document-reader.js";
import { TRANSACTION_ITEMS_MAX, flowWorkEventItems } from "../core/work-events/flow-events.js";

export interface DecisionServiceOptions {
  flow: TaskFlowDeps;
  /** Where the checked documents are kept. */
  blobs: ObjectStorage;
  store: DocumentStore;
  approvers: Approvers;
  audit: AuditSink;
  companyId: string;
  /** Other kinds of decision this host has (a test environment, a setup run, a design choice). */
  subjects?: readonly DecisionSubject[];
  /** Who decides as the task's owner. Default: one owner who decides everything, and a verified collaborator as a project approver. */
  workflowSubject?: Pick<WorkflowSubjectOptions, "ownerProvider" | "collaboratorsMayDecide" | "actorFor" | "ownerActing">;
  /** Optional host policy for the approval gate; omitted keeps the gate defaults. */
  policy?: DecisionGatePolicy;
  identity?: Pick<IdentityProvider, "capabilities">;
  now?: () => Date;
}

export interface DecisionService {
  readonly gate: DecisionGate;
  readonly actions: ReturnType<typeof createDecisionActions>;
}

export function createDecisionService(options: DecisionServiceOptions): DecisionService {
  const { flow, blobs, store } = options;
  // The decision's own steps (coding starts, the design's approval record), as they were before work events.
  const decided = ({ taskId, before, after, attempt, at, approver, risk }: Pick<Parameters<NonNullable<WorkflowSubjectOptions["onDecided"]>>[0], "taskId" | "before" | "after" | "attempt" | "at" | "approver" | "risk">): readonly TransactItem[] => {
    // The plan was approved: coding starts with no one asking, as a row like every automatic step.
    if (after.stage === "IMPLEMENT" && after.state === "READY" && before.stage !== "IMPLEMENT") return [pressedRowItem(flow, taskId, after.revision, "IMPLEMENT", at, approver.personId)];
    if (after.stage !== "PLAN" || after.state !== "READY" || before.stage === "PLAN") return [];
    // An approved design leaves its approval record under its digest (who, at what tier, the blockers and the reason) for the pull request's Proof section.
    const approval = designApprovalRecordItems({ taskId, before, after, attempt, approverId: approver.personId, approverLabel: approver.displayName ?? approver.personId, risk, at });
    if (approval.length > 0) return [...approval, pressedRowItem(flow, taskId, after.revision, "PLAN", at, approver.personId)];
    const text = (attempt.reason ?? "").trim();
    return [
      ...(text === "" ? [] : [{ kind: "put" as const, item: { ...planFeedbackKey(taskId, after.revision), entityType: "PLAN_FEEDBACK", text, createdAt: at } }]),
      pressedRowItem(flow, taskId, after.revision, "PLAN", at, approver.personId),
    ];
  };
  // Slice A4: a decision is a workflow change like any other, so its work events (the wait that ended, the send-back it is) join its transaction, when the flow writes them.
  const withWorkEvents = (task: Record<string, unknown>, before: WorkflowSnapshot, after: WorkflowSnapshot, own: readonly TransactItem[]): readonly TransactItem[] => {
    const project = typeof task["project"] === "string" ? task["project"] : undefined;
    if (project === undefined) return own;
    return [...own, ...flowWorkEventItems({ enabled: flow.workEvents, orgId: flow.companyId, project, before, after, room: TRANSACTION_ITEMS_MAX / 2 - own.length })];
  };
  const workflowSubject = createWorkflowDocumentSubject({
    store,
    ...(flow.applicationE2E === undefined ? {} : { applicationPlanning: flow.applicationE2E.planning }),
    ...(options.workflowSubject ?? {}),
    // The tier of the plan waiting now, read from the plan itself (the files it names, the claims nothing proves): a plan nobody could grade is never graded low, but a plan that names its files
    // and its proof is not high just for being a plan.
    riskOf: async (task, workflow) => {
      const artifact = workflow.artifacts.filter((entry) => entry.type === currentDocumentType(workflow)).at(-1);
      const parsed = artifact === undefined ? undefined : WorkflowArtifactSchema.safeParse(artifact);
      const loaded = parsed?.success === true ? await loadWorkflowDocument(textReaderOf(blobs), parsed.data, {}).catch(() => undefined) : undefined;
      // A design that went through design review is graded from the review's own facts (the areas it touches, the open blockers, how much of the review ran), never lower than the review says.
      const estimate = (task["runEstimate"] as { highUsd?: unknown } | undefined)?.highUsd;
      return gradeApprovalRisk({ loaded, workflow, requestText: typeof task["requestText"] === "string" ? task["requestText"] : undefined, ...(typeof estimate === "number" ? { costHighUsd: estimate } : {}) });
    },
    // The decided plan's own decisions, read from the checked document (the same load the work breakdown uses), so the owner's answers are held to the options it offered.
    planFactsOf: async (_task, _workflow, artifact) => {
      const loaded = await loadPlanDocument(blobs, artifact);
      return loaded.kind === "structured" ? planFactsOf(loaded.plan) : "unreadable";
    },
    // A plan with a work breakdown (spec 059) is approved WITH its graph: every surface that approves binds the graph in the stored document the approval's digest names.
    breakdown: ({ task, workflow, artifactDigest }) => breakdownForApproval(flow, { taskId: String(task["taskId"]), project: String(task["project"]), startingRevision: Number(task["startingRevision"]) }, workflow, artifactDigest),
    // A design with an open blocker is approved only with a one-line reason.
    checkDecision: async ({ task, workflow, attempt }) => {
      checkDesignApproval(workflow, attempt);
      if (attempt.outcome === "approve" && currentDocumentType(workflow) === "plan") await checkPlanRunLimit(flow, task as unknown as TaskRecord);
    },
    onDecided: ({ taskId, task, before, after, attempt, at, approver, risk }) => withWorkEvents(task, before, after, decided({ taskId, before, after, attempt, at, approver, risk })),
  });
  const innerGate = createDecisionGate({
    store, approvers: options.approvers, audit: options.audit, subjects: [...(options.subjects ?? []), workflowSubject],
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // A decision on a task's document wrote its entry in the task log in its own transaction; the surfaces that draw the log are told once it is committed (a repeat of a decision writes nothing, so tells nothing).
  // C-A5: an approved plan confirms the task's suggested feature.
  const gate: DecisionGate = {
    ...innerGate,
    async decide(attempt) {
      const result = await innerGate.decide(attempt);
      if (flow.taskLog !== undefined && result.status === "decided" && attempt.kind === WORKFLOW_DOCUMENT_KIND) await flow.taskLog.changed(attempt.subjectId);
      if (result.status === "decided" && result.record.kind === "workflow-document" && result.record.approvalKind === "plan" && result.record.outcome === "approve") {
        await confirmPlanFeature({ store, audit: options.audit, companyId: options.companyId, now: () => (options.now?.() ?? new Date()).getTime(), ...(flow.log === undefined ? {} : { log: flow.log }) }, result.record.subjectId, result.approver.personId);
      }
      return result;
    },
  };
  return { gate, actions: createDecisionActions({ gate, companyId: options.companyId }) };
}


/** Approving a coding plan starts paid work. Every surface uses the same live cap and spend, never a limit supplied in the approval body. */
export async function checkPlanRunLimit(flow: TaskFlowDeps, task: TaskRecord): Promise<void> {
  if (flow.taskCapUsd === undefined) return;
  let cap: number | undefined;
  let spent: number | undefined;
  try { cap = await flow.taskCapUsd(task); } catch { throw new SubjectRefusal("invalid_outcome", SPEND_UNKNOWN); }
  // The spend that cannot be read has a stable code of its own: the card then says the real reason (the one words table), where `invalid_outcome` reads "isn't ready to be decided yet" for every other refusal.
  try { spent = await flow.taskSpendUsd?.(task.taskId); } catch { throw new SubjectRefusal("spend_unreadable", SPEND_UNKNOWN); }
  if (cap === undefined || !Number.isFinite(cap) || cap < 0) throw new SubjectRefusal("invalid_outcome", SPEND_UNKNOWN);
  if (spent === undefined || !Number.isFinite(spent) || spent < 0) throw new SubjectRefusal("spend_unreadable", SPEND_UNKNOWN);
  if (spent >= cap) throw new SubjectRefusal("invalid_outcome", "This task has used its run limit, so Rovara will not start more work on it. Start a new task.");
}
