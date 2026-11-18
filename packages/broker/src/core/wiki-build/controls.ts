// Wiki W4: the controls on a project's setup page, shared by the hosted routes (core-host/wiki-build-routes.ts) and the laptop's (local/app/wiki-build.ts): Build, Stop, Continue, Refresh now,
// "Give the wiki to agents", Delete wiki, and the one state view the page reads. Every function here takes the caller's standing from `deps.build.standing` (read live on each call) and
// checks it itself; the routes only add the 404 for a project the person has no role on.
//
//   - Who: start, continue, stop, refresh, switch and delete need `manage` (a company owner or admin, or the project's administrator); the state is read by any role on the project.
//   - Money: Build, Continue and Refresh now are the build run's own (run.ts): the project pays, the build has its own cap, no AI key means "Connect an AI key" and nothing is written.
//   - Refresh now is the same entry as Build (`startWikiBuild`), with a filter on its plan: the pages whose cited files changed, the pages people marked wrong (as a whole or one claim), and planned pages with no page yet.
//   - Delete wiki removes EVERYTHING the project's wiki has: W2's `deleteWiki` (pages, notes, flags, build records, answers), A1's `deleteWikiUse` (the agents switch and the per-task reports, so a
//     project made again under the same name never inherits the switch) and the build run's own rows (pointer, notes, done pages, cached verdicts). The pointer goes FIRST, so a worker that is
//     still running cannot write a page into a wiki that was just deleted (its next callback is refused). A running build must be stopped first.
//   - `deleteProjectWiki` is the one call a project's removal makes (Cloud's project erase walk): the same three deletes without a person's standing, for a caller that already is the erase.
import {
  OrgIdSchema, WIKI_BUILD_WORDS, WIKI_CONTROLS_WORDS, WikiAgentSwitchBodySchema, WikiDeleteBodySchema, WikiProjectSchema, WikiRefreshBodySchema, agentXError, queryAll, when,
  type DocumentStore, type OrgId, type WikiAiKeyState, type WikiControlsExtra, type WikiIndexEntry, type WikiStore,
} from "@agentx/contracts";
import { deleteWikiUse, setWikiAgentSwitch, wikiAgentSwitchIsOn, type WikiAgentOptions } from "../wiki/agent-context.js";
import { createWikiStore } from "../wiki/store.js";
import { wikiBuildPartition, wikiBuildRowKey } from "./keys.js";
import { continueWikiBuild, readWikiBuildPointer, startWikiBuild, stopWikiBuild, wikiBuildState, type WikiBuildDeps, type WikiBuildView } from "./run.js";

/**
 * What an audit record names. `token` is the state the act found (the run's task id, the switch's old value, the wiki's last build) AND the time of the act: it goes into the record's event id,
 * so a REUSED request id that acts again (a second flip of the switch, the same flip after two others, a delete after a rebuild) always gets its own record. Only a repeat in the very same
 * millisecond records once; a client's retry may record twice, which loses nothing (the audit sink dedupes by event id, and an act must never hide behind an earlier record).
 */
export interface WikiControlDetails { requestId: string; on?: boolean; token: string }

export type WikiControlAction = "start_requested" | "continue_requested" | "stop_requested" | "refresh_requested" | "agents_switched" | "delete_requested";

export interface WikiControlsDeps {
  /** The build run's seams (the starter, the standing, the key, the map, the heads, the limits). `build.store` and `build.companyId` are the company's own. */
  build: WikiBuildDeps;
  /** The company's wiki store (W2). */
  wiki: WikiStore;
  /** The company's wiki use rows (A1): the switch and the per-task reports. */
  agents: WikiAgentOptions;
  /**
   * The audit record of an act or a request for one, written BEFORE it (an act whose record cannot be written is not done). Absent on a laptop. A repeat of a request id records once (the event id names it).
   * Throws when it could not write.
   */
  record?: ((action: WikiControlAction, project: string, details: WikiControlDetails) => Promise<void>) | undefined;
}

export type WikiControlsView = WikiBuildView & WikiControlsExtra;

type Access = "manage" | "view" | "none";

async function accessOf(deps: WikiControlsDeps, personId: string, project: string): Promise<Access> {
  try {
    const standing = await deps.build.standing(personId, project);
    return standing.access === "manage" ? "manage" : standing.access === "view" ? "view" : "none";
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unreadable);
  }
}

/** The caller manages the project's wiki, or the same refusals as the build run: a person with no role reads "project not found", a reader is refused in fixed words. */
async function requireManage(deps: WikiControlsDeps, personId: string, project: string): Promise<void> {
  let access: Access;
  try { access = await accessOf(deps, personId, project); } catch { throw agentXError("FORBIDDEN", WIKI_CONTROLS_WORDS.notAllowed); }
  if (access === "none") throw agentXError("PROJECT_NOT_FOUND", WIKI_CONTROLS_WORDS.projectNotFound);
  if (access !== "manage") throw agentXError("FORBIDDEN", WIKI_CONTROLS_WORDS.notAllowed);
}

async function recorded(deps: WikiControlsDeps, action: WikiControlAction, project: string, details: WikiControlDetails): Promise<void> {
  if (deps.record === undefined) return;
  try { await deps.record(action, project, details); } catch { throw agentXError("AUDIT_UNAVAILABLE", WIKI_CONTROLS_WORDS.auditUnavailable); }
}

/** A body that is not the strict one is refused in fixed words (nothing of it is echoed). */
function bodyOf<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the request is not valid");
  return parsed.data;
}

/**
 * A page is out of date when someone marked it wrong as a whole, a cited claim changed, or someone marked one of its CLAIMS wrong since the page was last written. A claim mark older than the page
 * (a refresh already rewrote the page and kept the claim: "disputed") does not pick it up again, so Refresh now never rewrites the same page over and over for a mark it already looked at.
 * `marks` is the store's bounded read of open claim marks; when it could not read them all (`complete` false), every page counts, never a partial answer.
 */
interface ClaimMarks { complete: boolean; latest: Map<string, number> }
const isStale = (entry: WikiIndexEntry, marks: ClaimMarks): boolean => {
  if (entry.flagged || entry.claims.changed > 0 || !marks.complete) return true;
  const marked = marks.latest.get(entry.pageId);
  // `>=` on purpose: a mark made in the same millisecond as the write counts (one extra rewrite at most; the rewrite moves writtenAt forward).
  return marked !== undefined && marked >= Date.parse(entry.writtenAt);
};

async function claimMarksOf(deps: WikiControlsDeps, project: string): Promise<ClaimMarks> {
  try {
    const read = await deps.wiki.openClaimFlagPages(project);
    return { complete: read.complete, latest: new Map(read.pages.map((entry) => [entry.pageId, Date.parse(entry.latestAt)])) };
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unreadable); }
}

/** The task id of the project's current or last build run, or "none": the state a start, continue, stop or refresh found. */
async function runToken(deps: WikiControlsDeps, project: string): Promise<string> {
  try { return `${(await readWikiBuildPointer(deps.build.store, deps.build.companyId, project))?.taskId ?? "none"}@${String(deps.build.now())}`; } catch { return `unread@${String(deps.build.now())}`; }
}

async function indexOf(deps: WikiControlsDeps, project: string): Promise<WikiIndexEntry[]> {
  try { return await deps.wiki.readIndex(project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unreadable); }
}

/** The AI key as this install can tell: no gateway at all is `missing`; the rest is the seam's answer (`unknown` when it cannot say). */
async function aiKeyOf(deps: WikiControlsDeps): Promise<WikiAiKeyState> {
  if (!deps.build.modelAccessConfigured) return "missing";
  try { return await deps.build.aiKey(); } catch { return "unknown"; }
}

/** The state the setup page reads: the build run's own view plus what the controls show beside it. Any role on the project reads it; a person with none reads "project not found". */
export async function wikiControlsView(deps: WikiControlsDeps, personId: string, project: string): Promise<WikiControlsView> {
  const access = await accessOf(deps, personId, project);
  if (access === "none") throw agentXError("PROJECT_NOT_FOUND", WIKI_CONTROLS_WORDS.projectNotFound);
  const [build, index, marks, key, on] = await Promise.all([wikiBuildState(deps.build, project), indexOf(deps, project), claimMarksOf(deps, project), aiKeyOf(deps), wikiAgentSwitchIsOn(deps.agents, project)]);
  return {
    ...build, canManage: access === "manage", aiKey: key, ...(key === "missing" ? { connectKey: WIKI_BUILD_WORDS.connectKey } : {}),
    agents: { on }, wiki: { pages: index.length, refreshPages: index.filter((entry) => isStale(entry, marks)).length },
  };
}

type Answer = { status: 200 | 202; view: WikiControlsView };
const withView = async (deps: WikiControlsDeps, personId: string, project: string, status: 200 | 202): Promise<Answer> => ({ status, view: await wikiControlsView(deps, personId, project) });

/** Build the wiki (the build run's start). The body is the run's own strict one: a request id, optional notes and chips. */
export async function startWikiControl(deps: WikiControlsDeps, personId: string, project: string, rawBody: unknown): Promise<Answer> {
  const requestId = requestIdOf(rawBody);
  // The run checks the body, the standing, the key and the map; the record comes after the standing is known and before anything starts.
  await requireManage(deps, personId, project);
  if (requestId !== undefined) await recorded(deps, "start_requested", project, { requestId, token: await runToken(deps, project) });
  const done = await startWikiBuild(deps.build, personId, project, rawBody);
  return withView(deps, personId, project, done.status);
}

export async function continueWikiControl(deps: WikiControlsDeps, personId: string, project: string, rawBody: unknown): Promise<Answer> {
  const requestId = requestIdOf(rawBody);
  await requireManage(deps, personId, project);
  if (requestId !== undefined) await recorded(deps, "continue_requested", project, { requestId, token: await runToken(deps, project) });
  const done = await continueWikiBuild(deps.build, personId, project, rawBody);
  return withView(deps, personId, project, done.status);
}

export async function stopWikiControl(deps: WikiControlsDeps, personId: string, project: string, rawBody: unknown): Promise<Answer> {
  const requestId = requestIdOf(rawBody);
  await requireManage(deps, personId, project);
  if (requestId !== undefined) await recorded(deps, "stop_requested", project, { requestId, token: await runToken(deps, project) });
  const done = await stopWikiBuild(deps.build, personId, project, rawBody);
  return withView(deps, personId, project, done.status);
}

/**
 * Refresh now: a new build run over what is out of date. It needs a wiki (pages) to refresh, reads the default branches again (a fresh map, so the commits it pins are today's), and writes
 * only the planned pages that are flagged (the page or one of its claims), have changed claims, or have no page yet. Every other page is left as it is. Nothing to refresh is a fixed refusal and starts nothing.
 */
export async function refreshWikiControl(deps: WikiControlsDeps, personId: string, project: string, rawBody: unknown): Promise<Answer> {
  const body = bodyOf(WikiRefreshBodySchema, rawBody);
  await requireManage(deps, personId, project);
  const index = await indexOf(deps, project);
  if (index.length === 0) throw agentXError("CONFIG_INVALID", WIKI_CONTROLS_WORDS.buildFirst);
  const marks = await claimMarksOf(deps, project);
  const have = new Set(index.map((entry) => entry.pageId));
  const stale = new Set(index.filter((entry) => isStale(entry, marks)).map((entry) => entry.pageId));
  await recorded(deps, "refresh_requested", project, { requestId: body.requestId, token: await runToken(deps, project) });
  const done = await startWikiBuild(deps.build, personId, project, { requestId: body.requestId }, { refresh: { include: (page) => !have.has(page.id) || stale.has(page.id) } });
  return withView(deps, personId, project, done.status);
}

/** "Give the wiki to agents": turns A1's switch on or off. The row is the project's own (company and project in its key). */
export async function agentsSwitchControl(deps: WikiControlsDeps, personId: string, project: string, rawBody: unknown): Promise<Answer> {
  const body = bodyOf(WikiAgentSwitchBodySchema, rawBody);
  await requireManage(deps, personId, project);
  await recorded(deps, "agents_switched", project, { requestId: body.requestId, on: body.on, token: `${String(await wikiAgentSwitchIsOn(deps.agents, project))}>${String(body.on)}@${String(deps.build.now())}` });
  try { await setWikiAgentSwitch(deps.agents, project, body.on); } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unreadable); }
  return withView(deps, personId, project, 200);
}

/** Every row of the build run's own partition for this company and project (pointer, notes, done pages, cached verdicts). Answers how many went. */
export async function deleteWikiBuildRows(store: Pick<DocumentStore, "query" | "delete">, scope: { orgId: OrgId; project: string }): Promise<number> {
  const orgId = OrgIdSchema.parse(scope.orgId);
  const project = WikiProjectSchema.parse(scope.project);
  const pk = wikiBuildPartition({ orgId, project });
  const items = await queryAll(store, { pk });
  // The pointer first: a worker that is still running is refused at its next callback, so it cannot write a page after the wiki is gone.
  const ordered = [...items.filter((item) => item.sk === "RUN"), ...items.filter((item) => item.sk !== "RUN")];
  for (const item of ordered) {
    if (item.pk !== pk) continue;
    // The pointer goes only while it is the run that was read: a build started a moment ago keeps its pointer (a start after the delete is a start, not part of it).
    await store.delete({ key: wikiBuildRowKey({ orgId, project }, item.sk), ...(item.sk === "RUN" && typeof item["taskId"] === "string" ? { condition: when.eq("taskId", item["taskId"]) } : {}) });
  }
  return items.length;
}

export interface ProjectWikiDeletion { buildRows: number; wikiRows: number; useRows: number }

/**
 * Deletes everything the project's wiki keeps, for this company only: the build run's rows, then W2's wiki rows, then A1's switch and task reports. "Delete wiki" calls it, and so must a
 * project's removal (Cloud's project erase walk), so a project made again under the same name starts with no wiki and the agents switch OFF. Safe to repeat.
 */
export async function deleteProjectWiki(options: { store: DocumentStore; companyId: OrgId; now: () => number }, project: string): Promise<ProjectWikiDeletion> {
  const buildRows = await deleteWikiBuildRows(options.store, { orgId: options.companyId, project });
  const wikiRows = await createWikiStore({ store: options.store, companyId: options.companyId, now: options.now }).deleteWiki(project);
  const useRows = await deleteWikiUse({ store: options.store, companyId: options.companyId, now: options.now }, project);
  return { buildRows, wikiRows, useRows };
}

/** Delete wiki. A running build must be stopped first (fixed words). */
export async function deleteWikiControl(deps: WikiControlsDeps, personId: string, project: string, rawBody: unknown, options: { store: DocumentStore; now: () => number }): Promise<{ status: 200; deleted: ProjectWikiDeletion; message: string; view: WikiControlsView }> {
  const body = bodyOf(WikiDeleteBodySchema, rawBody);
  await requireManage(deps, personId, project);
  if ((await wikiBuildState(deps.build, project)).status === "running") throw agentXError("WORKSPACE_BUSY", WIKI_CONTROLS_WORDS.deleteWhileRunning);
  const last = await deps.wiki.lastBuild(project).catch(() => undefined);
  await recorded(deps, "delete_requested", project, { requestId: body.requestId, token: `${last?.buildId ?? "none"}:${String((await indexOf(deps, project)).length)}@${String(deps.build.now())}` });
  let deleted: ProjectWikiDeletion;
  try { deleted = await deleteProjectWiki({ store: options.store, companyId: deps.build.companyId, now: options.now }, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unreadable); }
  return { status: 200, deleted, message: WIKI_CONTROLS_WORDS.deleted, view: await wikiControlsView(deps, personId, project) };
}

/** The request id of a body, if it has a usable one (the run's own schema refuses the rest; this only names the audit record). */
function requestIdOf(raw: unknown): string | undefined {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["requestId"] : undefined;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) ? value : undefined;
}
