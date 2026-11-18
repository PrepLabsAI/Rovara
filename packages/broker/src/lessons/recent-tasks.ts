// Lessons phase 1 wiring (L4-LP12b): the tasks of the last 30 days, as the loader would have seen them (repositories and the files the plan names), for the weekly list's tie-break "would have applied to N tasks last month"
// (`weekly-order.ts` `wouldHaveApplied`). No model, nothing written, nothing new stored: the tasks are named by the project's own load rows (`LESSON_FIT#<project>`, one row per load, newest first), and each task's scope is read from
// its own record and plan the way the loader reads it (`taskPlanFacts`), so "would have applied" means "would have passed the same scope test".
//
// Only this company's rows for this project are read (the partition is keyed by company AND project, and every row is checked against both again); a task that is not this company's or not this project's is left out.
// One TOTAL limit on rows, tasks and time. Never a partial answer: a read that fails, or a clock that runs out, is "not known" for the whole list (undefined), which leaves the tie-break out as it was before. A project with no recent
// task is also "not known" (not "applied to 0 tasks"). The answer is kept for `RECENT_TASKS_TTL_MS` per project (numbers and names of repositories and files only; at most `RECENT_TASKS_CACHE_MAX` projects).
// The plan reads are capped per object (`RECENT_PLAN_BYTES_MAX`, applied by the two wirings): a legacy Markdown plan over the cap is cut, fails its digest check and counts as a task with no named files (an undercount of "would have applied" for file-scoped lessons), never an error.
import type { DocumentStore, OrgId } from "@agentx/contracts";
import { fitPk, timeSk } from "./measure.js";
import { WOULD_HAVE_APPLIED_DAYS } from "./scoring-settings.js";
import type { ScopeKey } from "./store.js";
import type { TaskScope } from "./weekly-order.js";

const DAY = 86_400_000;
const PAGE = 200;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** The most load rows one read looks at, the most tasks it reads, and the longest it may take (all of it together). */
export const RECENT_ROWS_MAX = 600;
export const RECENT_TASKS_MAX = 40;
export const RECENT_TASKS_MS = 5_000;
export const RECENT_TASKS_TTL_MS = 10 * 60_000;
export const RECENT_TASKS_CACHE_MAX = 200;
/** The most bytes of one task's plan a read takes (the ports apply it): 40 tasks at most, so the whole read is bounded in bytes too. */
export const RECENT_PLAN_BYTES_MAX = 256 * 1024;
/** Tasks read at once. */
const PARALLEL = 5;

export interface RecentTasksPorts {
  /** One task's facts, when the task is this company's: its project and the files its plan names. Undefined: not this company's task. A throw is "not known" for the whole list. */
  task(taskId: string): Promise<{ project: string; files: readonly string[] } | undefined>;
  /** The project's repositories (its names for them), or undefined when they cannot be read. */
  repositories(project: string): Promise<readonly string[] | undefined>;
}

export interface RecentTasksDeps {
  documents: Pick<DocumentStore, "query">;
  companyId: OrgId;
  now: () => number;
  ports: RecentTasksPorts;
}

/** The recent tasks of one project of this company, as the weekly list's scopes; undefined when not known. Never throws, and never takes longer than `RECENT_TASKS_MS` whatever a read is doing (a read still in flight when the time is up is let go, and its answer is dropped). */
export async function readRecentTaskScopes(deps: RecentTasksDeps, key: ScopeKey): Promise<readonly TaskScope[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([readRecentTaskScopesWhole(deps, key), new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, RECENT_TASKS_MS); timer.unref?.(); })]);
  } catch { return undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function readRecentTaskScopesWhole(deps: RecentTasksDeps, key: ScopeKey): Promise<readonly TaskScope[] | undefined> {
  if (key.workspaceId !== deps.companyId || !NAME.test(key.project)) return undefined;
  const now = deps.now();
  const since = now - WOULD_HAVE_APPLIED_DAYS * DAY;
  const stopAt = Date.now() + RECENT_TASKS_MS;
  const expired = (): boolean => Date.now() >= stopAt;
  try {
    const pk = fitPk(deps.companyId, key.project);
    const taskIds: string[] = [];
    const seen = new Set<string>();
    let read = 0;
    for (let cursor: string | undefined; taskIds.length < RECENT_TASKS_MAX;) {
      const take = Math.min(PAGE, RECENT_ROWS_MAX - read);
      if (take <= 0 || expired()) return undefined;
      const page = await deps.documents.query({ pk, sk: { op: "gte", value: `L#${timeSk(since)}` }, descending: true, limit: take, ...(cursor === undefined ? {} : { cursor }) });
      read += Math.max(1, page.items.length);
      for (const row of page.items) {
        const id = row["taskId"];
        if (row["pk"] !== pk || row["entityType"] !== "LESSON_FIT" || row["project"] !== key.project || typeof id !== "string" || typeof row["at"] !== "number" || row["at"] < since || row["at"] > now
          || typeof row["keepUntil"] !== "number" || row["keepUntil"] <= now || seen.has(id)) continue;
        seen.add(id);
        if (taskIds.length < RECENT_TASKS_MAX) taskIds.push(id);
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
    if (taskIds.length === 0) return undefined;
    const repos = await deps.ports.repositories(key.project);
    if (repos === undefined || expired()) return undefined;
    const scopes: TaskScope[] = [];
    for (let at = 0; at < taskIds.length; at += PARALLEL) {
      if (expired()) return undefined;
      const facts = await Promise.all(taskIds.slice(at, at + PARALLEL).map((id) => deps.ports.task(id)));
      for (const fact of facts) if (fact !== undefined && fact.project === key.project) scopes.push({ repos: [...repos], files: [...fact.files], languages: [] });
    }
    return expired() || scopes.length === 0 ? undefined : scopes;
  } catch { return undefined; }
}

/** The same read, kept per project for `RECENT_TASKS_TTL_MS` (a weekly page opened again and again does not read the plans again). Only an answer is kept; "not known" is read again. */
export function cachedRecentTasks(deps: RecentTasksDeps): (key: ScopeKey) => Promise<readonly TaskScope[] | undefined> {
  const kept = new Map<string, { at: number; scopes: readonly TaskScope[] }>();
  // One read at a time per project: a page opened again while a slow read runs shares it.
  const flights = new Map<string, Promise<readonly TaskScope[] | undefined>>();
  return async (key) => {
    if (key.workspaceId !== deps.companyId) return undefined;
    const known = kept.get(key.project);
    if (known !== undefined && deps.now() - known.at < RECENT_TASKS_TTL_MS) return known.scopes;
    const running = flights.get(key.project);
    if (running !== undefined) return running;
    const flight = readRecentTaskScopes(deps, key).then((scopes) => {
      if (scopes !== undefined) {
        if (kept.size >= RECENT_TASKS_CACHE_MAX) kept.delete(kept.keys().next().value as string);
        kept.set(key.project, { at: deps.now(), scopes });
      }
      return scopes;
    }).finally(() => { flights.delete(key.project); });
    flights.set(key.project, flight);
    return flight;
  };
}
