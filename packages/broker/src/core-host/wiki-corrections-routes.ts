// Lead 4 C1 (DEC 254zh/254zi): the project wiki's CORRECTION routes on the deployed developer API, AS the signed-in person. The contract (paths, bodies, answers, fixed words) is contracts/src/wiki-corrections.ts;
// the store is W2's (core/wiki/store.ts).
//
// Rules:
//  - The caller's role comes ONLY from live membership (`wiring.projectRole`: a company owner or admin is a `maintainer` of every project; a project grant gives `maintainer` or `contributor`; a
//    role the install knows as `viewer` reads only). It is read on every request, before the body is looked at, and never from a body, a query or a header. A person who is not on the project,
//    a project the company does not have and another company's project all get the same 404 "project not found", so a company's project names cannot be probed.
//  - Who may do what: any project role reads (the corrections page, and so sees only the controls the role can use); a contributor or above adds notes and marks pages or claims wrong; only a maintainer
//    approves a note, resolves marks and reads the disputed list; a note is deleted or suggested as a lesson by its author (still a contributor or above) or by a maintainer.
//  - A note is PENDING when added: people see it at once, agents never until a maintainer approves it (the store's agent read leaves pending notes out). Approval records who and when. The approver
//    may be the note's author when they are a maintainer.
//  - "Suggest as a lesson" never approves anything: it writes one pending lesson (core/wiki/note-lesson.ts) that the lessons library's own approval decides. The author named on the lesson is the note's author.
//  - A mark on a claim or a page hides it from agents at once (the store). The reason is the person's own words: shown to maintainers on the disputed list, never to agents, erased with the person.
//  - Disputed: a mark still open after the page was written again (the rewrite made the same claim, so it stays hidden). Maintainers only.
//  - A repository no longer in the project has its pages deleted before anything is read or written (`pruneRepositories`), as on the read routes.
//  - Refusals are fixed words; nothing a caller sent is echoed; a store fault is a fixed 503.
import {
  WIKI_ACTION_FAILED, WIKI_BAD_REQUEST, WIKI_LESSONS_OFF, WIKI_LESSON_REFUSED, WIKI_NEEDS_MAINTAINER, WIKI_NEEDS_WORKING_ROLE, WIKI_NOT_A_RULE, WIKI_NOTE_NOT_FOUND, WIKI_NOTE_NOT_YOURS,
  WIKI_NO_SUCH_CLAIM, WIKI_PAGE_NOT_FOUND, WIKI_PROJECT_NOT_FOUND, WIKI_TOO_MANY, WIKI_UNAVAILABLE,
  WikiAddNoteRequestSchema, WikiCorrectionsResponseSchema, WikiDisputedResponseSchema, WikiIdSchema, WikiMarkWrongRequestSchema, WikiMarkedResponseSchema, WikiNoBodySchema, WikiNoteAddedResponseSchema,
  WikiNoteApprovedResponseSchema, WikiNoteDeletedResponseSchema, WikiPageIdSchema, WikiProjectSchema, WikiResolvedResponseSchema, WikiSuggestedResponseSchema, wikiNoteLooksLikeRule,
  AgentXError, agentXError, redactText, type DocumentStore, type OrgId, type ProjectRole, type WikiNote, type WikiPageRead, type WikiStore, type WikiYouCan,
} from "@agentx/contracts";
import type { z } from "zod";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { WIKI_FORMER_MEMBER, WikiStoreError, createWikiStore } from "../core/wiki/store.js";
import type { WikiNoteLessonInput, WikiNoteLessonResult } from "../core/wiki/note-lesson.js";
import { WIKI_FORMER_MEMBER_NAME } from "./wiki-routes.js";

/** What the deployment wires for the corrections (aws/core-engine-root.ts). */
export interface HostedWikiCorrectionsWiring {
  /**
   * The person's role on the project in THIS company, read live from membership: a live owner or admin of the company is a `maintainer`; otherwise the project grant (`maintainer`, `contributor`) or a
   * `viewer`; undefined when the person is not a live member of this company or has no role on the project. Throws when it cannot be read.
   */
  projectRole(personId: string, companyId: OrgId, project: string): Promise<ProjectRole | undefined>;
  /** The names of the project's repositories now, or undefined when the company has no such project. Throws when it cannot be read. */
  projectRepositories(companyId: OrgId, project: string): Promise<readonly string[] | undefined>;
  /** A person's display name now. Absent or unknown: "a former member". */
  displayName?: ((personId: string) => Promise<string | undefined>) | undefined;
  /**
   * Writes the pending lesson for a note (core/wiki/note-lesson.ts). Absent where lessons are off for the company: the route says so and the corrections page does not offer the button. A throw is
   * a fixed "try again".
   */
  suggestLesson?: ((input: WikiNoteLessonInput) => Promise<WikiNoteLessonResult>) | undefined;
}

export interface HostedWikiCorrectionsInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  personId: string;
  /** The member company the dev routes mounted. */
  companyId: OrgId;
  store: DocumentStore;
  wiring: HostedWikiCorrectionsWiring;
  now: () => number;
}

const BASE = "^/v1/app/projects/([^/]+)/wiki/";
const ROUTES: ReadonlyArray<{ method: "GET" | "POST"; action: Action; pattern: RegExp }> = [
  { method: "GET", action: "corrections", pattern: new RegExp(`${BASE}pages/([^/]+)/corrections$`, "u") },
  { method: "POST", action: "add_note", pattern: new RegExp(`${BASE}pages/([^/]+)/notes$`, "u") },
  { method: "POST", action: "approve_note", pattern: new RegExp(`${BASE}pages/([^/]+)/notes/([^/]+)/approve$`, "u") },
  { method: "POST", action: "delete_note", pattern: new RegExp(`${BASE}pages/([^/]+)/notes/([^/]+)/delete$`, "u") },
  { method: "POST", action: "suggest_lesson", pattern: new RegExp(`${BASE}pages/([^/]+)/notes/([^/]+)/suggest-lesson$`, "u") },
  { method: "POST", action: "mark_wrong", pattern: new RegExp(`${BASE}pages/([^/]+)/flags$`, "u") },
  { method: "POST", action: "resolve_marks", pattern: new RegExp(`${BASE}pages/([^/]+)/flags/resolve$`, "u") },
  { method: "GET", action: "disputed", pattern: new RegExp(`${BASE}disputed$`, "u") },
];
type Action = "corrections" | "add_note" | "approve_note" | "delete_note" | "suggest_lesson" | "mark_wrong" | "resolve_marks" | "disputed";

/** Whether this method and path is one of the correction routes. */
export function isWikiCorrectionPath(path: string, method: string): boolean {
  return ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

const BODY_MAX = 16_384;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const projectNotFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_PROJECT_NOT_FOUND);
const pageNotFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_PAGE_NOT_FOUND);
const noteNotFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_NOTE_NOT_FOUND);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", WIKI_UNAVAILABLE);
const badRequest = (): AgentXError => agentXError("CONFIG_INVALID", WIKI_BAD_REQUEST);
const forbidden = (message: string): AgentXError => agentXError("FORBIDDEN", message);

/** A person's words are stored with anything key-shaped redacted (a pasted secret never reaches a page, an agent or a lesson). */
const redacted = (text: string): string => redactText(text).trim();

const isWorking = (role: ProjectRole): boolean => role === "maintainer" || role === "contributor";
const isMaintainer = (role: ProjectRole): boolean => role === "maintainer";
export function wikiYouCan(role: ProjectRole): WikiYouCan {
  return { role, addNote: isWorking(role), markWrong: isWorking(role), approveNotes: isMaintainer(role), resolveMarks: isMaintainer(role), seeDisputed: isMaintainer(role) };
}

function bodyOf<S extends z.ZodTypeAny>(request: BrokerRequest, schema: S): z.infer<S> {
  const text = request.body;
  if (text !== undefined && text.length > BODY_MAX) throw badRequest();
  let value: unknown = {};
  if (text !== undefined && text !== "") { try { value = JSON.parse(text); } catch { throw badRequest(); } }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest();
  return parsed.data;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw error instanceof AgentXError ? error : unavailable(); }
}

/** One request on a correction path (`isWikiCorrectionPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedWikiCorrections(input: HostedWikiCorrectionsInput): Promise<BrokerResponse> {
  try {
    const route = ROUTES.find((candidate) => candidate.method === input.request.method && candidate.pattern.test(input.path));
    const match = route?.pattern.exec(input.path);
    if (route === undefined || match === null || match === undefined) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw projectNotFound(); }
    if (!WikiProjectSchema.safeParse(project).success) throw projectNotFound();
    // The role first: live, from membership. No role (or not in this company) is the same 404 as a project the company does not have.
    let role: ProjectRole | undefined;
    try { role = await input.wiring.projectRole(input.personId, input.companyId, project); } catch { throw unavailable(); }
    if (role !== "maintainer" && role !== "contributor" && role !== "viewer") throw projectNotFound();
    let repositories: readonly string[] | undefined;
    try { repositories = await input.wiring.projectRepositories(input.companyId, project); } catch { throw unavailable(); }
    if (!Array.isArray(repositories)) throw projectNotFound();
    // What the role may not do is refused before anything else is looked at (a body, a page, a note).
    if ((route.action === "add_note" || route.action === "mark_wrong" || route.action === "delete_note" || route.action === "suggest_lesson") && !isWorking(role)) throw forbidden(WIKI_NEEDS_WORKING_ROLE);
    if ((route.action === "approve_note" || route.action === "resolve_marks" || route.action === "disputed") && !isMaintainer(role)) throw forbidden(WIKI_NEEDS_MAINTAINER);
    const store = createWikiStore({ store: input.store, companyId: input.companyId, now: input.now });
    const ctx: Ctx = { input, store, project, role, repositories };
    await guarded(async () => await store.pruneRepositories(project, repositories));
    if (route.action === "disputed") return json(200, await disputedAnswer(ctx));
    let pageId: string;
    try { pageId = decodeURIComponent(match[2]!); } catch { throw pageNotFound(); }
    if (!WikiPageIdSchema.safeParse(pageId).success) throw pageNotFound();
    let noteId: string | undefined;
    if (match[3] !== undefined) {
      try { noteId = decodeURIComponent(match[3]); } catch { throw noteNotFound(); }
      if (!WikiIdSchema.safeParse(noteId).success) throw noteNotFound();
    }
    switch (route.action) {
      case "corrections": return json(200, await correctionsAnswer(ctx, pageId));
      case "add_note": return json(200, await addNote(ctx, pageId));
      case "approve_note": return json(200, await approveNote(ctx, pageId, noteId!));
      case "delete_note": return json(200, await deleteNote(ctx, pageId, noteId!));
      case "suggest_lesson": return json(200, await suggestLesson(ctx, pageId, noteId!));
      case "mark_wrong": return json(200, await markWrong(ctx, pageId));
      case "resolve_marks": return json(200, await resolveMarks(ctx, pageId));
    }
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(unavailable());
  }
}

interface Ctx { input: HostedWikiCorrectionsInput; store: WikiStore; project: string; role: ProjectRole; repositories: readonly string[] }

async function readPerson(ctx: Ctx, pageId: string): Promise<WikiPageRead> {
  const read = await guarded(async () => await ctx.store.readPage(ctx.project, pageId, "person"));
  if (read === undefined) throw pageNotFound();
  return read;
}

async function nameOf(ctx: Ctx, personId: string): Promise<string> {
  if (personId === WIKI_FORMER_MEMBER || ctx.input.wiring.displayName === undefined) return WIKI_FORMER_MEMBER_NAME;
  try { return (await ctx.input.wiring.displayName(personId)) ?? WIKI_FORMER_MEMBER_NAME; } catch { return WIKI_FORMER_MEMBER_NAME; }
}

/** The note on this page, or a refusal. The page's own notes only: a note id from another page, project or company is "not there". */
function noteOf(read: WikiPageRead, noteId: string): WikiNote {
  const note = read.notes.find((candidate) => candidate.noteId === noteId);
  if (note === undefined) throw noteNotFound();
  return note;
}

/** A note is deleted or suggested as a lesson by its author (still a contributor or above: checked by the caller) or by a maintainer. */
function mayHandleNote(ctx: Ctx, note: WikiNote): boolean {
  return isMaintainer(ctx.role) || (isWorking(ctx.role) && note.authorId === ctx.input.personId);
}

/** The file a note is tied to has changed: a claim of this page that cites it is `changed` or `not_found`. */
function fileChanged(read: WikiPageRead, file: { repo: string; path: string }): boolean {
  return read.page.claims.some((claim) => claim.source !== "found" && claim.citations.some((citation) => citation.repo === file.repo && citation.path === file.path));
}

async function correctionsAnswer(ctx: Ctx, pageId: string) {
  const read = await readPerson(ctx, pageId);
  const personId = ctx.input.personId;
  const lessonsOffered = ctx.input.wiring.suggestLesson !== undefined;
  const notes = read.notes.map((note) => {
    const mine = note.authorId === personId;
    return {
      noteId: note.noteId, mine,
      canDelete: mayHandleNote(ctx, note),
      canApprove: isMaintainer(ctx.role) && note.approval.state === "pending",
      canSuggestLesson: lessonsOffered && mayHandleNote(ctx, note) && wikiNoteLooksLikeRule(note.text) && note.authorId !== WIKI_FORMER_MEMBER,
      // Only the note's author and the maintainers are asked to check a note whose file changed.
      mayBeOutOfDate: (mine || isMaintainer(ctx.role)) && note.file !== undefined && fileChanged(read, note.file),
    };
  }).sort((a, b) => a.noteId.localeCompare(b.noteId));
  return WikiCorrectionsResponseSchema.parse({ project: ctx.project, pageId, you: wikiYouCan(ctx.role), notes });
}

async function addNote(ctx: Ctx, pageId: string) {
  const body = bodyOf(ctx.input.request, WikiAddNoteRequestSchema);
  const read = await readPerson(ctx, pageId);
  // A note may be tied only to a file of a repository the page is about.
  if (body.file !== undefined && !read.page.repos.some((entry) => entry.repo === body.file!.repo)) throw badRequest();
  const note = await guarded(async () => {
    try { return await ctx.store.addNote(ctx.project, { pageId, text: redacted(body.text), authorId: ctx.input.personId, ...(body.file === undefined ? {} : { file: body.file }) }); } catch (error) { throw storeRefusal(error); }
  });
  return WikiNoteAddedResponseSchema.parse({
    note: { noteId: note.noteId, text: note.text, author: await nameOf(ctx, note.authorId), createdAt: note.createdAt, ...(note.file === undefined ? {} : { file: note.file }), approval: note.approval.state },
  });
}

async function approveNote(ctx: Ctx, pageId: string, noteId: string) {
  const approved = await guarded(async () => {
    try { return await ctx.store.approveNote(ctx.project, pageId, noteId, ctx.input.personId); } catch (error) { throw storeRefusal(error); }
  });
  if (approved === undefined) throw noteNotFound();
  return WikiNoteApprovedResponseSchema.parse({ noteId: approved.noteId, approval: approved.approval.state });
}

async function deleteNote(ctx: Ctx, pageId: string, noteId: string) {
  const note = noteOf(await readPerson(ctx, pageId), noteId);
  if (!mayHandleNote(ctx, note)) throw forbidden(WIKI_NOTE_NOT_YOURS);
  const gone = await guarded(async () => await ctx.store.deleteNote(ctx.project, pageId, noteId));
  if (!gone) throw noteNotFound();
  return WikiNoteDeletedResponseSchema.parse({ deleted: true });
}

async function suggestLesson(ctx: Ctx, pageId: string, noteId: string) {
  const note = noteOf(await readPerson(ctx, pageId), noteId);
  if (!mayHandleNote(ctx, note)) throw forbidden(WIKI_NOTE_NOT_YOURS);
  const suggest = ctx.input.wiring.suggestLesson;
  if (suggest === undefined) throw agentXError("NOT_FOUND", WIKI_LESSONS_OFF);
  // A note whose author is gone cannot name them on a lesson.
  if (note.authorId === WIKI_FORMER_MEMBER) throw agentXError("CONFIG_INVALID", WIKI_LESSON_REFUSED);
  const result = await guarded(async () => await suggest({ companyId: ctx.input.companyId, project: ctx.project, noteId: note.noteId, authorId: note.authorId, text: note.text, ...(note.file === undefined ? {} : { file: note.file }) }));
  if (result.state === "off") throw agentXError("NOT_FOUND", WIKI_LESSONS_OFF);
  if (result.state === "too_long") throw agentXError("CONFIG_INVALID", WIKI_NOT_A_RULE);
  if (result.state === "refused") throw agentXError("CONFIG_INVALID", WIKI_LESSON_REFUSED);
  return WikiSuggestedResponseSchema.parse({ state: result.state, lessonId: result.lessonId });
}

async function markWrong(ctx: Ctx, pageId: string) {
  const body = bodyOf(ctx.input.request, WikiMarkWrongRequestSchema);
  const read = await readPerson(ctx, pageId);
  const personId = ctx.input.personId;
  // The same person marking the same claim (or page) again is the same mark, not a second one.
  const same = read.flags.find((flag) => flag.by?.kind === "person" && flag.by.personId === personId && flag.claimId === body.claimId);
  if (same !== undefined) return WikiMarkedResponseSchema.parse({ flagId: same.flagId, pageId, ...(body.claimId === undefined ? {} : { claimId: body.claimId }) });
  const flag = await guarded(async () => {
    try { return await ctx.store.addFlag(ctx.project, { pageId, ...(body.claimId === undefined ? {} : { claimId: body.claimId }), by: { kind: "person", personId }, ...(body.reason === undefined ? {} : { reason: redacted(body.reason) }) }); } catch (error) { throw storeRefusal(error); }
  });
  return WikiMarkedResponseSchema.parse({ flagId: flag.flagId, pageId, ...(flag.claimId === undefined ? {} : { claimId: flag.claimId }) });
}

async function resolveMarks(ctx: Ctx, pageId: string) {
  bodyOf(ctx.input.request, WikiNoBodySchema);
  await readPerson(ctx, pageId);
  const resolved = await guarded(async () => await ctx.store.resolveFlags(ctx.project, pageId));
  return WikiResolvedResponseSchema.parse({ resolved });
}

const DISPUTED_PAGES_AT_ONCE = 8;
async function disputedAnswer(ctx: Ctx) {
  const index = await guarded(async () => await ctx.store.readIndex(ctx.project));
  const items: Array<Record<string, unknown>> = [];
  for (let from = 0; from < index.length; from += DISPUTED_PAGES_AT_ONCE) {
    const reads = await guarded(async () => await Promise.all(index.slice(from, from + DISPUTED_PAGES_AT_ONCE).map(async (entry) => await ctx.store.readPage(ctx.project, entry.pageId, "person"))));
    for (const read of reads) {
      if (read === undefined) continue;
      // Disputed: still open although the page was written after the mark (the rewrite made the same claim again).
      for (const flag of read.flags) {
        if (flag.createdAt === undefined || flag.by === undefined || flag.createdAt >= read.page.writtenAt) continue;
        const claim = flag.claimId === undefined ? undefined : read.page.claims.find((candidate) => candidate.claimId === flag.claimId);
        if (flag.claimId !== undefined && claim === undefined) continue;
        const markedBy = flag.by.kind === "person" ? await nameOf(ctx, flag.by.personId) : flag.by.kind === "task" ? "a task step" : "an answer";
        items.push({
          flagId: flag.flagId, pageId: read.page.pageId, pageTitle: read.page.title, ...(claim === undefined ? {} : { claimId: claim.claimId, claimText: claim.text }), markedBy, markedAt: flag.createdAt,
          ...(flag.reason === undefined ? {} : { reason: flag.reason }),
        });
      }
    }
  }
  items.sort((a, b) => String(a["markedAt"]).localeCompare(String(b["markedAt"])) || String(a["flagId"]).localeCompare(String(b["flagId"])));
  return WikiDisputedResponseSchema.parse({ project: ctx.project, items });
}

/** A store refusal in the route's fixed words (a refusal never echoes what the caller sent). */
function storeRefusal(error: unknown): unknown {
  if (!(error instanceof WikiStoreError)) return error;
  if (error.code === "no_such_page") return pageNotFound();
  if (error.code === "no_such_claim") return agentXError("CONFIG_INVALID", WIKI_NO_SUCH_CLAIM);
  if (error.code === "too_many") return agentXError("IDEMPOTENCY_CONFLICT", WIKI_TOO_MANY);
  if (error.code === "invalid") return badRequest();
  if (error.code === "conflict") return agentXError("IDEMPOTENCY_CONFLICT", WIKI_ACTION_FAILED);
  return error;
}
