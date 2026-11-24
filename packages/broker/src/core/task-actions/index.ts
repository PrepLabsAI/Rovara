// S1: the task action registry (v1): the entries, what a task offers now, and the one function every surface's press goes through. Declarations a surface sees are in `@agentx/contracts` (`task-actions.ts`).
export { TASK_ACTION_ENTRIES, entryOf } from "./entries.js";
export { actionsFor, declaredExclusions, describeAction, stateOffers, type OfferCapabilities } from "./offers.js";
export { performRegistryAction, requestIdOf, type RegistryPress } from "./perform.js";
export { confirmDigestOf } from "./digest.js";
export type { ActionCaller, ActionEnv, MergeHost, PeopleHost, PlanFacts, PlanHost, TaskActionEntry } from "./types.js";
