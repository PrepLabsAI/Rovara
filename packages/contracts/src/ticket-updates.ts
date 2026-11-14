// Slice 5 "Outside tools" (owner decision 6): what Rovara writes back to the ticket that started a task. A comment on the Linear or Jira ticket (or the GitHub issue) at four moments, each with
// the link to the task's page, and, only when a maintainer turns it on, the ticket's status moved to match. The settings are the project's; the words of every comment are fixed (the task's title,
// the moment and the link, nothing else). This file depends on nothing but zod, so the browser and the broker both import it.
import { z } from "zod";

/** The moments a ticket hears about: the task started, its plan is ready for review, its pull request opened, and it merged or closed. */
export const TICKET_UPDATE_MOMENTS = ["started", "plan_ready", "pr_opened", "merged", "closed"] as const;
export type TicketUpdateMoment = (typeof TICKET_UPDATE_MOMENTS)[number];

/** The trackers Rovara writes back to. */
export const TICKET_TRACKERS = ["linear", "jira", "github"] as const;
export type TicketTracker = (typeof TICKET_TRACKERS)[number];

const NoControls = (text: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(text);
/** A status name as the tracker spells it (`In Progress`, `In Review`, `Done`). Matched without regard to case. */
export const TicketStatusNameSchema = z.string().trim().min(1).max(60).refine(NoControls, "must not contain control or invisible characters");

export const TicketStatusMapSchema = z.object({
  started: TicketStatusNameSchema.optional(),
  plan_ready: TicketStatusNameSchema.optional(),
  pr_opened: TicketStatusNameSchema.optional(),
  merged: TicketStatusNameSchema.optional(),
  closed: TicketStatusNameSchema.optional(),
}).strict();
export type TicketStatusMap = z.infer<typeof TicketStatusMapSchema>;

/**
 * A project's ticket updates.
 *   comments        post a comment at each moment (on by default: the ticket asked for the work);
 *   changeStatus    "Also change the ticket's status" (OFF by default), to the names in `statuses`.
 * A task only its owner (or a named few) can see NEVER writes to a public tracker (a GitHub issue in a repository that is not private): an owner rule, with no project switch.
 */
export const TicketUpdatesSettingsSchema = z.object({
  comments: z.boolean(),
  changeStatus: z.boolean(),
  statuses: TicketStatusMapSchema,
}).strict();
export type TicketUpdatesSettings = z.infer<typeof TicketUpdatesSettingsSchema>;

/** The statuses a ticket moves to when the switch is on and the project named none (a common Linear and Jira workflow). A moment with no name moves nothing. */
export const DEFAULT_TICKET_STATUSES: Readonly<TicketStatusMap> = { started: "In Progress", pr_opened: "In Review", merged: "Done" };

export const DEFAULT_TICKET_UPDATES: Readonly<TicketUpdatesSettings> = { comments: true, changeStatus: false, statuses: DEFAULT_TICKET_STATUSES };

/** `PUT /v1/app/projects/{project}/intake/updates`: a maintainer replaces the project's settings. */
export const TicketUpdatesPutBodySchema = z.object({ requestId: z.string().uuid(), settings: TicketUpdatesSettingsSchema }).strict();
export type TicketUpdatesPutBody = z.infer<typeof TicketUpdatesPutBodySchema>;

/** Whether Rovara can write to a tracker through the company's connection: `needs_write_access` when the last write was skipped because the connection may only read (or the tracker refused it). */
export const TicketWriteAccessViewSchema = z.object({
  tracker: z.enum(TICKET_TRACKERS),
  state: z.enum(["ok", "needs_write_access"]),
  at: z.string().datetime().optional(),
}).strict();
export type TicketWriteAccessView = z.infer<typeof TicketWriteAccessViewSchema>;

/** `GET /v1/app/projects/{project}/intake/updates`: the settings, whether the caller may change them, and each tracker's write access as last seen. */
export const TicketUpdatesViewSchema = z.object({
  settings: TicketUpdatesSettingsSchema,
  canEdit: z.boolean(),
  access: z.array(TicketWriteAccessViewSchema).max(TICKET_TRACKERS.length),
}).strict();
export type TicketUpdatesView = z.infer<typeof TicketUpdatesViewSchema>;

/** What a person reads about a tracker's write access. */
export const TICKET_WRITE_ACCESS_WORDS: Readonly<Record<TicketTracker, string>> = {
  linear: "Rovara can't comment in Linear: the company's Linear connection can only read. A company admin can give it read and write access in Connections.",
  jira: "Rovara can't comment in Jira: the company's Jira connection can only read, or Jira refused the write. A company admin can check it in Connections.",
  github: "Rovara can't comment on GitHub issues: the GitHub App isn't allowed to write issues in that repository.",
};

/** The words of one moment in a comment. */
export const TICKET_MOMENT_WORDS: Readonly<Record<TicketUpdateMoment, string>> = {
  started: "Rovara started work on this ticket",
  plan_ready: "Rovara's plan for this ticket is ready for review",
  pr_opened: "Rovara opened a pull request for this ticket",
  merged: "Rovara's pull request for this ticket was merged",
  closed: "Rovara's task for this ticket was closed",
};
