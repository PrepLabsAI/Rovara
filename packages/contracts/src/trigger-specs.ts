// Trigger specs (Plan 4 Task 18): how an agent or a chain may be started other than by a person. An `event` spec names a vendor's event and filters on it; a `schedule`
// spec names a time. The same two shapes are what a custom agent's recipe lists as the ways it may be started (G10) and what a trigger record stores as its live spec.
// This file depends on nothing but zod, so the recipe schema (agent-recipe.ts) and the chain schema can both import it; the records that name a chain or an agent are in
// triggers.ts. The limits here are the plan's exact names.
import { z } from "zod";

// ---- limits

export const TRIGGER_DEFAULT_MAX_RUNS_PER_HOUR = 30;
export const TRIGGER_MAX_RUNS_PER_HOUR = 60;
export const ORG_MAX_AUTONOMOUS_RUNS_PER_DAY = 500;
export const MAX_TRIGGERS_PER_TARGET = 10;
export const SCHEDULE_INTERVAL_MINUTES = [15, 30, 60, 120, 240, 360, 720, 1440] as const;
export const SCHEDULE_MISSED_GRACE_MINUTES = 30;
export const TRIGGER_ACTIVITY_TTL_DAYS = 30;
/** How long after a trigger started a run for a subject an event on the same subject is skipped, as one the run may have caused. */
export const TRIGGER_SUBJECT_GUARD_MINUTES = 30;
export const TRIGGER_FILTER_VALUES_MAX = 10;
export const TRIGGER_FILTER_VALUE_MAX_CHARS = 100;

/** The EventBridge Scheduler group that holds the schedules of an environment's schedule triggers (Task 26). */
export function chainScheduleGroupName(env: string): string {
  return `agentx-${env}-chain-triggers`;
}

// ---- event sources, types and filters

export const EVENT_SOURCES = ["github", "linear", "jira", "pagerduty", "sentry", "datadog", "grafana", "vercel", "cloudwatch"] as const;
export const EventSourceSchema = z.enum(EVENT_SOURCES);
export type EventSource = z.infer<typeof EventSourceSchema>;

/** The event types each source can start a trigger on, exactly. */
export const EVENT_TYPES = {
  github: ["pull_request.opened", "pull_request.ready_for_review", "issues.opened", "issues.labeled", "issues.assigned", "deployment_status.success", "deployment_status.failure", "workflow_run.completed"],
  linear: ["issue.created"],
  jira: ["issue.created", "issue.labeled", "issue.assigned"],
  pagerduty: ["incident.triggered"],
  sentry: ["issue.created", "alert.triggered"],
  datadog: ["monitor.triggered"],
  grafana: ["alert.firing"],
  vercel: ["deployment.succeeded", "deployment.error"],
  cloudwatch: ["alarm.fired"],
} as const satisfies Record<EventSource, readonly string[]>;

const PULL_REQUEST_FILTERS = ["baseBranch", "label", "authorAssociation"] as const;
const ISSUE_FILTERS = ["label", "issueType"] as const;
const ERROR_FILTERS = ["level", "environment"] as const;

/**
 * The filter keys of each event type, by `<source>:<type>` (linear's and sentry's `issue.created` differ). A key narrows which events start the trigger: the event's
 * value for that key must be one of the listed ones. `authorAssociation` takes GitHub's values (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, ...), so a trigger on a
 * public repository can be limited to people who belong to it.
 */
export const EVENT_FILTER_KEYS: Readonly<Record<string, readonly string[]>> = {
  "github:pull_request.opened": PULL_REQUEST_FILTERS,
  "github:pull_request.ready_for_review": PULL_REQUEST_FILTERS,
  "github:issues.opened": ["label", "authorAssociation"],
  // Meta repo lane F: an issue labeled or assigned asks for work. `label` is the label that was ADDED (not every label on the issue); `assignee` is who it was assigned to.
  "github:issues.labeled": ["label"],
  "github:issues.assigned": ["assignee"],
  "github:deployment_status.success": ["environment"],
  "github:deployment_status.failure": ["environment"],
  "github:workflow_run.completed": ["workflow", "conclusion", "branch"],
  "linear:issue.created": ISSUE_FILTERS,
  "jira:issue.created": ISSUE_FILTERS,
  "jira:issue.labeled": ["label"],
  "jira:issue.assigned": ["assignee"],
  "pagerduty:incident.triggered": ["urgency", "service"],
  "sentry:issue.created": ERROR_FILTERS,
  "sentry:alert.triggered": ERROR_FILTERS,
  "datadog:monitor.triggered": ["priority", "tag"],
  "grafana:alert.firing": ["label"],
  "vercel:deployment.succeeded": ["target"],
  "vercel:deployment.error": ["target"],
  "cloudwatch:alarm.fired": ["alarm", "namespace", "region"],
};

/** The filter keys an event type takes; none for a type the source does not have. */
export function eventFilterKeys(source: string, type: string): readonly string[] {
  return Object.hasOwn(EVENT_FILTER_KEYS, `${source}:${type}`) ? EVENT_FILTER_KEYS[`${source}:${type}`]! : [];
}

const FilterValueSchema = z.string().min(1).max(TRIGGER_FILTER_VALUE_MAX_CHARS).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control or invisible characters");
const FilterSchema = z.record(z.string(), z.array(FilterValueSchema).min(1).max(TRIGGER_FILTER_VALUES_MAX));

export const EventTriggerSpecSchema = z
  .object({ kind: z.literal("event"), source: EventSourceSchema, type: z.string().min(1).max(60), filter: FilterSchema.optional() })
  .strict()
  .superRefine((spec, context) => {
    const types: readonly string[] = EVENT_TYPES[spec.source];
    if (!types.includes(spec.type)) {
      context.addIssue({ code: "custom", path: ["type"], message: `${spec.source} has no ${spec.type} event; it has ${types.join(", ")}` });
      return;
    }
    const allowed = eventFilterKeys(spec.source, spec.type);
    for (const key of Object.keys(spec.filter ?? {})) {
      if (!allowed.includes(key)) context.addIssue({ code: "custom", path: ["filter", key], message: `${spec.type} can't be filtered by ${key}; it takes ${allowed.join(", ")}` });
    }
  });
export type EventTriggerSpec = z.infer<typeof EventTriggerSpecSchema>;

// ---- schedules

export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time of day like 09:30");
const IntervalMinutesSchema = z.number().refine((minutes): minutes is (typeof SCHEDULE_INTERVAL_MINUTES)[number] => (SCHEDULE_INTERVAL_MINUTES as readonly number[]).includes(minutes), `must be one of ${SCHEDULE_INTERVAL_MINUTES.join(", ")} minutes`);

export const ScheduleSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: IntervalMinutesSchema }).strict(),
  z
    .object({ kind: z.literal("daily"), at: TimeOfDaySchema, days: z.array(WeekdaySchema).min(1).max(7).refine((days) => new Set(days).size === days.length, "must not repeat a day").optional() })
    .strict(),
  z.object({ kind: z.literal("weekly"), at: TimeOfDaySchema, day: WeekdaySchema }).strict(),
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

let zones: ReadonlySet<string> | undefined;
/** The IANA zones this runtime knows (`Intl.supportedValuesOf("timeZone")`), and UTC, which that list leaves out in some runtimes. */
function knownZones(): ReadonlySet<string> {
  zones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  return zones;
}
export const TimezoneSchema = z.string().refine((zone) => knownZones().has(zone), "must be an IANA time zone like Europe/Berlin");

export const MISSED_BEHAVIOURS = ["skip", "run_once"] as const;
export const MissedSchema = z.enum(MISSED_BEHAVIOURS);

export const ScheduleTriggerSpecSchema = z
  .object({ kind: z.literal("schedule"), schedule: ScheduleSpecSchema, timezone: TimezoneSchema, missed: MissedSchema.default("run_once") })
  .strict();
export type ScheduleTriggerSpec = z.infer<typeof ScheduleTriggerSpecSchema>;

// ---- how a spec changes

/** Fires per week: the measure of "more often". A person trigger fires never. */
export function triggerScheduleRate(spec: { kind: string } & Partial<Pick<ScheduleTriggerSpec, "schedule">>): number {
  if (spec.kind !== "schedule" || spec.schedule === undefined) return 0;
  const schedule = spec.schedule;
  if (schedule.kind === "interval") return Math.round((7 * 24 * 60) / schedule.minutes);
  if (schedule.kind === "daily") return schedule.days?.length ?? 7;
  return 1;
}

/** Whether `after`'s filter lets in an event `before`'s did not: a key dropped, or a value added to one. A key that is new narrows. */
function filterWidens(before: Record<string, string[]> | undefined, after: Record<string, string[]> | undefined): boolean {
  for (const [key, values] of Object.entries(before ?? {})) {
    const next = after?.[key];
    if (next === undefined) return true;
    if (next.some((value) => !values.includes(value))) return true;
  }
  return false;
}

type Spec = { kind: string } & Partial<Pick<EventTriggerSpec, "filter"> & Pick<ScheduleTriggerSpec, "schedule" | "missed">>;

/**
 * Whether changing a trigger's spec from `before` to `after` lets it start work it did not: a wider event filter, a schedule that fires more often (`triggerScheduleRate`),
 * or a missed run that is no longer skipped. The identity of the spec (its kind, source and type) is a different question, which the routes ask themselves.
 */
export function triggerSpecWidens(before: Spec, after: Spec): boolean {
  if (before.kind === "event" && after.kind === "event") return filterWidens(before.filter, after.filter);
  if (before.kind === "schedule" && after.kind === "schedule") {
    return triggerScheduleRate(after) > triggerScheduleRate(before) || (before.missed === "skip" && after.missed === "run_once");
  }
  return false;
}

// ---- meta repo lane F: events that ask Rovara Code for work

/** The event types that ask for work on a ticket: a label put on it, or an assignment. Only Rovara Code's built-in suggestions use them, and they start work through the intake engine, not as a run. */
export const INTAKE_EVENT_TYPES = { github: ["issues.labeled", "issues.assigned"], jira: ["issue.labeled", "issue.assigned"] } as const;

/** Whether a spec is one of those. */
export function isIntakeEventSpec(spec: { kind: string; source?: string; type?: string }): boolean {
  if (spec.kind !== "event" || spec.source === undefined || spec.type === undefined || !Object.hasOwn(INTAKE_EVENT_TYPES, spec.source)) return false;
  return (INTAKE_EVENT_TYPES[spec.source as keyof typeof INTAKE_EVENT_TYPES] as readonly string[]).includes(spec.type);
}

/** The filter key that must name what asks for work, for a spec that is an intake event (a trigger without it would start on any label or any assignment). */
export function intakeEventRequiredFilter(spec: { type: string }): "label" | "assignee" {
  return spec.type.endsWith(".assigned") ? "assignee" : "label";
}
