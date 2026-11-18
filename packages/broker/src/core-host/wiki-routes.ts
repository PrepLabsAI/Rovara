// Lead 4 W2 (DEC 254zh/254zi): the project wiki's READ routes on the deployed developer API, for Cloud's Wiki tab, AS the signed-in person:
//
//   GET /v1/app/projects/{project}/wiki                           the page index and the last build's state
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}            one page: prose, claims (never their quotes), notes (pending ones marked), how many open "Mark wrong" flags
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}/sources    the files and lines the page cites, at their commits (never their quotes)
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}/lessons    lead 4 L4-LP3W: the team's approved lessons an agent is told in this page's area (the same units the agent's look-up answers), or none
//
// Rules:
//  - The company is the caller's LIVE membership (the dev routes check it and mount that company's runtime); the store is made for that company only, so every key is the company's and
//    the project's (`wikiPartition`). No route reads across projects or companies; there is no company-wide wiki read.
//  - Who reads: any project role. A live owner or admin of the company, or a person with a grant on the project (the setup run's `lifecycleAccess` standing: `manage` or `view`). Anyone
//    else, a project the company does not have, a malformed name and another company's project all get the same 404 "project not found". A missing page is its own fixed 404.
//  - A script token never reaches these routes (the dev routes refuse it before this file; the MCP `wiki` permission is M1's). Nothing here writes.
//  - A repository no longer in the project (removed, whichever path removed it) has its pages and every cross-repo page naming it deleted before the read (`pruneRepositories`).
//  - People never see a stored quote, a flag's author or reason, or a claim id's text beyond the claim: the answers are built field by field and parsed with the contract's strict schemas.
//  - Refusals are fixed words; nothing a caller sent is echoed, and a store fault is a fixed 503.
import {
  WIKI_PAGE_NOT_FOUND, WIKI_PROJECT_NOT_FOUND, WIKI_TRUST_LINE, WIKI_UNAVAILABLE, WikiIndexResponseSchema, WikiPageIdSchema, WikiPageResponseSchema, WikiProjectSchema, WikiSourcesResponseSchema,
  AgentXError, TEAM_LESSONS_NOTE, TeamLessonsAnswerSchema, agentXError, type DocumentStore, type OrgId, type TeamLessonsAnswer, type WikiIndexResponse, type WikiPageResponse, type WikiSourcesResponse, type WikiStore,
} from "@agentx/contracts";
import type { LoadDeps } from "../lessons/load.js";
import { teamLessonRowOf, teamLessonsForArea } from "../lessons/team-lessons.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { WIKI_FORMER_MEMBER, createWikiStore } from "../core/wiki/store.js";
import type { SetupRunStanding } from "./setup-run-routes.js";
import { companyProjects } from "./lessons.js";

/** How a note's author is named when they have no name now (gone, erased, or unreadable). */
export const WIKI_FORMER_MEMBER_NAME = "a former member";

/** What the deployment wires for the wiki reads (aws/core-engine-root.ts). */
export interface HostedWikiWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's: membership and the project grant). Throws when it cannot be read. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** The names of the project's repositories now (its latest revision), or undefined when the company has no such project. Throws when it cannot be read. */
  projectRepositories(companyId: OrgId, project: string): Promise<readonly string[] | undefined>;
  /** A person's display name now, for a note's author. Absent or unknown: "a former member". */
  displayName?: ((personId: string) => Promise<string | undefined>) | undefined;
  /**
   * Lead 4 L4-LP3W: the lessons library of THIS company (its own runtime's load dependencies), for the page's "Team lessons for this area". Absent, or undefined for the company (lessons off): that path says "route not found".
   * It is asked for the member company only, so another company's lessons are never in reach.
   */
  lessonsOf?: ((companyId: OrgId) => LoadDeps | undefined) | undefined;
}

export interface HostedWikiInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  personId: string;
  /** The member company the dev routes mounted. */
  companyId: OrgId;
  store: DocumentStore;
  wiring: HostedWikiWiring;
  now: () => number;
}

const WIKI_PATH = /^\/v1\/app\/projects\/([^/]+)\/wiki(?:\/pages\/([^/]+)(\/sources|\/lessons)?)?$/u;

/** Whether this method and path is one of the wiki reads. */
export function isWikiPath(path: string, method: string): boolean {
  return method === "GET" && WIKI_PATH.test(path);
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const projectNotFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_PROJECT_NOT_FOUND);
const pageNotFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_PAGE_NOT_FOUND);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", WIKI_UNAVAILABLE);

/** Whether the person may read the project's wiki: any role on it (a company owner or admin manages every project). Anything but the known answers is no. */
async function mayRead(input: HostedWikiInput, project: string): Promise<boolean> {
  let standing: SetupRunStanding | undefined;
  try { standing = await input.wiring.standing(input.personId, input.companyId, project); } catch { throw unavailable(); }
  return standing?.access === "manage" || standing?.access === "view";
}

/** One request on a wiki read path (`isWikiPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedWiki(input: HostedWikiInput): Promise<BrokerResponse> {
  try {
    const match = input.request.method === "GET" ? WIKI_PATH.exec(input.path) : null;
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw projectNotFound(); }
    if (!WikiProjectSchema.safeParse(project).success) throw projectNotFound();
    if (!(await mayRead(input, project))) throw projectNotFound();
    let repositories: readonly string[] | undefined;
    try { repositories = await input.wiring.projectRepositories(input.companyId, project); } catch { throw unavailable(); }
    if (!Array.isArray(repositories)) throw projectNotFound();
    const store = createWikiStore({ store: input.store, companyId: input.companyId, now: input.now });
    // A repository removed from the project leaves nothing behind: its pages, and every cross-repo page naming it, go before anything is read.
    await guarded(async () => await store.pruneRepositories(project, repositories));
    if (match[2] === undefined) return json(200, await indexAnswer(store, project));
    let pageId: string;
    try { pageId = decodeURIComponent(match[2]); } catch { throw pageNotFound(); }
    if (!WikiPageIdSchema.safeParse(pageId).success) throw pageNotFound();
    const answer = match[3] === undefined ? await pageAnswer(input, store, project, pageId)
      : match[3] === "/sources" ? await sourcesAnswer(store, project, pageId) : await lessonsAnswer(input, store, project, pageId);
    if (answer === undefined) throw pageNotFound();
    return json(200, answer);
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(unavailable());
  }
}

async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch { throw unavailable(); }
}

async function indexAnswer(store: WikiStore, project: string): Promise<WikiIndexResponse> {
  const [pages, last] = await guarded(async () => await Promise.all([store.readIndex(project), store.lastBuild(project)]));
  return WikiIndexResponseSchema.parse({
    project, state: pages.length === 0 ? "empty" : "ready", pages,
    ...(last === undefined ? {} : { lastBuild: { buildId: last.buildId, kind: last.kind, state: last.state, startedAt: last.startedAt, ...(last.endedAt === undefined ? {} : { endedAt: last.endedAt }), ...(last.stopReason === undefined ? {} : { stopReason: last.stopReason }) } }),
  });
}

async function pageAnswer(input: HostedWikiInput, store: WikiStore, project: string, pageId: string): Promise<WikiPageResponse | undefined> {
  const read = await guarded(async () => await store.readPage(project, pageId, "person"));
  if (read === undefined) return undefined;
  const flaggedClaims = new Set(read.flags.filter((flag) => flag.claimId !== undefined).map((flag) => flag.claimId!));
  const nameOf = async (personId: string): Promise<string> => {
    if (personId === WIKI_FORMER_MEMBER || input.wiring.displayName === undefined) return WIKI_FORMER_MEMBER_NAME;
    try { return (await input.wiring.displayName(personId)) ?? WIKI_FORMER_MEMBER_NAME; } catch { return WIKI_FORMER_MEMBER_NAME; }
  };
  const notes = await Promise.all(read.notes.map(async (note) => ({
    noteId: note.noteId, text: note.text, author: await nameOf(note.authorId), createdAt: note.createdAt, ...(note.file === undefined ? {} : { file: { repo: note.file.repo, path: note.file.path } }), approval: note.approval.state,
  })));
  const { page } = read;
  return WikiPageResponseSchema.parse({
    project,
    page: {
      pageId: page.pageId, kind: page.kind, title: page.title, summary: page.summary, ...(page.parentId === undefined ? {} : { parentId: page.parentId }), repos: page.repos, writtenAt: page.writtenAt, blocks: page.blocks,
      claims: page.claims.map((claim) => ({
        claimId: claim.claimId, text: claim.text, source: claim.source, flagged: flaggedClaims.has(claim.claimId),
        citations: claim.citations.map((citation) => ({ repo: citation.repo, path: citation.path, commit: citation.commit, line: citation.line, ...(citation.lineEnd === undefined ? {} : { lineEnd: citation.lineEnd }) })),
      })),
    },
    notes: notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.noteId.localeCompare(b.noteId)),
    openFlags: read.flags.length,
    trustLine: WIKI_TRUST_LINE,
  });
}

async function sourcesAnswer(store: WikiStore, project: string, pageId: string): Promise<WikiSourcesResponse | undefined> {
  const read = await guarded(async () => await store.readPage(project, pageId, "person"));
  if (read === undefined) return undefined;
  const files = new Map<string, { repo: string; path: string; commit: string; ranges: Array<{ line: number; lineEnd?: number }>; claimIds: string[] }>();
  for (const claim of read.page.claims) {
    for (const citation of claim.citations) {
      const key = JSON.stringify([citation.repo, citation.path, citation.commit]);
      const file = files.get(key) ?? { repo: citation.repo, path: citation.path, commit: citation.commit, ranges: [], claimIds: [] };
      if (!file.ranges.some((range) => range.line === citation.line && range.lineEnd === citation.lineEnd)) file.ranges.push({ line: citation.line, ...(citation.lineEnd === undefined ? {} : { lineEnd: citation.lineEnd }) });
      if (!file.claimIds.includes(claim.claimId)) file.claimIds.push(claim.claimId);
      files.set(key, file);
    }
  }
  return WikiSourcesResponseSchema.parse({ project, pageId, files: [...files.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path)) });
}

/** Lead 4 L4-LP3W: the page's area and the team's lessons an agent is told there. A page about no single area, or a company with no lessons wired, answers an empty list (or the route is not found when lessons are not wired). */
async function lessonsAnswer(input: HostedWikiInput, store: WikiStore, project: string, pageId: string): Promise<TeamLessonsAnswer | undefined> {
  const deps = input.wiring.lessonsOf?.(input.companyId);
  if (deps === undefined) throw agentXError("NOT_FOUND", "route not found");
  const read = await guarded(async () => await store.readPage(project, pageId, "person"));
  if (read === undefined) return undefined;
  const citedPaths = read.page.claims.flatMap((claim) => claim.citations.map((citation) => citation.path)).slice(0, 200);
  const found = await teamLessonsForArea(deps, { key: { workspaceId: input.companyId, project }, target: { page: { pageId, kind: read.page.kind, repos: read.page.repos.map((entry) => entry.repo), citedPaths } } });
  if (found === undefined) throw unavailable();
  return TeamLessonsAnswerSchema.parse({
    project, pageId, ...(found.area === undefined ? {} : { area: found.area }),
    lessons: found.lessons.map(teamLessonRowOf), moreLessons: found.more, note: TEAM_LESSONS_NOTE,
  });
}

/**
 * The person erase's wiki step on a deployed install (`PersonEraseDeps.eraseWiki`): the person's notes and saved answer records are deleted and their "Mark wrong" reasons removed, in every
 * project of the company. Rejects when it could not finish (the erase is then repeated or resumed).
 */
export function hostedEraseWiki(input: { store: DocumentStore; now: () => number }): (companyId: string, personId: string) => Promise<unknown> {
  return async (companyId, personId) => {
    const company = companyId;
    // A catalog name that is not a project name can hold no wiki partition (`wikiPartition` refuses it), so it has nothing to erase.
    const projects = (await companyProjects(input.store, company)).filter((name) => WikiProjectSchema.safeParse(name).success);
    return await createWikiStore({ store: input.store, companyId: company, now: input.now }).erasePerson(projects, personId);
  };
}
