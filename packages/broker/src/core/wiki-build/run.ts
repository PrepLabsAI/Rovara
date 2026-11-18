// Wiki W3: the build run, broker side. A build is a task with purpose `wiki_build` (wired into the task flow and the worker by the follow-up PR); this module decides everything about it
// that is not the agent's reading: who may start, stop and continue it, what it costs at most, which commits it reads, which page comes next, and what is kept of each page.
//
// Shape (copied from the setup run, core/setup-agent/agent.ts):
//   - ONE run per project: the pointer (`RUN` row) is written in the task's start transaction and only while it is the one the start read (`seenTaskId`); two starts at once: one is refused.
//   - THE LIMITS are fixed at start (the project's setting cut to the company's lock) and kept on the pointer; nothing in a request body sets them.
//   - THE PAYER is the project (its monthly limit), never the person who pressed Build (review fix 3); the build cap is the run's own `budgetCents`.
//   - THE COMMITS are fixed at start: the default branch's head of each repository as the broker reads it. Every page is handed out and checked at those commits; a continued run keeps them.
//   - No AI key connected: the start is refused with "Connect an AI key" and nothing is written (review fix 9).
//
// The page loop (the worker's callback calls these; each page is one grant and one answer):
//   `nextWikiPage`   re-reads who started the run (must still be allowed), the stop, the clock, the page limit and the cap: a page is granted only when spend + the page's reserve fits under
//                    the cap (`wikiPageFits`). One page is out at a time; asking again while it is out answers the same page.
//   `submitWikiPage` takes the worker's answer for the granted page only, re-checks every citation (check.ts) and writes what survived through the page sink. A page is "done" only once the
//                    sink wrote it (or nothing on it survived), so a stop at any point keeps every finished page and a continue never writes them again.
import {
  WIKI_BUILD_PAYER_KIND, WIKI_BUILD_WORDS, WIKI_BUILD_WORKFLOW_MODE, WIKI_CONTROLS_WORDS, WikiBuildPinsSchema, WikiPageDraftSchema, agentXError, change, effectiveWikiBuildLimits, oneLineText, when, wikiPageFits,
  type DocumentStore, type JsonValue, type OrgId, type TransactItem, type WikiBuildEndWord, type WikiBuildLimits, type WikiBuildPins, type WikiBuildRecord, type WikiBuildSummary, type WikiFileMap,
  type WikiPagePlan, type WikiPageSink,
} from "@agentx/contracts";
import { z } from "zod";
import type { CitationFileReader } from "../citations/citation-check.js";
import { checkWikiPage, storeCheckCache } from "./check.js";
import { wikiBuildNotesKey, wikiBuildPartition, wikiBuildRunKey, wikiExpiryOf, wikiPageDoneKey, type WikiRunScope } from "./keys.js";
import { planWikiPages } from "./plan.js";
import { releaseWikiBuildSlot, reserveWikiBuildSlot, type WikiCompanySlot } from "./company-cap.js";
import { cleanWikiNotes, frameWikiNotes, wikiPageInstructions } from "./prompt.js";

/** The operation mode of a build run's own step (defined in the contract so the worker and the broker read one definition). */
export { WIKI_BUILD_WORKFLOW_MODE };
/** Grace after the run's clock before a run that never reported an end reads as failed. */
const STALE_GRACE_MIN = 60;

// ---- bodies (strict: limits, payer, commits and goal never come from the client)

export const WikiBuildStartBodySchema = z.object({
  requestId: z.string().uuid(),
  /** "Tell Rovara what matters" (folded, optional). Steers order only. */
  notes: z.string().max(4_000).optional(),
  /** The chips a person turned on (ids from the file map). Absent: the map's defaults. */
  chipsOn: z.array(z.string().min(1).max(80)).max(200).optional(),
}).strict();
export const WikiBuildContinueBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const WikiBuildStopBodySchema = z.object({ requestId: z.string().uuid() }).strict();

/** The worker's answer for one page. `spentCents` is the run's spend so far (whole cents, never less than before). */
export const WikiPageAnswerSchema = z.object({
  pageId: z.string().min(1).max(420),
  spentCents: z.number().int().min(0).max(1_000_000),
  draft: z.unknown().optional(),
  /** The worker could not write the page: the run ends with this word (a model key refused, a repository unreadable at its commit, its own spend reached the ceiling it was given, anything else). The page is not done: a continue writes it again. */
  failure: z.enum(["needs_ai_key", "repo_unreadable", "budget_used", "infrastructure"]).optional(),
}).strict();
export const WikiNextBodySchema = z.object({ spentCents: z.number().int().min(0).max(1_000_000) }).strict();

// ---- who may act

/** A person's standing on one project of their company, read live (the setup run's rule: company owners and admins, and the project's admins, manage; project users view). */
export type WikiBuildStanding = { access: "manage" } | { access: "view" | "none" };

// ---- the pointer

export interface WikiBuildPointer {
  /** Ownership of this run's slot on the existing company limit row. */
  companySlot?: WikiCompanySlot;
  orgId: OrgId;
  project: string;
  taskId: string;
  requestId: string;
  requestedBy: string;
  startedAt: string;
  limits: WikiBuildLimits;
  pins: WikiBuildPins;
  plan: WikiPagePlan[];
  /** Pages an earlier run of the same build (same commits) already finished; a continued run skips them. */
  keptFromEarlier: string[];
  continuedFrom?: string;
  /** Pages this run finished, in order. */
  doneIds: string[];
  pagesWritten: number;
  claimsKept: number;
  claimsDropped: number;
  /** What this run spent (the worker's metered session spend, never lowered). */
  spentCents: number;
  /** What earlier runs of the same build spent: a continue carries it, so the build cap holds across Stop and Continue. */
  spentEarlierCents: number;
  granted?: { pageId: string; at: string };
  stop?: { by: string; at: string };
  end?: { word: WikiBuildEndWord; at: string };
  payer: { kind: typeof WIKI_BUILD_PAYER_KIND; project: string };
  /** The store's build kind: the project's first wiki, or a rebuild of one ("Refresh now"). A continue keeps the kind of the run it continues. */
  buildKind: "first" | "refresh";
}

/** The pointer's write for the build's start transaction: holds only while the pointer is the one the start read, so two starts cannot both win. */
export function wikiBuildPointerItem(pointer: WikiBuildPointer, seenTaskId: string | undefined): TransactItem {
  return {
    kind: "put",
    item: { ...wikiBuildRunKey(pointer), entityType: "WIKI_BUILD_RUN", ...(JSON.parse(JSON.stringify(pointer)) as Record<string, JsonValue>) },
    condition: seenTaskId === undefined ? when.absent() : when.eq("taskId", seenTaskId),
  };
}

/** Reads the pointer of this company's project. Anything that is not a well-formed pointer of exactly this company and project reads as none. */
export async function readWikiBuildPointer(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string): Promise<WikiBuildPointer | undefined> {
  const item = await store.get(wikiBuildRunKey({ orgId, project }));
  if (item === undefined || item["entityType"] !== "WIKI_BUILD_RUN" || item["orgId"] !== orgId || item["project"] !== project || typeof item["taskId"] !== "string") return undefined;
  if (!WikiBuildPinsSchema.safeParse(item["pins"]).success || !Array.isArray(item["plan"]) || !Array.isArray(item["doneIds"])) return undefined;
  const pointer = item as unknown as WikiBuildPointer;
  // Limits that do not read are held to the defaults (never looser).
  // An earlier spend that does not read is unknown, and an unknown spend never fits (`wikiPageFits`): the run stops rather than spend past the cap.
  const earlier = item["spentEarlierCents"] === undefined ? 0 : typeof item["spentEarlierCents"] === "number" && Number.isSafeInteger(item["spentEarlierCents"]) && item["spentEarlierCents"] >= 0 ? item["spentEarlierCents"] : Number.NaN;
  return { ...pointer, limits: effectiveWikiBuildLimits(pointer.limits), keptFromEarlier: Array.isArray(pointer.keptFromEarlier) ? pointer.keptFromEarlier : [], spentEarlierCents: earlier };
}

// ---- the view

export const WIKI_BUILD_STATUSES = ["none", "running", "built", "stopped"] as const;
export type WikiBuildStatus = (typeof WIKI_BUILD_STATUSES)[number];

export interface WikiBuildView {
  status: WikiBuildStatus;
  limits: WikiBuildLimits;
  taskId?: string;
  startedAt?: string;
  stop?: WikiBuildEndWord;
  /** The fixed sentence for how it ended (never a worker's or model's words). */
  message?: string;
  summary?: WikiBuildSummary;
  /** True when a stopped build has pages left that "Continue" would write. */
  canContinue?: boolean;
  /** Which limit pays: always the project's monthly limit, with this build cap. */
  payer: "project";
  stoppedBy?: { name: string; at: string };
}

export interface WikiBuildReadDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The project's own build-limit setting (any shape) and the company's lock. */
  limitSetting?: ((project: string) => Promise<unknown>) | undefined;
  limitLock?: (() => Promise<unknown>) | undefined;
  displayName?: ((personId: string) => Promise<string | undefined>) | undefined;
}

/** What the whole build spent: earlier runs plus this one. NaN when an earlier spend did not read. */
function buildSpendOf(pointer: Pick<WikiBuildPointer, "spentCents" | "spentEarlierCents">): number {
  return pointer.spentEarlierCents + pointer.spentCents;
}

function remainingPages(pointer: WikiBuildPointer): WikiPagePlan[] {
  const done = new Set([...pointer.keptFromEarlier, ...pointer.doneIds]);
  return pointer.plan.filter((page) => !done.has(page.id));
}

function staleAt(pointer: WikiBuildPointer): number {
  return Date.parse(pointer.startedAt) + (pointer.limits.wallClockMin + STALE_GRACE_MIN) * 60_000;
}

/** The word a pointer ended with, including a run that never reported an end past its clock (stale: infrastructure). */
function endWordOf(pointer: WikiBuildPointer, now: number): WikiBuildEndWord | undefined {
  if (pointer.end !== undefined) return pointer.end.word;
  return Number.isFinite(staleAt(pointer)) && now > staleAt(pointer) ? (pointer.stop === undefined ? "infrastructure" : "stopped_by_person") : undefined;
}

export async function wikiBuildState(deps: WikiBuildReadDeps, project: string): Promise<WikiBuildView> {
  const pointer = await readWikiBuildPointer(deps.store, deps.companyId, project);
  if (pointer === undefined) return { status: "none", limits: effectiveWikiBuildLimits(await deps.limitSetting?.(project), await deps.limitLock?.()), payer: "project" };
  const summary: WikiBuildSummary = {
    pagesPlanned: pointer.plan.length, pagesWritten: pointer.pagesWritten, pagesKeptFromEarlier: pointer.keptFromEarlier.length,
    claimsKept: pointer.claimsKept, claimsDropped: pointer.claimsDropped, spentCents: buildSpendOf(pointer),
  };
  const base = { limits: pointer.limits, taskId: pointer.taskId, startedAt: pointer.startedAt, summary, payer: "project" as const };
  const word = endWordOf(pointer, deps.now());
  if (word === undefined) return { status: "running", ...base };
  const stoppedBy = word === "stopped_by_person" && pointer.stop !== undefined
    ? { stoppedBy: { name: oneLineText(await deps.displayName?.(pointer.stop.by).catch(() => undefined), 100) || "Unknown", at: pointer.stop.at } } : {};
  if (word === "built") return { status: "built", ...base, stop: word, message: WIKI_BUILD_WORDS.built };
  return { status: "stopped", ...base, stop: word, message: WIKI_BUILD_WORDS[word], canContinue: remainingPages(pointer).length > 0, ...stoppedBy };
}

// ---- start, continue, stop

/** The task flow's start and cancel, as a build run uses them (wired by the follow-up PR). */
export interface WikiBuildStarter {
  /**
   * Starts the run as a task of the caller with purpose `wiki_build`, paid by `payer` (the project), with the pointer's write (`pointerItemFor(taskId)`) in the start's own transaction.
   * A repeat of `requestId` answers the first run's task and starts nothing. A pointer that moved is `WORKSPACE_BUSY`. The task's preparation reads exactly `pins`.
   */
  start(request: {
    requestId: string; project: string; text: string; payer: { kind: typeof WIKI_BUILD_PAYER_KIND; project: string }; limits: WikiBuildLimits; pins: WikiBuildPins;
    pointerItemFor(taskId: string): TransactItem; notesItemFor(taskId: string): TransactItem | undefined;
  }): Promise<{ taskId: string; duplicate: boolean }>;
  cancel(request: { taskId: string; requestId: string }): Promise<void>;
}

export interface WikiBuildDeps extends WikiBuildReadDeps {
  starter: WikiBuildStarter | undefined;
  /** The caller's standing on the project, read live. Throws when it cannot be read (the action is refused). */
  standing(personId: string, project: string): Promise<WikiBuildStanding>;
  /** The install has a model gateway that meters and prices the run. False: refused ("Connect an AI key"). */
  modelAccessConfigured: boolean;
  /** Whether the company has an AI key connected, as the gateway says. "unknown": allowed (the gateway refuses at the first call and the run ends `needs_ai_key`). */
  aiKey(): Promise<"connected" | "missing" | "unknown">;
  /** The project's latest file map (W0), or undefined when none was made. */
  fileMap(project: string): Promise<WikiFileMap | undefined>;
  /** The default branch's head of each repository of the project, as the code host says now. A repository that cannot be read is left out. */
  defaultBranchHeads(project: string): Promise<Array<{ repo: string; commit: string }>>;
  /** An archived project takes no new work. */
  requireNewWork?(project: string): Promise<void>;
  /** The wiki store's build record write (W2), so the Wiki tab shows a build is running. A failed write never undoes the start. */
  recordBuild?: ((record: WikiBuildRecord) => Promise<void>) | undefined;
}

async function recordNow(deps: WikiBuildDeps, project: string): Promise<void> {
  if (deps.recordBuild === undefined) return;
  try {
    const pointer = await readWikiBuildPointer(deps.store, deps.companyId, project);
    if (pointer !== undefined) await deps.recordBuild(wikiBuildRecordOf(pointer));
  } catch { /* a view for people only */ }
}

/** The sentence the run's task is asked: the project's own name and nothing from a repository. */
export function wikiBuildRequestText(project: string): string {
  return `Build the project wiki for ${project} from its code.`;
}

/** Fixed words: nothing of the body (not even a field name it sent) is echoed. */
const bodyError = () => agentXError("CONFIG_INVALID", "the request is not valid");

async function requireManager(deps: WikiBuildDeps, personId: string, project: string): Promise<void> {
  let standing: WikiBuildStanding;
  try { standing = await deps.standing(personId, project); } catch { throw agentXError("FORBIDDEN", WIKI_BUILD_WORDS.notAllowed); }
  if (standing.access === "none") throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if (standing.access !== "manage") throw agentXError("FORBIDDEN", WIKI_BUILD_WORDS.notAllowed);
}

async function requireKey(deps: WikiBuildDeps): Promise<void> {
  if (!deps.modelAccessConfigured) throw agentXError("MODEL_PROXY_UNAVAILABLE", WIKI_BUILD_WORDS.connectKey);
  let key: "connected" | "missing" | "unknown";
  try { key = await deps.aiKey(); } catch { key = "unknown"; }
  if (key === "missing") throw agentXError("MODEL_PROXY_UNAVAILABLE", WIKI_BUILD_WORDS.connectKey);
}

async function launch(
  deps: WikiBuildDeps, personId: string, project: string, requestId: string,
  shape: {
    pins: WikiBuildPins; plan: WikiPagePlan[]; keptFromEarlier: string[]; continuedFrom?: string; notes: string | undefined; notesBy?: string; buildKind: "first" | "refresh"; spentEarlierCents: number;
  }, seenTaskId: string | undefined,
): Promise<string> {
  const starter = deps.starter!;
  const limits = effectiveWikiBuildLimits(await deps.limitSetting?.(project), await deps.limitLock?.());
  const startedAt = new Date(deps.now()).toISOString();
  const companySlot = await reserveWikiBuildSlot(deps.store, deps.companyId, project, Date.parse(startedAt), Date.parse(startedAt) + (limits.wallClockMin + STALE_GRACE_MIN) * 60_000);
  const payer = { kind: WIKI_BUILD_PAYER_KIND, project };
  const pointerFor = (taskId: string): WikiBuildPointer => ({
    companySlot, orgId: deps.companyId, project, taskId, requestId, requestedBy: personId, startedAt, limits, pins: shape.pins, plan: shape.plan, keptFromEarlier: shape.keptFromEarlier,
    ...(shape.continuedFrom === undefined ? {} : { continuedFrom: shape.continuedFrom }), doneIds: [], pagesWritten: 0, claimsKept: 0, claimsDropped: 0, spentCents: 0, spentEarlierCents: shape.spentEarlierCents, payer, buildKind: shape.buildKind,
  });
  try {
    const started = await starter.start({
      requestId, project, text: wikiBuildRequestText(project), payer, limits, pins: shape.pins,
      pointerItemFor: (taskId) => wikiBuildPointerItem(pointerFor(taskId), seenTaskId),
      notesItemFor: (taskId) => shape.notes === undefined ? undefined : {
        kind: "put", item: { ...wikiBuildNotesKey({ orgId: deps.companyId, project, taskId }), entityType: "WIKI_BUILD_NOTES", orgId: deps.companyId, project, taskId, by: shape.notesBy ?? personId, notes: shape.notes, ...wikiExpiryOf(deps.now()) },
        condition: when.absent(),
      },
    });
    if (started.duplicate) await releaseWikiBuildSlot(deps.store, deps.companyId, companySlot);
    return started.taskId;
  } catch (error) {
    // A failed response can follow a committed task start. The port's strongly
    // consistent read tells us whether the running task already owns this slot.
    const committed = await readWikiBuildPointer(deps.store, deps.companyId, project);
    if (committed?.companySlot?.token !== companySlot.token) await releaseWikiBuildSlot(deps.store, deps.companyId, companySlot);
    if (error instanceof Error && (error as { code?: unknown }).code === "WORKSPACE_BUSY") throw agentXError("WORKSPACE_BUSY", WIKI_BUILD_WORDS.busy);
    throw error;
  }
}

/**
 * Start a fresh build: plan from the file map, pin the default branches now, start the task. A repeat of the request id answers the first request. One run at a time.
 */
export async function startWikiBuild(
  deps: WikiBuildDeps, personId: string, project: string, rawBody: unknown,
  /** W4 "Refresh now": the run writes only the planned pages `include` accepts (the changed, the marked wrong and the not yet written), and is a refresh even when there was no earlier run. */
  options?: { refresh?: { include(page: WikiPagePlan): boolean } },
): Promise<{ status: 200 | 202; view: WikiBuildView }> {
  const parsed = WikiBuildStartBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError();
  await requireManager(deps, personId, project);
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "building the wiki is not set up in this deployment");
  await requireKey(deps);
  const before = await readWikiBuildPointer(deps.store, deps.companyId, project);
  if (before?.requestId === requestIdOf(parsed.data)) return { status: 200, view: await wikiBuildState(deps, project) };
  await deps.requireNewWork?.(project);
  if (before !== undefined && endWordOf(before, deps.now()) === undefined) throw agentXError("WORKSPACE_BUSY", WIKI_BUILD_WORDS.busy);
  const map = await deps.fileMap(project);
  if (map === undefined) throw agentXError("CONFIG_INVALID", WIKI_BUILD_WORDS.noMap);
  const pins = pinsOf(await deps.defaultBranchHeads(project), map);
  if (pins === undefined) throw agentXError("CONFIG_INVALID", WIKI_BUILD_WORDS.noRepositories);
  const limits = effectiveWikiBuildLimits(await deps.limitSetting?.(project), await deps.limitLock?.());
  const notes = cleanWikiNotes(parsed.data.notes);
  const planned = planWikiPages({ map, repositories: pins.map((pin) => pin.repo), pages: limits.pages, chipsOn: parsed.data.chipsOn, notes }).pages;
  const refresh = options?.refresh;
  const plan = refresh === undefined ? planned : planned.filter((page) => refresh.include(page));
  if (refresh !== undefined && plan.length === 0) throw agentXError("CONFIG_INVALID", WIKI_CONTROLS_WORDS.nothingToRefresh);
  await launch(deps, personId, project, parsed.data.requestId, { pins, plan, keptFromEarlier: [], notes, buildKind: before === undefined && refresh === undefined ? "first" : "refresh", spentEarlierCents: 0 }, before?.taskId);
  await recordNow(deps, project);
  return { status: 202, view: await wikiBuildState(deps, project) };
}

const requestIdOf = (body: { requestId: string }) => body.requestId;

/** The pins: one per readable repository the map lists, at the head the code host gave now. Undefined when none. */
function pinsOf(heads: ReadonlyArray<{ repo: string; commit: string }>, map: WikiFileMap): WikiBuildPins | undefined {
  const mapped = new Set(map.repositories.filter((repo) => repo.status !== "unavailable").map((repo) => repo.name));
  const seen = new Set<string>();
  const pins = heads.filter((head) => mapped.has(head.repo) && !seen.has(head.repo) && seen.add(head.repo) !== undefined).map((head) => ({ repo: head.repo, commit: head.commit }));
  const parsed = WikiBuildPinsSchema.safeParse(pins);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Continue a stopped build: the same commits and the same plan, skipping every page an earlier run finished. The build cap holds across runs: what earlier runs spent is carried, and the limits are read as they are now ("Raise cap and continue").
 */
export async function continueWikiBuild(deps: WikiBuildDeps, personId: string, project: string, rawBody: unknown): Promise<{ status: 200 | 202; view: WikiBuildView }> {
  const parsed = WikiBuildContinueBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError();
  await requireManager(deps, personId, project);
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "building the wiki is not set up in this deployment");
  await requireKey(deps);
  const before = await readWikiBuildPointer(deps.store, deps.companyId, project);
  if (before?.requestId === parsed.data.requestId) return { status: 200, view: await wikiBuildState(deps, project) };
  await deps.requireNewWork?.(project);
  if (before === undefined) throw agentXError("CONFIG_INVALID", WIKI_BUILD_WORDS.nothingToContinue);
  const word = endWordOf(before, deps.now());
  if (word === undefined) throw agentXError("WORKSPACE_BUSY", WIKI_BUILD_WORDS.busy);
  if (word === "built" || remainingPages(before).length === 0) throw agentXError("CONFIG_INVALID", WIKI_BUILD_WORDS.nothingToContinue);
  // The build cap holds across Stop and Continue: what earlier runs spent is carried, and a continue with no room for one more page under the limits as they are now is refused.
  // A page that was out when the run ended reported no spend: it is charged at its reserve, so Stop and Continue cannot slip a page past the cap.
  const spentEarlierCents = buildSpendOf(before) + (before.granted === undefined ? 0 : before.limits.pageReserveCents);
  if (!wikiPageFits(spentEarlierCents, effectiveWikiBuildLimits(await deps.limitSetting?.(project), await deps.limitLock?.()))) throw agentXError("BUDGET_EXCEEDED", WIKI_BUILD_WORDS.raiseCap);
  const notesRow = await deps.store.get(wikiBuildNotesKey({ orgId: deps.companyId, project, taskId: before.taskId }));
  const ownNotes = notesRow?.["orgId"] === deps.companyId && notesRow["project"] === project;
  const notes = ownNotes ? cleanWikiNotes(notesRow["notes"]) : undefined;
  // The notes keep their author, so erasing that person removes every copy.
  const notesBy = ownNotes && typeof notesRow["by"] === "string" ? notesRow["by"] : undefined;
  await launch(deps, personId, project, parsed.data.requestId, {
    pins: before.pins, plan: before.plan, keptFromEarlier: [...new Set([...before.keptFromEarlier, ...before.doneIds])], continuedFrom: before.taskId, notes, ...(notesBy === undefined ? {} : { notesBy }), buildKind: before.buildKind === "refresh" ? "refresh" : "first", spentEarlierCents,
  }, before.taskId);
  await recordNow(deps, project);
  return { status: 202, view: await wikiBuildState(deps, project) };
}

/** Stop the running build. Who pressed Stop is written BEFORE the cancel; every page already finished stays. */
export async function stopWikiBuild(deps: WikiBuildDeps, personId: string, project: string, rawBody: unknown): Promise<{ status: 200 | 202; view: WikiBuildView }> {
  const parsed = WikiBuildStopBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError();
  await requireManager(deps, personId, project);
  const pointer = await readWikiBuildPointer(deps.store, deps.companyId, project);
  if (pointer === undefined || pointer.end !== undefined) return { status: 200, view: await wikiBuildState(deps, project) };
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "building the wiki is not set up in this deployment");
  await deps.store.update({
    key: wikiBuildRunKey(pointer), ops: [change.setIfAbsent("stop", { by: personId, at: new Date(deps.now()).toISOString() })], condition: when.and(when.present(), when.eq("taskId", pointer.taskId)),
  });
  await deps.starter.cancel({ taskId: pointer.taskId, requestId: parsed.data.requestId });
  // A cancelled task reports no more pages: the run ends now, as stopped.
  await endWikiBuild(deps.store, { orgId: deps.companyId, project, taskId: pointer.taskId }, "stopped_by_person", deps.now);
  await recordNow(deps, project);
  return { status: 202, view: await wikiBuildState(deps, project) };
}

/**
 * Ends the run with a word (the first word stands). A page that is out stays granted, so the worker can still hand in a page it finished (a stop keeps finished pages); no new page is granted.
 */
export async function endWikiBuild(store: Pick<DocumentStore, "get" | "update">, scope: WikiRunScope, word: WikiBuildEndWord, now: () => number): Promise<boolean> {
  const pointer = await readWikiBuildPointer(store, scope.orgId, scope.project);
  const written = await store.update({
    key: wikiBuildRunKey(scope), ops: [change.setIfAbsent("end", { word, at: new Date(now()).toISOString() })],
    condition: when.and(when.present(), when.eq("taskId", scope.taskId), when.notExists("end")),
  });
  // Retry a failed release even when the first end write already succeeded.
  if (pointer?.taskId === scope.taskId && pointer.companySlot !== undefined) await releaseWikiBuildSlot(store, scope.orgId, pointer.companySlot);
  return written.applied;
}

/** Person erase (review fix 7): the build notes a person wrote in this project are removed. The wiki store's own erase step covers its rows. */
export async function eraseWikiBuildNotes(store: Pick<DocumentStore, "query" | "delete">, scope: { orgId: OrgId; project: string }, personId: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk: wikiBuildPartition(scope), sk: { op: "beginsWith", prefix: "NOTES#" }, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of page.items) {
      if (row["by"] !== personId || typeof row["taskId"] !== "string") continue;
      const done = await store.delete({ key: wikiBuildNotesKey({ ...scope, taskId: row["taskId"] }), condition: when.eq("by", personId) });
      if (done.applied) removed += 1;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return removed;
}

// ---- the page loop

export interface WikiPageLoopDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  standing(personId: string, project: string): Promise<WikiBuildStanding>;
  /** The code host's file read at a commit (the project's own repositories only). */
  read: CitationFileReader | undefined;
  fileVersion?: ((repo: string, path: string, commit: string) => Promise<string | undefined>) | undefined;
  /** The wiki store's write seam for THIS company's project (W2 `WikiStore.pageSink(project)`). A sink of any other company or project is refused. */
  sink: WikiPageSink;
  /** The wiki store's build record write (W2 `WikiStore.writeBuild`), so the Wiki tab shows the last build. Absent: no record. A failed write never stops the run. */
  recordBuild?: ((record: WikiBuildRecord) => Promise<void>) | undefined;
}

/** The store's stop reason for an end word. */
const STOP_REASON: Readonly<Record<WikiBuildEndWord, WikiBuildRecord["stopReason"] | undefined>> = {
  built: undefined, budget_used: "cap", pages_used: "cap", time_used: "failed", stopped_by_person: "person", needs_ai_key: "no_ai_key", repo_unreadable: "repo_unreadable",
  access_lost: "failed", infrastructure: "failed",
};

/** The store's build record of a run, as it stands. Pure. */
export function wikiBuildRecordOf(pointer: WikiBuildPointer): WikiBuildRecord {
  const kind: WikiBuildRecord["kind"] = pointer.buildKind === "refresh" ? "refresh" : "first";
  const word = pointer.end?.word;
  return {
    buildId: pointer.taskId, kind, state: word === undefined ? "running" : word === "built" ? "done" : word === "stopped_by_person" || word === "budget_used" || word === "pages_used" ? "stopped" : "failed",
    startedBy: pointer.requestedBy, taskId: pointer.taskId, startedAt: pointer.startedAt, ...(pointer.end === undefined ? {} : { endedAt: pointer.end.at }),
    repos: pointer.pins.map((pin) => ({ repo: pin.repo, commit: pin.commit })),
    counts: { pagesWritten: pointer.pagesWritten, claimsKept: pointer.claimsKept, claimsDropped: pointer.claimsDropped, skipped: 0 },
    dropped: [], skipped: [], ...(Number.isSafeInteger(buildSpendOf(pointer)) ? { spentCents: buildSpendOf(pointer) } : {}),
    ...(word === undefined || STOP_REASON[word] === undefined ? {} : { stopReason: STOP_REASON[word] }),
  };
}

async function recordBuild(deps: WikiPageLoopDeps, scope: WikiRunScope): Promise<void> {
  if (deps.recordBuild === undefined) return;
  try {
    const pointer = await readWikiBuildPointer(deps.store, deps.companyId, scope.project);
    if (pointer?.taskId === scope.taskId) await deps.recordBuild(wikiBuildRecordOf(pointer));
  } catch { /* the record is a view for people; the run's own pointer is the truth */ }
}

export type WikiPageJob =
  /**
   * `spendCeilingCents`: the most this run's own metered spend (the `spentCents` the worker reports) may reach: what is left of the build cap, and at most one page's reserve above what the broker
   * already knows was spent. The worker stops its session there (a page that cannot finish inside its reserve ends the run `budget_used`); the broker grants no page whose reserve does not fit under the cap.
   */
  | { kind: "page"; page: WikiPagePlan; pins: WikiBuildPins; instructions: string; notes?: string; spendCeilingCents: number }
  | { kind: "end"; word: WikiBuildEndWord };

const CALLBACK_REFUSED = "this callback does not belong to the project's current wiki build";

async function runPointer(deps: WikiPageLoopDeps, scope: WikiRunScope): Promise<WikiBuildPointer> {
  if (scope.orgId !== deps.companyId || deps.sink.companyId !== scope.orgId || deps.sink.project !== scope.project) throw agentXError("CALLBACK_FORBIDDEN", CALLBACK_REFUSED);
  const pointer = await readWikiBuildPointer(deps.store, deps.companyId, scope.project);
  if (pointer === undefined || pointer.taskId !== scope.taskId) throw agentXError("CALLBACK_FORBIDDEN", CALLBACK_REFUSED);
  return pointer;
}

async function jobFor(deps: WikiPageLoopDeps, pointer: WikiBuildPointer, page: WikiPagePlan, spentCents: number): Promise<WikiPageJob> {
  const notesRow = await deps.store.get(wikiBuildNotesKey(pointer));
  const framed = notesRow?.["orgId"] === pointer.orgId && notesRow["project"] === pointer.project ? frameWikiNotes(cleanWikiNotes(notesRow["notes"])) : undefined;
  // The ceiling is the most this run's metered spend may reach: what is left of the build cap, and never more than what the broker KNOWS was spent plus ONE page's reserve. The worker reports its spend only between pages, so a page
  // that dies unreported (a Stop, a crash, a lost machine) cost at most its reserve, which is exactly what a continue charges for a page that was out: the cap cannot be slipped past by stopping and continuing (review M2).
  const capLeft = Math.max(0, pointer.limits.budgetCents - (Number.isSafeInteger(pointer.spentEarlierCents) ? pointer.spentEarlierCents : pointer.limits.budgetCents));
  const ceiling = Math.min(capLeft, Math.max(0, spentCents) + pointer.limits.pageReserveCents);
  return { kind: "page", page, pins: pointer.pins, instructions: wikiPageInstructions(page, pointer.pins), spendCeilingCents: ceiling, ...(framed === undefined ? {} : { notes: framed }) };
}

async function ended(deps: WikiPageLoopDeps, scope: WikiRunScope, word: WikiBuildEndWord): Promise<WikiPageJob> {
  await endWikiBuild(deps.store, scope, word, deps.now);
  await recordBuild(deps, scope);
  const after = await readWikiBuildPointer(deps.store, deps.companyId, scope.project);
  return { kind: "end", word: after?.end?.word ?? word };
}

/**
 * The next page of the run, or how it ends. `spentCents` is the run's spend so far as the worker's session counts it. Order of the checks: an end already recorded; the requester's
 * standing (read now); a stop; the clock; a page already out (answered again); no page left (built); the page limit; the cap with the next page's reserve.
 */
export async function nextWikiPage(deps: WikiPageLoopDeps, scope: WikiRunScope, rawBody: unknown): Promise<WikiPageJob> {
  const parsed = WikiNextBodySchema.safeParse(rawBody);
  const pointer = await runPointer(deps, scope);
  if (pointer.end !== undefined) return { kind: "end", word: pointer.end.word };
  // A spend the broker cannot read is a run that cannot tell what it spent: it stops.
  if (!parsed.success) return ended(deps, scope, "infrastructure");
  const spent = Math.max(pointer.spentCents, parsed.data.spentCents);
  if (spent !== pointer.spentCents) {
    await deps.store.update({ key: wikiBuildRunKey(scope), ops: [change.set("spentCents", spent)], condition: when.and(when.eq("taskId", scope.taskId), when.lte("spentCents", spent)) });
  }
  let standing: WikiBuildStanding["access"];
  try { standing = (await deps.standing(pointer.requestedBy, pointer.project)).access; } catch { standing = "none"; }
  if (standing !== "manage") return ended(deps, scope, "access_lost");
  if (pointer.stop !== undefined) return ended(deps, scope, "stopped_by_person");
  if (deps.now() - Date.parse(pointer.startedAt) > pointer.limits.wallClockMin * 60_000) return ended(deps, scope, "time_used");
  if (pointer.granted !== undefined) {
    const out = pointer.plan.find((page) => page.id === pointer.granted!.pageId);
    if (out !== undefined) return jobFor(deps, pointer, out, spent);
  }
  const next = remainingPages(pointer)[0];
  if (next === undefined) return ended(deps, scope, "built");
  if (pointer.doneIds.length >= pointer.limits.pages) return ended(deps, scope, "pages_used");
  if (!wikiPageFits(buildSpendOf({ spentCents: spent, spentEarlierCents: pointer.spentEarlierCents }), pointer.limits)) return ended(deps, scope, "budget_used");
  const grant = await deps.store.update({
    key: wikiBuildRunKey(scope), ops: [change.set("granted", { pageId: next.id, at: new Date(deps.now()).toISOString() })],
    condition: when.and(when.eq("taskId", scope.taskId), when.notExists("end"), when.notExists("granted"), when.notExists("stop")),
  });
  if (!grant.applied) {
    const now = await runPointer(deps, scope);
    if (now.end !== undefined) return { kind: "end", word: now.end.word };
    if (now.stop !== undefined) return ended(deps, scope, "stopped_by_person");
    const out = now.granted === undefined ? undefined : now.plan.find((page) => page.id === now.granted!.pageId);
    if (out === undefined) throw agentXError("CONFIG_INVALID", "the wiki build moved; ask again");
    return jobFor(deps, now, out, Math.max(now.spentCents, spent));
  }
  return jobFor(deps, pointer, next, spent);
}

export interface WikiPageReceipt { pageId: string; kept: boolean; claimsKept: number; claimsDropped: number; complete: boolean }

/**
 * The worker's answer for the page it was granted. Re-checks every citation at the pinned commits, writes what survived through the sink, then marks the page done (only after the write)
 * and releases the grant, in one conditional update that holds only while this page is the one granted.
 */
export async function submitWikiPage(deps: WikiPageLoopDeps, scope: WikiRunScope, rawBody: unknown): Promise<WikiPageReceipt> {
  const parsed = WikiPageAnswerSchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError();
  const answer = parsed.data;
  const pointer = await runPointer(deps, scope);
  // Only the page that is out. A page finished after the run ended (a person's stop) is still taken: it was paid for, and a stop keeps finished pages.
  if (pointer.granted?.pageId !== answer.pageId) throw agentXError("CALLBACK_FORBIDDEN", "this page was not handed out, or the build has ended");
  const page = pointer.plan.find((entry) => entry.id === answer.pageId);
  if (page === undefined) throw agentXError("CALLBACK_FORBIDDEN", "this page was not handed out, or the build has ended");
  const spent = Math.max(pointer.spentCents, answer.spentCents);
  if (answer.failure !== undefined) {
    await deps.store.update({ key: wikiBuildRunKey(scope), ops: [change.set("spentCents", spent), change.remove("granted")], condition: when.and(when.eq("taskId", scope.taskId), when.lte("spentCents", spent)) });
    await endWikiBuild(deps.store, scope, answer.failure, deps.now);
    await recordBuild(deps, scope);
    return { pageId: page.id, kept: false, claimsKept: 0, claimsDropped: 0, complete: false };
  }
  const draft = WikiPageDraftSchema.safeParse(answer.draft);
  const usable = draft.success && draft.data.pageId === page.id ? draft.data : undefined;
  const checked = usable === undefined
    ? { page: undefined, claimsKept: 0, claimsDropped: 0, dropped: { unreadable_draft: 1 } as Record<string, number>, complete: true }
    : await checkWikiPage({
      read: deps.read, plan: page, draft: usable, pins: new Map(pointer.pins.map((pin) => [pin.repo, pin.commit])), taskId: scope.taskId,
      cache: storeCheckCache(deps.store, scope, deps.now), fileVersion: deps.fileVersion, now: deps.now,
    });
  if (checked.page !== undefined) {
    // The check can take a while: the page is written only if this run still holds this page (no new run replaced it meanwhile).
    const still = await readWikiBuildPointer(deps.store, deps.companyId, scope.project);
    if (still?.taskId !== scope.taskId || still.granted?.pageId !== page.id) throw agentXError("CALLBACK_FORBIDDEN", "this page was not handed out, or the build has ended");
    try {
      await deps.sink.putPage(checked.page);
    } catch {
      // Not written: the page is not done, the run ends, and a continue writes it again.
      await endWikiBuild(deps.store, scope, "infrastructure", deps.now);
      await recordBuild(deps, scope);
      return { pageId: page.id, kept: false, claimsKept: 0, claimsDropped: 0, complete: false };
    }
  }
  // Spend only ever goes up: written on its own, conditional on not lowering what a racing callback stored.
  await deps.store.update({ key: wikiBuildRunKey(scope), ops: [change.set("spentCents", spent)], condition: when.and(when.eq("taskId", scope.taskId), when.lte("spentCents", spent)) });
  const at = new Date(deps.now()).toISOString();
  const marked = await deps.store.transact([
    {
      kind: "update", key: wikiBuildRunKey(scope),
      ops: [
        change.set("doneIds", [...pointer.doneIds, page.id]), change.remove("granted"),
        change.add("pagesWritten", checked.page === undefined ? 0 : 1), change.add("claimsKept", checked.claimsKept), change.add("claimsDropped", checked.claimsDropped),
      ],
      condition: when.and(when.eq("taskId", scope.taskId), when.eq("granted.pageId", page.id)),
    },
    {
      kind: "put",
      item: {
        ...wikiPageDoneKey(scope, page.id), entityType: "WIKI_BUILD_PAGE_DONE", orgId: scope.orgId, project: scope.project, taskId: scope.taskId, pageId: page.id,
        written: checked.page !== undefined, claimsKept: checked.claimsKept, claimsDropped: checked.claimsDropped, dropped: checked.dropped, complete: checked.complete, at, ...wikiExpiryOf(deps.now()),
      },
    },
  ]);
  if (!marked.applied) throw agentXError("CALLBACK_FORBIDDEN", "this page was not handed out, or the build has ended");
  await recordBuild(deps, scope);
  return { pageId: page.id, kept: checked.page !== undefined, claimsKept: checked.claimsKept, claimsDropped: checked.claimsDropped, complete: checked.complete };
}
