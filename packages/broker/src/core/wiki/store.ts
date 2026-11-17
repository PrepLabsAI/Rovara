// The project wiki store (lead 4, W2; DEC 254zh/254zi): one company's wiki rows, one partition per project (`wikiPartition`: `ORG#<company>#WIKI#<project>`). The contract, the limits and
// the rules are in contracts/src/wiki-store.ts; what this file adds:
//
//  - The company is fixed when the store is made (the caller's live membership, never a request's input), and every key is built from it and the project of the call. Every row also
//    names its company and project, and a row read back that names another is refused as unreadable (a second wall behind the key: a wrong key never becomes a leak).
//  - Rows only. A page is two rows written together in one transaction: the index row (`PAGE#`, small: title, summary, repos, claim counts, open page flags) and the body (`BODY#`: blocks
//    and claims). Notes (`NOTE#<page>#`) and flags (`FLAG#<page>#`) are their own rows, so a rewrite of the page keeps them. Build records (`BUILD#`) and answer records (`ANSWER#`) sit
//    in the same partition, so deleting a project's wiki or purging the company removes everything.
//  - Stored code quotes are redacted (`redactText`), put on one line and cut to `WIKI_QUOTE_MAX` characters before the write, whatever the caller did.
//  - Reads fail closed: a row that does not parse, or names another company or project, makes the read throw (never a silent partial answer).
//  - The agents' read leaves out pending notes, flagged and `not_found` claims and every block resting on one, and the whole page while a page-level flag is open. A person's flag
//    reasons are never given to agents.
import { randomUUID } from "node:crypto";
import {
  OrgIdSchema, WIKI_ANSWER_RETENTION_DAYS, WIKI_ANSWER_SWEEP_MAX, WIKI_LIMITS, WIKI_QUOTE_MAX, WIKI_SK, WikiAnswerRecordWriteSchema, WikiBlockSchema, WikiBuildRecordSchema, WikiClaimSchema,
  WikiFlagAddSchema, WikiFlagSchema, WikiIdSchema, WikiNoteAddSchema, WikiNoteSchema, WikiPageIdSchema, WikiPageKindSchema, WikiPageWriteSchema, WikiPersonIdSchema, WikiProjectSchema,
  WikiRepoCommitSchema, WikiRepoSchema, WikiSourceStateSchema, queryAll, redactText, when, wikiAnswerKey, wikiBodyKey, wikiBuildKey, wikiFlagKey, wikiNoteKey, wikiPageKey, wikiPartition, wikiRowKey,
  type DocumentStore, type OrgId, type StoredDocument, type TransactItem, type WikiAnswerRecord, type WikiAnswerRecordWrite, type WikiAudience, type WikiBlock, type WikiBuildRecord,
  type WikiClaim, type WikiFlag, type WikiFlagAdd, type WikiIndexEntry, type WikiNote, type WikiNoteAdd, type WikiPage, type WikiPageRead, type WikiPageSink, type WikiPageWrite,
  type WikiPersonErasure, type WikiRepositoryDeletion, type WikiSourceState, type WikiStore,
} from "@agentx/contracts";
import { z } from "zod";

const WIKI_PAGE_ENTITY = "WIKI_PAGE";
const WIKI_BODY_ENTITY = "WIKI_PAGE_BODY";
const WIKI_NOTE_ENTITY = "WIKI_NOTE";
const WIKI_FLAG_ENTITY = "WIKI_FLAG";
const WIKI_BUILD_ENTITY = "WIKI_BUILD";
const WIKI_ANSWER_ENTITY = "WIKI_ANSWER";
export const WIKI_ENTITY = { page: WIKI_PAGE_ENTITY, body: WIKI_BODY_ENTITY, note: WIKI_NOTE_ENTITY, flag: WIKI_FLAG_ENTITY, build: WIKI_BUILD_ENTITY, answer: WIKI_ANSWER_ENTITY } as const;
/** The id a flag's person becomes when that person is erased (their reason is removed too). */
export const WIKI_FORMER_MEMBER = "former-member";
const ANSWER_TTL_SECONDS = WIKI_ANSWER_RETENTION_DAYS * 86_400;

/** A fault with fixed words (the cause is never echoed: a stored row's text could be anyone's). */
export class WikiStoreError extends Error {
  constructor(readonly code: "unreadable" | "invalid" | "page_cap" | "no_such_page" | "no_such_claim" | "too_many" | "conflict", message: string) {
    super(message);
    this.name = "WikiStoreError";
  }
}
const unreadable = (): WikiStoreError => new WikiStoreError("unreadable", "A wiki row could not be read.");
const invalid = (): WikiStoreError => new WikiStoreError("invalid", "That is not a valid wiki input.");

export interface WikiStoreOptions {
  store: Pick<DocumentStore, "get" | "getMany" | "put" | "update" | "delete" | "query" | "transact">;
  /** The company, from the caller's LIVE membership. */
  companyId: OrgId;
  now: () => number;
  /** New ids (notes, flags). Default: a random UUID. */
  newId?: () => string;
}

/** A stored quote: redacted, one line, at most `WIKI_QUOTE_MAX` characters. */
export function storedQuote(quote: string): string {
  const plain = redactText(quote).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const points = Array.from(plain);
  return points.length <= WIKI_QUOTE_MAX ? plain : points.slice(0, WIKI_QUOTE_MAX).join("").trimEnd();
}

/** A parsed input, as plain JSON: an optional field given as `undefined` is dropped, so the store never sees it. */
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return JSON.parse(JSON.stringify(result.data)) as T;
}

// ---- Stored row shapes (what a read accepts back) ------------------------------------------------------------------------------------------------------------------------------------

const isoTime = z.string().datetime({ offset: false });
const scoped = { companyId: OrgIdSchema, project: WikiProjectSchema };
const PageRow = z.object({
  ...scoped, entityType: z.literal(WIKI_PAGE_ENTITY), pageId: WikiPageIdSchema, kind: WikiPageKindSchema, title: z.string(), summary: z.string(), parentId: WikiPageIdSchema.optional(),
  order: z.number().int(), repos: z.array(WikiRepoCommitSchema), repoNames: z.array(WikiRepoSchema), writtenAt: isoTime, buildId: WikiIdSchema, revision: z.number().int().min(1),
  claimsFound: z.number().int().min(0), claimsChanged: z.number().int().min(0), openPageFlags: z.number().int().min(0),
}).passthrough();
type PageRowT = z.infer<typeof PageRow>;
const BodyRow = z.object({ ...scoped, entityType: z.literal(WIKI_BODY_ENTITY), pageId: WikiPageIdSchema, revision: z.number().int().min(1), blocks: z.array(WikiBlockSchema), claims: z.array(WikiClaimSchema) }).passthrough();
type BodyRowT = z.infer<typeof BodyRow>;
const NoteRow = z.object({ ...scoped, entityType: z.literal(WIKI_NOTE_ENTITY), note: WikiNoteSchema }).passthrough();
const FlagRow = z.object({ ...scoped, entityType: z.literal(WIKI_FLAG_ENTITY), flag: WikiFlagSchema }).passthrough();
const BuildRow = z.object({ ...scoped, entityType: z.literal(WIKI_BUILD_ENTITY), build: WikiBuildRecordSchema }).passthrough();
const AnswerRow = z.object({ ...scoped, entityType: z.literal(WIKI_ANSWER_ENTITY), answer: WikiAnswerRecordWriteSchema, createdAt: isoTime, expiresAt: z.number().int(), notRight: z.boolean().optional() }).passthrough();

export function createWikiStore(options: WikiStoreOptions): WikiStore {
  const companyId = OrgIdSchema.parse(options.companyId);
  const { store, now } = options;
  const newId = options.newId ?? (() => randomUUID());
  const iso = (): string => new Date(now()).toISOString();

  const projectOf = (project: string): string => parsed(WikiProjectSchema, project);
  const pageIdOf = (pageId: string): string => parsed(WikiPageIdSchema, pageId);
  const idOf = (id: string): string => parsed(WikiIdSchema, id);
  const rowBase = (project: string) => ({ companyId, project });

  /** A stored row back: it must parse, and name this company and this project (and sit in their partition). */
  function readRow<T extends { companyId: string; project: string }>(schema: z.ZodType<T>, item: StoredDocument | undefined, project: string): T | undefined {
    if (item === undefined) return undefined;
    if (item.pk !== wikiPartition(companyId, project)) throw unreadable();
    const result = schema.safeParse(item);
    if (!result.success) throw unreadable();
    const row = result.data;
    if (row.companyId !== companyId || row.project !== project) throw unreadable();
    return row;
  }
  /** The key of a row a query of the project's partition gave back (its sort key must be one of the wiki's families). */
  const keyOf = (project: string, item: StoredDocument) => wikiRowKey(companyId, project, item.sk);
  const family = async (project: string, prefix: string): Promise<StoredDocument[]> => await queryAll(store, { pk: wikiPartition(companyId, project), sk: { op: "beginsWith", prefix } });

  async function pageRows(project: string): Promise<PageRowT[]> {
    // Every page row is read and checked (prune and delete must see them all); the cap is the writer's (two writes at once can pass it by one), so a read never fails on it.
    return (await family(project, WIKI_SK.page)).map((item) => readRow(PageRow, item, project)!);
  }
  const indexEntryOf = (row: PageRowT): WikiIndexEntry => ({
    pageId: row.pageId, kind: row.kind, title: row.title, summary: row.summary, ...(row.parentId === undefined ? {} : { parentId: row.parentId }), order: row.order, repos: row.repos,
    writtenAt: row.writtenAt, claims: { found: row.claimsFound, changed: row.claimsChanged }, flagged: row.openPageFlags > 0,
  });
  const counts = (claims: readonly WikiClaim[]) => ({ claimsFound: claims.filter((claim) => claim.source === "found").length, claimsChanged: claims.filter((claim) => claim.source === "changed").length });

  async function readIndex(project: string): Promise<WikiIndexEntry[]> {
    const name = projectOf(project);
    return (await pageRows(name)).map(indexEntryOf).sort((a, b) => (a.parentId ?? "").localeCompare(b.parentId ?? "") || a.order - b.order || a.pageId.localeCompare(b.pageId)).slice(0, WIKI_LIMITS.pagesPerProject);
  }

  async function notesOf(project: string, pageId: string): Promise<WikiNote[]> {
    return (await family(project, `${WIKI_SK.note}${pageId}#`)).map((item) => readRow(NoteRow, item, project)!.note).filter((note) => note.pageId === pageId);
  }
  async function flagsOf(project: string, pageId: string): Promise<WikiFlag[]> {
    return (await family(project, `${WIKI_SK.flag}${pageId}#`)).map((item) => readRow(FlagRow, item, project)!.flag).filter((flag) => flag.pageId === pageId);
  }

  async function readPage(project: string, pageId: string, audience: WikiAudience): Promise<WikiPageRead | undefined> {
    const name = projectOf(project);
    const id = pageIdOf(pageId);
    if (audience !== "person" && audience !== "agent") throw invalid();
    const [pageItem, bodyItem] = await store.getMany([wikiPageKey(companyId, name, id), wikiBodyKey(companyId, name, id)]);
    const row = readRow(PageRow, pageItem, name);
    const body = readRow(BodyRow, bodyItem, name);
    if (row === undefined || body === undefined) return undefined;
    if (row.pageId !== id || body.pageId !== id || row.revision !== body.revision) throw unreadable();
    const [notes, allFlags] = await Promise.all([notesOf(name, id), flagsOf(name, id)]);
    const open = allFlags.filter((flag) => flag.state === "open");
    const page: WikiPage = {
      pageId: row.pageId, kind: row.kind, title: row.title, summary: row.summary, ...(row.parentId === undefined ? {} : { parentId: row.parentId }), order: row.order, repos: row.repos,
      blocks: body.blocks, claims: body.claims, buildId: row.buildId, writtenAt: row.writtenAt,
    };
    const staleOf = (blocks: readonly WikiBlock[], claims: readonly WikiClaim[]): string[] => {
      const changed = new Set(claims.filter((claim) => claim.source === "changed").map((claim) => claim.claimId));
      return blocks.filter((block) => block.kind !== "heading" && block.claimIds.some((claimId) => changed.has(claimId))).map((block) => block.blockId);
    };
    if (audience === "person") return { page, notes, flags: open, staleBlockIds: staleOf(page.blocks, page.claims) };
    // An agent: nothing of a page someone marked wrong as a whole; no pending note; no flagged or not-found claim, nor any block resting on one; no person's reason.
    if (open.some((flag) => flag.claimId === undefined)) return undefined;
    const hidden = new Set([...open.map((flag) => flag.claimId!), ...page.claims.filter((claim) => claim.source === "not_found").map((claim) => claim.claimId)]);
    const claims = page.claims.filter((claim) => !hidden.has(claim.claimId));
    const blocks = page.blocks.filter((block) => block.kind === "heading" || !block.claimIds.some((claimId) => hidden.has(claimId)));
    const agentFlags = open.map((flag) => ({ flagId: flag.flagId, pageId: flag.pageId, ...(flag.claimId === undefined ? {} : { claimId: flag.claimId }), state: flag.state }));
    return { page: { ...page, claims, blocks }, notes: notes.filter((note) => note.approval.state === "approved"), flags: agentFlags, staleBlockIds: staleOf(blocks, claims) };
  }

  async function writePage(project: string, input: WikiPageWrite): Promise<void> {
    const name = projectOf(project);
    // Quotes are redacted and cut first, then the whole page is checked as the contract says (a quote that redaction changed is still bound to its commit and line).
    const raw = input as unknown as { claims?: unknown };
    const withQuotes = Array.isArray(raw.claims)
      ? { ...input, claims: (raw.claims as Array<Record<string, unknown>>).map((claim) => ({ ...claim, citations: Array.isArray(claim["citations"]) ? (claim["citations"] as Array<Record<string, unknown>>).map((citation) => (typeof citation["quote"] === "string" ? { ...citation, quote: storedQuote(citation["quote"]) } : citation)) : claim["citations"] })) }
      : input;
    const page = parsed(WikiPageWriteSchema, withQuotes);
    const pageKey = wikiPageKey(companyId, name, page.pageId);
    const existing = readRow(PageRow, await store.get(pageKey), name);
    if (existing === undefined && (await family(name, WIKI_SK.page)).length >= WIKI_LIMITS.pagesPerProject) throw new WikiStoreError("page_cap", "The wiki already has as many pages as a project can.");
    const revision = (existing?.revision ?? 0) + 1;
    const writtenAt = iso();
    const pageItem: StoredDocument = {
      ...pageKey, entityType: WIKI_PAGE_ENTITY, ...rowBase(name), pageId: page.pageId, kind: page.kind, title: page.title, summary: page.summary, ...(page.parentId === undefined ? {} : { parentId: page.parentId }),
      order: page.order, repos: page.repos, repoNames: page.repos.map((entry) => entry.repo), writtenAt, buildId: page.buildId, revision, ...counts(page.claims), openPageFlags: existing?.openPageFlags ?? 0,
    };
    const bodyItem: StoredDocument = { ...wikiBodyKey(companyId, name, page.pageId), entityType: WIKI_BODY_ENTITY, ...rowBase(name), pageId: page.pageId, revision, blocks: page.blocks, claims: page.claims } as unknown as StoredDocument;
    const guard = existing === undefined ? when.absent() : when.eq("revision", existing.revision);
    const result = await store.transact([{ kind: "put", item: pageItem, condition: guard }, { kind: "put", item: bodyItem }]);
    if (!result.applied) throw new WikiStoreError("conflict", "The page changed while it was written. Write it again.");
  }

  async function markClaims(project: string, pageId: string, changes: ReadonlyArray<{ claimId: string; source: WikiSourceState }>): Promise<number> {
    const name = projectOf(project);
    const id = pageIdOf(pageId);
    const wanted = parsed(z.array(z.object({ claimId: WikiIdSchema, source: WikiSourceStateSchema }).strict()).max(WIKI_LIMITS.claimsPerPage), changes);
    const [pageItem, bodyItem] = await store.getMany([wikiPageKey(companyId, name, id), wikiBodyKey(companyId, name, id)]);
    const row = readRow(PageRow, pageItem, name);
    const body = readRow(BodyRow, bodyItem, name);
    if (row === undefined || body === undefined) return 0;
    const bySource = new Map(wanted.map((change) => [change.claimId, change.source]));
    const checkedAt = iso();
    let changed = 0;
    const claims = body.claims.map((claim) => {
      const source = bySource.get(claim.claimId);
      if (source === undefined || source === claim.source) return claim;
      changed += 1;
      return { ...claim, source, checkedAt };
    });
    if (changed === 0) return 0;
    const result = await store.transact([
      { kind: "update", key: wikiPageKey(companyId, name, id), ops: [{ op: "set", path: ["claimsFound"], value: counts(claims).claimsFound }, { op: "set", path: ["claimsChanged"], value: counts(claims).claimsChanged }], condition: when.eq("revision", row.revision) },
      { kind: "update", key: wikiBodyKey(companyId, name, id), ops: [{ op: "set", path: ["claims"], value: claims as unknown as never }], condition: when.eq("revision", body.revision) },
    ]);
    if (!result.applied) throw new WikiStoreError("conflict", "The page changed while it was written. Write it again.");
    return changed;
  }

  async function deletePageRows(project: string, pageId: string): Promise<{ deleted: boolean; notes: number; flags: number }> {
    const [notes, flags] = await Promise.all([family(project, `${WIKI_SK.note}${pageId}#`), family(project, `${WIKI_SK.flag}${pageId}#`)]);
    for (const item of [...notes, ...flags]) await store.delete({ key: keyOf(project, item) });
    const body = await store.delete({ key: wikiBodyKey(companyId, project, pageId), return: "old" });
    const page = await store.delete({ key: wikiPageKey(companyId, project, pageId), return: "old" });
    return { deleted: (page.applied && page.item !== undefined) || (body.applied && body.item !== undefined), notes: notes.length, flags: flags.length };
  }

  async function deletePage(project: string, pageId: string): Promise<boolean> {
    return (await deletePageRows(projectOf(project), pageIdOf(pageId))).deleted;
  }

  async function deleteRepository(project: string, repo: string): Promise<WikiRepositoryDeletion> {
    const name = projectOf(project);
    const repoName = parsed(WikiRepoSchema, repo);
    const done: WikiRepositoryDeletion = { pages: 0, notes: 0, flags: 0 };
    for (const row of await pageRows(name)) {
      if (!row.repoNames.includes(repoName) && !row.repos.some((entry) => entry.repo === repoName)) continue;
      const gone = await deletePageRows(name, row.pageId);
      if (gone.deleted) done.pages += 1;
      done.notes += gone.notes;
      done.flags += gone.flags;
    }
    return done;
  }

  async function pruneRepositories(project: string, current: readonly string[]): Promise<WikiRepositoryDeletion> {
    const name = projectOf(project);
    const keep = new Set(parsed(z.array(WikiRepoSchema).max(64), current));
    const done: WikiRepositoryDeletion = { pages: 0, notes: 0, flags: 0 };
    for (const row of await pageRows(name)) {
      if ([...row.repoNames, ...row.repos.map((entry) => entry.repo)].every((repo) => keep.has(repo))) continue;
      const gone = await deletePageRows(name, row.pageId);
      if (gone.deleted) done.pages += 1;
      done.notes += gone.notes;
      done.flags += gone.flags;
    }
    return done;
  }

  async function deleteWiki(project: string): Promise<number> {
    const name = projectOf(project);
    const items = await queryAll(store, { pk: wikiPartition(companyId, name) });
    // Index rows last, so a wiki half deleted by a fault still lists what is left to delete.
    const ordered = [...items.filter((item) => !item.sk.startsWith(WIKI_SK.page)), ...items.filter((item) => item.sk.startsWith(WIKI_SK.page))];
    for (const item of ordered) await store.delete({ key: keyOf(name, item) });
    return items.length;
  }

  async function requirePage(project: string, pageId: string): Promise<{ row: PageRowT; body: BodyRowT }> {
    const [pageItem, bodyItem] = await store.getMany([wikiPageKey(companyId, project, pageId), wikiBodyKey(companyId, project, pageId)]);
    const row = readRow(PageRow, pageItem, project);
    const body = readRow(BodyRow, bodyItem, project);
    if (row === undefined || body === undefined) throw new WikiStoreError("no_such_page", "That wiki page is not there.");
    return { row, body };
  }

  async function addNote(project: string, input: WikiNoteAdd): Promise<WikiNote> {
    const name = projectOf(project);
    const add = parsed(WikiNoteAddSchema.strict(), input);
    await requirePage(name, add.pageId);
    if ((await family(name, `${WIKI_SK.note}${add.pageId}#`)).length >= WIKI_LIMITS.notesPerPage) throw new WikiStoreError("too_many", "This page has as many notes as it can hold.");
    const note = parsed(WikiNoteSchema, { noteId: newId(), pageId: add.pageId, text: add.text, authorId: add.authorId, createdAt: iso(), ...(add.file === undefined ? {} : { file: add.file }), approval: { state: "pending" } });
    const written = await store.put({ item: { ...wikiNoteKey(companyId, name, note.pageId, note.noteId), entityType: WIKI_NOTE_ENTITY, ...rowBase(name), note } as unknown as StoredDocument, condition: when.absent() });
    if (!written.applied) throw new WikiStoreError("conflict", "That note could not be saved. Try again.");
    return note;
  }

  async function approveNote(project: string, pageId: string, noteId: string, by: string): Promise<WikiNote | undefined> {
    const name = projectOf(project);
    const key = wikiNoteKey(companyId, name, pageIdOf(pageId), idOf(noteId));
    const approver = parsed(WikiPersonIdSchema, by);
    const row = readRow(NoteRow, await store.get(key), name);
    if (row === undefined) return undefined;
    if (row.note.approval.state === "approved") return row.note;
    const note: WikiNote = { ...row.note, approval: { state: "approved", by: approver, at: iso() } };
    const written = await store.put({ item: { ...key, entityType: WIKI_NOTE_ENTITY, ...rowBase(name), note } as unknown as StoredDocument, condition: when.present() });
    return written.applied ? note : undefined;
  }

  async function deleteNote(project: string, pageId: string, noteId: string): Promise<boolean> {
    const name = projectOf(project);
    const gone = await store.delete({ key: wikiNoteKey(companyId, name, pageIdOf(pageId), idOf(noteId)), return: "old" });
    return gone.applied && gone.item !== undefined;
  }

  async function addFlag(project: string, input: WikiFlagAdd): Promise<WikiFlag> {
    const name = projectOf(project);
    const add = parsed(WikiFlagAddSchema, input);
    const { row, body } = await requirePage(name, add.pageId);
    if (add.claimId !== undefined && !body.claims.some((claim) => claim.claimId === add.claimId)) throw new WikiStoreError("no_such_claim", "That claim is not on the page.");
    // Only open marks count: resolved ones (a refresh rewrote the page) never fill a page up for good.
    if ((await flagsOf(name, add.pageId)).filter((flag) => flag.state === "open").length >= WIKI_LIMITS.flagsPerPage) throw new WikiStoreError("too_many", "This page has as many marks as it can hold.");
    const flag = parsed(WikiFlagSchema, { flagId: newId(), pageId: add.pageId, ...(add.claimId === undefined ? {} : { claimId: add.claimId }), by: add.by, ...(add.reason === undefined ? {} : { reason: add.reason }), createdAt: iso(), state: "open" });
    const items: TransactItem[] = [{ kind: "put", item: { ...wikiFlagKey(companyId, name, flag.pageId, flag.flagId), entityType: WIKI_FLAG_ENTITY, ...rowBase(name), flag } as unknown as StoredDocument, condition: when.absent() }];
    // A page-level mark shows in the index (and hides the page from agents) in the same write.
    if (flag.claimId === undefined) items.push({ kind: "update", key: wikiPageKey(companyId, name, flag.pageId), ops: [{ op: "add", path: ["openPageFlags"], amount: 1 }], condition: when.eq("revision", row.revision) });
    const result = await store.transact(items);
    if (!result.applied) throw new WikiStoreError("conflict", "That mark could not be saved. Try again.");
    return flag;
  }

  async function resolveFlags(project: string, pageId: string): Promise<number> {
    const name = projectOf(project);
    const id = pageIdOf(pageId);
    let resolved = 0;
    for (const item of await family(name, `${WIKI_SK.flag}${id}#`)) {
      const row = readRow(FlagRow, item, name)!;
      if (row.flag.state !== "open") continue;
      await store.put({ item: { ...item, flag: { ...row.flag, state: "resolved" } } as unknown as StoredDocument });
      resolved += 1;
    }
    if (resolved > 0) await store.update({ key: wikiPageKey(companyId, name, id), ops: [{ op: "set", path: ["openPageFlags"], value: 0 }], condition: when.present() });
    return resolved;
  }

  async function writeBuild(project: string, record: WikiBuildRecord): Promise<void> {
    const name = projectOf(project);
    const build = parsed(WikiBuildRecordSchema, record);
    await store.put({ item: { ...wikiBuildKey(companyId, name, build.buildId), entityType: WIKI_BUILD_ENTITY, ...rowBase(name), build } as unknown as StoredDocument });
  }
  async function readBuild(project: string, buildId: string): Promise<WikiBuildRecord | undefined> {
    const name = projectOf(project);
    return readRow(BuildRow, await store.get(wikiBuildKey(companyId, name, idOf(buildId))), name)?.build;
  }
  async function lastBuild(project: string): Promise<WikiBuildRecord | undefined> {
    const name = projectOf(project);
    const builds = (await family(name, WIKI_SK.build)).map((item) => readRow(BuildRow, item, name)!.build);
    return builds.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.buildId.localeCompare(a.buildId))[0];
  }

  async function writeAnswer(project: string, input: WikiAnswerRecordWrite): Promise<WikiAnswerRecord> {
    const name = projectOf(project);
    await expireAnswers(name);
    const answer = parsed(WikiAnswerRecordWriteSchema, { ...input, sources: Array.isArray(input.sources) ? input.sources.map((citation) => ({ ...citation, quote: typeof citation.quote === "string" ? storedQuote(citation.quote) : citation.quote })) : input.sources });
    const nowMs = now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = Math.floor(nowMs / 1000) + ANSWER_TTL_SECONDS;
    const written = await store.put({ item: { ...wikiAnswerKey(companyId, name, answer.answerId), entityType: WIKI_ANSWER_ENTITY, ...rowBase(name), answer, createdAt, expiresAt } as unknown as StoredDocument, condition: when.absent() });
    if (!written.applied) throw new WikiStoreError("conflict", "That answer is already recorded.");
    return { ...answer, createdAt, expiresAt };
  }
  async function readAnswer(project: string, answerId: string): Promise<WikiAnswerRecord | undefined> {
    const name = projectOf(project);
    const row = readRow(AnswerRow, await store.get(wikiAnswerKey(companyId, name, idOf(answerId))), name);
    // A record past its time may still be in the table until the sweep removes it: it is gone for every reader from that moment.
    if (row === undefined || row.expiresAt * 1000 <= now()) return undefined;
    return { ...row.answer, createdAt: row.createdAt, expiresAt: row.expiresAt, ...(row.notRight === true ? { notRight: true } : {}) };
  }

  async function listAnswers(project: string, scanMax: number): Promise<{ records: WikiAnswerRecord[]; more: boolean }> {
    const name = projectOf(project);
    const most = parsed(z.number().int().min(1).max(1_000), scanMax);
    const records: WikiAnswerRecord[] = [];
    let seen = 0;
    let more = false;
    let cursor: string | undefined;
    do {
      const page = await store.query({ pk: wikiPartition(companyId, name), sk: { op: "beginsWith", prefix: WIKI_SK.answer }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) {
        if (seen >= most) { more = true; break; }
        seen += 1;
        const row = readRow(AnswerRow, item, name)!;
        if (row.expiresAt * 1000 <= now()) continue;
        records.push({ ...row.answer, createdAt: row.createdAt, expiresAt: row.expiresAt, ...(row.notRight === true ? { notRight: true } : {}) });
      }
      cursor = more ? undefined : page.cursor;
    } while (cursor !== undefined);
    return { records, more };
  }

  async function markAnswerNotRight(project: string, answerId: string, personId: string): Promise<"marked" | "already" | undefined> {
    const name = projectOf(project);
    const person = parsed(WikiPersonIdSchema, personId);
    const key = wikiAnswerKey(companyId, name, idOf(answerId));
    const row = readRow(AnswerRow, await store.get(key), name);
    // Another person's record and an expired one are "not there".
    if (row === undefined || row.expiresAt * 1000 <= now() || row.answer.askedBy !== person) return undefined;
    if (row.notRight === true) return "already";
    const done = await store.update({ key, ops: [{ op: "set", path: ["notRight"], value: true }], condition: when.eq("expiresAt", row.expiresAt) });
    return done.applied ? "marked" : undefined;
  }

  // Expiry is app-driven (no table TTL): an expired record reads as gone at once, and this bounded sweep deletes expired rows (every answer write runs it; J1 or a scheduled job can too).
  async function expireAnswers(project: string, limit: number = WIKI_ANSWER_SWEEP_MAX): Promise<number> {
    const name = projectOf(project);
    const most = parsed(z.number().int().min(1).max(WIKI_ANSWER_SWEEP_MAX), limit);
    const nowSeconds = now() / 1000;
    let swept = 0;
    let scanned = 0;
    let cursor: string | undefined;
    do {
      const page = await store.query({ pk: wikiPartition(companyId, name), sk: { op: "beginsWith", prefix: WIKI_SK.answer }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) {
        // One sweep reads at most ten times its delete bound, so an answer write never walks a whole large project.
        if (swept >= most || ++scanned > most * 10) return swept;
        const row = readRow(AnswerRow, item, name)!;
        if (row.expiresAt > nowSeconds) continue;
        await store.delete({ key: keyOf(name, item), condition: when.eq("expiresAt", row.expiresAt) });
        swept += 1;
      }
      cursor = page.cursor;
    } while (cursor !== undefined && swept < most);
    return swept;
  }

  async function erasePerson(projects: readonly string[], personId: string): Promise<WikiPersonErasure> {
    const person = parsed(WikiPersonIdSchema, personId);
    const names = projects.map(projectOf);
    const done: WikiPersonErasure = { notes: 0, reasons: 0, answers: 0 };
    for (const name of names) {
      for (const item of await family(name, WIKI_SK.note)) {
        const row = readRow(NoteRow, item, name)!;
        if (row.note.authorId === person) {
          await store.delete({ key: keyOf(name, item) });
          done.notes += 1;
        } else if (row.note.approval.state === "approved" && row.note.approval.by === person) {
          // Someone else's note they approved stays approved, but no longer names them.
          await store.put({ item: { ...item, note: { ...row.note, approval: { ...row.note.approval, by: WIKI_FORMER_MEMBER } } } as unknown as StoredDocument, condition: when.present() });
        }
      }
      for (const item of await family(name, WIKI_SK.build)) {
        const row = readRow(BuildRow, item, name)!;
        if (row.build.startedBy !== person) continue;
        await store.put({ item: { ...item, build: { ...row.build, startedBy: WIKI_FORMER_MEMBER } } as unknown as StoredDocument, condition: when.present() });
      }
      for (const item of await family(name, WIKI_SK.flag)) {
        const row = readRow(FlagRow, item, name)!;
        if (row.flag.by.kind !== "person" || row.flag.by.personId !== person) continue;
        // The mark stays (it says the page was wrong), but it no longer names the person or keeps their words.
        const { reason, ...rest } = row.flag;
        await store.put({ item: { ...item, flag: { ...rest, by: { kind: "person", personId: WIKI_FORMER_MEMBER } } } as unknown as StoredDocument, condition: when.present() });
        if (reason !== undefined) done.reasons += 1;
      }
      for (const item of await family(name, WIKI_SK.answer)) {
        const row = readRow(AnswerRow, item, name)!;
        if (row.answer.askedBy !== person) continue;
        await store.delete({ key: keyOf(name, item) });
        done.answers += 1;
      }
    }
    return done;
  }

  function pageSink(project: string): WikiPageSink {
    const name = projectOf(project);
    return {
      companyId,
      project: name,
      putPage: async (page) => await writePage(name, page),
      deletePages: async (pageIds) => {
        const ids = parsed(z.array(WikiPageIdSchema).max(WIKI_LIMITS.pagesPerProject), pageIds);
        let deleted = 0;
        for (const id of ids) if ((await deletePageRows(name, id)).deleted) deleted += 1;
        return deleted;
      },
      listPages: async () => await readIndex(name),
    };
  }

  return { companyId, pageSink, readIndex, readPage, writePage, markClaims, deletePage, deleteRepository, pruneRepositories, deleteWiki, addNote, approveNote, deleteNote, addFlag, resolveFlags, writeBuild, readBuild, lastBuild, writeAnswer, readAnswer, listAnswers, markAnswerNotRight, expireAnswers, erasePerson };
}
