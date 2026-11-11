// The Tracker port: where work is asked for and tracked (Linear, Jira, a customer's tracker). It starts tasks and writes status.
// Reading an item's text for context is the MCP sources design (read-only, per project); this port only starts tasks and writes status back.
import { z } from "zod";
import type { ChangeRequestRef } from "./code-host.js";
import type { EventSourceRegistration } from "../open-ids.js";
import type { SubjectCommentsPage } from "./comment-source.js";
import { ExternalIdSchema, HttpsUrlOrEmptySchema, ISO_TIME, PluginKindSchema, type HostScope, type PluginKind, type UntrustedText } from "./common.js";
import type { ExternalAccountRef } from "../ports/policy.js";

export const TrackerCapabilitiesSchema = z.object({
  /** A task can start from an item (assigned to Rovara, or labelled by an admin rule; never from free text). */
  startTasks: z.boolean(),
  comment: z.boolean(),
  status: z.boolean(),
  link: z.boolean(),
  events: z.enum(["webhook", "poll", "none"]),
  /** The tracker can be asked what is asked for now in a place (`Tracker.askedFor`), so a laptop with no webhook can start tasks from it. Absent: no. */
  intake: z.boolean().optional(),
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

// ---- intake by asking (a poll), and the writes that go back

/** What a tracker is asked when it is polled: the places a project named, in neutral words. */
export interface TrackerAskedQuery {
  /** What asks for work: a label someone puts on a ticket, or the ticket being assigned to Rovara's own account on that tracker. At least one is set. */
  when: { label?: string | undefined; assignedToRovara?: true | undefined };
  /** Which of the install's connections to this tracker to read through, when it has several (a name, never an address or a secret). */
  connection?: string | undefined;
  /** The most items to hand back; more are cut. */
  limit: number;
  /** The read stops when this aborts. */
  signal: AbortSignal;
}

/** Who made the act that asked for work, as the tracker's own history says. Only an `account` the identity port knows can ever make a person a member. */
export interface TrackerActor {
  kind: "person" | "bot" | "rovara" | "unknown";
  /** The neutral outside-account shape: the tracker's id for itself, the workspace or site the account lives in (empty when it has none), and the tracker's own id for the account. Never an email or a name. */
  account?: ExternalAccountRef | undefined;
  display?: string | undefined;
}

/** One ticket that asks for work. Every text in it is the tracker's (and its writers'): data, never an instruction. */
export interface TrackerAskedItem {
  ref: TrackerItemRef;
  title: string;
  body: string;
  /** Who wrote the ticket (a display name). */
  reporter?: string | undefined;
  /** Who made the act that asks for work. Absent when the tracker's history does not say: the ticket then waits for the owner. */
  actor?: TrackerActor | undefined;
  /** When the act was made, from the tracker's own history (an ISO time): the windows in which Rovara's own writes are told from a person's are measured from it, not from the time of the poll. */
  occurredAt?: string | undefined;
  /** The tracker's own change-log entry that made the act, as the tracker read it from its history (not a sender's word). */
  change?: { id: string; act: { kind: "label" | "assignee"; value: string } } | undefined;
  /** Other spellings of the item's id (a Jira issue has a key and a numeric id). */
  alternateIds?: readonly string[] | undefined;
}

/** The fixed codes a failing read is recorded under (`INTAKE_SOURCE_ERROR_WORDS` says them in words). Never the tracker's own words. */
export type TrackerSearchCode = "CONNECTION_MISSING" | "CONNECTION_AMBIGUOUS" | "CONNECTION_REFUSED" | "RATE_LIMITED" | "SEARCH_FAILED";

export class TrackerSearchError extends Error {
  constructor(readonly code: TrackerSearchCode) {
    super(code);
    this.name = "TrackerSearchError";
  }
}

/** What a tracker's write refused for (a refusal that will not pass by itself), in fixed words. A rate limit or a fault that may pass is thrown as an `AgentXError` instead. */
export type TrackerWriteRefusal = "needs_write_access" | "not_found" | "no_such_status" | "not_connected";

export class TrackerWriteRefusedError extends Error {
  constructor(readonly reason: TrackerWriteRefusal) {
    super(reason);
    this.name = "TrackerWriteRefusedError";
  }
}

/** How a comment is posted: `key` names it, so the same key again is the same comment (a retry is never a second post); `requirePrivate` keeps it from customers where the tracker can tell (an internal comment). */
export interface TrackerCommentOptions {
  key?: string | undefined;
  requirePrivate?: boolean | undefined;
}

export interface Tracker {
  readonly kind: PluginKind;
  readonly capabilities: TrackerCapabilities;
  /** The item as it is now, read fresh; never stored beyond the Team record's own rules. */
  readItem(ref: TrackerItemRef, scope: HostScope): Promise<TrackerItem>;
  /** Writes go through the write gate and are audited by the caller. */
  comment?(ref: TrackerItemRef, body: UntrustedText, scope: HostScope, options?: TrackerCommentOptions): Promise<void>;
  setStatus?(ref: TrackerItemRef, status: NeutralStatus, scope: HostScope): Promise<void>;
  /**
   * Optional: moves the item to the status the tracker calls `name` (a project's own words: "In Review"), matched without regard to case. "moved" when it is there now; "no_such_status" when the tracker has no such
   * status for this item. A refusal (no write access, no such item) is a `TrackerWriteRefusedError`.
   */
  setStatusByName?(ref: TrackerItemRef, name: string, scope: HostScope): Promise<"moved" | "no_such_status">;
  /**
   * Optional: what is asked for now in a place, oldest change last, at most `query.limit`, with who made the act from the tracker's own history. The poll calls it on a timer (`capabilities.intake`). A failure is a
   * `TrackerSearchError` with one of the fixed codes; any other throw is read as `SEARCH_FAILED`.
   */
  askedFor?(query: TrackerAskedQuery, scope: HostScope): Promise<readonly TrackerAskedItem[]>;
  link?(ref: TrackerItemRef, changeRequest: ChangeRequestRef, scope: HostScope): Promise<void>;
  readonly events?: TrackerEvents;
  /**
   * Optional (port lane P6, item E1; interface only, nothing reads it yet): the comments on an item, oldest first, created or edited since `since`, 100 a page. FETCH ONLY, like `CodeHost.comments`
   * (decision 66): the adapter says what was written, by whom, when and on which item; whether it is a command and whether its author may give one is decided in Rovara's core. An adapter without it has no
   * comment commands on its items.
   */
  comments?(ref: TrackerItemRef, options: { since?: string; page?: number }, scope: HostScope): Promise<SubjectCommentsPage>;
  /**
   * Optional (port lane P6, item E1): the event types this tracker can start work from, and the keys a trigger may filter each on. The source id is this tracker's `kind`. A tracker registers here instead
   * of being added to the fixed `EVENT_SOURCES` list, which takes no new entry (owner decision 62). See `open-ids.ts`.
   */
  readonly eventSource?: EventSourceRegistration;
}
