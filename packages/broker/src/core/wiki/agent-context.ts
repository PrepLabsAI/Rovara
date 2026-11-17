// Lead 4 A1 (DEC 254zh/254zi; wiki design review fixes 5 and 8): the broker's side of "agents get the wiki".
//
//  - The switch "Give the wiki to agents" is one row per company AND project (`wikiAgentSwitchKey`). OFF until a person turns it on: no row means off, and a row that cannot be read means off
//    (never "on by accident"). W4's route calls `setWikiAgentSwitch` (who may is that route's check); nothing here decides who.
//  - `buildWikiContext` makes the `wikiContext` of a task step, at delivery, from ONE project's pages as W2's store gives them to an agent (`readPage(project, id, "agent")`: no pending note, no
//    flagged or not-found claim, no flagged page). It adds its own rules on top: only pages whose repositories are all still in the project, no page mostly out of date by the store's own
//    freshness marks, a fixed priority and a size budget. It reads only; it never prunes or deletes (a removed repository's pages are simply not given).
//  - The project comes from the task (the caller passes the task's own project), the company from the store's fixed company. A page of another project cannot be reached: the store's key is built from both.
//  - The worker's report is filed per company, project AND task (`wikiUseKey`), under the operation's own ref (`wikiUseRefKey`, written at delivery), so a report can only land on the task the
//    delivery was for. Information only: a lost report loses only a "pages this task read" line.
import {
  INDEX_EXPIRY_ATTRIBUTE, WIKI_AGENT_LIMITS, WikiAgentPageSchema, WikiContextSchema, WikiUseRefRowSchema, WikiUseRowSchema, WikiAgentSwitchRowSchema, OrgIdSchema, queryAll, wikiAgentSwitchKey, wikiUseKey,
  wikiUsePartition, wikiUseRefKey, wikiUseRowKey, wikiReadReportOfProgress, wikiModeAllows,
  type DocumentStore, type OrgId, type WikiAgentPage, type WikiContext, type WikiIndexEntry, type WikiPageKind, type WikiPageRead, type WikiReadReport,
} from "@agentx/contracts";
import { workspaceKeys } from "../task-flow/workspace-location.js";
import { createWikiStore } from "./store.js";

type AgentStore = Pick<DocumentStore, "get" | "getMany" | "put" | "update" | "delete" | "query" | "transact">;
export interface WikiAgentOptions { store: AgentStore; companyId: OrgId; now: () => number }

/** The use rows are kept as long as the lessons' use rows are. */
const USE_KEEP_SECONDS = 180 * 86_400;
/** The delivery ref only has to outlive the operation. */
const REF_KEEP_SECONDS = 30 * 86_400;

// ---- The switch --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the project gives its wiki to agents. Off when there is no row, and off when the row cannot be read or names another company or project. */
export async function wikiAgentSwitchIsOn(options: WikiAgentOptions, project: string): Promise<boolean> {
  try {
    const companyId = OrgIdSchema.parse(options.companyId);
    const row = await options.store.get(wikiAgentSwitchKey(companyId, project));
    if (row === undefined) return false;
    const parsed = WikiAgentSwitchRowSchema.safeParse(row);
    return parsed.success && parsed.data.companyId === companyId && parsed.data.project === project && parsed.data.on === true;
  } catch {
    return false;
  }
}

/** Turns the switch on or off for one project of the company. The caller (W4's route) has already checked that the person may. */
export async function setWikiAgentSwitch(options: WikiAgentOptions, project: string, on: boolean): Promise<void> {
  const companyId = OrgIdSchema.parse(options.companyId);
  const key = wikiAgentSwitchKey(companyId, project);
  await options.store.put({ item: { ...key, entityType: "WIKI_AGENT_SWITCH", companyId, project, on, changedAt: new Date(options.now()).toISOString() } });
}

// ---- The context -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The order pages are placed in when the budget is short: the map first, then the repositories, then the rest. */
const KIND_RANK: Readonly<Record<WikiPageKind, number>> = { overview: 0, connections: 1, repo: 2, module: 3, data_flow: 4, how_to_run: 5, patterns: 6, glossary: 7, docs: 8 };

/** Whether the page is too out of date to give: more of its cited claims than the share are marked `changed` by the store's freshness check. */
function mostlyStale(entry: WikiIndexEntry): boolean {
  const total = entry.claims.found + entry.claims.changed;
  return total > 0 && entry.claims.changed / total > WIKI_AGENT_LIMITS.mostlyStaleShare;
}

/** The agent copy of a page read (exported for its test). A second wall behind the store's agent view: a pending note or a not-found claim is left out here too. */
export function agentPageOf(read: WikiPageRead): WikiAgentPage | undefined {
  const { page } = read;
  const candidate = {
    pageId: page.pageId, kind: page.kind, title: page.title, summary: page.summary, ...(page.parentId === undefined ? {} : { parentId: page.parentId }), order: page.order, repos: page.repos,
    blocks: page.blocks,
    claims: page.claims.filter((claim) => claim.source !== "not_found").map((claim) => ({ claimId: claim.claimId, source: claim.source, citations: claim.citations })),
    notes: read.notes.filter((note) => note.approval.state === "approved").slice(0, WIKI_AGENT_LIMITS.notesPerPage).map((note) => ({ noteId: note.noteId, text: note.text })),
    staleBlockIds: read.staleBlockIds,
  };
  const parsed = WikiAgentPageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The wiki the task's step is given, or undefined when there is nothing to give: the switch is off, the project has no page the agent may read, or anything could not be read (the step
 * then runs as it would without the wiki). `repositories` are the names of the project's repositories NOW (its revision the task runs on).
 */
export async function buildWikiContext(options: WikiAgentOptions, input: { project: string; repositories: readonly string[] }): Promise<WikiContext | undefined> {
  try {
    if (!(await wikiAgentSwitchIsOn(options, input.project))) return undefined;
    const wiki = createWikiStore(options);
    const current = new Set(input.repositories);
    const index = await wiki.readIndex(input.project);
    const candidates = index
      .filter((entry) => !entry.flagged && entry.repos.every((repo) => current.has(repo.repo)) && !mostlyStale(entry))
      .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.order - b.order || a.pageId.localeCompare(b.pageId));
    const pages: WikiAgentPage[] = [];
    let bytes = 0;
    const envelope = Buffer.byteLength(JSON.stringify({ v: 1, project: input.project, pages: [], leftOut: 10_000 }), "utf8");
    for (const entry of candidates) {
      if (pages.length >= WIKI_AGENT_LIMITS.pages) break;
      const read = await wiki.readPage(input.project, entry.pageId, "agent");
      if (read === undefined) continue;
      const page = agentPageOf(read);
      if (page === undefined) continue;
      const size = Buffer.byteLength(JSON.stringify(page), "utf8") + 1;
      if (envelope + bytes + size > WIKI_AGENT_LIMITS.contextBytes) continue;
      pages.push(page);
      bytes += size;
    }
    if (pages.length === 0) return undefined;
    const parsed = WikiContextSchema.safeParse({ v: 1, project: input.project, pages, leftOut: Math.max(0, index.length - pages.length) });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ---- The delivery seam and the report ------------------------------------------------------------------------------------------------------------------------------------------------------

export interface WikiStepRequest { companyId: string; project: string; taskId: string; operationId: string; workflowMode: string | undefined; repositories: readonly string[] }
export type WikiForStep = (input: WikiStepRequest) => Promise<{ wikiContext?: WikiContext }>;

/**
 * The seam the task flow calls when it builds a task step's invocation (`TaskFlowDeps.wiki`): bound to ONE company; a request that names another company's workspace gets nothing. The delivery
 * is noted under the operation (company, project, task) so the worker's report is filed on the right task; a failure to note it only loses the report.
 */
export function createWikiForStep(options: WikiAgentOptions): WikiForStep {
  return async (input) => {
    try {
      if (input.companyId !== options.companyId || !wikiModeAllows(input.workflowMode)) return {};
      const wikiContext = await buildWikiContext(options, { project: input.project, repositories: input.repositories });
      if (wikiContext === undefined) return {};
      const ttl = Math.floor(options.now() / 1000) + REF_KEEP_SECONDS;
      await options.store.put({ item: { ...wikiUseRefKey(options.companyId, input.project, input.operationId), entityType: "WIKI_AGENT_USE_REF", companyId: options.companyId, project: input.project, taskId: input.taskId, operationId: input.operationId, [INDEX_EXPIRY_ATTRIBUTE]: ttl } }).catch(() => undefined);
      return { wikiContext };
    } catch {
      return {};
    }
  };
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/**
 * Files the worker's reports of one operation under its task: the pages given and the pages the agent opened (a set; each page once). Only an operation this company's delivery noted counts, and a
 * report that names another project than the delivery's is dropped, so a report can neither land on another task nor in another project. Never throws.
 */
export async function recordWikiReports(options: WikiAgentOptions, input: { project: string; operationId: string; reports: readonly WikiReadReport[] }): Promise<void> {
  try {
    const companyId = OrgIdSchema.parse(options.companyId);
    const ref = WikiUseRefRowSchema.safeParse(await options.store.get(wikiUseRefKey(companyId, input.project, input.operationId)));
    if (!ref.success || ref.data.companyId !== companyId || ref.data.project !== input.project || ref.data.operationId !== input.operationId) return;
    const mine = input.reports.filter((report) => report.project === input.project).slice(0, 20);
    if (mine.length === 0) return;
    const key = wikiUseKey(companyId, input.project, ref.data.taskId);
    const existing = WikiUseRowSchema.safeParse(await options.store.get(key));
    const was = existing.success && existing.data.companyId === companyId && existing.data.project === input.project && existing.data.taskId === ref.data.taskId ? existing.data : undefined;
    const given = union(was?.given ?? [], mine.filter((report) => report.phase === "given").flatMap((report) => report.pages.map((page) => page.pageId)));
    const read = union(was?.read ?? [], mine.filter((report) => report.phase === "read").flatMap((report) => report.pages.map((page) => page.pageId)));
    const cap = WIKI_AGENT_LIMITS.pages * 2;
    const expires = Math.floor(options.now() / 1000) + USE_KEEP_SECONDS;
    await options.store.put({ item: { ...key, entityType: "WIKI_AGENT_USE", companyId, project: input.project, taskId: ref.data.taskId, given: given.slice(0, cap), read: read.slice(0, cap), updatedAt: new Date(options.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: expires } });
  } catch { /* information only */ }
}

/** The reports in a batch of worker events (progress events carrying `wikiReadReport`). */
export function wikiReportsOfEvents(events: ReadonlyArray<{ type: string; payload: unknown }>): WikiReadReport[] {
  return events.slice(0, 500).flatMap((event) => (event.type === "progress" ? [wikiReadReportOfProgress(event.payload)] : [])).flatMap((report) => (report === undefined ? [] : [report]));
}

/**
 * The callback layer's hook for a step's worker events (the hosted broker composes it with the lessons' one): files the step's wiki reports under its task. The project comes from the operation's own
 * workspace record in this company (never from an event), and a workspace of another company is nobody's. Never throws.
 */
export function createWikiOnEvents(options: WikiAgentOptions): (operation: { workspaceId: string; id: string }, events: ReadonlyArray<{ type: string; payload: unknown }>) => Promise<void> {
  return async (operation, events) => {
    try {
      const reports = wikiReportsOfEvents(events);
      if (reports.length === 0) return;
      const workspace = await options.store.get((await workspaceKeys({ store: options.store, companyId: options.companyId }, operation.workspaceId)).workspaceKey);
      if (workspace === undefined || workspace["companyId"] !== options.companyId || typeof workspace["projectName"] !== "string") return;
      await recordWikiReports(options, { project: workspace["projectName"], operationId: operation.id, reports });
    } catch { /* information only */ }
  };
}

export interface WikiTaskUse { given: string[]; read: string[] }
/** What a task's agents were given and read of this project's wiki, or undefined when nothing was recorded (or the row does not belong to this company, project and task). */
export async function readWikiTaskUse(options: WikiAgentOptions, input: { project: string; taskId: string }): Promise<WikiTaskUse | undefined> {
  try {
    const companyId = OrgIdSchema.parse(options.companyId);
    const row = WikiUseRowSchema.safeParse(await options.store.get(wikiUseKey(companyId, input.project, input.taskId)));
    if (!row.success || row.data.companyId !== companyId || row.data.project !== input.project || row.data.taskId !== input.taskId) return undefined;
    return { given: row.data.given, read: row.data.read };
  } catch {
    return undefined;
  }
}

/** Deletes everything this slice keeps for one project (the switch, the delivery refs and the task reports): "Delete wiki" and a removed project call it. Answers how many rows went. */
export async function deleteWikiUse(options: WikiAgentOptions, project: string): Promise<number> {
  const companyId = OrgIdSchema.parse(options.companyId);
  const items = await queryAll(options.store, { pk: wikiUsePartition(companyId, project) });
  for (const item of items) await options.store.delete({ key: wikiUseRowKey(companyId, project, item.sk) });
  return items.length;
}
