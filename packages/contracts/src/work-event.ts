// Work events (U3, requirements P-11 and E-62; owner Q1: "Cloud starts emitting the Code-defined work-event type now so Insights has history").
//
// A work event is ONE fact about the flow of one task: it started, a plan was approved, a step began or ended, a decision was asked or answered, a pull request opened, merged or closed, the task failed, the
// next actor changed, a cost settled. Insights and the attention and work summaries are computed from a company's events, and history cannot be rebuilt afterwards, so the events are written from the first day.
//
// What an event holds, and does not:
//  - Ids, never names: the company, the project (its name is its id), the task, and a PERSON'S Rovara id (an opaque id, never a name, an email or a chat handle).
//  - Closed words, never text: the kind comes from `WORK_EVENT_KINDS`; every other field is a number, a closed list of words, or a short lower-case code. There is no field that can hold a prompt, a plan, a comment, a
//    title, a branch name, a file path, an error message or a secret, and every shape is strict, so an unknown field is refused rather than stored.
//  - Time: `at` is the instant of the change itself (UTC, with milliseconds), taken from the source change, so a repeat of the same change is the same event.
//
// The set of kinds is CLOSED and versioned (`WORK_EVENT_VERSION`). A new kind, or a new field, is an interface change for both owners and bumps the version; a reader refuses a version it does not know.
// Where events are kept is an adapter's business (a document store row under the company's key scope, see `workEventPartition`); this file holds the shape, the keys and the retention rule.
import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";
import { AgentXNameSchema } from "./names.js";

export const WORK_EVENT_VERSION = 1;

/** Events are kept this many whole months after the month they happened in (owner: 13 months). */
export const WORK_EVENT_RETENTION_MONTHS = 13;

export const WORK_EVENT_KINDS = [
  "task_started",
  "plan_approved",
  "step_started",
  "step_ended",
  "decision_asked",
  "decision_answered",
  "pr_opened",
  "pr_merged",
  "pr_closed",
  "task_failed",
  "waiting_changed",
  "cost_settled",
] as const;
export const WorkEventKindSchema = z.enum(WORK_EVENT_KINDS);
export type WorkEventKind = z.infer<typeof WorkEventKindSchema>;

/** A short lower-case word for a fact the core names (a step, a decision kind, a reason, a place): `plan`, `code_review`, `budget_paused`. Never text a person or a model wrote. */
export const WorkEventCodeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/u);

/** A person's Rovara id: opaque, from a closed alphabet that holds no space, `@` or other mark of a name or an email. */
export const WorkEventPersonIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);

/** An id of a thing the core minted (a decision card, a request): opaque, same alphabet as a person id. */
export const WorkEventRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);

/** `wev_` and 32 hex characters: derived from the source change (`workEventId` in `work-event-node.ts`), so the same change is the same id. */
export const WorkEventIdSchema = z.string().regex(/^wev_[a-f0-9]{32}$/u);

/** A UTC instant in the exact form `Date.prototype.toISOString` writes, so that text order is time order and the month of an event is its first seven characters. */
export const WorkEventInstantSchema = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "a UTC instant with milliseconds");

/** Who did it: a person (by id), an agent, or Rovara itself. Never a name. */
export const WorkEventActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), personId: WorkEventPersonIdSchema }).strict(),
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);
export type WorkEventActor = z.infer<typeof WorkEventActorSchema>;

/** Who the work waits for now. `none` is "nobody": the work is moving or finished. */
export const WORK_EVENT_WAITING_ON = ["person", "agent", "system", "none"] as const;

const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const RepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/u);
const base = {
  version: z.literal(WORK_EVENT_VERSION),
  id: WorkEventIdSchema,
  at: WorkEventInstantSchema,
  orgId: OrgIdSchema,
  project: AgentXNameSchema,
  taskId: z.string().uuid(),
  actor: WorkEventActorSchema,
};

export const WORK_EVENT_RISKS = ["low", "medium", "high"] as const;
export const WORK_EVENT_DECISION_OUTCOMES = ["approved", "rejected", "changes_requested", "answered", "expired"] as const;
export const WORK_EVENT_STEP_OUTCOMES = ["done", "failed", "stopped", "superseded"] as const;

export const WorkEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("task_started"), path: z.enum(["QUICK", "FULL"]).optional(), origin: WorkEventCodeSchema.optional() }).strict(),
  z.object({ ...base, kind: z.literal("plan_approved"), risk: z.enum(WORK_EVENT_RISKS).optional() }).strict(),
  // A retry is a second `step_started` for the same step of the same task: a reader counts them, so no event carries an attempt number.
  z.object({ ...base, kind: z.literal("step_started"), step: WorkEventCodeSchema }).strict(),
  z.object({ ...base, kind: z.literal("step_ended"), step: WorkEventCodeSchema, outcome: z.enum(WORK_EVENT_STEP_OUTCOMES) }).strict(),
  z.object({ ...base, kind: z.literal("decision_asked"), decisionId: WorkEventRefSchema, decision: WorkEventCodeSchema, risk: z.enum(WORK_EVENT_RISKS).optional() }).strict(),
  z.object({
    ...base, kind: z.literal("decision_answered"), decisionId: WorkEventRefSchema, decision: WorkEventCodeSchema, outcome: z.enum(WORK_EVENT_DECISION_OUTCOMES), place: WorkEventCodeSchema.optional(),
  }).strict(),
  z.object({ ...base, kind: z.literal("pr_opened"), repository: RepositorySchema, number: z.number().int().positive() }).strict(),
  z.object({ ...base, kind: z.literal("pr_merged"), repository: RepositorySchema, number: z.number().int().positive() }).strict(),
  z.object({ ...base, kind: z.literal("pr_closed"), repository: RepositorySchema, number: z.number().int().positive() }).strict(),
  z.object({ ...base, kind: z.literal("task_failed"), reason: WorkEventCodeSchema }).strict(),
  z.object({
    ...base, kind: z.literal("waiting_changed"), waitingOn: z.enum(WORK_EVENT_WAITING_ON), personIds: z.array(WorkEventPersonIdSchema).min(1).max(20).optional(), reason: WorkEventCodeSchema.optional(),
  }).strict().refine((event) => event.personIds === undefined || event.waitingOn === "person", "personIds are given only when the work waits on a person (and not always: the person may not be known)"),
  z.object({ ...base, kind: z.literal("cost_settled"), micros: CountSchema, currency: z.string().regex(/^[A-Z]{3}$/u), source: WorkEventCodeSchema }).strict(),
]);
export type WorkEvent = z.infer<typeof WorkEventSchema>;
export type WorkEventInput = z.input<typeof WorkEventSchema>;

/** The partition for one company's events of one month (`ORG#<org>#WORK_EVENTS#<yyyy-mm>`): a month is read with one query, and a company's events never share a partition with another's. */
export function workEventPartition(orgId: OrgId, month: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new Error("a work event month is yyyy-mm");
  // `ORG#<company>#WORK_EVENTS#<month>`: the company-scoped key scheme (decision 45.6; `companyScoped` in `ports/company-scope.ts`), written out here so this file imports nothing but `browser-ids` and `names`.
  if (!/^org_[0-9a-z]{20}$/u.test(orgId)) throw new Error("a work event company id is org_ and 20 characters");
  return `ORG#${orgId}#WORK_EVENTS#${month}`;
}

/** The key of one event: its month's partition, and `<at>#<id>` (time order, then id). */
export function workEventKey(event: Pick<WorkEvent, "orgId" | "at" | "id">): { pk: string; sk: string } {
  return { pk: workEventPartition(event.orgId, event.at.slice(0, 7)), sk: `${event.at}#${event.id}` };
}

/** The months from `from` to `to` (both instants, inclusive) as `yyyy-mm`, oldest first: the partitions a read of that range must ask. */
export function workEventMonths(from: string, to: string): string[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new Error("a work event range runs from an earlier instant to a later one");
  const months: string[] = [];
  const cursor = new Date(start);
  let year = cursor.getUTCFullYear();
  let month = cursor.getUTCMonth();
  const last = new Date(end);
  const lastYear = last.getUTCFullYear();
  const lastMonth = last.getUTCMonth();
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

/**
 * When an event expires, in epoch SECONDS (a store's expiry attribute): the start of the month `WORK_EVENT_RETENTION_MONTHS + 1` after the event's own month, so an event is kept for at least the whole of
 * the 13 months after the month it happened in (an event of November 2026 is kept until 1 January 2028), and a month's events leave together.
 */
export function workEventExpiresAt(at: string): number {
  const time = Date.parse(at);
  if (Number.isNaN(time)) throw new Error("a work event time is an instant");
  const date = new Date(time);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + WORK_EVENT_RETENTION_MONTHS + 1, 1) / 1000);
}
