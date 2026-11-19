// The `team-record-source` plug-in point (a new interface; the owner decides it alone, decision 63).
//
// A team record source turns what happens in ONE kind of outside system (a chat tool, a code host, a tracker, a read-only tool server) into record rows: a person's
// message, a review comment, a ticket change, each with who wrote it, how far it can be believed (`TrustClass`) and who may see it (`Audience`). The record itself
// (where rows are kept, how long, the vectors, erasure) is the hosted product's (decision 41); Code defines the two sides of the seam so a source is written once:
//
//   - `TeamRecordSource`, the adapter: what it is called in its rows (`source`), what it can do, and up to three ways in. `receive` takes one delivery the host's
//     route has already verified (a signed webhook, an event); `poll` reads a page of changes from a cursor, within a deadline; `exists` asks whether items are still
//     there (an item deleted at its source is deleted everywhere). A source never writes anywhere but the sink it is handed, and never keeps text itself.
//   - `RecordSink`, the host's write side, handed to the source on every call. Its contract (below) is what makes arrival order, repeats and deletes safe; any sink
//     must pass `tests/support/ports/record-source-conformance.ts`.
//
// The rule `record-trust.ts` already keeps: the `source` ids of the registered adapters (and of the recorders built in) are the ONLY sources whose declared audience is
// believed (`audienceForSource`); any other source's rows are visible to the project's maintainers alone.
//
// Who a source's account is (a company member, an outsider), the source's settings (on, retention, excluded accounts) and the capture switch are the adapter's own
// dependencies, given when it is made: they are the host's people and settings, not part of this seam. A source that cannot read them records nothing (fail closed).
//
// The field names are the hosted record's own (`workspaceId` is the company id), so the hosted product's taps sit behind this interface with no change to what it stores.
import { z } from "zod";
import { AudienceSchema, RecordSourceIdSchema, TrustClassSchema, minTrust, type Audience, type TrustClass } from "../record-trust.js";

/** A live only (no text kept), B process then drop (text reaches the distiller only), C raw text 30 days then distilled, D full history. */
export const RECORD_RETENTIONS = ["A", "B", "C", "D"] as const;
export const RecordRetentionSchema = z.enum(RECORD_RETENTIONS);
export type RecordRetention = z.infer<typeof RecordRetentionSchema>;

/** The most bytes of a row's text. */
export const RECORD_TEXT_MAX_BYTES = 8_192;
/** The longest link (a permalink, `sourceRef.url`) kept. */
export const RECORD_URL_MAX = 2_048;
/** The most links (permalinks) a stored row keeps; a sink keeps the first this many valid ones and drops the rest (`recordLinks`), it never refuses a draft for them. */
export const RECORD_LINKS_MAX = 20;

/** A row kind: the source's family and the event, dotted lower-case words (`chat.message`, `ticket.comment`, `codehost.review`). The hosted record narrows these to its own list. */
export const RecordKindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,30}\.[a-z][a-z0-9_]{0,40}$/u);

const ISO_INSTANT = z.string().datetime();
const ShortId = z.string().min(1).max(300);
const Scalar = z.union([z.string().max(1_000), z.number().finite(), z.boolean()]);

/** The draft of one row, as a source hands it to the sink. */
export const RecordDraftSchema = z.object({
  /** The company id (the hosted record's field name). */
  workspaceId: z.string().min(1).max(64),
  project: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u).optional(),
  repo: z.string().min(1).max(300).optional(),
  /** The adapter's `source`: the id every row and every permission snapshot of this adapter carries. */
  source: RecordSourceIdSchema,
  /** `system` names the source's instance (a chat workspace, a host, a tool server); `id` and `version` make the write idempotent. */
  sourceRef: z.object({
    system: ShortId,
    id: ShortId,
    url: z.string().url().max(RECORD_URL_MAX).optional(),
    parentId: ShortId.optional(),
    version: z.string().min(1).max(200),
    /** When this version was made (an edit's time). Absent: `occurredAt`. Versions are ordered by it, never by arrival. */
    versionAt: ISO_INSTANT.optional(),
    /** The source's own id, for asking the source again (`exists`). Absent: the same as `id`. */
    nativeId: ShortId.optional(),
    /** A per-editor change row: ONE change to the item `id` by `actor`, holding only that person's words; the change's time at the source in milliseconds. Never replaced. */
    order: z.number().int().nonnegative().optional(),
  }).strict(),
  kind: RecordKindSchema,
  occurredAt: ISO_INSTANT,
  actor: z.object({ sourceId: ShortId, developerId: z.string().min(1).max(100).optional(), trust: TrustClassSchema }).strict().optional(),
  /** The lowest trust of everything in the row. */
  trust: TrustClassSchema,
  audience: AudienceSchema,
  /** Already control-stripped and redacted by the source. Absent under retention A. */
  text: z.string().max(RECORD_TEXT_MAX_BYTES).optional(),
  structured: z.record(z.string().min(1).max(64), Scalar).optional(),
  /** Permalinks only. A sink keeps what `recordLinks` keeps (valid http(s) links of at most 2,048 characters, the first 20) and drops the rest. */
  links: z.array(z.string()),
  retention: RecordRetentionSchema,
  /** The words came from a chat tool (a row Rovara made from a thread): the chat tool's keeping rule follows the words. */
  origin: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/u).optional(),
  /** The place the item came from (`chat:T1/C9`, `tracker:project/SHOP`). A restricted audience's snapshot names it too. */
  scope: z.string().min(1).max(300).optional(),
  /** The trust of every author whose own words are in the text; the row takes the lowest. */
  pieceTrusts: z.array(TrustClassSchema).max(50).optional(),
  /** The trust of quoted or forwarded authors the source could identify; without it quoted text counts as an outsider's. */
  quotedTrusts: z.array(TrustClassSchema).max(50).optional(),
  hasAttachments: z.boolean().optional(),
}).strict();

/** The draft as a TypeScript type (written out, so a hosted type with a closed `source` and `kind` list is assignable to it). */
export interface RecordDraft {
  workspaceId: string;
  project?: string;
  repo?: string;
  source: string;
  sourceRef: { system: string; id: string; url?: string; parentId?: string; version: string; versionAt?: string; nativeId?: string; order?: number };
  kind: string;
  occurredAt: string;
  actor?: { sourceId: string; developerId?: string; trust: TrustClass };
  trust: TrustClass;
  audience: Audience;
  text?: string;
  structured?: Record<string, string | number | boolean>;
  links: string[];
  retention: RecordRetention;
  origin?: string;
  scope?: string;
  pieceTrusts?: TrustClass[];
  quotedTrusts?: TrustClass[];
  hasAttachments?: boolean;
}

export type RecordIngestOutcome = { status: "stored" | "duplicate" | "queued" } | { status: "refused"; reason: string };

export type RecordTombstoneCause = "source_deleted" | "person_erased" | "project_archived" | "excluded";

/**
 * The host's write side. CONTRACT every sink keeps (and `record-source-conformance.ts` checks):
 *  - `put` is idempotent on (workspace, source, system, id, version): a repeat answers `duplicate` (or `queued` for a sink that queues every call);
 *  - a `put` of a NEW version of an item replaces the earlier versions' text: words a person edited away are not kept;
 *  - versions are ordered by `sourceRef.versionAt ?? occurredAt`, not by arrival: a `put` older than the stored version answers `duplicate` and changes nothing;
 *  - a draft whose `sourceRef.order` is set is a per-editor change row: it replaces nothing and is replaced by nothing;
 *  - a tombstone hides at once, and is STICKY: a later `put` for a tombstoned (workspace, system, id) is refused, so a delete that arrives before its put never
 *    brings the text back;
 *  - a scope tombstone for cause `source_deleted` or `excluded` CLOSES the place: what is in it is hidden, and every later `put` in it or in a place under it is refused
 *    (a deleted channel or repository never fills again from a late retry or a backfill). Causes `person_erased` and `project_archived` hide without closing;
 *  - a scope matches itself and every scope under it (`chat:T1` covers `chat:T1/C9`, not `chat:T10`). A draft's place is its restricted snapshot's scope, else `scope`
 *    (`recordDraftScope`);
 *  - the stored trust is never higher than the lowest of the draft's trust, its actor's and its pieces' (the sink lowers it; it never raises it);
 *  - under retention A or B no text is kept: the sink stores the row without its text, or does not store it (refused). B text reaches the distiller only
 *    through `distillTransient`;
 *  - links are trimmed to what `recordLinks` keeps, never a reason to refuse;
 *  - a draft that is not a `RecordDraftSchema` draft is refused.
 */
export interface RecordSink {
  put(draft: RecordDraft): Promise<RecordIngestOutcome>;
  /** Hides at once and deletes rows (and what was derived from them). `sourceIds` limits it to those items; `scope` takes everything in that scope. */
  tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: RecordTombstoneCause }): Promise<{ hidden: number }>;
  /** Join and leave events for a private place: only the principals change. */
  changePrincipals(input: { workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<void>;
  /** A place that became private or public: every row of the scope takes the new audience. */
  replaceScopeAudience(input: { workspaceId: string; scope: string; audience: Audience; at: string }): Promise<void>;
  /**
   * Retention B (process then drop): the text is handed to the host's distiller in memory, after the same checks a stored row passes (a deleted item, a closed place),
   * and no row with text is stored. Optional: a sink without it accepts no B text (a source then records the draft without its text, or nothing).
   */
  distillTransient?(draft: RecordDraft & { text: string }): Promise<{ accepted: boolean }>;
  /** Seeds the place's access record from its full, freshly read member list (nothing when already seeded). Optional. */
  ensureAccessSeed?(input: { workspaceId: string; scope: string; read: () => Promise<Audience | undefined> }): Promise<void>;
}

export interface TeamRecordSourceCapabilities {
  /** How the source hears of changes: a delivery the host's route verified (`push`), a read from a cursor (`poll`), or both. */
  readonly delivery: readonly ("push" | "poll")[];
  /** `exists` can say whether items are still at the source. */
  readonly existence: boolean;
  /** Where its permission snapshots come from: each item's own list (`item`), the place's member list (`place`), or none (rows take the source's configured default). */
  readonly acl: "item" | "place" | "none";
  /** The retentions this source can honour (a source that cannot drop text after processing does not list B). */
  readonly retentions: readonly RecordRetention[];
}

/** What one delivery or poll did, counted (never the text). A write the sink could not take is `failed`, never counted as written: the host redelivers or polls again. */
export interface RecordWriteCounts {
  written: number;
  duplicates: number;
  refused: number;
  failed: number;
}

export interface RecordReceiveOutcome extends RecordWriteCounts {
  /** `recorded`: the sink was called. `ignored`: nothing to record (an event this source does not record, a source switched off). */
  status: "recorded" | "ignored";
  /** A fixed word for why it was ignored. */
  reason?: string;
}

export interface RecordPollRequest {
  workspaceId: string;
  /** The place to read (the source's own scope of a configured source). */
  scope: string;
  /** Where the last poll stopped. Absent: from the start of what the source keeps (or its own backfill limit). */
  cursor?: string;
  /** The most items to read this time. */
  limit: number;
  /** An absolute time (Date.now milliseconds) the poll stops by, keeping its cursor at the last item it recorded. */
  deadline: number;
}

export interface RecordPollOutcome extends RecordWriteCounts {
  /** Where the next poll starts. Absent: no change (poll again from the same cursor). */
  cursor?: string;
  /** True when the poll reached the end of what there is now. */
  done: boolean;
}

/** `forbidden`: the source refused the credential or the item; it is never read as `missing` (many sources hide what a credential may not see). */
export type RecordExistence = "exists" | "missing" | "forbidden" | "unknown";

export type TeamRecordSourceErrorCode = "refused" | "unavailable";

export class TeamRecordSourceError extends Error {
  constructor(readonly code: TeamRecordSourceErrorCode, message: string) {
    super(message);
    this.name = "TeamRecordSourceError";
  }
  get retryable(): boolean {
    return this.code === "unavailable";
  }
}

export interface TeamRecordSource {
  /** The id its rows and permission snapshots carry (`chat`, `codehost:<name>`): a `RecordSourceIdSchema` id. */
  readonly source: string;
  readonly capabilities: TeamRecordSourceCapabilities;
  /** One delivery the host's route already verified. Throws `TeamRecordSourceError` (`unavailable` when the sink or a lookup could not be reached: the host redelivers). */
  receive?(payload: unknown, sink: RecordSink): Promise<RecordReceiveOutcome>;
  /** Reads changes from `cursor`, writing each to the sink. Throws `TeamRecordSourceError`. */
  poll?(request: RecordPollRequest, sink: RecordSink): Promise<RecordPollOutcome>;
  /** Whether these items are still at the source, by their native ids. A missing answer for an id reads as `unknown`. */
  exists?(request: { workspaceId: string; system: string; nativeIds: readonly string[]; deadline?: number }): Promise<ReadonlyMap<string, RecordExistence>>;
  close?(): Promise<void> | void;
}

/** The dedupe key of a write: the source item and its version. */
export function recordIdempotencyKey(draft: Pick<RecordDraft, "workspaceId" | "source" | "sourceRef">): string {
  return `${draft.workspaceId}|${draft.source}|${draft.sourceRef.system}|${draft.sourceRef.id}|${draft.sourceRef.version}`;
}

/** Whether a scope is `parent` or lies under it (`chat:T1` covers `chat:T1/C9`, not `chat:T10`). */
export function recordScopeCovers(parent: string, scope: string): boolean {
  return scope === parent || scope.startsWith(`${parent}/`);
}

/** A draft's place: its restricted snapshot's scope, else its `scope` (the hosted record's rule). */
export function recordDraftScope(draft: Pick<RecordDraft, "audience" | "scope">): string | undefined {
  return draft.audience.kind === "restricted" ? draft.audience.acl.scope : draft.scope;
}

/** The links a stored row keeps: http(s) links of at most `RECORD_URL_MAX` characters with no credentials, the first `RECORD_LINKS_MAX` of them. */
export function recordLinks(links: readonly string[]): string[] {
  return links.filter((link) => {
    if (link.length > RECORD_URL_MAX) return false;
    try {
      const url = new URL(link);
      return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }).slice(0, RECORD_LINKS_MAX);
}

/** The lowest of the draft's own trust, its actor's and its pieces' (what a source must already have said). */
const ownPartsTrust = (draft: Pick<RecordDraft, "trust" | "actor" | "pieceTrusts">): TrustClass =>
  minTrust(draft.trust, ...(draft.actor === undefined ? [] : [draft.actor.trust]), ...(draft.pieceTrusts ?? []));

/**
 * The trust a stored row gets (the hosted record's rule): the lowest of the draft's own, its actor's, its pieces' and its quoted authors' (`quotedTrusts`), and at most
 * `system` for text from an outside source with no actor (nobody vouches for it). Rovara's own rows (`source: "rovara"`) are not capped.
 */
export function recordStoredTrust(draft: Pick<RecordDraft, "trust" | "actor" | "pieceTrusts" | "quotedTrusts" | "source" | "text">): TrustClass {
  return minTrust(
    ownPartsTrust(draft),
    ...(draft.quotedTrusts ?? []),
    ...(draft.actor === undefined && draft.source !== "rovara" && draft.text !== undefined ? ["system" as const] : []),
  );
}

/** Why a SINK must refuse a draft, in a fixed sentence, or `undefined`: it is not a `RecordDraftSchema` draft, or its text is over the byte limit. Everything else a sink repairs (trust, text under A or B, links). */
export function recordDraftRefusal(draft: unknown): string | undefined {
  const parsed = RecordDraftSchema.safeParse(draft);
  if (!parsed.success) return "not a record draft";
  if (parsed.data.text !== undefined && new TextEncoder().encode(parsed.data.text).length > RECORD_TEXT_MAX_BYTES) return "the text is too long";
  return undefined;
}

/**
 * What a SOURCE must not write, in a fixed sentence, or `undefined` (the source conformance suite checks every draft with it): anything a sink refuses, text under
 * retention A, a restricted snapshot naming another source, or a row trust above its actor's or a piece's. (Text under B is allowed: it goes to `distillTransient`.)
 */
export function recordSourceDraftProblem(draft: unknown): string | undefined {
  const refusal = recordDraftRefusal(draft);
  if (refusal !== undefined) return refusal;
  const row = draft as RecordDraft;
  if (row.text !== undefined && row.retention === "A") return "retention A keeps no text";
  if (row.audience.kind === "restricted" && row.audience.acl.source !== row.source) return "the permission snapshot names another source";
  if (ownPartsTrust(row) !== row.trust) return "the row's trust is higher than one of its parts";
  return undefined;
}
