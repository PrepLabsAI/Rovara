// TE-R1 part A (M2, release 0.5.19; DECISIONS 166a, 161): the pure rules of the reply-set store. No I/O, no clock, no randomness: the same inputs give the same head.
//
// THE RULE (DECISIONS 161): a reply's provenance is written ONCE, by Rovara-side code, and never changes. Nothing here promotes a reply (`task_made` stays `task_made` after a join and after another task reads it),
// and nothing here lets a value the sandbox can write decide a provenance. `createRovaraIndependentDecision` is called in ONE place, `decisionForEntry` below, for an entry the STORE lists as `independent` (a test
// greps the lane for any other call); the store lists a reply as `independent` only after its own channel (`putIndependentOverlay`, R2) put it in an overlay.
//
// Order is content: the first matching reply wins. A join appends (a joined reply never shadows an existing one). The round set puts COUNTED replies before NOT-counted ones (so a counted reply always wins over a
// not-counted one for the same prompt), which replaces F2's "base order, then the candidate's" for store-backed projects.
import {
  ModelReplySetFileSchema,
  ModelReplySetSchema,
  MODEL_REPLY_SET_MAX_BYTES,
  createRovaraIndependentDecision,
  modelReplyEntrySha256,
  modelReplySetDigest,
  parseModelReplySetFileBytes,
  stampReplyProvenance,
  type IndependentReplyDecision,
  type ModelReplyFileEntry,
  type ModelReplySet,
  type ModelReplySetFile,
  type ReplyProvenanceDecision,
} from "./model-reply-set.js";
import type { BeforeTaskOrigin, ReplyProvenance } from "./model-reply-provenance.js";
import {
  REAL_RECORDING_MAX_BYTES,
  REAL_RECORDING_MAX_PER_FAMILY,
  REPLY_SET_HEAD_MAX_ENTRIES,
  ReplyOverlaySchema,
  ReplySetEntryBodySchema,
  ReplySetHeadSchema,
  type ReplyAddedBySource,
  type ReplyOverlay,
  type ReplySetEntryBody,
  type ReplySetHead,
  type ReplySetHeadEntry,
  type ReplyStoreWord,
  type ResolvedReplySet,
} from "./model-reply-store.js";
import { canonicalJson } from "./canonical-json.js";
import type { ServedModelFamily } from "./model-served-family.js";
import { sha256HexOf } from "./service-catalog-verify.js";

const REPLY_CONTENT_DIGEST_DOMAIN = "rovara-model-reply-content/v1\n";

/** Reply bodies by `entrySha256` (what the `ENTRY#` rows hold). Unparsed on purpose: every body is parsed and its hash re-checked here, so a stored row that no longer says what its key says is never served. */
export type ReplyBodies = ReadonlyMap<string, unknown>;

/** Why a rule refused, as a fixed code (never text from a reply). The `word` is what a caller may show. */
export type RuleReason =
  | "head_invalid" | "overlay_invalid" | "body_missing" | "body_changed" | "id_mismatch" | "digest_mismatch" | "set_invalid" | "set_too_large"
  | "before_task_overlay" | "family_mismatch" | "id_clash" | "head_full" | "reply_too_large" | "recording_cap";
export interface RuleFailure {
  readonly ok: false;
  readonly word: ReplyStoreWord;
  readonly reason: RuleReason;
}
const fail = (word: ReplyStoreWord, reason: RuleReason): RuleFailure => ({ ok: false, word, reason });

/**
 * A hash of a reply's `{match, response}` that ignores the id and treats an absent `toolCalls` like `toolCalls: []`: two replies that answer alike hash alike, however they are named. MADE# records it next to the entry hash,
 * so renaming a reply, or writing an empty `toolCalls`, does not get it past the import's check.
 */
export function replyContentSha256(reply: Pick<ModelReplyFileEntry, "match" | "response">): string {
  const { toolCalls, ...rest } = reply.response;
  const response = toolCalls === undefined || toolCalls.length === 0 ? rest : { ...rest, toolCalls };
  return sha256HexOf(new TextEncoder().encode(`${REPLY_CONTENT_DIGEST_DOMAIN}${canonicalJson({ match: reply.match, response })}`));
}

/** `<id>.edit-<first 8 hex of the content hash>`, cut so it stays a valid id (64 characters at most). */
export function replyEditId(id: string, entrySha256: string): string {
  const suffix = `.edit-${entrySha256.slice(0, 8)}`;
  return `${id.slice(0, 64 - suffix.length)}${suffix}`;
}
/** The id a reply gets in a set that already uses `taken`: its own, else the derived edit id, else none (a clash that cannot be told apart is refused, never guessed). */
function idFor(taken: ReadonlySet<string>, id: string, entrySha256: string): string | undefined {
  if (!taken.has(id)) return id;
  const derived = replyEditId(id, entrySha256);
  return taken.has(derived) ? undefined : derived;
}

/**
 * The ONE place an `independent` decision is made: for an entry the store lists as `independent`, bound to the resolved reply's content hash (its id may be the derived edit id, which the hash covers). Every other
 * provenance gets a plain decision. No other file of this lane calls `createRovaraIndependentDecision`.
 */
function decisionForEntry(entry: { provenance: ReplyProvenance; origin?: BeforeTaskOrigin | undefined }, contentSha256: string): ReplyProvenanceDecision | IndependentReplyDecision {
  if (entry.provenance === "independent") return createRovaraIndependentDecision(contentSha256);
  if (entry.provenance === "before_task" && entry.origin !== undefined) return { provenance: "before_task", origin: entry.origin, contentSha256 };
  return { provenance: "task_made", contentSha256 };
}

interface Placed {
  readonly id: string;
  readonly entrySha256: string;
  readonly provenance: ReplyProvenance;
  readonly origin?: BeforeTaskOrigin | undefined;
}

/** Bodies to a stamped set, every body parsed and re-hashed. A missing or changed body, an id that is neither the body's nor its derived edit id, or a set that does not pass the schema refuses. */
function buildResolved(family: ServedModelFamily, placed: readonly Placed[], bodies: ReplyBodies): ({ readonly ok: true } & ResolvedReplySet) | RuleFailure {
  const replies: ModelReplyFileEntry[] = [];
  const decisions = new Map<string, ReplyProvenanceDecision | IndependentReplyDecision>();
  for (const entry of placed) {
    const raw = bodies.get(entry.entrySha256);
    if (raw === undefined) return fail("not_found", "body_missing");
    const parsed = ReplySetEntryBodySchema.safeParse(raw);
    if (!parsed.success) return fail("not_found", "body_changed");
    const body = parsed.data;
    const bodySha = modelReplyEntrySha256(body);
    if (bodySha !== entry.entrySha256) return fail("not_found", "body_changed");
    if (entry.id !== body.id && entry.id !== replyEditId(body.id, entry.entrySha256)) return fail("not_found", "id_mismatch");
    const reply: ModelReplyFileEntry = { id: entry.id, match: body.match, response: body.response };
    replies.push(reply);
    decisions.set(entry.id, decisionForEntry(entry, entry.id === body.id ? bodySha : modelReplyEntrySha256(reply)));
  }
  const file: ModelReplySetFile = { version: 1, family, replies };
  const set = stampReplyProvenance(file, decisions);
  if (new TextEncoder().encode(JSON.stringify(set)).length > MODEL_REPLY_SET_MAX_BYTES) return fail("too_large", "set_too_large");
  // The schema is the last word: ids listed once, operations of the family, bounded sizes. A file that passes the file form passes it with provenance too.
  if (!ModelReplySetFileSchema.safeParse(file).success || !ModelReplySetSchema.safeParse(set).success) return fail("not_found", "set_invalid");
  return { ok: true, file, decisions, set, digest: modelReplySetDigest(set) };
}

const headOf = (value: unknown): ReplySetHead | undefined => {
  const parsed = ReplySetHeadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const overlayOf = (value: unknown): ReplyOverlay | undefined => {
  const parsed = ReplyOverlaySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** The head with nothing in it. */
export function emptyReplyHead(family: ServedModelFamily, branch: string): ReplySetHead {
  const set: ModelReplySet = { version: 1, family, replies: [] };
  return { kind: "model_replies", schemaVersion: 1, family, branch, revision: 0, entries: [], digest: modelReplySetDigest(set) };
}

/**
 * The head as a stamped set for the worker: the file in head order and the decisions `stampReplyProvenance` takes (`before_task` with its origin and content hash; `task_made`; `independent` through the one
 * Rovara-side call). Every body is re-hashed and the recomputed digest must equal the head's: a head or body that was changed, or a body that is gone, is refused (fail closed: the caller treats it as no set, so
 * nothing counts).
 */
export function resolveHead(head: unknown, bodies: ReplyBodies): ({ readonly ok: true } & ResolvedReplySet) | RuleFailure {
  const parsed = headOf(head);
  if (parsed === undefined) return fail("not_found", "head_invalid");
  const resolved = buildResolved(parsed.family, parsed.entries, bodies);
  if (!resolved.ok) return resolved;
  return resolved.digest === parsed.digest ? resolved : fail("not_found", "digest_mismatch");
}

/** Counted replies: `before_task` and `independent`. */
const counted = (provenance: ReplyProvenance): boolean => provenance === "before_task" || provenance === "independent";

/**
 * The set a check round loads: COUNTED entries first (the head's `before_task` and `independent` in head order, then this task's `independent` overlay entries), then the NOT-counted ones (the head's `task_made`, then
 * this task's `task_made`), so a counted reply always wins over a not-counted one for the same prompt. An overlay entry whose content the head already lists is not added again (its stored provenance is kept); one that
 * edits an existing id takes the derived edit id. The overlay can only hold `task_made` and `independent`: a `before_task` entry refuses.
 */
export function resolveRoundSet(head: unknown, overlay: unknown, bodies: ReplyBodies): ({ readonly ok: true } & ResolvedReplySet) | RuleFailure {
  const base = headOf(head);
  if (base === undefined) return fail("not_found", "head_invalid");
  const own = overlay === undefined ? undefined : overlayOf(overlay);
  if (overlay !== undefined && own === undefined) return fail("not_allowed", containsBeforeTask(overlay) ? "before_task_overlay" : "overlay_invalid");
  if (own !== undefined && own.family !== base.family) return fail("not_allowed", "family_mismatch");
  const headShas = new Set(base.entries.map((entry) => entry.entrySha256));
  const taken = new Set(base.entries.map((entry) => entry.id));
  const independent: Placed[] = [];
  const taskMade: Placed[] = [];
  for (const group of ["independent", "task_made"] as const) {
    for (const entry of own?.entries ?? []) {
      if (entry.provenance !== group || headShas.has(entry.entrySha256)) continue;
      const id = idFor(taken, entry.id, entry.entrySha256);
      if (id === undefined) return fail("id_clash", "id_clash");
      taken.add(id);
      (group === "independent" ? independent : taskMade).push({ id, entrySha256: entry.entrySha256, provenance: group });
    }
  }
  const placed: Placed[] = [
    ...base.entries.filter((entry) => counted(entry.provenance)),
    ...independent,
    ...base.entries.filter((entry) => !counted(entry.provenance)),
    ...taskMade,
  ];
  return buildResolved(base.family, placed, bodies);
}

const containsBeforeTask = (overlay: unknown): boolean =>
  typeof overlay === "object" && overlay !== null && Array.isArray((overlay as { entries?: unknown }).entries) && (overlay as { entries: unknown[] }).entries.some((entry) => typeof entry === "object" && entry !== null && (entry as { provenance?: unknown }).provenance === "before_task");

export interface JoinOptions {
  /** The bodies of the head's entries and the overlay's (by `entrySha256`): the head's new digest is computed over the resolved set. */
  readonly bodies: ReplyBodies;
}
export type JoinResult = { readonly ok: true; readonly head: ReplySetHead; readonly added: readonly ReplySetHeadEntry[]; readonly skipped: number } | RuleFailure;

/**
 * The post-merge rule. New entries go AFTER the existing ones, the overlay's `independent` entries first, then its `task_made` ones (the order the round set used); the first match wins, so a joined reply never
 * shadows an existing one. An entry whose `entrySha256` is already in the head is NOT added again and the stored provenance is kept: a `task_made` copy of a `before_task` reply never downgrades it, and a
 * `before_task` or `independent` copy never upgrades a `task_made` one, because nothing is changed. An entry that edits an existing id (same id, other content) joins as a NEW entry with the derived id
 * `<id>.edit-<first 8 hex of entrySha256>`, with the provenance it had (`task_made` for the coding agent's edit), after the original. An overlay entry that says `before_task` refuses (`not_allowed`); over 1,000
 * entries refuses the whole join (`too_many`); a set over 4 MiB refuses (`too_large`): all or none. Pure: same inputs, same head; the revision goes up by one when entries were added.
 */
export function joinTaskReplies(head: unknown, overlay: unknown, options: JoinOptions): JoinResult {
  const base = headOf(head);
  if (base === undefined) return fail("not_found", "head_invalid");
  const own = overlayOf(overlay);
  if (own === undefined) return fail("not_allowed", containsBeforeTask(overlay) ? "before_task_overlay" : "overlay_invalid");
  if (own.family !== base.family) return fail("not_allowed", "family_mismatch");
  const known = new Set(base.entries.map((entry) => entry.entrySha256));
  const taken = new Set(base.entries.map((entry) => entry.id));
  const added: ReplySetHeadEntry[] = [];
  let skipped = 0;
  for (const group of ["independent", "task_made"] as const) {
    for (const entry of own.entries) {
      if (entry.provenance !== group) continue;
      if (known.has(entry.entrySha256)) {
        skipped += 1;
        continue;
      }
      const id = idFor(taken, entry.id, entry.entrySha256);
      if (id === undefined) return fail("id_clash", "id_clash");
      taken.add(id);
      known.add(entry.entrySha256);
      added.push({ id, entrySha256: entry.entrySha256, provenance: group, addedBy: { taskId: own.taskId, source: group === "independent" ? "independent_channel" : "task_join" } });
    }
  }
  if (added.length === 0) return { ok: true, head: base, added, skipped };
  if (base.entries.length + added.length > REPLY_SET_HEAD_MAX_ENTRIES) return fail("too_many", "head_full");
  return withDigest({ ...base, revision: base.revision + 1, entries: [...base.entries, ...added] }, options.bodies, added, skipped);
}

/** A head with its entries changed, given the digest of the resolved set over `bodies`. */
function withDigest(next: ReplySetHead, bodies: ReplyBodies, added: readonly ReplySetHeadEntry[], skipped: number): JoinResult {
  const resolved = buildResolved(next.family, next.entries, bodies);
  if (!resolved.ok) return resolved;
  return { ok: true, head: { ...next, digest: resolved.digest }, added, skipped };
}

export interface ImportOptions {
  readonly origin: BeforeTaskOrigin;
  readonly source: Extract<ReplyAddedBySource, "repo_import" | "setup_agent" | "recording_intake">;
  readonly commit?: string | undefined;
  /** Content hashes of the replies a Rovara task wrote that a human merged, and of the replies in any open task's overlay: they are NOT imported and stay `task_made`. */
  readonly notImportedShas: ReadonlySet<string>;
  /** `replyContentSha256` of every reply the coding agent wrote (it ignores the id and an empty `toolCalls`): a reply with one of these is NOT imported either. */
  readonly notImportedContentShas?: ReadonlySet<string> | undefined;
  /** The bodies of the head's existing entries. */
  readonly bodies: ReplyBodies;
  /** For `real_recording_capped` only: how many capped recordings this (project, family) already holds. */
  readonly existingRecordings?: number | undefined;
}
export type ImportResult = { readonly ok: true; readonly head: ReplySetHead; readonly newBodies: readonly ReplySetEntryBody[]; readonly added: number; readonly skipped: number } | RuleFailure;

/**
 * The seed: an EXPLICIT import (never a side effect of starting a task) of a base commit's reply file, the setup agent's replies made from the customer's fakes, or a capped recording, as `before_task` with its
 * origin. A reply the head already lists is skipped (its stored provenance stays); a reply a Rovara task wrote (`notImportedShas`) is skipped and stays `task_made`; a reply that edits an existing id takes the
 * derived edit id and goes after the original. All or none: over 1,000 entries, a reply over 256 KiB or a recording past its cap refuses the whole import.
 */
export function planImport(head: unknown, file: ModelReplySetFile, options: ImportOptions): ImportResult {
  const base = headOf(head);
  if (base === undefined) return fail("not_found", "head_invalid");
  if (file.family !== base.family) return fail("not_allowed", "family_mismatch");
  const known = new Set(base.entries.map((entry) => entry.entrySha256));
  const taken = new Set(base.entries.map((entry) => entry.id));
  const fresh: { reply: ModelReplyFileEntry; sha: string }[] = [];
  let skipped = 0;
  for (const reply of file.replies) {
    const sha = modelReplyEntrySha256(reply);
    if (known.has(sha) || options.notImportedShas.has(sha) || options.notImportedContentShas?.has(replyContentSha256(reply)) === true) {
      skipped += 1;
      continue;
    }
    known.add(sha);
    fresh.push({ reply, sha });
  }
  if (options.origin === "real_recording_capped") {
    const capped = capRealRecordings(options.existingRecordings ?? 0, fresh.map((entry) => entry.reply));
    if (capped.refused.length > 0) return fail(capped.refused[0]!.word, capped.refused[0]!.word === "too_large" ? "reply_too_large" : "recording_cap");
  }
  const added: ReplySetHeadEntry[] = [];
  const newBodies: ReplySetEntryBody[] = [];
  const bodies = new Map(options.bodies);
  for (const { reply, sha } of fresh) {
    const body: ReplySetEntryBody = { id: reply.id, match: reply.match, response: reply.response };
    if (!ReplySetEntryBodySchema.safeParse(body).success) return fail("too_large", "reply_too_large");
    const id = idFor(taken, reply.id, sha);
    if (id === undefined) return fail("id_clash", "id_clash");
    taken.add(id);
    bodies.set(sha, body);
    newBodies.push(body);
    added.push({ id, entrySha256: sha, provenance: "before_task", origin: options.origin, addedBy: { source: options.source, ...(options.commit === undefined ? {} : { commit: options.commit }) } });
  }
  if (added.length === 0) return { ok: true, head: base, newBodies, added: 0, skipped };
  if (base.entries.length + added.length > REPLY_SET_HEAD_MAX_ENTRIES) return fail("too_many", "head_full");
  const next = withDigest({ ...base, revision: base.revision + 1, entries: [...base.entries, ...added] }, bodies, added, skipped);
  return next.ok ? { ok: true, head: next.head, newBodies, added: added.length, skipped } : next;
}

/** Parses a base commit's reply-file bytes strictly (F2-A's parser). Fixed words on failure. */
export function parseRepoReplyFile(bytes: Uint8Array): { readonly ok: true; readonly file: ModelReplySetFile } | RuleFailure {
  const parsed = parseModelReplySetFileBytes(bytes);
  return parsed.ok ? { ok: true, file: parsed.set } : fail("not_allowed", "set_invalid");
}

/**
 * Capped real recordings: at most 25 per (project, family) (`existingCount` is what the project already holds), each at most 64 KiB as compact JSON. Pure; the intake that calls it is not wired in M2 (phase A
 * of TE-F8 deletes recordings at task end, so nothing writes `real_recording_capped` yet).
 */
export function capRealRecordings(existingCount: number, incoming: readonly ModelReplyFileEntry[]): { readonly accepted: readonly ModelReplyFileEntry[]; readonly refused: readonly { readonly id: string; readonly word: ReplyStoreWord }[] } {
  const accepted: ModelReplyFileEntry[] = [];
  const refused: { id: string; word: ReplyStoreWord }[] = [];
  let count = Math.max(0, Math.floor(existingCount));
  for (const reply of incoming) {
    if (new TextEncoder().encode(JSON.stringify(reply)).length > REAL_RECORDING_MAX_BYTES) refused.push({ id: reply.id, word: "too_large" });
    else if (count >= REAL_RECORDING_MAX_PER_FAMILY) refused.push({ id: reply.id, word: "too_many" });
    else {
      count += 1;
      accepted.push(reply);
    }
  }
  return { accepted, refused };
}

/**
 * At the start or end of a task: the replies of the candidate's file that the head does not list. They are the task's overlay as `task_made` (fail closed): a base-commit entry the store has never seen (a human
 * edited the file outside Rovara since the last import) is `task_made` until the next explicit import.
 */
export function unseenCandidateReplies(head: unknown, candidate: ModelReplySetFile): readonly ModelReplyFileEntry[] | RuleFailure {
  const base = headOf(head);
  if (base === undefined) return fail("not_found", "head_invalid");
  if (candidate.family !== base.family) return fail("not_allowed", "family_mismatch");
  const known = new Set(base.entries.map((entry) => entry.entrySha256));
  return candidate.replies.filter((reply) => !known.has(modelReplyEntrySha256(reply)));
}

/**
 * For a project that keeps mocks in the repo: F2's `decideFromBase` says `before_task` for a reply equal to the base commit's; this accepts that answer only for an entry the store also lists with the same
 * `entrySha256` as `before_task` (and takes the store's origin). A reply the store lists as `independent` is `independent`; one it lists as `task_made`, or does not list, is `task_made`. A decision that was not
 * `before_task` stays as it was: the store never promotes.
 */
export function reconcileBaseDecisions(decisions: ReadonlyMap<string, ReplyProvenanceDecision>, head: unknown): Map<string, ReplyProvenanceDecision | IndependentReplyDecision> | RuleFailure {
  const base = headOf(head);
  if (base === undefined) return fail("not_found", "head_invalid");
  const bySha = new Map(base.entries.map((entry) => [entry.entrySha256, entry] as const));
  const out = new Map<string, ReplyProvenanceDecision | IndependentReplyDecision>();
  for (const [id, decision] of decisions) {
    const listed = bySha.get(decision.contentSha256);
    if (decision.provenance !== "before_task" || listed === undefined || listed.provenance === "task_made") out.set(id, { provenance: "task_made", contentSha256: decision.contentSha256 });
    else out.set(id, decisionForEntry(listed, decision.contentSha256));
  }
  return out;
}

/** A head's counts by provenance, for a list page (never the bodies). */
export function replyHeadCounts(head: ReplySetHead): Readonly<Record<ReplyProvenance, number>> {
  const counts: Record<ReplyProvenance, number> = { before_task: 0, independent: 0, task_made: 0 };
  for (const entry of head.entries) counts[entry.provenance] += 1;
  return counts;
}
