// The task standing as a CLIENT reads it: where one task stands for the person reading it (phase, step, the strip, the pill, who it waits on, the moves they may make). Code computes it (`taskStandingFor`) and serves it on the task read
// (`GET /v1/dev/tasks/{taskId}`, `standing`); a client builds against THIS reader, which is tolerant by design: unknown keys pass through, every key a newer Code may add a value to is a plain string (not an enum), and `actions` is read with a LOOSE
// offer reader that SKIPS any offer whose id the reader does not know, so a newer Code never fails a task answer for an older client. Words travel with the keys: an unknown key still draws with its words and tone.
//
// This package imports nothing of Code's, so the keys, tones, words and action ids a client may want to recognise are inlined below; `tests/contract/code-api-standing.test.ts` proves they equal the ones Code computes with.
import { z } from "zod";

/** The pill keys Code serves today (a newer Code may add one: read `pill.key` as a string). */
export const STANDING_PILL_KEYS = ["needs_you", "needs_role", "working", "fixing", "waiting", "in_review", "stopped", "merged", "closed"] as const;
export const STANDING_PILL_TONES = ["attention", "running", "ok", "idle"] as const;
/** The words, tone and icon key of each pill (the `needs_role` pill's words are in `STANDING_NEEDS_ROLE_WORDS`). A client draws the words Code serves; this table is for a client that wants to recognise them. */
export const STANDING_PILLS: Readonly<Record<(typeof STANDING_PILL_KEYS)[number], { words: string; tone: (typeof STANDING_PILL_TONES)[number]; icon: string }>> = {
  needs_you: { words: "Needs you", tone: "attention", icon: "alert" },
  needs_role: { words: "Needs the task owner", tone: "attention", icon: "alert" },
  working: { words: "Rovara is working", tone: "running", icon: "arc" },
  fixing: { words: "Rovara is fixing it", tone: "running", icon: "arc" },
  waiting: { words: "Waiting", tone: "running", icon: "clock" },
  in_review: { words: "In review", tone: "ok", icon: "ring" },
  stopped: { words: "Stopped", tone: "idle", icon: "dash" },
  merged: { words: "Merged", tone: "ok", icon: "tick" },
  closed: { words: "Closed", tone: "idle", icon: "dash" },
};
export const STANDING_NEEDS_ROLE_WORDS: Readonly<Record<string, string>> = { task_owner: "Needs the task owner", company_admin: "Needs a company admin" };
export const STANDING_ROLE_WORDS: Readonly<Record<string, string>> = { task_owner: "task owner", co_owner: "co-owner", project_admin: "project admin", company_admin: "company admin" };
/** The action ids Code offers today. An offer whose id is not in the reader's list is skipped, never a failure. */
export const STANDING_ACTION_IDS: readonly string[] = [
  "plan.approve", "plan.request-changes", "plan.reject",
  "step.retry", "work.send-back", "findings.resolve",
  "feedback.fix", "feedback.dismiss", "feedback.answer",
  "feedback.retry-review", "pull-request.keep", "task.close",
  "task.stop", "task.merge", "task.continue",
  "task.review", "pull-request.open", "task.answer",
  "people.view", "people.add", "people.set-role",
  "people.take-ownership",
];

const Binding = z.object({ revision: z.number().int().min(0), digest: z.string().optional() }).passthrough();
/** One offer as a client reads it: ids and risks are plain strings, unknown keys pass through. */
export const LooseActionOfferSchema = z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), risk: z.string().min(1).max(40), needsDialog: z.boolean(), binding: Binding }).passthrough();
export type LooseActionOffer = z.infer<typeof LooseActionOfferSchema>;

/**
 * The offers a client can use: every entry that reads as an offer AND names an action the client knows (`known`, the client's own pinned list: by default this package's ids). An entry it does not know, or that does not read, is skipped,
 * never a failure. A value that is not a list reads as no offers.
 */
export function readLooseOffers(value: unknown, known: readonly string[] = STANDING_ACTION_IDS): LooseActionOffer[] {
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

const standingShape = {
  phase: Keyed.optional(),
  step: Step.optional(),
  steps: z.array(Step).max(40).optional(),
  pill: z.object({ key: z.string().min(1).max(60), words: z.string().min(1).max(200), tone: z.string().min(1).max(40), icon: z.string().max(40).optional() }).passthrough(),
  waitingOn: z.object({ role: z.string().min(1).max(60), words: z.string().max(200) }).passthrough().optional(),
};

/** The tolerant reader of `standing` (a client that cannot be sure of its Code's version). A standing with no `actions` member reads as no offers; the offers it keeps are `readLooseOffers`'. */
export const TaskStandingSchema = z.object({ ...standingShape, actions: z.unknown().optional().transform((value) => readLooseOffers(value)) }).passthrough();
export type TaskStanding = z.infer<typeof TaskStandingSchema>;

/** The same shape as the route table names it (`tasks.read`): the offers are an untyped list here (a schema with a transform has no JSON Schema), and a client reads them with `TaskStandingSchema`. */
export const TaskStandingWireSchema = z.object({ ...standingShape, actions: z.array(z.unknown()).optional() }).passthrough();
