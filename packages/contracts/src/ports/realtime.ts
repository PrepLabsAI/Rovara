// The `realtime` plug-in point (a new interface; the owner decides it alone, decision 63).
//
// Realtime push tells an open page that something it shows has changed, so it reads again. It is a HINT, never the data: a notice holds a type, ids and numbers
// only. The port refuses free text (`isRealtimeNotice`), but an id-shaped token can still carry anything: putting no title, no person's words and no secret in a
// notice is the CORE's responsibility, not something the port can prove. And a page that missed one still finds the change when it next reads (a host that keeps a catch-up feed writes it
// in its own store before it publishes; that feed is core logic, not this port). So a push that is lost, late or repeated does no harm.
//
//   - `publish` sends a batch of notices, each to one audience: everyone looking at one session, everyone looking at one project, or one person. It NEVER
//     throws: an entry that could not be sent is counted in `failed` (a notice is never a reason for a task's step to fail), and it returns by the batch's
//     `deadline` whatever is still in flight.
//   - Who hears a change (the session's owner, the people a decision waits on, followers) is decided in Rovara's core before `publish`; the adapter only
//     delivers. Who may LISTEN to an audience (a person to their own, a project member to a project's) is the adapter's own sign-in check where it has
//     listeners outside the process; an in-process adapter's listeners are the install's own pages.
//
// Code's adapter is in the process (`rovara up`'s own pages listen); Cloud's adapter posts to its cloud events service, one channel per audience, keeping its
// channel names (`/<namespace>/o-<company>/<u|s|p>/<segment>`), so nothing it stores or signs changes.

/** One notice is at most this many bytes of JSON. A notice is a hint, not a document. */
export const REALTIME_NOTICE_MAX_BYTES = 1_024;
/** The most entries one `publish` takes. A caller with more sends several batches. */
export const REALTIME_BATCH_MAX = 200;

/** A notice type: dotted lower-case words (`session.updated`, `home.changed`). */
const NOTICE_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
/** A field name in a notice. */
const NOTICE_FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/u;
/** A string value in a notice: an id-shaped token (letters, digits, `_`, `-`, `.`, `:`, `#`), never free text. */
const NOTICE_TOKEN = /^[A-Za-z0-9_.:#-]{1,128}$/u;
/** An audience id: the same id-shaped token. */
const AUDIENCE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** What a page hears: a type and a few ids and numbers. */
export interface RealtimeNotice {
  readonly type: string;
  readonly [field: string]: string | number | boolean;
}

/** Who hears one notice: everyone watching a session, everyone watching a project, or one person (their home and their own pages). */
export type RealtimeAudience =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly project: string }
  | { readonly kind: "person"; readonly personId: string };

export interface RealtimeEntry {
  readonly audience: RealtimeAudience;
  readonly notice: RealtimeNotice;
}

export interface RealtimeBatch {
  /** Every entry is for this company: an adapter never sends one company's notice where another company listens. */
  readonly companyId: string;
  readonly entries: readonly RealtimeEntry[];
  /** An absolute time (Date.now milliseconds). `publish` returns by then, giving up on what is still in flight. Absent: the adapter's own limit. */
  readonly deadline?: number;
}

export interface RealtimePublishResult {
  /** Entries handed to the transport (sent is not heard: nobody may be listening). */
  readonly sent: number;
  /** Entries refused (not a notice, not an audience) or not sent (the transport failed, the deadline passed). */
  readonly failed: number;
}

export interface RealtimeCapabilities {
  /** Whether anything outside this process can listen. False for an in-process adapter (only the install's own pages hear). */
  readonly remoteListeners: boolean;
  /** The most entries the adapter sends in one request to its transport (it splits a batch itself; for information). */
  readonly entriesPerRequest: number;
}

export interface RealtimePublisher {
  readonly capabilities: RealtimeCapabilities;
  /** Never throws. */
  publish(batch: RealtimeBatch): Promise<RealtimePublishResult>;
  close?(): Promise<void> | void;
}

/** Whether a value is a notice this port carries: a dotted type, at most 16 fields, each an id-shaped string, a finite number or a boolean, within the byte limit. */
export function isRealtimeNotice(value: unknown): value is RealtimeNotice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["type"] !== "string" || !NOTICE_TYPE.test(record["type"]) || record["type"].length > 64) return false;
  const fields = Object.entries(record);
  if (fields.length > 16) return false;
  for (const [name, field] of fields) {
    if (name === "type") continue;
    if (!NOTICE_FIELD.test(name)) return false;
    if (typeof field === "string" ? !NOTICE_TOKEN.test(field) : typeof field === "number" ? !Number.isFinite(field) : typeof field !== "boolean") return false;
  }
  return new TextEncoder().encode(JSON.stringify(record)).length <= REALTIME_NOTICE_MAX_BYTES;
}

/** Whether a value is an audience this port carries. */
export function isRealtimeAudience(value: unknown): value is RealtimeAudience {
  if (typeof value !== "object" || value === null) return false;
  const audience = value as Record<string, unknown>;
  const keys = Object.keys(audience).sort().join(",");
  const id = (field: string): boolean => typeof audience[field] === "string" && AUDIENCE_ID.test(audience[field]);
  switch (audience["kind"]) {
    case "session": return keys === "kind,sessionId" && id("sessionId");
    case "project": return keys === "kind,project" && id("project");
    case "person": return keys === "kind,personId" && id("personId");
    default: return false;
  }
}

/** A stable name for an audience within its company (a map key; an adapter's own channel name is its business). */
export function realtimeAudienceKey(audience: RealtimeAudience): string {
  switch (audience.kind) {
    case "session": return `session:${audience.sessionId}`;
    case "project": return `project:${audience.project}`;
    case "person": return `person:${audience.personId}`;
  }
}
