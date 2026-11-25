// S1: the task action registry's declarations (pure data and zod, browser-safe: no engine imports). A task action is one move a person may make on a task (approve a plan, retry a step, stop, close, merge, ...). Code holds the
// list and decides what a person may do now (`broker/src/core/task-actions`); a surface (the web page, Slack) renders what Code offers and sends back a press that names the action, the task and the revision it was shown.
// Nothing here decides: the shapes of an offer, an input and a result, and the button value a card carries.
import { z } from "zod";
import type { AgentXErrorCode, TaskActionRefusalReason, TaskActionWrites } from "./errors.js";

/** Every action a person may take on a task from any surface (the web offers the same set). `people.add` and `people.set-role` are declared and held for the second cut (`TASK_ACTION_NOTES`). */
export const TASK_ACTION_IDS = [
  "plan.approve", "plan.request-changes", "plan.reject", "step.retry", "work.send-back", "findings.resolve",
  "feedback.fix", "feedback.dismiss", "feedback.answer", "feedback.retry-review", "pull-request.keep",
  "task.close", "task.stop", "task.merge", "task.continue", "task.review", "pull-request.open", "task.answer",
  "people.view", "people.add", "people.set-role", "people.take-ownership",
] as const;
export type TaskActionId = (typeof TASK_ACTION_IDS)[number];
export const TaskActionIdSchema = z.enum(TASK_ACTION_IDS);

/** What a move costs or risks; Code decides, a surface only obeys: `money` starts paid work, `high` moves plan authority or review gates, `irreversible` cannot be taken back. */
export const TASK_ACTION_RISKS = ["routine", "money", "high", "irreversible"] as const;
export type TaskActionRisk = (typeof TASK_ACTION_RISKS)[number];

const Label = z.string().min(1).max(120);
const FieldId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u);
const Option = z.object({ value: z.string().min(1).max(200), label: Label, selected: z.boolean().optional() }).strict();

/** One value a person gives before a move is made. The spec is built by Code from the live task (never from anything the surface sent); untrusted text in it is made inert before it is served. */
export const InputFieldSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), id: FieldId, label: Label, required: z.boolean(), max: z.number().int().min(1).max(3_000), multiline: z.boolean().optional(), initial: z.string().max(3_000).optional() }).strict(),
  z.object({ kind: z.literal("choice"), id: FieldId, label: Label, options: z.array(Option).min(1).max(100), required: z.boolean(), initial: z.string().max(200).optional() }).strict(),
  z.object({ kind: z.literal("pick-many"), id: FieldId, label: Label, options: z.array(Option).min(1).max(100), min: z.number().int().min(0).max(100), max: z.number().int().min(1).max(100) }).strict(),
  /** One answer per item (a review finding): Fix or Accept, with a note that is required to Accept. */
  z.object({ kind: z.literal("per-item"), id: FieldId, label: Label, items: z.array(z.object({ id: z.string().min(1).max(200), text: z.string().max(600), role: z.string().max(40).optional() }).strict()).min(1).max(20), choices: z.array(Option).min(2).max(4), noteRequiredFor: z.string().max(40).optional(), noteMax: z.number().int().min(1).max(3_000) }).strict(),
]);
export type InputField = z.infer<typeof InputFieldSchema>;
export const InputSpecSchema = z.object({ fields: z.array(InputFieldSchema).max(8) }).strict();
export type InputSpec = z.infer<typeof InputSpecSchema>;
export const NO_INPUT: InputSpec = { fields: [] };

/** What a person is told before an irreversible, review-skipping or limit-raising move: fixed words, numbers and an inert task title, never model text. */
export const ConfirmLinesSchema = z.object({ title: Label, lines: z.array(z.string().max(600)).max(20), button: z.string().min(1).max(30), danger: z.boolean() }).strict();
export type ConfirmLines = z.infer<typeof ConfirmLinesSchema>;

/** What the person saw: the task's revision and, where the action has one, the digest of what it is about (a plan, the checked code, a review). A move made on anything else is stale. */
export const ActionBindingSchema = z.object({ revision: z.number().int().min(0), digest: z.string().regex(/^[a-f0-9]{16,64}$/u).optional() }).strict();
export type ActionBinding = z.infer<typeof ActionBindingSchema>;

/** One offer: what a task may be asked to do now. It carries no right, no price and no text a person wrote; the press is judged again for whoever presses. */
export const ActionOfferSchema = z.object({
  id: TaskActionIdSchema, label: Label, risk: z.enum(TASK_ACTION_RISKS),
  /** True when a press must first open a form or the confirm (an input, or a confirm for a high or irreversible risk). */
  needsDialog: z.boolean(),
  binding: ActionBindingSchema,
}).strict();
export type ActionOffer = z.infer<typeof ActionOfferSchema>;

/** The button value a card carries (Slack keeps it to 2,000 characters): the task, the revision and digest the person was shown. Nothing else. */
export const TaskActionValueSchema = z.object({
  t: z.string().uuid(), r: z.number().int().min(0), d: z.string().regex(/^[a-f0-9]{16,64}$/u).optional(),
  /** Layout only: the press opens a form or a confirm, so the surface opens its dialog at once (a trigger is good for a few seconds). Code judges the press again whatever this says. */
  n: z.literal(1).optional(),
}).strict();
export type TaskActionValue = z.infer<typeof TaskActionValueSchema>;

/** The action id prefix of a task action button, in Slack and in any surface with namespaced ids: `rovara_task:<id>`. */
export const TASK_ACTION_PREFIX = "rovara_task:";
export const taskActionButtonId = (id: TaskActionId): string => `${TASK_ACTION_PREFIX}${id}`;
/** The registry id a button action id names, or undefined for any other id. */
export function taskActionOfButtonId(actionId: string): TaskActionId | undefined {
  if (!actionId.startsWith(TASK_ACTION_PREFIX)) return undefined;
  const parsed = TaskActionIdSchema.safeParse(actionId.slice(TASK_ACTION_PREFIX.length));
  return parsed.success ? parsed.data : undefined;
}

/** What a person gave in a form, keyed by the spec's field ids: a text, a chosen value, the chosen values, or (per-item) `<itemId>` for the choice and `<itemId>#note` for its note. */
export const ActionValuesSchema = z.record(z.string().min(1).max(220), z.union([z.string().max(3_000), z.array(z.string().max(200)).max(100)])).refine((values) => Object.keys(values).length <= 60, "too many values");
export type ActionValues = z.infer<typeof ActionValuesSchema>;

/** The outcome of a task action, whatever the surface. A refusal says why by a stable word and whether anything may have been written. */
export type ActionResult =
  | { status: "done"; said?: string; /** What the person may do next (a view that offers a move): their own offers, judged again at the press. */ next?: ActionOffer[] }
  | { status: "started"; said?: string }
  | { status: "replayed" }
  | { status: "refused"; code: AgentXErrorCode; reason: TaskActionRefusalReason; writes: TaskActionWrites };

/** What `describeAction` answers: a refusal (never a spec, so a public card leaks no finding text, close preview or money to someone who may not act) or the form and confirm to show. */
export type ActionDescription =
  | { status: "refused"; code: AgentXErrorCode; reason: TaskActionRefusalReason }
  | { status: "ok"; label: string; spec: InputSpec; confirm?: ConfirmLines; confirmDigest?: string; binding: ActionBinding };

// The words of every action (labels, the line a card shows once a move was taken, a retry's label by step) live in `task-words.ts`: the ONE words table of Code.

/** The declared exclusions of the same-set check, each with its reason (nothing is silently left out of a surface). */
export const TASK_ACTION_NOTES: Readonly<Partial<Record<TaskActionId, string>>> = {
  "people.add": "Held for the second cut: adding a person moves plan authority and spend to them.",
  "people.set-role": "Held for the second cut: changing a role moves plan authority and spend.",
};
