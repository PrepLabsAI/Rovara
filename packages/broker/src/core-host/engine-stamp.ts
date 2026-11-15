// Engine host (lane E2): every task is pinned to one engine when it starts, and keeps it.
//
// The stamp is its own small item, `TASK_ENGINE#<taskId>` / `STAMP`, written only by the core's start, in the start's own transaction (the core's `startExtras` seam), so a core task and its stamp
// exist together or not at all. A task with no stamp is a spec 056 workflow task: every task that exists today, and every task started while the switch is off. So with the switch off nothing new
// is written anywhere, and no task record changes shape (the workflow's strict readers never meet a new field).
//
// Routing reads the stamp, never the switch: a flip of the switch changes where the NEXT task starts and nothing else. A running core task finishes on the core after the switch is turned off;
// a running workflow task finishes on the workflow after it is turned on.
import { when, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { CORE_AREAS, coreAreaOn, flagSnapshot, type CoreArea, type CoreEngineFlags } from "./flags.js";

/** `workflow`: the spec 056 workflow (Code's deployed engine today). `core`: the core engine. */
export type Engine = "workflow" | "core";

/** The attribute of the stamp item that holds the stamp. */
export const ENGINE_STAMP_ATTRIBUTE = "coreEngine";

export const engineStampKey = (taskId: string): DocumentKey => ({ pk: `TASK_ENGINE#${taskId}`, sk: "STAMP" });

export interface EngineStamp {
  /** `core` when the task's flow runs on the core. */
  engine: Engine;
  /** Each area's engine for this task. With one combined switch all three agree; a later lane may narrow one. */
  areas: Readonly<Record<CoreArea, Engine>>;
  /** The switches the task started under (`flagSnapshot`). */
  flags: string;
  stampedAt: string;
}

const WORKFLOW_AREAS: Readonly<Record<CoreArea, Engine>> = Object.freeze({ merge: "workflow", build: "workflow", flow: "workflow" });

/** The stamp a new task of this company gets now. */
export function stampForNewTask(flags: CoreEngineFlags, companyId: string, now: Date): EngineStamp {
  const areas = Object.fromEntries(CORE_AREAS.map((area) => [area, coreAreaOn(flags, area, companyId) ? "core" : "workflow"])) as Record<CoreArea, Engine>;
  // The task flow owns the start: a task whose flow stays on the workflow cannot have its build or merge on the core (the core's build step and merge tracking read the core's task record,
  // which only the core's start writes). Narrowing `flow` therefore keeps the whole task on the workflow.
  const pinned = areas.flow === "core" ? areas : WORKFLOW_AREAS;
  return { engine: pinned.flow, areas: { ...pinned }, flags: flagSnapshot(flags), stampedAt: now.toISOString() };
}

/** Where a new task starts. */
export function engineForNewTask(flags: CoreEngineFlags, companyId: string): Engine {
  return coreAreaOn(flags, "flow", companyId) ? "core" : "workflow";
}

/** The stamp kept on a stamp item, or undefined when it has none or it cannot be read (both mean the workflow). */
export function stampOf(record: Readonly<Record<string, unknown>> | undefined): EngineStamp | undefined {
  const raw = record?.[ENGINE_STAMP_ATTRIBUTE];
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as Partial<EngineStamp>;
  if (value.engine !== "workflow" && value.engine !== "core") return undefined;
  const areas = value.areas as Partial<Record<CoreArea, unknown>> | undefined;
  if (areas === null || typeof areas !== "object" || CORE_AREAS.some((area) => areas[area] !== "workflow" && areas[area] !== "core")) return undefined;
  if (typeof value.flags !== "string" || typeof value.stampedAt !== "string") return undefined;
  return value as EngineStamp;
}

/** The engine that runs this area of an existing task. Unstamped (or unreadable): the workflow. */
export function engineOfTask(record: Readonly<Record<string, unknown>> | undefined, area: CoreArea): Engine {
  return stampOf(record)?.areas[area] ?? "workflow";
}

/** The stamp item, written once with the core's start (a repeat of the start writes nothing new: `when.absent()`). */
export function stampItem(companyId: string, taskId: string, stamp: EngineStamp): Extract<TransactItem, { kind: "put" }> {
  const item: StoredDocument = { ...engineStampKey(taskId), entityType: "TASK_ENGINE", orgId: companyId, taskId, [ENGINE_STAMP_ATTRIBUTE]: { engine: stamp.engine, areas: { ...stamp.areas }, flags: stamp.flags, stampedAt: stamp.stampedAt } };
  return { kind: "put", item, condition: when.absent() };
}

/** The engine that runs this area of an existing task, read from its stamp item. No stamp (or an unreadable one): the workflow. */
export async function engineOfStoredTask(store: Pick<DocumentStore, "get">, taskId: string, area: CoreArea): Promise<Engine> {
  return engineOfTask(await store.get(engineStampKey(taskId)), area);
}

/**
 * Where the root looks, cheaply, to learn which companies have ever started a task on the core (the stamp is per task, and there is no list of them). The rows share one partition so they can be
 * listed: while the switch is off the root serves the core's tasks of EVERY company that has one (their sweeps and jobs), so an install that never switched on builds nothing and asks for nothing.
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
 * the company starts. A mark with no task behind it is harmless (the jobs find nothing to do); a task never exists without its mark, because the mark is written before the start that stamps it.
 */
export async function ensureCoreInUse(store: Pick<DocumentStore, "put">, companyId: string): Promise<void> {
  let known = ensured.get(store);
  if (known === undefined) ensured.set(store, known = new Set());
  if (known.has(companyId)) return;
  await store.put({ item: coreInUseItem(companyId).item, condition: when.absent() });
  known.add(companyId);
}
