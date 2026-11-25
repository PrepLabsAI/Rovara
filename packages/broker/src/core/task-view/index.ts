// F2-A: the standing of a task (A2). `stateOf` is the person-free rule, `taskStandingFor` adds the reader; the words are `@agentx/contracts` `task-words.ts`.
export { statusOfTask, BUDGET_PAUSE_NEXT, BUDGET_PAUSE_REASON, type StatusFacts, type StatusInput } from "./status.js";
export { blockedOnSpend, stateOf, type StandingFacts, type StandingWorkflow, type StripStep, type SystemWait, type TaskState } from "./state.js";
export { failedChecksOf, needsPersonOf, standingFactsOf, type ExtraFacts } from "./facts.js";
export { taskStandingFor, type TaskStanding } from "./standing.js";
