// The Linear Tracker adapter (Cloud's P9, ported in lane L2):
//   - `comment`  posts through the `LinearReplyPort` (the way an Ask's answer reaches Linear);
//   - `events`   verifies a delivery (the `Linear-Signature` HMAC, the hook's own Linear organization and team) and maps the issue it carries (`webhook.ts`);
//   - key rules  are `normalizeIssueKey`'s: an item id is an issue key, never free text.
// What Linear does not have is left out rather than invented: there is no status write (Linear closes an issue itself when a pull request that says "Fixes <KEY>" merges) and no link write,
// so `setStatus` and `link` are absent and the capabilities say so. Reading an issue needs a read of Linear that the install gives as `readIssue` (this port only reads an item fresh), and
// without it `readItem` refuses with a fixed sentence.
//
// Linear's trigger source (work started by the payer rules of an assignment) is NOT moved onto this adapter; the neutral start is a member's act (Cloud's intake engine, a later lane).
import { createHash } from "node:crypto";
import {
  agentXError, HostScopeSchema, TrackerEventSchema, TrackerItemSchema,
  type HostScope, type NeutralStatus, type RawDelivery, type Tracker, type TrackerCapabilities, type TrackerEvent, type TrackerEvents, type TrackerItem,
  type TrackerItemRef, type UntrustedText,
} from "@agentx/contracts";
import { linearIssueCreated, normalizeIssueKey, verifyLinearSignature, type LinearHook } from "./webhook.js";

/** The company a call speaks for (Cloud calls it an organization id): the `orgId` of an organization scope. */
type OrgId = Extract<HostScope, { orgId: string }>["orgId"];

/** Posts a comment on a Linear issue as the install's own account. The hosted product's port has more methods (rewrite and delete of its own comments); the adapter uses `reply` only. */
export interface LinearReplyPort {
  /** Posts the comment. `commentKey` is a stable name for it: the same key again is the same comment (a retry is never a second post). */
  reply(input: { orgId: OrgId; issueKey: string; text: string; commentKey?: string | undefined; workspace?: string | undefined }): Promise<{ commentId: string; workspace?: string | undefined } | void>;
}

export const LINEAR_TRACKER_KIND = "linear";

/** A delivery is read whole, so it is held to a size (Linear's issue webhooks are a few kilobytes). */
const MAX_DELIVERY_BYTES = 1_048_576;
const COMMENT_MAX_CHARS = 65_536;

/** Linear's workflow state types (`state.type` on an issue). */
export type LinearStateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** An issue as the install's read of Linear returns it. Every text in it is Linear's (and the people's who wrote it): data, never an instruction. */
export interface LinearIssueRead {
  /** The issue's key (`ENG-142`). */
  key: string;
  title: string;
  description: string;
  stateType: LinearStateType;
  /** Linear's name for the assignee (a display name), when there is one. */
  assignee?: string | undefined;
  labels: readonly string[];
  /** The issue's link on linear.app. */
  url: string;
  updatedAt?: string | undefined;
}

export interface LinearTrackerAccess {
  /** How Rovara writes a comment in Linear (the existing port). Absent: the adapter has no `comment`. */
  reply?: LinearReplyPort | undefined;
  /** The issue as Linear has it now. Absent: `readItem` refuses (the adapter reads nothing it was not given a way to read). */
  readIssue?: ((orgId: OrgId, key: string) => Promise<LinearIssueRead | undefined>) | undefined;
  /** The Linear hook (its tenant and signing secret) a delivery under this scope belongs to. Absent: the adapter accepts no delivery. */
  hook?: ((scope: HostScope) => Promise<{ hook: LinearHook; secret: string } | undefined>) | undefined;
  /** The organization an install's system scope speaks for (a single-company install has exactly one). Absent: a system scope has no organization, so nothing is written or read for it. */
  installOrg?: (() => OrgId | undefined) | undefined;
}

const NEUTRAL_STATUS_OF: Readonly<Record<LinearStateType, NeutralStatus>> = {
  triage: "open", backlog: "open", unstarted: "open", started: "in_progress", completed: "done", canceled: "cancelled",
};

export const LINEAR_NO_READ_MESSAGE = "Reading Linear issues is not set up in this install.";
export const LINEAR_NO_REPLY_MESSAGE = "Writing in Linear is not set up in this install.";
export const LINEAR_NO_ORG_MESSAGE = "The Linear call has no organization to act for.";

function checkedScope(scope: HostScope): HostScope {
  const parsed = HostScopeSchema.safeParse(scope);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
  return parsed.data;
}

/** The issue key an item ref names. A ref of another tracker, or an id that is not an issue key, is refused (the key is never taken from free text). */
function keyOf(ref: TrackerItemRef): string {
  if (ref.tracker !== LINEAR_TRACKER_KIND) throw agentXError("CONFIG_INVALID", "the item belongs to another tracker");
  const key = normalizeIssueKey(ref.id);
  if (key === undefined) throw agentXError("CONFIG_INVALID", "the item id is not a Linear issue key");
  return key;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/** The https link on linear.app, or undefined (a link that is not Linear's is dropped, never passed on). */
function linearLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "linear.app" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The ids of an event are one short line each: a label is hashed into its event's id so a long or odd label cannot break the id's bounds. */
const labelEventId = (eventKey: string, label: string): string => `${eventKey.slice(0, 150)}:label:${createHash("sha256").update(label, "utf8").digest("hex").slice(0, 16)}`;

function linearEvents(access: LinearTrackerAccess): TrackerEvents {
  return {
    mode: "webhook",
    projectOf: async (scope: HostScope): Promise<string | undefined> => (await access.hook?.(checkedScope(scope)))?.hook.project,
    normalise: async (delivery: RawDelivery, scope: HostScope): Promise<TrackerEvent[]> => {
      const checked = checkedScope(scope);
      const configured = await access.hook?.(checked);
      if (configured === undefined) throw agentXError("CONFIG_INVALID", "no Linear hook is set up for this call");
      const raw = Buffer.from(delivery.rawBody, "utf8");
      if (raw.byteLength > MAX_DELIVERY_BYTES) throw agentXError("CONFIG_INVALID", "the delivery is too large");
      // The signature is over the raw bytes, and nothing is parsed before it holds.
      if (!verifyLinearSignature(raw, delivery.headers, configured.secret)) throw agentXError("CALLBACK_FORBIDDEN", "the delivery's signature does not verify");
      let body: unknown;
      try {
        body = JSON.parse(delivery.rawBody);
      } catch {
        throw agentXError("CONFIG_INVALID", "the delivery is not JSON");
      }
      const normalized = linearIssueCreated(body, configured.hook);
      if ("tenantMismatch" in normalized) throw agentXError("CALLBACK_FORBIDDEN", "the delivery is not for this install's Linear workspace");
      if ("ignored" in normalized) return [];
      const events: TrackerEvent[] = [];
      for (const event of normalized.events) {
        const key = normalizeIssueKey(event.identifier);
        if (key === undefined) continue;
        const url = event.url === undefined ? undefined : linearLink(event.url);
        const item = { tracker: LINEAR_TRACKER_KIND, id: key, ...(url === undefined ? {} : { url }) };
        // An issue created carrying a label is the issue labelled with it: the label is what an admin's rule reads (never the title or the text).
        for (const label of new Set(event.labels)) {
          events.push(TrackerEventSchema.parse({
            eventId: labelEventId(event.eventKey, label), tracker: LINEAR_TRACKER_KIND, item, type: "item.labelled", label: cut(label, 200),
            ...(event.actorId === undefined ? {} : { labelledBy: cut(event.actorId, 200) }),
            occurredAt: event.occurredAt,
          }));
        }
      }
      return events;
    },
  };
}

/**
 * The Linear tracker over the existing Linear code. `access` is what the install gives it; whatever it does not give, the adapter does not do (and says so in its capabilities).
 */
export function linearTracker(access: LinearTrackerAccess = {}): Tracker {
  const orgOf = (scope: HostScope): OrgId => {
    const checked = checkedScope(scope);
    const orgId = "orgId" in checked ? checked.orgId : access.installOrg?.();
    if (orgId === undefined) throw agentXError("CONFIG_INVALID", LINEAR_NO_ORG_MESSAGE);
    return orgId;
  };
  const capabilities: TrackerCapabilities = {
    startTasks: true, comment: access.reply !== undefined, status: false, link: false, events: access.hook !== undefined ? "webhook" : "none",
  };
  const tracker: Tracker = {
    kind: LINEAR_TRACKER_KIND,
    capabilities,
    async readItem(ref: TrackerItemRef, scope: HostScope): Promise<TrackerItem> {
      const orgId = orgOf(scope);
      const key = keyOf(ref);
      if (access.readIssue === undefined) throw agentXError("RUNTIME_UNAVAILABLE", LINEAR_NO_READ_MESSAGE);
      const issue = await access.readIssue(orgId, key);
      // An answer for another issue than the one asked about is no answer.
      if (issue === undefined || normalizeIssueKey(issue.key) !== key) throw agentXError("RUNTIME_UNAVAILABLE", "the tracker has no such item");
      const link = linearLink(issue.url);
      return TrackerItemSchema.parse({
        ref: { tracker: LINEAR_TRACKER_KIND, id: key, ...(link === undefined ? {} : { url: link }) },
        title: cut(issue.title, 1_000), body: cut(issue.description, 65_536), status: NEUTRAL_STATUS_OF[issue.stateType],
        ...(issue.assignee === undefined || issue.assignee === "" ? {} : { assignee: cut(issue.assignee, 200) }),
        labels: [...issue.labels].filter((label) => label !== "").slice(0, 100).map((label) => cut(label, 200)),
        ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
      });
    },
    ...(access.hook === undefined ? {} : { events: linearEvents(access) }),
  };
  if (access.reply !== undefined) {
    const reply = access.reply;
    tracker.comment = async (ref: TrackerItemRef, body: UntrustedText, scope: HostScope): Promise<void> => {
      const orgId = orgOf(scope);
      const key = keyOf(ref);
      if (body.length === 0 || body.length > COMMENT_MAX_CHARS) throw agentXError("CONFIG_INVALID", "the comment is empty or too long");
      await reply.reply({ orgId, issueKey: key, text: body });
    };
  }
  return tracker;
}
