// Engine host: the core's mark on a task (renamed from the engine stamp in D1; the STORED names are unchanged: `TASK_ENGINE#<taskId>` / `STAMP`, the attribute `coreEngine`, the entity type `TASK_ENGINE`).
//
// A task is the core's when its mark item exists. The mark is its own small item, written only by the core's start, in the start's own transaction (the core's `startExtras` seam), so a core
// task and its mark exist together or not at all. A task with no mark is a record of the old workflow engine (removed): it is kept, not listed and not served.
//
// The mark is kept PERMANENTLY and its shape is the one release N-1 wrote, byte for byte: release N-1 and earlier parse it strictly and THROW on an item they cannot read, so a changed shape
// breaks a rollback hard (an error, not a fallback). Only a later release may relax the strict shape check in the reader; the mark is never removed.
import { when, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { CORE_AREAS, type CoreArea } from "./flags.js";

/** The words a stored mark may carry for an engine: `core` is all a release ever wrote; `workflow` is read, never written (the reader never refuses what an earlier release could have stored). */
export type MarkedEngine = "workflow" | "core";

/** The attribute of the mark item that holds the mark. */
export const CORE_TASK_MARK_ATTRIBUTE = "coreEngine";

export const coreTaskMarkKey = (taskId: string): DocumentKey => ({ pk: `TASK_ENGINE#${taskId}`, sk: "STAMP" });

export interface CoreTaskMark {
  /** `core` for every mark a release writes. */
  engine: MarkedEngine;
  /** Each step group's engine for this task (all `core` as written). */
  areas: Readonly<Record<CoreArea, MarkedEngine>>;
  /** The settings text the task started under. Written as the fixed text `cc=on` (the old combined switch, always on); read as any text. */
  flags: string;
  stampedAt: string;
}

/** The fixed settings text of every mark written now: what the old writer recorded for "every area of every company on". */
export const CORE_TASK_MARK_FLAGS = "cc=on";

/** The mark a new core task gets now: the old strict shape, constant. */
export function coreTaskMarkFor(now: Date): CoreTaskMark {
  const areas = Object.fromEntries(CORE_AREAS.map((area) => [area, "core"])) as Record<CoreArea, MarkedEngine>;
  return { engine: "core", areas, flags: CORE_TASK_MARK_FLAGS, stampedAt: now.toISOString() };
}

/** The mark kept on a mark item, or undefined when it has none or it cannot be read as one. */
export function coreTaskMarkOf(record: Readonly<Record<string, unknown>> | undefined): CoreTaskMark | undefined {
  const raw = record?.[CORE_TASK_MARK_ATTRIBUTE];
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as Partial<CoreTaskMark>;
  if (value.engine !== "workflow" && value.engine !== "core") return undefined;
  const areas = value.areas as Partial<Record<CoreArea, unknown>> | undefined;
  if (areas === null || typeof areas !== "object" || CORE_AREAS.some((area) => areas[area] !== "workflow" && areas[area] !== "core")) return undefined;
  if (typeof value.flags !== "string" || typeof value.stampedAt !== "string") return undefined;
  return value as CoreTaskMark;
}

/** The mark item, written once with the core's start (a repeat of the start writes nothing new: `when.absent()`). */
export function coreTaskMarkItem(companyId: string, taskId: string, mark: CoreTaskMark): Extract<TransactItem, { kind: "put" }> {
  const item: StoredDocument = { ...coreTaskMarkKey(taskId), entityType: "TASK_ENGINE", orgId: companyId, taskId, [CORE_TASK_MARK_ATTRIBUTE]: { engine: mark.engine, areas: { ...mark.areas }, flags: mark.flags, stampedAt: mark.stampedAt } };
  return { kind: "put", item, condition: when.absent() };
}

/**
 * Where the root looks, cheaply, to learn which companies have ever started a task on the core (the mark is per task, and there is no list of them). The rows share one partition so they can be
 * listed: the root serves the core's tasks of EVERY company that has one (their sweeps and jobs). Kept permanently (the company purge and rollback read it).
 */
export const CORE_IN_USE_PARTITION = "CORE_ENGINE_IN_USE";
export const coreInUseKey = (companyId: string): DocumentKey => ({ pk: CORE_IN_USE_PARTITION, sk: `ORG#${companyId}` });

export function coreInUseItem(companyId: string): Extract<TransactItem, { kind: "put" }> {
  return { kind: "put", item: { ...coreInUseKey(companyId), entityType: "CORE_ENGINE_IN_USE", orgId: companyId } };
}

/** Every company with an in-use mark, at most `limit` pages of the partition (the companies the root serves for the tasks the core holds). */
export async function listCoreInUse(store: Pick<DocumentStore, "query">, pages = 20): Promise<string[]> {
  const companies: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page += 1) {
    const read = await store.query({ pk: CORE_IN_USE_PARTITION, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of read.items) if (typeof item.orgId === "string") companies.push(item.orgId);
    if (read.cursor === undefined) return companies;
    cursor = read.cursor;
  }
  // More marks than the pages read: refuse rather than serve a silent subset.
  throw new Error("the core engine's in-use marks are more than one job can list");
}

const ensured = new WeakMap<object, Set<string>>();

/**
 * Makes sure the company's in-use mark is there, OFF the start's hot path: a conditional put (only when absent), made once per company per store in this container, before the first core task of
 * the company starts. A mark with no task behind it is harmless (the jobs find nothing to do); a task never exists without its mark, because the mark is written before the start that marks it.
 */
export async function ensureCoreInUse(store: Pick<DocumentStore, "put">, companyId: string): Promise<void> {
  let known = ensured.get(store);
  if (known === undefined) ensured.set(store, known = new Set());
  if (known.has(companyId)) return;
  await store.put({ item: coreInUseItem(companyId).item, condition: when.absent() });
  known.add(companyId);
}
