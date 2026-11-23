import { startPrFeedbackReview, recordPrFeedbackReview } from "../pr-feedback/review.js";
import { readTask } from "../task-flow/reads.js";
// Lane L10: the build step. The steps after the plan is approved, on the document store, the queue and the code-host port: coding, the checks, the reviews, Rovara's own fixing of a block, the
// publication of the checked code, and the round-trips of a pull request's fix. See docs/ports.md.
import { agentXError } from "@agentx/contracts";
import type { BuildSteps } from "../task-flow/deps.js";
import { runAutofix } from "./autofix.js";
import { recordMaintained, startBranchSync } from "./maintain.js";
import { recordPublished, startPublication } from "./publish.js";
import { recordBuilt, recordReviewed } from "./results.js";
import { startImplementation, startReview } from "./start.js";
import { recordCritiqued, startCriticRevision, startPlanCritique } from "../plan/check.js";
import { isNonCandidateRound, settleNonCandidateRound } from "../e2e/verification.js";

export * from "./autofix.js";
export * from "./check-results.js";
export * from "./head-check.js";
export * from "./maintain.js";
export * from "./plan-input.js";
export * from "./publish.js";
export * from "./records.js";
export * from "./prompts.js";
export * from "./results.js";
export * from "./start.js";

/** The build step as the task flow's `BuildSteps`. */
export function createBuildSteps(): BuildSteps {
  return {
    async runRow(deps, row) {
      switch (row.kind) {
        case "CHECKS": {
          if (deps.applicationE2E === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "application admission is unavailable");
          return deps.applicationE2E.rounds.runRow(row);
        }
        case "IMPLEMENT": return startImplementation(deps, row);
        case "REVIEW": {
          const task = await readTask(deps, row.taskId);
          return task?.workflow?.stage === "WAIT_FOR_MERGE" ? startPrFeedbackReview(deps, row) : startReview(deps, row);
        }
        case "PUBLISH": return startPublication(deps, row);
        case "SYNC": return startBranchSync(deps, row);
        case "AUTOFIX": return runAutofix(deps, row);
        // The plan check and the one revision it may ask for sit between the plan and the coding: Cloud's CRITIQUE and CRITIC_REPLAN rows.
        case "CRITIQUE": return startPlanCritique(deps, row);
        case "CRITIC_REPLAN": return startCriticRevision(deps, row);
        default: throw agentXError("CONFIG_INVALID", "this install does not run that step");
      }
    },
    async onEnded(deps, task, operation, ended) {
      // A baseline, replay or grounding round only settles its own record: it never moves the workflow.
      if (deps.e2e !== undefined && operation.kind === "task" && isNonCandidateRound(operation.workflowE2EAdmission) && await settleNonCandidateRound(deps.e2e, operation, ended.status)) return;
      if (operation.kind === "publish") return recordPublished(deps, task, operation, ended);
      if (operation.kind === "maintain") return recordMaintained(deps, task, operation, ended);
      if (operation.workflowMode === "PLAN_CRITIQUE") return recordCritiqued(deps, task, operation, ended);
      if (operation.workflowMode === "FEEDBACK_REVIEW") return recordPrFeedbackReview(deps, task, operation, ended);
      if (operation.workflowMode === "REVIEW") return recordReviewed(deps, task, operation, ended);
      if (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS") return recordBuilt(deps, task, operation, ended);
    },
  };
}
