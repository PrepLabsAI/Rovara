// TE-R1 part A (M2, release 0.5.19; DECISIONS 166a, 161, 150, 152c): the Rovara-side reply-set store, a SERVICE over the existing `DocumentStore` port (no new port, so DECISIONS 42/63 is not triggered). TE-G7 extends the key
// layout in `@agentx/contracts` (`model-reply-store.ts`); it does not replace it.
//
// What this module guarantees, all of it fail closed:
//   - The company comes from the CALLER's scope through the company resolver, never from an id or a body. A resolver that throws, or answers nothing or a malformed company, REFUSES the call (a `ReplyStoreRefusal` with
//     the fixed words); there is no default company. Every key is built from that company (`ORG#<company>#MOCKSET#<project>`), so another company's data is unreachable, not filtered.
//   - One answer for "no": a missing set, another company's and another project's all answer the same `not_found` words. Nothing in an answer or an error echoes an id, a branch, a project or a reply text.
//   - Provenance is written once by this code and never changes: the head holds it, a join appends and never edits, and the only way to an `independent` entry is `putIndependentOverlay` with a decision from
//     `createRovaraIndependentDecision` (checked by running F2-A's `stampReplyProvenance` over that one reply). `putOverlay` can only write `task_made`. A coding agent's file never reaches `before_task` here: the only
//     way in is an explicit `importFromRepoFile` (or the unwired recording intake).
//   - Writes: bodies first (content-addressed, idempotent), then ONE conditional write or transaction that moves the head (its `revision` must equal the one read; one retry, then `conflict`) and, for a join, writes the
//     `JOIN#` marker and removes the overlay in the same transaction, so a retried join changes nothing.
//   - Read back, every body is re-hashed and the head's digest recomputed (`resolveHead`): a row that no longer says what its key says is never served.
//   - The durable `MADE#<entrySha256>` record: every content the coding agent wrote through `putOverlay` is recorded in the same transaction as a bump of the project's `MADE#version` counter, and never expires (only `eraseProject`
//     removes it). An import skips every hash listed there, so a reply cannot become `before_task` because its overlay expired, was deleted, or never joined (the agent can force a failed join). An import's write checks the
//     counter in its own transaction, so a concurrent overlay write makes it retry. TE-G7 must not reuse the prefixes `ENTRY#`, `MADE#`, `TASK#`, `JOIN#` or `HEAD#model#`.
//   - Overlays and join markers expire 30 days after they were written (`INDEX_EXPIRY_ATTRIBUTE`); a row past its time that is not yet swept is treated as absent. Heads and bodies carry no expiry (they are the project's data).
//
// Cloud keeps the same keys in its state table with its own implementation of `ReplySetStoreService`; both pass `packages/testing/src/ports/reply-set-store-conformance.ts`.
import {
  DOCUMENT_STORE_LIMITS,
  DocumentStoreError,
  HostScopeSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  ModelReplySetFileSchema,
  OrgIdSchema,
  REPLY_JOIN_KIND,
  REPLY_OVERLAY_KIND,
  REPLY_OVERLAY_MAX_ENTRIES,
  REPLY_OVERLAY_TTL_DAYS,
  REPLY_STORE_OWN_PREFIXES,
  REPLY_ENTRY_ROW_KIND,
  REPLY_HEAD_PREFIX,
  REPLY_MADE_PREFIX,
  REPLY_MADE_VERSION_KIND,
  REPLY_MADE_VERSION_SORT_KEY,
  REPLY_MADE_KIND,
  ReplyMadeRowSchema,
  ReplyMadeVersionRowSchema,
  replyMadeSortKey,
  type ReplySkipReason,
  change,
  REPLY_ENTRY_BODY_MAX_BYTES,
  ReplyEntryRowSchema,
  ReplyJoinMarkerSchema,
  ReplyOverlaySchema,
  ReplySetHeadSchema,
  ReplyStoreBranchSchema,
  ReplyStoreFamilySchema,
  ReplyStoreProjectSchema,
  ReplyStoreRefusal,
  ReplyStoreTaskIdSchema,
  emptyReplyHead,
  modelReplyEntrySha256,
  planImport,
  parseRepoReplyFile,
  replyEntrySortKey,
  replyHeadCounts,
  replyHeadSortKey,
  replyJoinSortKey,
  replyStorePartition,
  replyTaskSortKey,
  joinTaskReplies,
  queryAll,
  resolveHead,
  resolveRoundSet,
  stampReplyProvenance,
  when,
  type DocumentKey,
  type DocumentStore,
  type HostScope,
  type ImportOrigin,
  type ModelReplyFileEntry,
  type ReplyHeadSummary,
  type ReplyOverlay,
  type ReplyOverlayEntry,
  type ReplySetEntryBody,
  type ReplySetHead,
  type ReplySetQuery,
  type ReplySetStoreService,
  type ReplyStoreFailure,
  type RuleReason,
  type ServedModelFamily,
  type StoredDocument,
  type TransactItem,
} from "@agentx/contracts";

export type ReplyStoreCompanyResolver = (scope: HostScope) => string | undefined | Promise<string | undefined>;

export interface ReplySetStoreOptions {
  readonly store: DocumentStore;
  /** Which company a call is for. Default: the scope's own `orgId` (a `system` scope has none and is refused). A laptop gives `() => IMPLICIT_COMPANY_ID`. */
  readonly resolveCompany?: ReplyStoreCompanyResolver;
  /** The clock, for the expiry of overlays and join markers. */
  readonly now?: () => Date;
  /** Told a fixed code when a stored row or a rule's integrity check fails (never text from a row). The caller may audit it; the answer to the caller stays `not_found`. */
  readonly onProblem?: (code: RuleReason | "row_invalid") => void;
}

const NOT_FOUND: ReplyStoreFailure = Object.freeze({ ok: false, word: "not_found" });
const NOT_ALLOWED: ReplyStoreFailure = Object.freeze({ ok: false, word: "not_allowed" });
const CONFLICT: ReplyStoreFailure = Object.freeze({ ok: false, word: "conflict" });
const DAY_SECONDS = 86_400;
const BODY_WRITES_AT_ONCE = 20;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const IMPORT_ORIGINS: readonly string[] = ["customer_written", "setup_agent_from_fakes", "prompt_and_expected_shape"];
const defaultResolver: ReplyStoreCompanyResolver = (scope) => {
  const parsed = HostScopeSchema.safeParse(scope);
  return parsed.success && "orgId" in parsed.data ? parsed.data.orgId : undefined;
};

type Retry = typeof RETRY;
const RETRY = Symbol("retry");
const isTransient = (error: unknown): boolean => error instanceof DocumentStoreError && error.code === "conflict";

/** A stored row without its key and expiry, for the strict schemas. Keys are copied as OWN properties (never assigned), so a `__proto__` key a store parsed from JSON stays a key the strict schema refuses. */
const strip = (document: StoredDocument): Record<string, unknown> => {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === "pk" || key === "sk" || key === INDEX_EXPIRY_ATTRIBUTE) continue;
    Object.defineProperty(rest, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return rest;
};
const asDocument = (key: DocumentKey, body: object, extra: Record<string, number> = {}): StoredDocument => ({ ...body, ...extra, pk: key.pk, sk: key.sk });
const bodyBytes = (body: unknown): number => new TextEncoder().encode(JSON.stringify(body)).length;

export function createReplySetStore(options: ReplySetStoreOptions): ReplySetStoreService {
  const { store } = options;
  const resolve = options.resolveCompany ?? defaultResolver;
  const now = options.now ?? (() => new Date());
  const problem = (code: RuleReason | "row_invalid"): void => {
    try {
      options.onProblem?.(code);
    } catch {
      // a failing report never changes an answer
    }
  };

  async function companyOf(scope: HostScope): Promise<string> {
    let company: unknown;
    try {
      company = await resolve(scope);
    } catch {
      throw new ReplyStoreRefusal("not_allowed");
    }
    if (typeof company !== "string" || !OrgIdSchema.safeParse(company).success) throw new ReplyStoreRefusal("not_allowed");
    return company;
  }
  const expiresAt = (): number => Math.floor(now().getTime() / 1000) + REPLY_OVERLAY_TTL_DAYS * DAY_SECONDS;
  const live = (document: StoredDocument | undefined): StoredDocument | undefined => {
    if (document === undefined) return undefined;
    const expiry = document[INDEX_EXPIRY_ATTRIBUTE];
    return typeof expiry === "number" && expiry <= Math.floor(now().getTime() / 1000) ? undefined : document;
  };

  const headRow = async (pk: string, branch: string, family: ServedModelFamily): Promise<ReplySetHead | undefined> => {
    const document = await store.get({ pk, sk: replyHeadSortKey(branch, family) });
    if (document === undefined) return undefined;
    const parsed = ReplySetHeadSchema.safeParse(strip(document));
    if (!parsed.success || parsed.data.family !== family) {
      problem("row_invalid");
      return undefined;
    }
    return parsed.data;
  };
  const overlayRow = async (pk: string, taskId: string, family: ServedModelFamily): Promise<ReplyOverlay | undefined> => {
    const document = live(await store.get({ pk, sk: replyTaskSortKey(taskId, family) }));
    if (document === undefined) return undefined;
    const parsed = ReplyOverlaySchema.safeParse(strip(document));
    if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.family !== family) {
      problem("row_invalid");
      return undefined;
    }
    return parsed.data;
  };
  const joinRow = async (pk: string, taskId: string, family: ServedModelFamily) => {
    const document = live(await store.get({ pk, sk: replyJoinSortKey(taskId, family) }));
    if (document === undefined) return undefined;
    const parsed = ReplyJoinMarkerSchema.safeParse(strip(document));
    if (!parsed.success) problem("row_invalid");
    return parsed.success ? parsed.data : undefined;
  };
  /** The bodies for these hashes (each row parsed; a row that is missing or not what its key says is left out, and the rules then refuse). */
  const readBodies = async (pk: string, shas: Iterable<string>): Promise<Map<string, unknown>> => {
    const distinct = [...new Set(shas)];
    const bodies = new Map<string, unknown>();
    for (let from = 0; from < distinct.length; from += DOCUMENT_STORE_LIMITS.maxGetMany) {
      const chunk = distinct.slice(from, from + DOCUMENT_STORE_LIMITS.maxGetMany);
      const rows = await store.getMany(chunk.map((sha) => ({ pk, sk: replyEntrySortKey(sha) })));
      rows.forEach((row, index) => {
        if (row === undefined) return;
        const parsed = ReplyEntryRowSchema.safeParse(strip(row));
        if (parsed.success && parsed.data.entrySha256 === chunk[index]) bodies.set(chunk[index], parsed.data.body);
        else problem("row_invalid");
      });
    }
    return bodies;
  };
  /** Content-addressed puts, idempotent: a body that is already there is left alone. */
  const writeBodies = async (pk: string, bodies: readonly ReplySetEntryBody[]): Promise<void> => {
    for (let from = 0; from < bodies.length; from += BODY_WRITES_AT_ONCE) {
      await Promise.all(
        bodies.slice(from, from + BODY_WRITES_AT_ONCE).map((body) =>
          store.put({ item: asDocument({ pk, sk: replyEntrySortKey(modelReplyEntrySha256(body)) }, { kind: REPLY_ENTRY_ROW_KIND, schemaVersion: 1, entrySha256: modelReplyEntrySha256(body), body }), condition: when.absent() }),
        ),
      );
    }
  };
  /** The head of a branch for a READ: its own, else the default branch's (read-only inheritance). */
  const readableHead = async (pk: string, query: { branch: string; defaultBranch?: string | undefined; family: ServedModelFamily }): Promise<{ head: ReplySetHead; inheritedFrom?: string; own: boolean } | undefined> => {
    const own = await headRow(pk, query.branch, query.family);
    if (own !== undefined) return { head: own, own: true };
    if (query.defaultBranch === undefined || query.defaultBranch === query.branch) return undefined;
    const inherited = await headRow(pk, query.defaultBranch, query.family);
    return inherited === undefined ? undefined : { head: inherited, inheritedFrom: query.defaultBranch, own: false };
  };
  /** The head a WRITE starts from: the branch's own, else a copy of the default branch's (it becomes the branch's own at this write), else an empty one. */
  const writableHead = async (pk: string, query: { branch: string; defaultBranch?: string | undefined; family: ServedModelFamily }): Promise<{ head: ReplySetHead; own: boolean }> => {
    const found = await readableHead(pk, query);
    if (found === undefined) return { head: emptyReplyHead(query.family, query.branch), own: false };
    return found.own ? { head: found.head, own: true } : { head: { ...found.head, branch: query.branch, revision: 0 }, own: false };
  };
  /** The condition that makes a head write apply only if nobody moved it since it was read. */
  const headCondition = (own: boolean, revision: number) => (own ? when.eq("revision", revision) : when.absent());
  /** A row that is not there, or is past its expiry and not yet swept (a reader treats it as absent, so a writer must too). */
  const absentOrExpired = () => when.or(when.absent(), when.lte(INDEX_EXPIRY_ATTRIBUTE, Math.floor(now().getTime() / 1000)));
  const headDocument = (pk: string, head: ReplySetHead): StoredDocument => asDocument({ pk, sk: replyHeadSortKey(head.branch, head.family) }, head);

  const validQuery = (query: ReplySetQuery): boolean =>
    ReplyStoreProjectSchema.safeParse(query.project).success &&
    ReplyStoreBranchSchema.safeParse(query.branch).success &&
    (query.defaultBranch === undefined || ReplyStoreBranchSchema.safeParse(query.defaultBranch).success) &&
    ReplyStoreFamilySchema.safeParse(query.family).success;
  const validTask = (input: { project: string; taskId: string; family: string }): boolean =>
    ReplyStoreProjectSchema.safeParse(input.project).success && ReplyStoreTaskIdSchema.safeParse(input.taskId).success && ReplyStoreFamilySchema.safeParse(input.family).success;

  /** Runs `attempt` once, and once more when it says `RETRY` (a lost race); a second loss is `conflict`. */
  async function twice<T>(attempt: () => Promise<T | Retry>): Promise<T | ReplyStoreFailure> {
    for (let round = 0; round < 2; round += 1) {
      try {
        const result = await attempt();
        if (result !== RETRY) return result;
      } catch (error) {
        if (!isTransient(error)) throw error;
      }
    }
    return CONFLICT;
  }

  /**
   * What an import must not turn into `before_task`: every `task_made` entry of any head of the project and every hash in the durable MADE# record (a reply the coding agent ever wrote, whatever became of its overlay), plus the MADE
   * counter's value as read BEFORE the hashes (the import's write checks it). A row that does not parse stops the import (fail closed): `undefined`.
   */
  async function notImportedShas(pk: string): Promise<{ shas: Set<string>; version: number | undefined } | undefined> {
    let version: number | undefined;
    const versionRow = await store.get({ pk, sk: REPLY_MADE_VERSION_SORT_KEY });
    if (versionRow !== undefined) {
      const parsed = ReplyMadeVersionRowSchema.safeParse(strip(versionRow));
      if (!parsed.success) {
        problem("row_invalid");
        return undefined;
      }
      version = parsed.data.version;
    }
    const shas = new Set<string>();
    for (const row of await queryAll(store, { pk, sk: { op: "beginsWith", prefix: REPLY_MADE_PREFIX } })) {
      if (row.sk === REPLY_MADE_VERSION_SORT_KEY) continue;
      const parsed = ReplyMadeRowSchema.safeParse(strip(row));
      if (!parsed.success || row.sk !== replyMadeSortKey(parsed.data.entrySha256)) {
        problem("row_invalid");
        return undefined;
      }
      shas.add(parsed.data.entrySha256);
    }
    for (const row of await queryAll(store, { pk, sk: { op: "beginsWith", prefix: REPLY_HEAD_PREFIX } })) {
      const parsed = ReplySetHeadSchema.safeParse(strip(row));
      if (!parsed.success) {
        problem("row_invalid");
        return undefined;
      }
      for (const entry of parsed.data.entries) if (entry.provenance === "task_made") shas.add(entry.entrySha256);
    }
    return { shas, version };
  }
  /** Records the contents the coding agent wrote: MADE# rows (idempotent) and one bump of the counter in the SAME transaction, in chunks (a transaction holds at most 100 items). */
  async function recordMade(pk: string, shas: readonly string[]): Promise<void> {
    const distinct = [...new Set(shas)];
    const per = DOCUMENT_STORE_LIMITS.maxTransactItems - 2;
    for (let from = 0; from < distinct.length; from += per) {
      const items: TransactItem[] = distinct.slice(from, from + per).map((sha): TransactItem => ({ kind: "put", item: asDocument({ pk, sk: replyMadeSortKey(sha) }, { kind: REPLY_MADE_KIND, schemaVersion: 1, entrySha256: sha }) }));
      items.push({ kind: "update", key: { pk, sk: REPLY_MADE_VERSION_SORT_KEY }, ops: [change.setIfAbsent("kind", REPLY_MADE_VERSION_KIND), change.setIfAbsent("schemaVersion", 1), change.add("version", 1)] });
      const outcome = await store.transact(items);
      if (!outcome.applied) throw new DocumentStoreError("conflict", "made record");
    }
  }
  async function recordingCount(pk: string, family: ServedModelFamily): Promise<number> {
    const shas = new Set<string>();
    for (const row of await queryAll(store, { pk, sk: { op: "beginsWith", prefix: REPLY_HEAD_PREFIX } })) {
      const parsed = ReplySetHeadSchema.safeParse(strip(row));
      if (!parsed.success || parsed.data.family !== family) continue;
      for (const entry of parsed.data.entries) if (entry.origin === "real_recording_capped") shas.add(entry.entrySha256);
    }
    return shas.size;
  }

  async function importInto(
    scope: HostScope,
    input: ReplySetQuery & { replies: ModelReplyFileEntry[]; origin: ReplySetEntryOrigin; source: "repo_import" | "setup_agent" | "recording_intake"; commit?: string | undefined },
  ) {
    const pk = replyStorePartition(await companyOf(scope), input.project);
    return twice(async () => {
      const { head, own } = await writableHead(pk, input);
      const bodies = await readBodies(pk, head.entries.map((entry) => entry.entrySha256));
      const made = await notImportedShas(pk);
      if (made === undefined) return NOT_FOUND;
      const planned = planImport(head, { version: 1, family: input.family, replies: input.replies }, {
        origin: input.origin,
        source: input.source,
        commit: input.commit,
        notImportedShas: made.shas,
        bodies,
        existingRecordings: input.origin === "real_recording_capped" ? await recordingCount(pk, input.family) : undefined,
      });
      if (!planned.ok) {
        problem(planned.reason);
        return { ok: false, word: planned.word } satisfies ReplyStoreFailure;
      }
      if (planned.added === 0) return { ok: true as const, added: 0, skipped: planned.skipped, revision: head.revision };
      await writeBodies(pk, planned.newBodies);
      // The head moves only if no overlay write recorded a MADE# hash since the counter was read (M1): the counter is checked in the same transaction.
      const written = await store.transact([
        { kind: "put", item: headDocument(pk, planned.head), condition: headCondition(own, head.revision) },
        { kind: "check", key: { pk, sk: REPLY_MADE_VERSION_SORT_KEY }, condition: made.version === undefined ? when.absent() : when.eq("version", made.version) },
      ]);
      return written.applied ? { ok: true as const, added: planned.added, skipped: planned.skipped, revision: planned.head.revision } : RETRY;
    });
  }

  /** The overlay write both `putOverlay` and `putIndependentOverlay` use: read, change the entries, write the bodies first, then the row (conditional on the revision read, and on no join marker). */
  async function writeOverlay(
    scope: HostScope,
    input: { project: string; taskId: string; family: ServedModelFamily },
    change: (existing: readonly ReplyOverlayEntry[]) => { entries: ReplyOverlayEntry[]; bodies: ReplySetEntryBody[]; made?: string[]; skipped?: { id: string; reason: ReplySkipReason }[] } | ReplyStoreFailure,
  ) {
    const pk = replyStorePartition(await companyOf(scope), input.project);
    return twice(async () => {
      if ((await joinRow(pk, input.taskId, input.family)) !== undefined) return NOT_ALLOWED;
      const existing = await overlayRow(pk, input.taskId, input.family);
      const changed = change(existing?.entries ?? []);
      if ("ok" in changed) return changed;
      if (changed.entries.length > REPLY_OVERLAY_MAX_ENTRIES) return { ok: false, word: "too_many" } satisfies ReplyStoreFailure;
      // The durable record first (with its counter bump, one transaction per chunk): whatever happens to the overlay after this, the hashes stay listed.
      await recordMade(pk, changed.made ?? []);
      await writeBodies(pk, changed.bodies);
      const next: ReplyOverlay = { kind: REPLY_OVERLAY_KIND, schemaVersion: 1, family: input.family, taskId: input.taskId, revision: (existing?.revision ?? 0) + 1, entries: changed.entries };
      const key = { pk, sk: replyTaskSortKey(input.taskId, input.family) };
      const outcome = await store.transact([
        { kind: "put", item: asDocument(key, next, { [INDEX_EXPIRY_ATTRIBUTE]: expiresAt() }), condition: existing === undefined ? absentOrExpired() : when.eq("revision", existing.revision) },
        { kind: "check", key: { pk, sk: replyJoinSortKey(input.taskId, input.family) }, condition: absentOrExpired() },
      ]);
      return outcome.applied ? { ok: true as const, entries: changed.entries.length, skipped: changed.skipped ?? [] } : RETRY;
    });
  }

  const service: ReplySetStoreService = {
    async readSet(scope, query) {
      const company = await companyOf(scope);
      if (!validQuery(query)) return NOT_FOUND;
      const pk = replyStorePartition(company, query.project);
      const found = await readableHead(pk, query);
      if (found === undefined) return NOT_FOUND;
      const resolved = resolveHead(found.head, await readBodies(pk, found.head.entries.map((entry) => entry.entrySha256)));
      if (!resolved.ok) {
        problem(resolved.reason);
        return { ok: false, word: resolved.word };
      }
      return { ok: true, revision: found.head.revision, branch: query.branch, ...(found.inheritedFrom === undefined ? {} : { inheritedFrom: found.inheritedFrom }), file: resolved.file, decisions: resolved.decisions, set: resolved.set, digest: resolved.digest };
    },

    async readRoundSet(scope, query) {
      const company = await companyOf(scope);
      if (!validQuery(query) || !ReplyStoreTaskIdSchema.safeParse(query.taskId).success) return NOT_FOUND;
      const pk = replyStorePartition(company, query.project);
      const found = await readableHead(pk, query);
      const overlay = await overlayRow(pk, query.taskId, query.family);
      if (found === undefined && overlay === undefined) return NOT_FOUND;
      const head = found?.head ?? emptyReplyHead(query.family, query.branch);
      const shas = [...head.entries.map((entry) => entry.entrySha256), ...(overlay?.entries.map((entry) => entry.entrySha256) ?? [])];
      const resolved = resolveRoundSet(head, overlay, await readBodies(pk, shas));
      if (!resolved.ok) {
        problem(resolved.reason);
        return { ok: false, word: resolved.word };
      }
      return { ok: true, revision: head.revision, branch: query.branch, ...(found?.inheritedFrom === undefined ? {} : { inheritedFrom: found.inheritedFrom }), file: resolved.file, decisions: resolved.decisions, set: resolved.set, digest: resolved.digest };
    },

    async listHeads(scope, project) {
      const company = await companyOf(scope);
      if (!ReplyStoreProjectSchema.safeParse(project).success) return NOT_FOUND;
      const heads: ReplyHeadSummary[] = [];
      for (const row of await queryAll(store, { pk: replyStorePartition(company, project), sk: { op: "beginsWith", prefix: REPLY_HEAD_PREFIX } })) {
        const parsed = ReplySetHeadSchema.safeParse(strip(row));
        if (!parsed.success) {
          problem("row_invalid");
          continue;
        }
        const head = parsed.data;
        heads.push({ branch: head.branch, family: head.family, revision: head.revision, digest: head.digest, entryCount: head.entries.length, counts: replyHeadCounts(head) });
      }
      if (heads.length === 0) return NOT_FOUND;
      heads.sort((a, b) => (a.branch === b.branch ? a.family.localeCompare(b.family) : a.branch < b.branch ? -1 : 1));
      return { ok: true, heads };
    },

    async putOverlay(scope, input) {
      await companyOf(scope);
      if (!validTask(input)) return NOT_FOUND;
      if (!ModelReplySetFileSchema.safeParse({ version: 1, family: input.family, replies: input.replies }).success) return NOT_ALLOWED;
      const tooLarge = input.replies.filter((reply) => bodyBytes(reply) > REPLY_ENTRY_BODY_MAX_BYTES).map((reply) => reply.id);
      const storable = input.replies.filter((reply) => bodyBytes(reply) <= REPLY_ENTRY_BODY_MAX_BYTES);
      const written = await writeOverlay(scope, input, (existing) => {
        const independent = existing.filter((entry) => entry.provenance === "independent");
        const keep = new Set(independent.map((entry) => entry.entrySha256));
        const entries: ReplyOverlayEntry[] = [...independent];
        const bodies: ReplySetEntryBody[] = [];
        for (const reply of storable) {
          const sha = modelReplyEntrySha256(reply);
          if (keep.has(sha)) continue;
          keep.add(sha);
          entries.push({ id: reply.id, entrySha256: sha, provenance: "task_made", addedBy: { taskId: input.taskId, source: "task_join" } });
          bodies.push({ id: reply.id, match: reply.match, response: reply.response });
        }
        return { entries, bodies, made: storable.map((reply) => modelReplyEntrySha256(reply)) };
      });
      return "ok" in written && written.ok === true ? { ok: true, stored: storable.length, tooLarge } : written;
    },

    async putIndependentOverlay(scope, input) {
      await companyOf(scope);
      if (!validTask(input)) return NOT_FOUND;
      if (!ModelReplySetFileSchema.safeParse({ version: 1, family: input.family, replies: input.entries.map((entry) => entry.reply) }).success) return NOT_ALLOWED;
      // The decision must stamp THIS reply `independent` (a plain object, a spread copy or a look-alike stamps `task_made`): all or none.
      for (const { reply, decision } of input.entries) {
        const stamped = stampReplyProvenance({ version: 1, family: input.family, replies: [reply] }, new Map([[reply.id, decision]]));
        if (stamped.replies[0]?.provenance !== "independent") return NOT_ALLOWED;
        if (bodyBytes(reply) > REPLY_ENTRY_BODY_MAX_BYTES) return { ok: false, word: "too_large" };
      }
      const written = await writeOverlay(scope, input, (existing) => {
        const known = new Set(existing.map((entry) => entry.entrySha256));
        const entries: ReplyOverlayEntry[] = [...existing];
        const bodies: ReplySetEntryBody[] = [];
        const skipped: { id: string; reason: ReplySkipReason }[] = [];
        for (const { reply } of input.entries) {
          const sha = modelReplyEntrySha256(reply);
          if (known.has(sha)) {
            skipped.push({ id: reply.id, reason: "already_in_overlay" }); // its provenance stays as first written
            continue;
          }
          known.add(sha);
          entries.push({ id: reply.id, entrySha256: sha, provenance: "independent", addedBy: { taskId: input.taskId, source: "independent_channel" } });
          bodies.push({ id: reply.id, match: reply.match, response: reply.response });
        }
        return { entries, bodies, skipped };
      });
      return "ok" in written && written.ok === true ? { ok: true, stored: input.entries.length - written.skipped.length, skipped: written.skipped } : written;
    },

    async importFromRepoFile(scope, input) {
      await companyOf(scope);
      if (!validQuery(input) || !COMMIT_SHA.test(input.baseCommitSha)) return NOT_FOUND;
      // `real_recording_capped` has its own intake; nothing else is a before_task origin an import may name.
      if (!IMPORT_ORIGINS.includes(input.origin)) return NOT_ALLOWED;
      const parsed = parseRepoReplyFile(input.bytes);
      if (!parsed.ok) return { ok: false, word: parsed.word };
      if (parsed.file.family !== input.family) return NOT_ALLOWED;
      const result = await importInto(scope, { ...input, replies: [...parsed.file.replies], source: input.origin === "customer_written" ? "repo_import" : "setup_agent", commit: input.baseCommitSha });
      return result;
    },

    async importRecordings(scope, input) {
      await companyOf(scope);
      if (!validQuery(input)) return NOT_FOUND;
      if (!ModelReplySetFileSchema.safeParse({ version: 1, family: input.family, replies: input.replies }).success) return NOT_ALLOWED;
      const result = await importInto(scope, { ...input, replies: [...input.replies], origin: "real_recording_capped", source: "recording_intake" });
      return result;
    },

    async joinTask(scope, input) {
      const company = await companyOf(scope);
      if (!validTask(input) || !ReplyStoreBranchSchema.safeParse(input.branch).success || (input.defaultBranch !== undefined && !ReplyStoreBranchSchema.safeParse(input.defaultBranch).success)) return NOT_FOUND;
      const pk = replyStorePartition(company, input.project);
      const done = await joinRow(pk, input.taskId, input.family);
      if (done !== undefined) return { ok: true, status: "already_joined", added: done.added };
      const result = await twice(async () => {
        const marker = await joinRow(pk, input.taskId, input.family);
        if (marker !== undefined) return { ok: true as const, status: "already_joined" as const, added: marker.added };
        const overlay = await overlayRow(pk, input.taskId, input.family);
        if (overlay === undefined) return NOT_FOUND;
        const { head, own } = await writableHead(pk, { branch: input.branch, defaultBranch: input.defaultBranch, family: input.family });
        const bodies = await readBodies(pk, [...head.entries.map((entry) => entry.entrySha256), ...overlay.entries.map((entry) => entry.entrySha256)]);
        const joined = joinTaskReplies(head, overlay, { bodies });
        if (!joined.ok) {
          problem(joined.reason);
          return { ok: false, word: joined.word } satisfies ReplyStoreFailure;
        }
        const added = joined.added.length;
        const marked = { kind: REPLY_JOIN_KIND, schemaVersion: 1, taskId: input.taskId, family: input.family, branch: input.branch, headRevision: joined.head.revision, added };
        const items: TransactItem[] = [];
        if (added > 0) items.push({ kind: "put", item: headDocument(pk, joined.head), condition: headCondition(own, head.revision) });
        items.push({ kind: "put", item: asDocument({ pk, sk: replyJoinSortKey(input.taskId, input.family) }, marked, { [INDEX_EXPIRY_ATTRIBUTE]: expiresAt() }), condition: absentOrExpired() });
        items.push({ kind: "delete", key: { pk, sk: replyTaskSortKey(input.taskId, input.family) }, condition: when.eq("revision", overlay.revision) });
        const outcome = await store.transact(items);
        return outcome.applied ? { ok: true as const, status: "joined" as const, added } : RETRY;
      });
      return result;
    },

    async deleteOverlay(scope, input) {
      const company = await companyOf(scope);
      if (!validTask(input)) return NOT_FOUND;
      await store.delete({ key: { pk: replyStorePartition(company, input.project), sk: replyTaskSortKey(input.taskId, input.family) } });
      return { ok: true };
    },

    async eraseProject(scope, input) {
      const company = await companyOf(scope);
      if (!ReplyStoreProjectSchema.safeParse(input.project).success) return NOT_FOUND;
      const pk = replyStorePartition(company, input.project);
      let deleted = 0;
      // Only this lane's four kinds: a sort key with any other prefix (TE-G7's) is not ours to delete.
      for (const prefix of REPLY_STORE_OWN_PREFIXES) {
        const rows = await queryAll(store, { pk, sk: { op: "beginsWith", prefix } });
        for (let from = 0; from < rows.length; from += DOCUMENT_STORE_LIMITS.maxTransactItems) {
          const chunk = rows.slice(from, from + DOCUMENT_STORE_LIMITS.maxTransactItems);
          const outcome = await store.transact(chunk.map((row): TransactItem => ({ kind: "delete", key: { pk: row.pk, sk: row.sk } })));
          if (!outcome.applied) return CONFLICT;
          deleted += chunk.length;
        }
      }
      return { ok: true, deleted };
    },
  };
  return service;
}

type ReplySetEntryOrigin = ImportOrigin | "real_recording_capped";
