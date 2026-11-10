// Rovara Code's own sequence of steps: the plan, the plan check (a second step reads the plan before a person sees it), coding, the checks, the reviews and the pull request. It is the sequence of
// Cloud's built-in Rovara Code agent, version 2 (`builtinRecipe("rovara-code", 2)`), as the workflow engine follows it, with one difference: the review step names no `onFindings`. Cloud's sends the
// work back to coding by the engine's own rounds; Code's fixing of review findings is the build step's own rule (a code fault is sent back by itself at most twice, anything unclear is asked about),
// so a review that finds problems blocks the step and Rovara's own fixing looks at it, exactly as before the plan check existed. A Code task has no company agents, so the sequence is fixed here.
import { WorkflowProgramSchema, type WorkflowProgram } from "@agentx/contracts";

export const ROVARA_CODE_PROGRAM: WorkflowProgram = WorkflowProgramSchema.parse({
  steps: [
    { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
    { id: "review", kind: "review", reviewers: ["code", "security"] }, { id: "pull_request", kind: "pull_request" },
  ],
});
