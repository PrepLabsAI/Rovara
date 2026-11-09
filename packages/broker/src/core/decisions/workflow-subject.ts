// The subject of a plan decision: the document a task's workflow waits on (the requirements, the design or the coding plan). It reads the task's record and applies the person's decision with the workflow
// engine's own transition (`decideWorkflow`, in the contracts), so the engine's rules (a stale revision, a wrong digest, a repeat, who may decide) are the ones that already hold in the hosted product.
//
// ASSUMPTIONS about the task flow lane (L6a), the only coupling to it, listed so the lanes can be checked against each other:
//   1. the task is one document at `{ pk: "DEVTASK#<taskId>", sk: "META" }` (the hosted product's key), carrying `orgId` (when present it must equal the company asked for), `project`, `workflow`
//      (a `WorkflowSnapshot`) and optionally `closedAt`;
//   2. a task waiting for a plan decision has `workflow.stage === "PLAN_REVIEW"` and `workflow.state === "WAITING"`;
//   3. the decision's effect is the engine's: this subject writes the snapshot `decideWorkflow` returns. Starting the next run (coding, planning again) is the stage machine's job on seeing the new
//      state; `onDecided` lets it add its own steps (an outbox message, comment locks, a run-limit record) to the same transaction.
import { createHash } from "node:crypto";
import {
  WorkflowDecisionRequestSchema, WorkflowSnapshotSchema, WorkflowTransitionError, change, decideWorkflow, when,
  type DecisionRisk, type DocumentKey, type DocumentStore, type PolicySubject, type Principal, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { SubjectRefusal, type AppliedDecision, type DecisionAttempt, type DecisionSubject, type LoadedSubject } from "./approval-gate.js";

export const WORKFLOW_DOCUMENT_KIND = "workflow-document";

/** The task document's key, as the hosted product keeps it. */
export const workflowTaskKey = (taskId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: "META" });

/** What a plan decision may carry beyond the outcome. The engine validates each part against the document. */
export interface WorkflowDecisionDetails {
  answers?: ReadonlyArray<{ decisionId: string; optionId: string; opened: boolean }>;
  includedCommentIds?: readonly string[];
  selectedOptionalCheckIds?: readonly string[];
  workBreakdownDigest?: string;
  closeAsAnswered?: true;
  /** `PAGE` when the surface is a review page that sent the owner's answer to every decision; it is recorded with the decision. */
  via?: "PAGE";
  acknowledgedRunLimitUsd?: number;
  /** The decided plan's own decisions, read from the checked document; needed when `answers` is given. */
  planDecisions?: ReadonlyArray<{ id: string; optionIds: readonly string[]; recommended: string }>;
  /** The current plan's `noChangeNeeded`, read from the checked document; needed to close a plan as answered. */
  noChangeNeeded?: unknown;
}

export interface WorkflowSubjectOptions {
  store: Pick<DocumentStore, "get">;
  /**
   * The risk tier of the document waiting now. It decides which proofs may approve it (high: the local session only). It is a function of the plan's own facts (`planRiskOf`), which the caller reads from
   * the checked document. NOT supplying it means "high": a request nobody could grade is never graded low.
   */
  riskOf?: (task: Record<string, unknown>, workflow: WorkflowSnapshot) => DecisionRisk | Promise<DecisionRisk>;
  /** Who asked for the decision, when it is not the owner themselves (a request another person made). Absent: the owner. */
  requestedBy?: (task: Record<string, unknown>, workflow: WorkflowSnapshot) => Principal | undefined;
  /** When the waiting request stops being answerable (ISO). Absent: it does not expire. */
  expiresAt?: (task: Record<string, unknown>, workflow: WorkflowSnapshot) => string | undefined;
  /** More steps for the decision's transaction, from the stage machine. They must not name the task's own key. */
  onDecided?: (context: { taskId: string; task: Record<string, unknown>; before: WorkflowSnapshot; after: WorkflowSnapshot; attempt: DecisionAttempt; approver: Principal; at: string }) => readonly TransactItem[] | Promise<readonly TransactItem[]>;
  /** The id the engine knows a person by. Default: the local owner decides as the task's owner (a one-developer install owns every task). */
  actorFor?: (approver: Principal, workflow: WorkflowSnapshot) => { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" } | undefined;
}

/** The document type waiting for a decision, by the engine's own rule. */
export function currentDocumentType(workflow: WorkflowSnapshot): "plan" | "requirements" | "design" {
  if (workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN") return "plan";
  return workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : "design";
}

/** The digest of the document the person is deciding, or undefined when the workflow has none yet. */
export function waitingDocumentDigest(workflow: WorkflowSnapshot): string | undefined {
  const type = currentDocumentType(workflow);
  return workflow.artifacts.filter((artifact) => artifact.type === type).at(-1)?.sha256;
}

const jsonOf = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

/** The default mapping: the local owner is the owner of every task on this install. Anyone else is not who the engine knows. */
function defaultActorFor(approver: Principal, workflow: WorkflowSnapshot): { actorId: string; role: "TASK_OWNER" } | undefined {
  return approver.provider === "local-owner" && approver.roles.includes("owner") ? { actorId: workflow.ownerId, role: "TASK_OWNER" } : undefined;
}

/** A stable 64-hex id for a person who is not the owner, for an engine that knows only hex ids. Not used by the default mapping. */
export function hexActorId(approver: Pick<Principal, "provider" | "personId">): string {
  return createHash("sha256").update(`${approver.provider}\u0000${approver.personId}`).digest("hex");
}

export function createWorkflowDocumentSubject(options: WorkflowSubjectOptions): DecisionSubject {
  const actorFor = options.actorFor ?? defaultActorFor;
  return {
    kind: WORKFLOW_DOCUMENT_KIND,

    async load(companyId, taskId): Promise<LoadedSubject | undefined> {
      if (!/^[0-9a-f-]{36}$/u.test(taskId)) return undefined;
      const task = await options.store.get(workflowTaskKey(taskId));
      if (task === undefined) return undefined;
      // A task of another company reads as absent, the same as a missing one.
      if (task["orgId"] !== undefined && task["orgId"] !== companyId) return undefined;
      const parsed = WorkflowSnapshotSchema.safeParse(task["workflow"]);
      if (!parsed.success) return undefined;
      const workflow = parsed.data;
      const digest = waitingDocumentDigest(workflow);
      if (digest === undefined) return undefined;
      const waiting = workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && task["closedAt"] === undefined;
      const subject: PolicySubject = { type: "task", id: taskId };
      const risk = options.riskOf === undefined ? "high" : await options.riskOf(task, workflow);
      const requestedBy = options.requestedBy?.(task, workflow);
      const expiresAt = options.expiresAt?.(task, workflow);
      return {
        key: workflowTaskKey(taskId),
        // The revision and the wait, as the engine's own update condition holds them: a write from any other state loses.
        guard: when.and(when.eq(["workflow", "revision"], workflow.revision), when.eq(["workflow", "state"], "WAITING"), when.eq(["workflow", "stage"], "PLAN_REVIEW"), when.notExists("closedAt")),
        waiting,
        request: {
          kind: currentDocumentType(workflow), subject, ...(typeof task["project"] === "string" ? { projectName: task["project"] } : {}),
          revision: workflow.revision, artifactDigest: digest, risk,
          ...(requestedBy === undefined ? {} : { requestedBy }), ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        state: { task, workflow },
      };
    },

    async apply(loaded, attempt, approver, at): Promise<AppliedDecision> {
      const { task, workflow } = loaded.state as { task: Record<string, unknown>; workflow: WorkflowSnapshot };
      const actor = actorFor(approver, workflow);
      if (actor === undefined) throw new SubjectRefusal("not_the_approver", "That person cannot decide this task.");
      const details = (attempt.details ?? {}) as WorkflowDecisionDetails;
      const decision = attempt.outcome === "approve" ? "APPROVE" : attempt.outcome === "reject" ? "REJECT" : "REQUEST_CHANGES";
      const request = WorkflowDecisionRequestSchema.safeParse({
        requestId: attempt.requestId, expectedRevision: attempt.seen.revision, decision, artifactDigest: attempt.seen.artifactDigest,
        reason: attempt.reason ?? (decision === "APPROVE" ? "Approved." : decision === "REJECT" ? "Rejected." : "Changes requested."),
        ...(details.answers === undefined ? {} : { answers: details.answers }), ...(details.includedCommentIds === undefined ? {} : { includedCommentIds: details.includedCommentIds }),
        ...(details.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: details.selectedOptionalCheckIds }),
        ...(details.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: details.workBreakdownDigest }),
        ...(details.closeAsAnswered === undefined ? {} : { closeAsAnswered: details.closeAsAnswered }),
        ...(details.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: details.acknowledgedRunLimitUsd }),
      });
      if (!request.success) throw new SubjectRefusal("invalid", "The decision is not valid.");
      let after: WorkflowSnapshot;
      try {
        after = decideWorkflow(workflow, request.data, actor, {
          now: at, allowedSkipStages: [], ...(details.via === undefined ? {} : { via: details.via }),
          ...(details.planDecisions === undefined ? {} : { decisions: details.planDecisions }),
          ...(details.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: details.workBreakdownDigest }),
          ...(details.noChangeNeeded === undefined ? {} : { noChangeNeeded: details.noChangeNeeded as never }),
        });
      } catch (error) {
        if (error instanceof WorkflowTransitionError) throw new SubjectRefusal("invalid_outcome", error.message);
        throw error;
      }
      // The engine answers an unchanged snapshot for a repeat of a decision it already holds; nothing is left to write.
      if (after.revision === workflow.revision) throw new SubjectRefusal("invalid_outcome", "The workflow already holds this decision.");
      const taskId = loaded.request.subject.id;
      const extra = options.onDecided === undefined ? [] : await options.onDecided({ taskId, task, before: workflow, after, attempt, approver, at });
      return {
        ops: [change.set("workflow", jsonOf(after)), change.set("updatedAt", at)],
        extra,
        result: { workflow: after },
      };
    },
  };
}
