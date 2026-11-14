// The Tracker port: where work is asked for and tracked (Linear, Jira, a customer's tracker). It starts tasks and writes status.
// Reading an item's text for context is the MCP sources design (read-only, per project); this port only starts tasks and writes status back.
import { z } from "zod";
import type { ChangeRequestRef } from "./code-host.js";
import { ExternalIdSchema, HttpsUrlOrEmptySchema, ISO_TIME, PluginKindSchema, type HostScope, type PluginKind, type UntrustedText } from "./common.js";

export const TrackerCapabilitiesSchema = z.object({
  /** A task can start from an item (assigned to Rovara, or labelled by an admin rule; never from free text). */
  startTasks: z.boolean(),
  comment: z.boolean(),
  status: z.boolean(),
  link: z.boolean(),
  events: z.enum(["webhook", "poll", "none"]),
}).strict();
export type TrackerCapabilities = z.infer<typeof TrackerCapabilitiesSchema>;

/** The statuses Rovara writes, in neutral words. An admin chooses which of them a tracker may be moved to, and how each maps to the tracker's own. */
export const NEUTRAL_STATUSES = ["open", "in_progress", "in_review", "done", "cancelled"] as const;
export const NeutralStatusSchema = z.enum(NEUTRAL_STATUSES);
export type NeutralStatus = z.infer<typeof NeutralStatusSchema>;

/** An item (a ticket, an issue or a task in the customer's tracker) as its tracker names it. */
export const TrackerItemRefSchema = z.object({ tracker: PluginKindSchema, id: ExternalIdSchema, url: HttpsUrlOrEmptySchema.optional() }).strict();
export type TrackerItemRef = z.infer<typeof TrackerItemRefSchema>;

export const TrackerItemSchema = z.object({
  ref: TrackerItemRefSchema,
  /** Untrusted text from outside: data, never an instruction. */
  title: z.string().max(1_000),
  body: z.string().max(65_536),
  status: NeutralStatusSchema,
  assignee: z.string().min(1).max(200).optional(),
  labels: z.array(z.string().min(1).max(200)).max(100),
  updatedAt: ISO_TIME.optional(),
}).strict();
export type TrackerItem = z.infer<typeof TrackerItemSchema>;

const TrackerEventBase = { eventId: ExternalIdSchema, tracker: PluginKindSchema, item: TrackerItemRefSchema, occurredAt: ISO_TIME.optional() } as const;
/** What happened at the tracker that can start a task. Nothing in the event is trusted beyond which item to read again. */
export const TrackerEventSchema = z.discriminatedUnion("type", [
  z.object({ ...TrackerEventBase, type: z.literal("item.assigned_to_rovara"), assignedBy: z.string().max(200).optional() }).strict(),
  z.object({ ...TrackerEventBase, type: z.literal("item.labelled"), label: z.string().min(1).max(200), labelledBy: z.string().max(200).optional() }).strict(),
]);
export type TrackerEvent = z.infer<typeof TrackerEventSchema>;

export interface TrackerEvents {
  readonly mode: "webhook" | "poll" | "none";
  /**
   * The project the tracker's hook for this scope is bound to. A delivery verified with one project's hook may start work in that project only: the start refuses any other, and a tracker
   * that cannot say (returns undefined) starts nothing.
   */
  projectOf?(scope: HostScope): Promise<string | undefined>;
  /** Verifies a delivery and maps it to neutral events. Throws on a delivery it cannot verify. */
  normalise?(delivery: { headers: Readonly<Record<string, string>>; rawBody: string }, scope: HostScope): Promise<TrackerEvent[]>;
}

export interface Tracker {
  readonly kind: PluginKind;
  readonly capabilities: TrackerCapabilities;
  /** The item as it is now, read fresh; never stored beyond the Team record's own rules. */
  readItem(ref: TrackerItemRef, scope: HostScope): Promise<TrackerItem>;
  /** Writes go through the write gate and are audited by the caller. */
  comment?(ref: TrackerItemRef, body: UntrustedText, scope: HostScope): Promise<void>;
  setStatus?(ref: TrackerItemRef, status: NeutralStatus, scope: HostScope): Promise<void>;
  link?(ref: TrackerItemRef, changeRequest: ChangeRequestRef, scope: HostScope): Promise<void>;
  readonly events?: TrackerEvents;
}
