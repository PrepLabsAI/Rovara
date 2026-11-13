// Design review stage: the choices at the cost hold (run it anyway when no price is known, raise the limit, run a lighter tier, skip the review) as a SUBJECT of the approval gate. A choice about what the review may spend,
// or about leaving it out, is an approval like any other: it goes through `createDecisionGate` and the `approvers` port, so the gate's proof checks, single-use proofs, request-id rule, sign-in rule and risk tier all hold, on every surface.
// What is decided here: which choices the hold offers (`designChoicesOf`, from the stored review alone), the risk the request is graded at, and what each choice does to the workflow (the contract's own moves).
// Nothing a caller sends sets an amount or a tier: the choice names itself and the amount comes from the task's record.
import { createHash } from "node:crypto";
import {
  DESIGN_REVIEW_CAP_MAX_USD, IMPLICIT_COMPANY_ID, WorkflowSnapshotSchema, WorkflowTransitionError, canonicalJson, change, lowerDesignReviewTier, raiseDesignReviewCap, skipDesignReview, when,
  type DesignReviewTier, type DocumentStore, type PolicySubject, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { SubjectRefusal, type AppliedDecision, type DecisionAttempt, type DecisionSubject, type LoadedSubject } from "../decisions/approval-gate.js";
import { decisionRecordDocument } from "../decisions/store.js";
import { riskTierOf } from "../decisions/risk-tier.js";
import { workflowTaskKey } from "../decisions/workflow-subject.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workflowWriteOps } from "../task-flow/flow-guard.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import { nextLowerTier } from "./estimate.js";
import { isHighRiskCodes } from "./risk.js";
import { readEffectiveDesignReview } from "./setting.js";
import type { ProjectPlaybookReader } from "./playbook-store.js";
import { designRowItem } from "./steps.js";
import { designWaitArmItems } from "./wait.js";

export const DESIGN_CHOICE_KIND = "design-review-choice";
export type DesignChoiceName = "run_unpriced" | "raise_cap" | "lower_tier" | "skip";

/** What one choice would do, worked out from the stored review. `newCapUsd` and `tier` are the CODE's numbers, never a caller's. */
export type DesignChoice = { choice: "run_unpriced" } | { choice: "raise_cap"; newCapUsd: number } | { choice: "lower_tier"; tier: DesignReviewTier } | { choice: "skip" };

const roundUpCents = (value: number): number => Math.ceil(Math.round(value * 1_000_000) / 10_000) / 100;

/** The choices the cost hold offers. No price: run it anyway, or skip. Over the limit: raise it (to what is already spent plus the estimate, when that is within the largest limit), run the next lower tier, or skip. Skip only where the setting allows it. */
export function designChoicesOf(workflow: WorkflowSnapshot, options: { allowSkip: boolean }): DesignChoice[] {
  const review = workflow.designReview;
  if (review === undefined || workflow.stage !== "PLAN_CRITIQUE" || workflow.state !== "WAITING" || review.status !== "waiting_cost") return [];
  const choices: DesignChoice[] = [];
  if (review.estimateUsd === undefined) choices.push({ choice: "run_unpriced" });
  else {
    const lower = nextLowerTier(review.tier);
    if (lower !== undefined) choices.push({ choice: "lower_tier", tier: lower });
    const raised = roundUpCents(review.spentUsd + review.estimateUsd);
    if (review.capUsd !== undefined && raised > review.capUsd && raised <= DESIGN_REVIEW_CAP_MAX_USD) choices.push({ choice: "raise_cap", newCapUsd: raised });
  }
  if (options.allowSkip) choices.push({ choice: "skip" });
  return choices;
}

/** What the owner is shown beside each choice, in fixed words. */
export function designChoiceLabel(choice: DesignChoice): string {
  switch (choice.choice) {
    case "run_unpriced": return "Run it anyway";
    case "raise_cap": return `Raise the limit to $${choice.newCapUsd.toFixed(2)}`;
    case "lower_tier": return `Run ${choice.tier[0]!.toUpperCase()}${choice.tier.slice(1)} instead`;
    case "skip": return "Skip design review";
  }
}

/** The digest a choice is made on: the hold as it stands (its revision, estimate, limit, spend and tier), so a changed hold is a different request. */
export function designChoiceDigest(workflow: WorkflowSnapshot): string | undefined {
  const review = workflow.designReview;
  if (review === undefined) return undefined;
  return createHash("sha256").update(canonicalJson({ revision: workflow.revision, status: review.status, estimateUsd: review.estimateUsd ?? null, capUsd: review.capUsd ?? null, spentUsd: review.spentUsd, tier: review.tier })).digest("hex");
}

export interface DesignChoiceSubjectOptions {
  flow: Pick<TaskFlowDeps, "store" | "companyId" | "now">;
  reader: ProjectPlaybookReader;
}

export function createDesignChoiceSubject(options: DesignChoiceSubjectOptions): DecisionSubject {
  const store: Pick<DocumentStore, "get"> = options.flow.store;
  return {
    kind: DESIGN_CHOICE_KIND,

    async load(companyId, taskId): Promise<LoadedSubject | undefined> {
      if (!/^[0-9a-f-]{36}$/u.test(taskId)) return undefined;
      const task = await store.get(workflowTaskKey(taskId));
      if (task === undefined) return undefined;
      const taskCompany = task["companyId"] ?? task["orgId"];
      if (taskCompany !== companyId && !(taskCompany === undefined && companyId === IMPLICIT_COMPANY_ID)) return undefined;
      const parsed = WorkflowSnapshotSchema.safeParse(task["workflow"]);
      const project = task["project"];
      if (!parsed.success || typeof project !== "string") return undefined;
      const workflow = parsed.data;
      const review = workflow.designReview;
      const digest = designChoiceDigest(workflow);
      if (review === undefined || digest === undefined) return undefined;
      const setting = await readEffectiveDesignReview(options.reader, options.flow.companyId, project).catch(() => undefined);
      // The tier of the request: a review about a high-risk area (Understand's reasons) is high whatever it costs, because skipping or paying for it is then a high-risk call; otherwise by what it may cost, the room under the limit when no price is known.
      const amount = review.estimateUsd ?? Math.max(0, roundUpCents((review.capUsd ?? 0) - review.spentUsd));
      const risk = isHighRiskCodes(review.reasons) ? "high" : riskTierOf("approve_spend", { spend: { amountUsd: amount } }).risk;
      const subject: PolicySubject = { type: "task", id: taskId };
      return {
        key: workflowTaskKey(taskId),
        guard: when.and(when.eq(["workflow", "revision"], workflow.revision), when.notExists("closedAt")),
        waiting: workflow.stage === "PLAN_CRITIQUE" && workflow.state === "WAITING" && review.status === "waiting_cost" && task["closedAt"] === undefined,
        request: { kind: "design_spend", subject, projectName: project, revision: workflow.revision, artifactDigest: digest, risk },
        state: { task, workflow, allowSkip: setting?.setting.allowSkip === true },
      };
    },

    apply(loaded, attempt: DecisionAttempt, approvers, at): AppliedDecision {
      const { workflow, allowSkip } = loaded.state as { workflow: WorkflowSnapshot; allowSkip: boolean };
      if (attempt.outcome !== "approve") throw new SubjectRefusal("invalid_outcome", "A cost choice is made or left; there is nothing to reject.");
      const wanted = (attempt.details as { choice?: unknown } | undefined)?.choice;
      const offered = designChoicesOf(workflow, { allowSkip }).find((entry) => entry.choice === wanted);
      if (offered === undefined) throw new SubjectRefusal("invalid_outcome", "That choice is not offered now.");
      const taskId = loaded.request.subject.id;
      const by = { actorId: workflow.ownerId };
      const deps = { companyId: options.flow.companyId };
      const expectedRevision = workflow.revision;
      const estimate = workflow.designReview?.estimateUsd === undefined ? {} : { estimateUsd: workflow.designReview.estimateUsd };
      // The review's own record names the task's owner (an actor id the contract accepts); who the approvers port let through is in the gate's own record of the decision.
      const approver = workflow.ownerId;
      // The choice is also recorded in the decision history under the card it answers, in the layout both installs share: the choice word is the record's reason, and the developer is the person the approvers port let through.
      const decisionRow: TransactItem = {
        kind: "put", condition: when.absent(),
        item: decisionRecordDocument({
          orgId: options.flow.companyId, developerId: approvers[0]?.personId ?? workflow.ownerId, cardId: `approve_spend:${taskId}`, kind: "approve_spend", risk: loaded.request.risk ?? "high", outcome: "approved",
          reason: offered.choice, requestId: attempt.requestId, createdAt: at, decidedAt: at,
        }, Date.parse(at)),
      };
      try {
        if (offered.choice === "run_unpriced") {
          // The hold stays as it is, so the card does not change under the person; the round starts from it, with who approved on the row (the round's start moves WAITING to RUNNING with `costApproved`).
          const extra: TransactItem[] = [designRowItem(deps, taskId, expectedRevision, "CRITIQUE", at, approver), decisionRow];
          return { ops: [change.set("updatedAt", at)], extra, result: { choice: offered.choice } };
        }
        const next = offered.choice === "raise_cap" ? raiseDesignReviewCap(workflow, { expectedRevision, capUsd: offered.newCapUsd, by, ...estimate, now: at })
          : offered.choice === "lower_tier" ? lowerDesignReviewTier(workflow, { expectedRevision, tier: offered.tier, by, now: at })
            : skipDesignReview(workflow, { expectedRevision, by, now: at });
        const row = next.stage === "PLAN_CRITIQUE" && next.state === "READY" ? designRowItem(deps, taskId, next.revision, "CRITIQUE", at)
          : offered.choice === "skip" && next.stage === "PLAN" && next.state === "READY" ? dispatchRowItem(deps, taskId, next.revision, "PLAN", at) : undefined;
        return { ops: [...workflowWriteOps(workflow, next).ops, change.set("updatedAt", at)], extra: [decisionRow, ...(row === undefined ? [] : [row]), ...designWaitArmItems(deps, taskId, next, Date.parse(at))], result: { choice: offered.choice, workflow: next } };
      } catch (error) {
        if (error instanceof WorkflowTransitionError) throw new SubjectRefusal("invalid_outcome", error.message);
        throw error;
      }
    },
  };
}
