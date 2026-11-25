// F2-A: the shape of a task's standing for one reader (phase, step, strip, pill, who it waits on, the moves offered) and the TOLERANT reader of it. Code computes it (`broker/src/core/task-view`); it is served only on the task read, for
// the person reading, and is NEVER part of a stored document (a guard test fails if it is reachable from the session summary, the session view or the status). The reader is not strict: unknown keys pass through, every key that
// a newer Code may add a value to (`pill.key`, `phase.key`, `step.key`, `step.state`, `tone`) is a plain string, and `actions` is read with a LOOSE offer reader that SKIPS any offer whose id the reader does not know, so a new action id
// or risk value never fails the whole task answer (Code runs ahead of Cloud's pinned version and of installed MCP and CLI). Words travel with the keys: an unknown key still draws with its words and tone.
import { z } from "zod";
import { TASK_ACTION_IDS, type ActionOffer } from "./task-actions.js";
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

const Binding = z.object({ revision: z.number().int().min(0), digest: z.string().optional() }).passthrough();
/** One offer as an older reader sees it: ids and risks are plain strings, unknown keys pass through. */
export const LooseActionOfferSchema = z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), risk: z.string().min(1).max(40), needsDialog: z.boolean(), binding: Binding }).passthrough();
export type LooseActionOffer = z.infer<typeof LooseActionOfferSchema>;

/**
 * The offers a reader can use: every entry that reads as an offer AND names an action the reader knows (`known`, the reader's own pinned list: by default this build's ids). An entry it does not know, or that does not read, is
 * skipped, never a failure. A value that is not a list reads as no offers.
 */
export function readLooseOffers(value: unknown, known: readonly string[] = TASK_ACTION_IDS): LooseActionOffer[] {
  if (!Array.isArray(value)) return [];
  const offers: LooseActionOffer[] = [];
  for (const entry of value as unknown[]) {
    const parsed = LooseActionOfferSchema.safeParse(entry);
    if (parsed.success && known.includes(parsed.data.id)) offers.push(parsed.data);
  }
  return offers;
}

const Keyed = z.object({ key: z.string().min(1).max(60), words: z.string().max(200) }).passthrough();
const Step = z.object({ key: z.string().min(1).max(60), title: z.string().max(200), state: z.string().min(1).max(40), phase: z.string().max(60).optional() }).passthrough();

/** The tolerant reader of `standing` (a reader that cannot be sure of its Code's version). F3's package embeds it in the task read. */
export const TaskStandingReaderSchema = z.object({
  phase: Keyed.optional(),
  step: Step.optional(),
  steps: z.array(Step).max(40).optional(),
  pill: z.object({ key: z.string().min(1).max(60), words: z.string().min(1).max(200), tone: z.string().min(1).max(40), icon: z.string().max(40).optional() }).passthrough(),
  waitingOn: z.object({ role: z.string().min(1).max(60), words: z.string().max(200) }).passthrough().optional(),
  actions: z.unknown().optional().transform((value) => readLooseOffers(value)),
}).passthrough();
export type TaskStandingReading = z.infer<typeof TaskStandingReaderSchema>;
