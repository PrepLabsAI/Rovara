// F2-A: the shape of a task's standing for one reader (phase, step, strip, pill, who it waits on, the moves offered) and the TOLERANT reader of it. Code computes it (`broker/src/core/task-view`); it is served only on the task read, for
// the person reading, and is NEVER part of a stored document (a guard test fails if it is reachable from the session summary, the session view or the status). The reader is not strict: unknown keys pass through, every key that
// a newer Code may add a value to (`pill.key`, `phase.key`, `step.key`, `step.state`, `tone`) is a plain string, and `actions` is read with a LOOSE offer reader that SKIPS any offer whose id the reader does not know, so a new action id
// or risk value never fails the whole task answer (Code runs ahead of Cloud's pinned version and of installed MCP and CLI). Words travel with the keys: an unknown key still draws with its words and tone.
import type { ActionOffer } from "./task-actions.js";
import type { PhaseKey, PillView, RoleKey, StepStateKey } from "./task-words.js";

/** What Code serves: the standing of a task for the person reading it. */
export interface TaskStandingMembers {
  /** Omitted for a merged or closed task. */
  phase?: { key: PhaseKey; words: string } | undefined;
  step?: { key: string; title: string; phase: PhaseKey; state: StepStateKey } | undefined;
  /** The strip, in order, for this task's pipeline. */
  steps?: Array<{ key: string; title: string; phase: PhaseKey; state: StepStateKey }> | undefined;
  pill: PillView;
  /** Set when the pill is not "Needs you" for this reader but someone else is needed: who. */
  waitingOn?: { role: RoleKey; words: string } | undefined;
  /** S1's offers for this person, unchanged: ONE actions field. */
  actions: ActionOffer[];
}

// The tolerant reader itself is the Code API package's (`@preplabsai/rovara-code-api`, `TaskStandingSchema`): the package is what a client builds against, and Code reads with the same one. The old names stay for the callers here.
export { LooseActionOfferSchema, TaskStandingSchema as TaskStandingReaderSchema, readLooseOffers, type LooseActionOffer, type TaskStanding as TaskStandingReading } from "@preplabsai/rovara-code-api";
