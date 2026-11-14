// TE-F1c: the laptop's local meter for the product's model calls: per task and per month, in a file of its own (`model-meter.json`, mode 0600), with the design's default caps ($2 a task, $50 a month). Never Rovara's own
// agent spend: this counts only the user's own key. Reserve, then settle (design 5): the reservation is counted as spent AT ONCE (and is written to the file), so a call that never settles (a crash, a cut stream) keeps its
// reservation and the meter errs high, never low. One call may overrun a cap (DECISIONS 165): the settle that takes the SPEND past the cap marks the task, and the task takes no further call.
import { isOverCap } from "@agentx/contracts";
import { join } from "node:path";
import { ensurePrivateDirectory, readOwnerFile, writeOwnerFile } from "../state-directory.js";

export const METER_FILE_NAME = "model-meter.json";
export const DEFAULT_TASK_CAP_MICROS = 2_000_000;
export const DEFAULT_MONTH_CAP_MICROS = 50_000_000;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const TASKS_MAX = 5_000;
const KEEP_MS = 62 * 24 * 60 * 60 * 1000;

export interface MeterCaps { readonly taskCapMicros: number; readonly monthCapMicros: number }
export interface MeterReservation { readonly owner: string; readonly task: string; readonly month: string; readonly reserveMicros: number }
export type MeterReserveResult =
  | { readonly ok: true; readonly handle: MeterReservation }
  | { readonly ok: false; readonly reason: "task_cap" | "month_cap" | "overrun"; readonly capMicros: number };

export interface LocalMeter {
  reserve(args: { readonly owner: string; readonly task: string; readonly estimateMicros: number }): Promise<MeterReserveResult>;
  settle(handle: MeterReservation, costMicros: number): Promise<{ readonly overrun: boolean }>;
  taskSpent(owner: string, task: string): Promise<number>;
  /** Everything an owner has spent (all tasks still on file). */
  spentFor(owner: string): Promise<number>;
  caps(owner: string): Promise<MeterCaps>;
  setCaps(owner: string, caps: Partial<MeterCaps>): Promise<void>;
}

interface TaskRow { owner: string; task: string; spent: number; overrun: boolean; touchedMs: number }
interface MonthRow { owner: string; month: string; spent: number; overrun: boolean }
interface CapRow { owner: string; taskCapMicros: number; monthCapMicros: number }
interface State { tasks: Map<string, TaskRow>; months: Map<string, MonthRow>; caps: Map<string, CapRow> }

const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const taskKey = (owner: string, task: string): string => `${owner}\n${task}`;

function parseState(text: string): State {
  const bad = (): never => { throw new Error("the model meter file is not readable"); };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return bad(); }
  const root = parsed as { version?: unknown; tasks?: unknown; months?: unknown; caps?: unknown } | null;
  if (typeof root !== "object" || root === null || root.version !== 1 || !Array.isArray(root.tasks) || !Array.isArray(root.months) || !Array.isArray(root.caps)) return bad();
  const state: State = { tasks: new Map(), months: new Map(), caps: new Map() };
  for (const item of root.tasks as TaskRow[]) {
    if (typeof item !== "object" || item === null || !ID.test(String(item.owner)) || !ID.test(String(item.task)) || !whole(item.spent) || typeof item.overrun !== "boolean" || !whole(item.touchedMs)) return bad();
    state.tasks.set(taskKey(item.owner, item.task), { owner: item.owner, task: item.task, spent: item.spent, overrun: item.overrun, touchedMs: item.touchedMs });
  }
  for (const item of root.months as MonthRow[]) {
    if (typeof item !== "object" || item === null || !ID.test(String(item.owner)) || !/^\d{4}-\d{2}$/u.test(String(item.month)) || !whole(item.spent) || typeof item.overrun !== "boolean") return bad();
    state.months.set(taskKey(item.owner, item.month), { owner: item.owner, month: item.month, spent: item.spent, overrun: item.overrun });
  }
  for (const item of root.caps as CapRow[]) {
    if (typeof item !== "object" || item === null || !ID.test(String(item.owner)) || !whole(item.taskCapMicros) || !whole(item.monthCapMicros)) return bad();
    state.caps.set(item.owner, { owner: item.owner, taskCapMicros: item.taskCapMicros, monthCapMicros: item.monthCapMicros });
  }
  return state;
}

export function createLocalMeter(options: { readonly directory: string; readonly now: () => number; readonly defaults?: Partial<MeterCaps>; /** The most task rows kept on file. Default 5000. */ readonly tasksMax?: number }): LocalMeter {
  const path = join(options.directory, METER_FILE_NAME);
  const defaults: MeterCaps = { taskCapMicros: options.defaults?.taskCapMicros ?? DEFAULT_TASK_CAP_MICROS, monthCapMicros: options.defaults?.monthCapMicros ?? DEFAULT_MONTH_CAP_MICROS };
  const tasksMax = options.tasksMax ?? TASKS_MAX;
  /** Tasks with a reservation that has not settled (in this process): their rows are never pruned, whatever else is. */
  const open = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  async function load(): Promise<State> {
    const file = await readOwnerFile(path, { private: true, label: "model meter file", maxBytes: 8 * 1024 * 1024 });
    return file === undefined ? { tasks: new Map(), months: new Map(), caps: new Map() } : parseState(file.text);
  }
  /** `keep`: the task keys that must stay (the one being written, and every task with a reservation still open). */
  async function save(state: State, keep: ReadonlySet<string>): Promise<void> {
    const cutoff = options.now() - KEEP_MS;
    for (const [key, row] of state.tasks) if (row.touchedMs < cutoff && !keep.has(key)) state.tasks.delete(key);
    // Over the size limit: the least recently touched go first, and never one that must stay.
    if (state.tasks.size > tasksMax) {
      const oldest = [...state.tasks.entries()].filter(([key]) => !keep.has(key)).sort((a, b) => a[1].touchedMs - b[1].touchedMs);
      for (const [key] of oldest) {
        if (state.tasks.size <= tasksMax) break;
        state.tasks.delete(key);
      }
    }
    for (const [key, row] of state.months) if (row.month < monthOf(cutoff)) state.months.delete(key);
    await ensurePrivateDirectory(options.directory);
    await writeOwnerFile(path, `${JSON.stringify({ version: 1, tasks: [...state.tasks.values()], months: [...state.months.values()], caps: [...state.caps.values()] })}\n`);
  }
  const capsOf = (state: State, owner: string): MeterCaps => {
    const held = state.caps.get(owner);
    return held === undefined ? defaults : { taskCapMicros: held.taskCapMicros, monthCapMicros: held.monthCapMicros };
  };
  const checkIds = (owner: string, task: string): void => { if (!ID.test(owner) || !ID.test(task)) throw new Error("not a usable owner or task name"); };

  return {
    reserve: ({ owner, task, estimateMicros }) => serial(async () => {
      checkIds(owner, task);
      if (!whole(estimateMicros)) throw new Error("the estimate must be a whole number");
      const state = await load();
      const caps = capsOf(state, owner);
      const month = monthOf(options.now());
      const taskRow = state.tasks.get(taskKey(owner, task)) ?? { owner, task, spent: 0, overrun: false, touchedMs: options.now() };
      const monthRow = state.months.get(taskKey(owner, month)) ?? { owner, month, spent: 0, overrun: false };
      if (taskRow.overrun) return { ok: false, reason: "overrun", capMicros: caps.taskCapMicros } as const;
      if (monthRow.overrun) return { ok: false, reason: "overrun", capMicros: caps.monthCapMicros } as const;
      if (taskRow.spent + estimateMicros > caps.taskCapMicros) return { ok: false, reason: "task_cap", capMicros: caps.taskCapMicros } as const;
      if (monthRow.spent + estimateMicros > caps.monthCapMicros) return { ok: false, reason: "month_cap", capMicros: caps.monthCapMicros } as const;
      taskRow.spent += estimateMicros;
      taskRow.touchedMs = options.now();
      monthRow.spent += estimateMicros;
      state.tasks.set(taskKey(owner, task), taskRow);
      state.months.set(taskKey(owner, month), monthRow);
      const key = taskKey(owner, task);
      open.set(key, (open.get(key) ?? 0) + 1);
      await save(state, new Set([key, ...open.keys()]));
      return { ok: true, handle: { owner, task, month, reserveMicros: estimateMicros } } as const;
    }),
    settle: (handle, costMicros) => serial(async () => {
      if (!whole(costMicros)) throw new Error("the cost must be a whole number");
      const state = await load();
      const caps = capsOf(state, handle.owner);
      const taskRow = state.tasks.get(taskKey(handle.owner, handle.task));
      const monthRow = state.months.get(taskKey(handle.owner, handle.month));
      if (taskRow === undefined || monthRow === undefined) throw new Error("no such reservation");
      taskRow.spent = Math.max(0, taskRow.spent - handle.reserveMicros) + costMicros;
      monthRow.spent = Math.max(0, monthRow.spent - handle.reserveMicros) + costMicros;
      // The cap is overrun only when the SPEND passes it (DECISIONS 165): one call over its estimate but under the cap is nothing.
      if (isOverCap(taskRow.spent, caps.taskCapMicros)) taskRow.overrun = true;
      if (isOverCap(monthRow.spent, caps.monthCapMicros)) monthRow.overrun = true;
      const key = taskKey(handle.owner, handle.task);
      const left = (open.get(key) ?? 1) - 1;
      if (left > 0) open.set(key, left);
      else open.delete(key);
      await save(state, new Set([key, ...open.keys()]));
      return { overrun: taskRow.overrun || monthRow.overrun };
    }),
    taskSpent: async (owner, task) => (await load()).tasks.get(taskKey(owner, task))?.spent ?? 0,
    spentFor: async (owner) => [...(await load()).tasks.values()].filter((row) => row.owner === owner).reduce((total, row) => total + row.spent, 0),
    caps: async (owner) => capsOf(await load(), owner),
    setCaps: (owner, caps) => serial(async () => {
      if (!ID.test(owner)) throw new Error("not a usable owner name");
      for (const value of [caps.taskCapMicros, caps.monthCapMicros]) if (value !== undefined && !whole(value)) throw new Error("a cap must be a whole number");
      const state = await load();
      const held = capsOf(state, owner);
      state.caps.set(owner, { owner, taskCapMicros: caps.taskCapMicros ?? held.taskCapMicros, monthCapMicros: caps.monthCapMicros ?? held.monthCapMicros });
      await save(state, new Set(open.keys()));
    }),
  };
}
