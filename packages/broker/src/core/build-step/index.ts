// Lane L10: the build step. The steps after the plan is approved, on the document store, the queue and the code-host port: coding, the checks, the reviews, Rovara's own fixing of a block, the
// publication of the checked code, and the round-trips of a pull request's fix. See docs/ports.md.
import { agentXError } from "@agentx/contracts";
import type { BuildSteps } from "../task-flow/deps.js";
import { runAutofix } from "./autofix.js";
import { recordMaintained, startBranchSync } from "./maintain.js";
import { recordPublished, startPublication } from "./publish.js";
import { recordBuilt, recordReviewed } from "./results.js";
import { startImplementation, startReview } from "./start.js";

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
        case "IMPLEMENT": return startImplementation(deps, row);
        case "REVIEW": return startReview(deps, row);
        case "PUBLISH": return startPublication(deps, row);
        case "SYNC": return startBranchSync(deps, row);
        case "AUTOFIX": return runAutofix(deps, row);
        default: throw agentXError("CONFIG_INVALID", "this install does not run that step");
      }
    },
    async onEnded(deps, task, operation, ended) {
      if (operation.kind === "publish") return recordPublished(deps, task, operation, ended);
      if (operation.kind === "maintain") return recordMaintained(deps, task, operation, ended);
      if (operation.workflowMode === "REVIEW") return recordReviewed(deps, task, operation, ended);
      if (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS") return recordBuilt(deps, task, operation, ended);
    },
  };
}
