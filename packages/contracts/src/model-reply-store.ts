// TE-R1 part A (M2, release 0.5.19; DECISIONS 166a, 161, 150, 152c): the Rovara-side reply-set store, the SHAPES and the KEY LAYOUT. TE-G7 extends this layout; it does not replace it.
//
// What the store holds: for each (company, project, branch, family) an ordered set of scripted model replies, each with its content hash (`entrySha256`, F2-A's `modelReplyEntrySha256`), its `provenance`
// (`before_task`, `independent`, `task_made`) and, for `before_task` only, its `origin`. THE ONE RULE: a reply's provenance is written once, by Rovara-side code, and never changes. `task_made` stays `task_made`
// after a merge; `independent` stays `independent`; nothing is promoted because it now sits on a base commit. The coding agent's files never say where a reply came from (F2-A's file form has no provenance key).
//
// Layout, in the document store (no new port: the store is a service over `DocumentStore`, and Cloud keeps the same keys in its state table):
//   partition  ORG#<company>#MOCKSET#<project>               (`MOCKSET` is the generic partition: record kind `MOCKSET`, owner Cloud for hosted rows, DECISIONS 152c)
//   HEAD#model#<sha256(branch)>#<family>   this lane's head: the ordered entries and their provenance (the branch name is a FIELD, never put raw in a key)
//   ENTRY#<entrySha256>                    one reply body, content-addressed and immutable, shared by every branch of the project (no provenance on it: provenance lives in the head)
//   TASK#<taskId>#<family>                 the task's overlay: replies made in this task, not yet joined (expires)
//   JOIN#<taskId>#<family>                 the idempotency marker of a join (expires)
//   MADE#<entrySha256>                     the DURABLE record that the coding agent wrote this content in some task (never expires; only `eraseProject` removes it). An import never turns a hash listed here into
//                                          `before_task`, whatever became of the overlay (expiry, delete, a join that failed, a refused late write). Each reply is recorded twice: `MADE#<entrySha256>` and `MADE#c#<contentSha256>` (a hash that
//                                          ignores the id and treats an absent `toolCalls` like an empty one). `MADE#version` is the project's counter (a `version` bumped, and a `count` of rows added, in the same transaction as every MADE
//                                          write), so an import can check it and cannot race an overlay write; at `REPLY_MADE_MAX_PER_PROJECT` rows a putOverlay and an import are refused with `made_full`.
//   ERASED#project                         the content-free tombstone `eraseProject` leaves when it deleted something (only a time). Until a maintainer clears it (`clearErasure`) no import into the project is accepted (`erased`):
//                                          the MADE record is gone, so nothing could tell agent-made replies from customer-written ones. It is not one of the prefixes erase deletes.
// TE-G7 adds `HEAD#service#<name>...` and its own entry kinds under the same partition without migrating a row; this lane's reads and erase look only at the five prefixes above and ignore every other sort key.
// TE-G7 MUST NOT reuse the prefixes `ENTRY#`, `MADE#`, `TASK#`, `JOIN#`, `ERASED#` or `HEAD#model#` (a row of its own under one of them would be read, parsed as this lane's kind, refused, and make an import fail closed).
//
// PURE: no I/O. The rules (`model-reply-store-rules.ts`) and the service (`packages/broker/src/core/test-env/reply-set-store.ts`) are built on these shapes.
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import type { HostScope } from "./plugins/common.js";
import { companyScoped } from "./ports/company-scope.js";
import { ModelReplyMatchSchema, ModelReplyResponseSchema, type ModelReplyFileEntry, type ModelReplySet, type ModelReplySetFile, type ReplyProvenanceDecision, type IndependentReplyDecision } from "./model-reply-set.js";
import { BEFORE_TASK_ORIGINS, REPLY_PROVENANCES, type BeforeTaskOrigin, type ReplyProvenance } from "./model-reply-provenance.js";
import { SERVED_MODEL_FAMILIES, type ServedModelFamily } from "./model-served-family.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const REPLY_SET_HEAD_KIND = "model_replies";
export const REPLY_SET_HEAD_VERSION = 1;
/** Entries in one head (tighter than the file form's 2,000, so a head stays under `DOCUMENT_STORE_LIMITS.maxDocumentBytes`; a test measures the worst case). */
export const REPLY_SET_HEAD_MAX_ENTRIES = 1_000;
/** A stored reply body (compact JSON). A larger one is served for the task but never stored and never counted. */
export const REPLY_ENTRY_BODY_MAX_BYTES = 256 * 1_024;
/** Capped real recordings: at most this many per (project, family) and this many bytes each (DECISIONS 161: "a few capped real recordings"). */
export const REAL_RECORDING_MAX_PER_FAMILY = 25;
export const REAL_RECORDING_MAX_BYTES = 64 * 1_024;
/** An overlay and a join marker are deleted this long after they were written (the TTL attribute is `INDEX_EXPIRY_ATTRIBUTE`, `indexExpiresAt`; set by the service, never by these shapes). */
export const REPLY_OVERLAY_TTL_DAYS = 30;
export const REPLY_OVERLAY_MAX_ENTRIES = REPLY_SET_HEAD_MAX_ENTRIES;
/** MADE# rows (both kinds) one project may hold. Reached: putOverlay and imports are refused with `made_full` (fail closed). */
export const REPLY_MADE_MAX_PER_PROJECT = 20_000;

/** The fixed words of every refusal (code, never data). `not_found` is the one text for a missing set, another company's and another project's. */
export const REPLY_STORE_WORDS = {
  not_found: "reply set not found",
  too_large: "reply too large",
  too_many: "too many replies",
  conflict: "reply set changed, try again",
  id_clash: "reply id clash",
  erased: "project was erased",
  made_full: "too many recorded replies",
  not_allowed: "not allowed",
} as const;
export type ReplyStoreWord = keyof typeof REPLY_STORE_WORDS;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const CommitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const Revision = z.number().int().min(0).max(1_000_000_000);

/** A project's name, as every project name is. */
export const ReplyStoreProjectSchema = z.string().regex(AGENTX_NAME_PATTERN);
/** A branch name: free text, bounded, no control characters. It is hashed into the key and kept as a field. */
export const ReplyStoreBranchSchema = z.string().min(1).max(255).refine((branch) => !/\p{Cc}/u.test(branch), "no control characters");
/** A task id: a plain token of at most 64 characters, no `#` and no white space, so it can sit inside a sort key (64 keeps a full head, 1,000 entries each with an addedBy, under the 400 KB document limit: measured). */
export const ReplyStoreTaskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u);
export const ReplyStoreFamilySchema = z.enum(SERVED_MODEL_FAMILIES);

/**
 * A reply id, spelled as F2-A's file form spells it (`model-reply-set.ts` keeps its own copy private; a test pins that the two accept and refuse the same ids, so this cannot drift).
 */
export const ReplyStoreReplyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/u).refine((id) => id !== "__proto__", "a plain id");
/** `{id, match, response}` and nothing else (F2-A's file-form reply): no provenance, so one body can sit under two branches with the same or a different provenance. At most 256 KiB as compact JSON. */
export const ReplySetEntryBodySchema = z
  .object({ id: ReplyStoreReplyIdSchema, match: ModelReplyMatchSchema, response: ModelReplyResponseSchema })
  .strict()
  .refine((body) => new TextEncoder().encode(JSON.stringify(body)).length <= REPLY_ENTRY_BODY_MAX_BYTES, "a stored reply is at most 256 KiB");
export type ReplySetEntryBody = z.infer<typeof ReplySetEntryBodySchema>;
const ReplyIdSchema = ReplyStoreReplyIdSchema;

/** Where an entry came from, for the maintainer's page. Never decides anything. */
export const REPLY_ADDED_BY_SOURCES = ["repo_import", "setup_agent", "task_join", "independent_channel", "recording_intake"] as const;
export type ReplyAddedBySource = (typeof REPLY_ADDED_BY_SOURCES)[number];
export const ReplyAddedBySchema = z.object({ taskId: ReplyStoreTaskIdSchema.optional(), source: z.enum(REPLY_ADDED_BY_SOURCES), commit: CommitSha.optional() }).strict();
export type ReplyAddedBy = z.infer<typeof ReplyAddedBySchema>;

const originRule = (entry: { provenance: ReplyProvenance; origin?: BeforeTaskOrigin | undefined }): boolean => (entry.provenance === "before_task") === (entry.origin !== undefined);
const ORIGIN_WORDS = "an origin belongs to a before_task reply, and a before_task reply has one";

export const ReplySetHeadEntrySchema = z
  .object({ id: ReplyIdSchema, entrySha256: Sha256Hex, provenance: z.enum(REPLY_PROVENANCES), origin: z.enum(BEFORE_TASK_ORIGINS).optional(), addedBy: ReplyAddedBySchema.optional() })
  .strict()
  .refine(originRule, ORIGIN_WORDS);
export type ReplySetHeadEntry = z.infer<typeof ReplySetHeadEntrySchema>;

/** The head of one (branch, family): the ordered entries (the first match wins), the revision a write must name, and the digest of the RESOLVED set in head order (`modelReplySetDigest`). */
export const ReplySetHeadSchema = z
  .object({
    kind: z.literal(REPLY_SET_HEAD_KIND),
    schemaVersion: z.literal(REPLY_SET_HEAD_VERSION),
    family: ReplyStoreFamilySchema,
    branch: ReplyStoreBranchSchema,
    revision: Revision,
    entries: z.array(ReplySetHeadEntrySchema).max(REPLY_SET_HEAD_MAX_ENTRIES),
    digest: Sha256Hex,
  })
  .strict()
  .superRefine((head, context) => {
    if (new Set(head.entries.map((entry) => entry.id)).size !== head.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "a reply id is listed once" });
    if (new Set(head.entries.map((entry) => entry.entrySha256)).size !== head.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "a reply's content is listed once" });
  });
export type ReplySetHead = z.infer<typeof ReplySetHeadSchema>;

/** An overlay entry: only `task_made` and `independent` (a `before_task` reply can never come from a task). Ids may repeat across entries (two writers); content may not. */
export const ReplyOverlayEntrySchema = z
  .object({ id: ReplyIdSchema, entrySha256: Sha256Hex, provenance: z.enum(["task_made", "independent"]), addedBy: ReplyAddedBySchema.optional() })
  .strict();
export type ReplyOverlayEntry = z.infer<typeof ReplyOverlayEntrySchema>;
export const REPLY_OVERLAY_KIND = "model_reply_overlay";
export const ReplyOverlaySchema = z
  .object({
    kind: z.literal(REPLY_OVERLAY_KIND),
    schemaVersion: z.literal(1),
    family: ReplyStoreFamilySchema,
    taskId: ReplyStoreTaskIdSchema,
    revision: Revision,
    entries: z.array(ReplyOverlayEntrySchema).max(REPLY_OVERLAY_MAX_ENTRIES),
  })
  .strict()
  .superRefine((overlay, context) => {
    if (new Set(overlay.entries.map((entry) => entry.entrySha256)).size !== overlay.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "a reply's content is listed once" });
  });
export type ReplyOverlay = z.infer<typeof ReplyOverlaySchema>;

export const REPLY_ENTRY_ROW_KIND = "model_reply_entry";
export const ReplyEntryRowSchema = z.object({ kind: z.literal(REPLY_ENTRY_ROW_KIND), schemaVersion: z.literal(1), entrySha256: Sha256Hex, body: ReplySetEntryBodySchema }).strict();
export type ReplyEntryRow = z.infer<typeof ReplyEntryRowSchema>;

/** One content hash the coding agent wrote. No task id and no time: the same content is the same row, written again and again without change. */
export const REPLY_MADE_KIND = "model_reply_made";
export const ReplyMadeRowSchema = z.object({ kind: z.literal(REPLY_MADE_KIND), schemaVersion: z.literal(1), entrySha256: Sha256Hex }).strict();
export type ReplyMadeRow = z.infer<typeof ReplyMadeRowSchema>;
export const REPLY_MADE_CONTENT_KIND = "model_reply_made_content";
export const ReplyMadeContentRowSchema = z.object({ kind: z.literal(REPLY_MADE_CONTENT_KIND), schemaVersion: z.literal(1), contentSha256: Sha256Hex }).strict();
export type ReplyMadeContentRow = z.infer<typeof ReplyMadeContentRowSchema>;
export const REPLY_MADE_VERSION_KIND = "model_reply_made_version";
export const ReplyMadeVersionRowSchema = z.object({ kind: z.literal(REPLY_MADE_VERSION_KIND), schemaVersion: z.literal(1), version: z.number().int().min(0), count: z.number().int().min(0) }).strict();
export type ReplyMadeVersionRow = z.infer<typeof ReplyMadeVersionRowSchema>;

export const REPLY_JOIN_KIND = "model_reply_join";
export const ReplyJoinMarkerSchema = z
  .object({
    kind: z.literal(REPLY_JOIN_KIND),
    schemaVersion: z.literal(1),
    taskId: ReplyStoreTaskIdSchema,
    family: ReplyStoreFamilySchema,
    branch: ReplyStoreBranchSchema,
    /** The head's revision after the join (unchanged when nothing was added). */
    headRevision: Revision,
    added: z.number().int().min(0).max(REPLY_SET_HEAD_MAX_ENTRIES),
  })
  .strict();
export type ReplyJoinMarker = z.infer<typeof ReplyJoinMarkerSchema>;

// ---- the key layout

export const REPLY_STORE_PARTITION_NAME = "MOCKSET";
export const REPLY_HEAD_PREFIX = "HEAD#model#";
export const REPLY_ENTRY_PREFIX = "ENTRY#";
export const REPLY_TASK_PREFIX = "TASK#";
export const REPLY_JOIN_PREFIX = "JOIN#";
export const REPLY_MADE_PREFIX = "MADE#";
/** The sort key of the project's MADE counter (not 64 hex digits, so it never collides with a `MADE#<entrySha256>` row). */
export const REPLY_MADE_VERSION_SORT_KEY = "MADE#version";
/** The five sort-key prefixes this lane owns. Every other prefix in the partition (TE-G7's) is ignored by this lane's reads and erase. */
export const REPLY_STORE_OWN_PREFIXES = [REPLY_HEAD_PREFIX, REPLY_ENTRY_PREFIX, REPLY_TASK_PREFIX, REPLY_JOIN_PREFIX, REPLY_MADE_PREFIX] as const;

/** `ORG#<company>#MOCKSET#<project>`. The company comes from the caller's session or operation, never from an id or a body. */
export const replyStorePartition = (companyId: string, project: string): string => companyScoped(companyId, `${REPLY_STORE_PARTITION_NAME}#${project}`);
export const replyBranchKey = (branch: string): string => sha256HexOf(new TextEncoder().encode(branch));
export const replyHeadSortKey = (branch: string, family: ServedModelFamily): string => `${REPLY_HEAD_PREFIX}${replyBranchKey(branch)}#${family}`;
export const replyEntrySortKey = (entrySha256: string): string => `${REPLY_ENTRY_PREFIX}${entrySha256}`;
export const replyTaskSortKey = (taskId: string, family: ServedModelFamily): string => `${REPLY_TASK_PREFIX}${taskId}#${family}`;
export const replyJoinSortKey = (taskId: string, family: ServedModelFamily): string => `${REPLY_JOIN_PREFIX}${taskId}#${family}`;
export const replyMadeSortKey = (entrySha256: string): string => `${REPLY_MADE_PREFIX}${entrySha256}`;
export const replyMadeContentSortKey = (contentSha256: string): string => `${REPLY_MADE_PREFIX}c#${contentSha256}`;
/** The tombstone `eraseProject` leaves (see the layout comment). Not in `REPLY_STORE_OWN_PREFIXES`: erase never deletes it. */
export const REPLY_ERASED_PREFIX = "ERASED#";
export const REPLY_ERASED_SORT_KEY = "ERASED#project";
export const REPLY_ERASED_KIND = "model_reply_erased";
export const ReplyErasedRowSchema = z.object({ kind: z.literal(REPLY_ERASED_KIND), schemaVersion: z.literal(1), at: z.string().min(1).max(40) }).strict();

// ---- what the service answers (the shapes the conformance suite and Cloud's implementation share)

/** The stamped set for a worker: the file in head order, the decisions `stampReplyProvenance` takes, the resolved set and its digest. */
export interface ResolvedReplySet {
  readonly file: ModelReplySetFile;
  readonly decisions: Map<string, ReplyProvenanceDecision | IndependentReplyDecision>;
  readonly set: ModelReplySet;
  readonly digest: string;
}
export type ReplyStoreFailure = { readonly ok: false; readonly word: ReplyStoreWord };
export type ReplySetRead = ({ readonly ok: true; readonly revision: number; readonly branch: string; readonly inheritedFrom?: string } & ResolvedReplySet) | ReplyStoreFailure;
export interface ReplyHeadSummary {
  readonly branch: string;
  readonly family: ServedModelFamily;
  readonly revision: number;
  readonly digest: string;
  readonly entryCount: number;
  readonly counts: Readonly<Record<ReplyProvenance, number>>;
}
export interface ReplySetQuery {
  readonly project: string;
  readonly branch: string;
  /** The project's default branch: a branch with no head of its own reads this one (read-only inheritance) and gets its own head at its first write. */
  readonly defaultBranch?: string;
  readonly family: ServedModelFamily;
}
/** Why a reply sent to `putIndependentOverlay` was not added. */
export const REPLY_SKIP_REASONS = ["already_in_overlay"] as const;
export type ReplySkipReason = (typeof REPLY_SKIP_REASONS)[number];
export type ImportOrigin = Extract<BeforeTaskOrigin, "customer_written" | "setup_agent_from_fakes" | "prompt_and_expected_shape">;
export type JoinStatus = "joined" | "already_joined";

/**
 * The service over the document store. The company comes from the SCOPE (`HostScope`), through the service's company resolver; a call whose company cannot be resolved is REFUSED (it throws a `ReplyStoreRefusal`
 * with the fixed `not_allowed` words), never answered for a default company. Every other refusal is a plain `{ok:false, word}`. Missing, another company's and another project's all answer the same `not_found`.
 */
export interface ReplySetStoreService {
  readSet(scope: HostScope, query: ReplySetQuery): Promise<ReplySetRead>;
  /** The set a check round loads: counted replies first, then not-counted ones (`resolveRoundSet`). */
  readRoundSet(scope: HostScope, query: ReplySetQuery & { readonly taskId: string }): Promise<ReplySetRead>;
  listHeads(scope: HostScope, project: string): Promise<{ readonly ok: true; readonly heads: readonly ReplyHeadSummary[] } | ReplyStoreFailure>;
  /** Writes the task's `task_made` replies (replacing the task's earlier `task_made` ones; `independent` ones already there are kept). A reply over 256 KiB is not stored and is named in `tooLarge`. */
  putOverlay(scope: HostScope, input: { readonly project: string; readonly taskId: string; readonly family: ServedModelFamily; readonly replies: readonly ModelReplyFileEntry[] }): Promise<{ readonly ok: true; readonly stored: number; readonly tooLarge: readonly string[] } | ReplyStoreFailure>;
  /** For R2's channel only: each reply with the decision `createRovaraIndependentDecision` made for it. A reply whose decision does not stamp it `independent` is refused (`not_allowed`) and nothing is written. */
  putIndependentOverlay(scope: HostScope, input: { readonly project: string; readonly taskId: string; readonly family: ServedModelFamily; readonly entries: readonly { readonly reply: ModelReplyFileEntry; readonly decision: IndependentReplyDecision }[] }): Promise<{ readonly ok: true; readonly stored: number; readonly skipped: readonly { readonly id: string; readonly reason: ReplySkipReason }[] } | ReplyStoreFailure>;
  /**
   * An explicit import of a base commit's reply file as `before_task` (never a side effect of starting a task). It skips every content hash in the durable `MADE#` record (a reply the coding agent ever wrote). NEVER reachable from a worker callback
   * or any path the sandbox can drive (part B: only the setup agent and a maintainer's "refresh from the repo" call it), and `branch` must be the BASE branch of the project, never a task's.
   */
  importFromRepoFile(scope: HostScope, input: ReplySetQuery & { readonly baseCommitSha: string; readonly bytes: Uint8Array; readonly origin: ImportOrigin }): Promise<{ readonly ok: true; readonly added: number; readonly skipped: number; readonly revision: number } | ReplyStoreFailure>;
  /** The post-merge join of one task's overlay into the merged branch's head. Idempotent through the `JOIN#` marker. */
  joinTask(scope: HostScope, input: { readonly project: string; readonly taskId: string; readonly family: ServedModelFamily; readonly branch: string; readonly defaultBranch?: string }): Promise<{ readonly ok: true; readonly status: JoinStatus; readonly added: number } | ReplyStoreFailure>;
  /** The intake for capped real recordings (`real_recording_capped`: at most 25 per project and family, 64 KiB each). NOT WIRED in M2: nothing calls it until TE-F8's recording channel exists. */
  importRecordings(scope: HostScope, input: ReplySetQuery & { readonly replies: readonly ModelReplyFileEntry[] }): Promise<{ readonly ok: true; readonly added: number; readonly skipped: number; readonly revision: number } | ReplyStoreFailure>;
  /** A maintainer's action (the caller checks the role): removes the erase tombstone, so imports are accepted again. Whatever it lets in as `before_task` is then the maintainer's responsibility. */
  clearErasure(scope: HostScope, input: { readonly project: string }): Promise<{ readonly ok: true } | ReplyStoreFailure>;
  deleteOverlay(scope: HostScope, input: { readonly project: string; readonly taskId: string; readonly family: ServedModelFamily }): Promise<{ readonly ok: true } | ReplyStoreFailure>;
  /** Deletes every row of this lane's four kinds under one project of the caller's company (idempotent; TE-G7's rows are not touched). */
  eraseProject(scope: HostScope, input: { readonly project: string }): Promise<{ readonly ok: true; readonly deleted: number } | ReplyStoreFailure>;
}

/** The refusal thrown when the company of a call cannot be resolved. It names no company. */
export class ReplyStoreRefusal extends Error {
  readonly word: ReplyStoreWord;
  constructor(word: ReplyStoreWord = "not_allowed") {
    super(REPLY_STORE_WORDS[word]);
    this.name = "ReplyStoreRefusal";
    this.word = word;
  }
}
