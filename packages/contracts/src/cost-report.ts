// The admin portal's cost and time report (lead 4, Feature A, slices A1 and A2; designs-2026-11-17/cost-report-and-linear-parity.md). What a company owner or admin reads out of Code about their own
// company, and the routes that file tasks under features.
//
//   GET  /v1/app/org/report/tasks                      one row per task: when it started, its pull requests, its cost, its feature. Company owner or admin. Oldest start first, paged.
//   GET  /v1/app/org/report/features                   the company's features. Company owner or admin.
//   POST /v1/app/org/report/features                   make a feature ({ name, trackerLink? }). Company owner or admin.
//   POST /v1/app/org/report/features/{id}/rename       { name }. Company owner or admin.
//   POST /v1/app/org/report/features/{id}/merge        { into }: every task of this feature reads as the other one's from then on; no history is rewritten. Company owner or admin.
//   POST /v1/app/org/report/features/{id}/state        { state: "open" | "done" }. Company owner or admin.
//   POST /v1/app/tasks/{taskId}/feature                { feature: <id> | null }: file a task, or move it (null: No feature). The task's own starter files it once; a project maintainer or a
//                                                      company owner or admin moves it.
//
// Rules the numbers follow: a task belongs to the range it STARTED in and its whole cost goes there. Cost is whole millionths of the ledger's currency (never a float), read only from the cost
// ledger; a call with no price is counted in `unpricedCalls` (the cost is then a floor, and is never shown as zero). A task with no feature is "No feature": its row has no `feature`. The time split
// (`workingMs`, `waitingPeopleMs`, `waitingSystemMs`) and the send-back counts come from the task's work events (slice A4) and are present, all together with `timesComplete: true`, only for a task whose events cover
// it from its start; a task from before the events, or whose events cannot all be read, has none of them: absent is "not known", never zero. No row names a person.
import { z } from "zod";
import { AgentXNameSchema } from "./names.js";

export const COMPANY_REPORT_TASKS_PATH = "/v1/app/org/report/tasks";
export const COMPANY_REPORT_FEATURES_PATH = "/v1/app/org/report/features";
/** `POST /v1/app/tasks/{taskId}/feature`. */
export const TASK_FEATURE_PATH_PATTERN = /^\/v1\/app\/tasks\/([^/]+)\/feature$/u;

export const REPORT_PAGE_DEFAULT = 100;
export const REPORT_PAGE_MAX = 200;
/** The most task rows one call looks at (rows past this wait for the next call). */
export const REPORT_SCAN_MAX = 1_000;
/** The most features a company holds (merged ones included): one read of them is one page. */
export const REPORT_FEATURES_MAX = 500;
export const FEATURE_NAME_MAX = 80;
export const REPORT_TITLE_MAX = 120;
export const REPORT_PR_LINKS_MAX = 32;

export const FeatureIdSchema = z.string().regex(/^ft_[a-f0-9]{20}$/u);
export type FeatureId = z.infer<typeof FeatureIdSchema>;

/** How a task got its feature, highest rule first: a person moved it, chose it, or confirmed the tracker's suggestion at plan review, then the tracker parent, then inheritance. */
export const FEATURE_SOURCES = ["moved", "chosen", "confirmed_at_plan", "tracker", "inherited"] as const;
export const FeatureSourceSchema = z.enum(FEATURE_SOURCES);
export type FeatureSource = z.infer<typeof FeatureSourceSchema>;
/** Higher wins: a lower rule never replaces a higher one. */
export const FEATURE_SOURCE_RANK: Readonly<Record<FeatureSource, number>> = { moved: 5, chosen: 4, confirmed_at_plan: 3, tracker: 2, inherited: 1 };
/** The sources a person's own act makes: only these may replace a source of the same rank. */
export const PERSON_FEATURE_SOURCES: readonly FeatureSource[] = ["moved", "chosen", "confirmed_at_plan"];

/** A feature's name: one line, no control characters, at most `FEATURE_NAME_MAX` characters (checked again, and cleaned, where it is stored). */
export const FeatureNameInputSchema = z.string().min(1).refine((value) => [...value].length <= FEATURE_NAME_MAX, `at most ${String(FEATURE_NAME_MAX)} characters`);

export const FeatureTrackerLinkSchema = z.object({
  tracker: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u),
  id: z.string().min(1).max(120).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "no control characters"),
  url: z.string().max(2_048).refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === ""; } catch { return false; }
  }, "a plain https address"),
}).strict();
export type FeatureTrackerLink = z.infer<typeof FeatureTrackerLinkSchema>;

/** `open` and `done` are what people set; a feature merged into another is not listed (its tasks read as the other's). */
export const FeatureStateSchema = z.enum(["open", "done"]);
export type FeatureState = z.infer<typeof FeatureStateSchema>;

const InstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u).refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "an instant with milliseconds");

export const FeatureViewSchema = z.object({
  id: FeatureIdSchema,
  name: z.string().min(1).max(FEATURE_NAME_MAX * 4),
  state: FeatureStateSchema,
  trackerLink: FeatureTrackerLinkSchema.optional(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
}).strict();
export type FeatureView = z.infer<typeof FeatureViewSchema>;

export const FeaturesResponseSchema = z.object({ features: z.array(FeatureViewSchema).max(REPORT_FEATURES_MAX) }).strict();
export type FeaturesResponse = z.infer<typeof FeaturesResponseSchema>;
export const FeatureResponseSchema = z.object({ feature: FeatureViewSchema }).strict();
export type FeatureResponse = z.infer<typeof FeatureResponseSchema>;

export const CreateFeatureBodySchema = z.object({ name: FeatureNameInputSchema, trackerLink: FeatureTrackerLinkSchema.optional() }).strict();
export const RenameFeatureBodySchema = z.object({ name: FeatureNameInputSchema }).strict();
export const MergeFeatureBodySchema = z.object({ into: FeatureIdSchema }).strict();
export const FeatureStateBodySchema = z.object({ state: FeatureStateSchema }).strict();
/** `feature: null` files the task under "No feature" on purpose (no lower rule may then file it elsewhere). */
export const TaskFeatureBodySchema = z.object({ feature: FeatureIdSchema.nullable() }).strict();
export type TaskFeatureBody = z.infer<typeof TaskFeatureBodySchema>;

export const TaskFeatureResponseSchema = z.object({
  task: z.object({ taskId: z.string().uuid(), feature: z.object({ id: FeatureIdSchema, source: FeatureSourceSchema }).strict().nullable() }).strict(),
}).strict();
export type TaskFeatureResponse = z.infer<typeof TaskFeatureResponseSchema>;

// ---- the report rows

/** Where a task started: Linear, Jira, Slack, the web app, an AI tool or the CLI (`tool`), or anything else (an automation, a schedule, a GitHub issue). */
export const REPORT_ORIGINS = ["linear", "jira", "slack", "web", "tool", "other"] as const;
export const ReportOriginSchema = z.enum(REPORT_ORIGINS);
export type ReportOrigin = z.infer<typeof ReportOriginSchema>;
export const REPORT_PATHS = ["quick", "full"] as const;
export const ReportPathSchema = z.enum(REPORT_PATHS);
/** `failed` is part of the vocabulary for slice A4; version 0 reports open, merged and closed. */
export const REPORT_STATES = ["open", "merged", "closed", "failed"] as const;
export const ReportStateSchema = z.enum(REPORT_STATES);
export type ReportState = z.infer<typeof ReportStateSchema>;

/**
 * Code's own task page for one task: `/review/<taskId>/task`. A REFERENCE to follow, not access: the page asks the reader to sign in and checks their access to the task itself, so a row's reference
 * never lets anyone see a task they could not already open. Always the path of the row's own task (no host, query or other page), so a reader can follow it as it stands.
 */
export const TASK_PAGE_PATH_PATTERN = /^\/review\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/task$/u;
export const taskPagePath = (taskId: string): string => `/review/${taskId}/task`;

const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ReportTaskRowSchema = z.object({
  taskId: z.string().uuid(),
  project: AgentXNameSchema,
  /** The task's title, made inert and cut to `REPORT_TITLE_MAX`. Draw it as text. */
  title: z.string().max(REPORT_TITLE_MAX * 4),
  origin: ReportOriginSchema,
  path: ReportPathSchema.optional(),
  state: ReportStateSchema,
  /** Where to open this task: Code's own task page path for THIS row's task (`taskPagePath`), to follow as it stands. Absent from an older Code: draw the title as plain text. The page checks the reader's own access. */
  taskPage: z.string().regex(TASK_PAGE_PATH_PATTERN).optional(),
  /** Absent: "No feature". */
  feature: z.object({ id: FeatureIdSchema, source: FeatureSourceSchema }).strict().optional(),
  startedAt: InstantSchema,
  /** When Rovara first marked a pull request ready (the `pr_ready` milestone). Absent when no milestone says. */
  firstPrAt: InstantSchema.optional(),
  /** Merge or close time. Absent while the task is open. */
  endedAt: InstantSchema.optional(),
  prsOpened: CountSchema.max(REPORT_PR_LINKS_MAX),
  prsMerged: CountSchema.max(REPORT_PR_LINKS_MAX),
  /** Plain https addresses only. */
  prLinks: z.array(z.string().max(2_048)).max(REPORT_PR_LINKS_MAX),
  /** Whole millionths of `currency`, from the cost ledger. A floor when `unpricedCalls` is above zero. */
  costMicros: CountSchema,
  /** Absent when the ledger has recorded nothing for the task. */
  currency: z.string().min(1).max(10).optional(),
  unpricedCalls: CountSchema,
  // Slice A4 (work events): present together, with `timesComplete`, for a task whose events cover it from its start; absent is "not known", never zero. `workingMs` is time a step ran, `waitingPeopleMs` is time the
  // task waited for a person (`decisionsMs`: a plan to approve, a question, spend, something blocked; `prReviewMs`: pull request review up to the merge, shown apart), `waitingSystemMs` is time a step was queued.
  // For an open task they run to now. The three never overlap. Send-backs: `sendBacksRovara` is Rovara sending its own code back (an automatic fix, a CI fix round), `sendBacksPeople` is a person asking for changes.
  workingMs: CountSchema.optional(),
  waitingPeopleMs: z.object({ decisionsMs: CountSchema, prReviewMs: CountSchema }).strict().optional(),
  waitingSystemMs: CountSchema.optional(),
  sendBacksRovara: CountSchema.optional(),
  sendBacksPeople: CountSchema.optional(),
  timesComplete: z.boolean().optional(),
}).strict().superRefine((row, context) => {
  // All of the A4 numbers or none of them (a row never carries half a time split).
  const a4 = [row.workingMs, row.waitingPeopleMs, row.waitingSystemMs, row.sendBacksRovara, row.sendBacksPeople, row.timesComplete];
  if (a4.some((value) => value !== undefined) && a4.some((value) => value === undefined)) context.addIssue({ code: "custom", path: ["timesComplete"], message: "the time split and the send-backs come together or not at all" });
  if (row.taskPage !== undefined && row.taskPage.toLowerCase() !== taskPagePath(row.taskId).toLowerCase()) context.addIssue({ code: "custom", path: ["taskPage"], message: "the page of another task" });
  if (row.prsMerged > row.prsOpened) context.addIssue({ code: "custom", path: ["prsMerged"], message: "merged pull requests cannot exceed opened ones" });
  if (row.prLinks.some((link) => { try { const url = new URL(link); return url.protocol !== "https:" || url.username !== "" || url.password !== ""; } catch { return true; } })) context.addIssue({ code: "custom", path: ["prLinks"], message: "plain https addresses only" });
});
export type ReportTaskRow = z.infer<typeof ReportTaskRowSchema>;

export const ReportTasksQuerySchema = z.object({
  from: InstantSchema.optional(),
  to: InstantSchema.optional(),
  project: AgentXNameSchema.optional(),
  origin: ReportOriginSchema.optional(),
  state: ReportStateSchema.optional(),
  path: ReportPathSchema.optional(),
  limit: z.number().int().min(1).max(REPORT_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(1_024).optional(),
}).strict();
export type ReportTasksQuery = z.infer<typeof ReportTasksQuerySchema>;

export const ReportTasksResponseSchema = z.object({
  tasks: z.array(ReportTaskRowSchema).max(REPORT_PAGE_MAX),
  /** Where to go on from: always present. Pass it back as `cursor` with the same filters. */
  next: z.string(),
  /** True when the call stopped before the end of the range: ask again with `next`. */
  hasMore: z.boolean(),
  /** Rows of the company's partition that are not this company's. Never their content. */
  skipped: z.number().int().min(0),
  /** Rows this code could not read (or whose figures were not whole numbers), left out. Never their content. */
  unreadable: z.number().int().min(0),
}).strict();
export type ReportTasksResponse = z.infer<typeof ReportTasksResponseSchema>;

// ---- fixed words

export const REPORT_ADMIN_ONLY = "Only an owner or admin of the company can read the cost and time report.";
export const FEATURE_ADMIN_ONLY = "Only an owner or admin of the company can change features.";
export const FEATURE_NOT_FOUND = "That feature does not exist.";
export const FEATURE_NAME_TAKEN = "A feature with that name already exists.";
export const FEATURE_LIMIT = "The company has as many features as it can hold. Merge or reuse one.";
export const FEATURE_IS_DONE = "That feature is done. Reopen it first.";
export const FEATURE_CANNOT_MERGE = "A feature cannot be merged into itself or into one already merged away.";
export const FEATURE_CONFLICT = "The feature changed while you were saving. Try again.";
export const TASK_FEATURE_NOT_FOUND = "task not found";
export const TASK_FEATURE_NEEDS_MAINTAINER = "Only a project maintainer, owner or admin can move a task that already has a feature.";
export const REPORT_UNAVAILABLE = "Rovara can't read the report right now. Try again.";
export const REPORT_QUERY_REFUSED = "the report query is not valid";
