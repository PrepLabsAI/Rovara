// The Tidy card (lessons phase 4): "10 least used: retire?". Once a project holds more than `TIDY_MIN_ACTIVE` live lessons, a person who decides is shown, at most once in 30 days, the ten that were given to the fewest tasks
// (each at least 30 days old, so a new lesson is not "unused"), and may retire the ones they choose. Nothing retires by itself, and nothing is guessed: a lesson whose uses could not be counted is left out.
//   - the period's list is named once (`tidy#<period>`, a conditional put), so two readers see the same ten;
//   - a person retires only lessons on that list (`retireTidy`), through the same retire as everywhere (`retireByPerson`: an eligible person, audited as `lesson.retired`);
//   - "Not now" closes the period's card.
import type { DocumentStore, OrgId } from "@agentx/contracts";
import { retireByPerson, type ApproveDeps } from "./approve.js";
import { DAY_MS, closeTidy, openTidy, readTidy, tidyPeriodOf } from "./graduation-store.js";
import { modeAllows, resolveLearning } from "./policy.js";
import { readVisible } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { countLessonUses } from "./use-count.js";
import { idIn, type IdentitySet, type Lesson } from "./types.js";

export const TIDY_MAX = 10;
export const TIDY_MIN_ACTIVE = 20;
export const TIDY_MIN_AGE_DAYS = 30;
/** How many lessons' use rows are counted to pick the ten (the oldest first): a bound on the reads. */
export const TIDY_COUNTED = 100;

export interface TidyDeps extends ApproveDeps { documents: DocumentStore }
export interface TidyEntry { lessonId: string; version: number; title: string; type: Lesson["type"]; tasks: number; days: number }
export interface TidyCard { period: number; lessons: TidyEntry[] }
const orgOf = (key: ScopeKey): OrgId => key.workspaceId;

async function mayDecide(deps: TidyDeps, key: ScopeKey, personId: string): Promise<boolean> {
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: personId }).catch(() => undefined);
  return group !== undefined && group.complete && idIn(group.eligibleIds, personId);
}

/** The Tidy card of this 30-day period for a person who decides, or undefined. Throws `GraduationUnreadable` (from the rows) when they cannot be read. */
export async function tidyCard(deps: TidyDeps, key: ScopeKey, viewer: IdentitySet): Promise<TidyCard | undefined> {
  const personId = viewer.developerId;
  if (personId === undefined || !(await mayDecide(deps, key, personId))) return undefined;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return undefined;
  const now = deps.now();
  const period = tidyPeriodOf(now);
  let row = await readTidy(deps.documents, orgOf(key), key.project, period);
  if (row !== undefined && row.state !== "open") return undefined;
  const active = await deps.store.list(key, { statuses: ["active"] });
  const shown = await readVisible({ access: deps.access, key, viewer, lessons: active, where: "tidy", ...(deps.log === undefined ? {} : { log: deps.log }) });
  const byId = new Map(shown.map((lesson) => [lesson.id, lesson]));
  const counted = async (lessons: readonly Lesson[]): Promise<Map<string, number>> => {
    const used = await countLessonUses(deps.documents, { companyId: orgOf(key), project: key.project, lessonIds: lessons.map((lesson) => lesson.id), now });
    return new Map([...used.counts].map(([id, count]) => [id, count.tasks]));
  };
  if (row === undefined) {
    // Only a project with more than `TIDY_MIN_ACTIVE` live lessons is asked to tidy.
    if (active.length <= TIDY_MIN_ACTIVE) return undefined;
    const old = shown.filter((lesson) => lesson.trial === undefined && now - lesson.createdAt >= TIDY_MIN_AGE_DAYS * DAY_MS).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, TIDY_COUNTED);
    const tasks = await counted(old);
    const least = old.filter((lesson) => tasks.has(lesson.id)).sort((a, b) => tasks.get(a.id)! - tasks.get(b.id)! || a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, TIDY_MAX);
    if (least.length === 0) return undefined;
    row = await openTidy(deps.documents, orgOf(key), key.project, period, least.map((lesson) => lesson.id), now);
    if (row.state !== "open") return undefined;
  }
  const named = row.ids.flatMap((id) => { const lesson = byId.get(id); return lesson === undefined ? [] : [lesson]; });
  if (named.length === 0) return undefined;
  const tasks = await counted(named);
  return { period, lessons: named.flatMap((lesson) => { const count = tasks.get(lesson.id); return count === undefined ? [] : [{ lessonId: lesson.id, version: lesson.version, title: lesson.title, type: lesson.type, tasks: count, days: Math.floor((now - lesson.createdAt) / DAY_MS) }]; }) };
}

export type RetireTidyResult = { ok: true; retired: string[]; skipped: number } | { ok: false; code: "not_eligible" | "eligibility_unavailable" | "no_card" | "not_on_card" | "unreadable" };

/** Retires the chosen lessons of the open Tidy card (each through `retireByPerson`); a lesson not on the card is refused, and the card is closed when the person is done. */
export async function retireTidy(deps: TidyDeps, input: { workspaceId: string; project: string; actorId: string; ids: readonly string[] }): Promise<RetireTidyResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.actorId }).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const now = deps.now();
  const period = tidyPeriodOf(now);
  let row: Awaited<ReturnType<typeof readTidy>>;
  try { row = await readTidy(deps.documents, orgOf(key), key.project, period); } catch { return { ok: false, code: "unreadable" }; }
  if (row === undefined || row.state !== "open") return { ok: false, code: "no_card" };
  const ids = [...new Set(input.ids)];
  if (ids.length === 0 || ids.some((id) => !row.ids.includes(id))) return { ok: false, code: "not_on_card" };
  const retired: string[] = [];
  for (const id of ids) {
    const done = await retireByPerson(deps, { ...key, lessonId: id, actorId: input.actorId, reason: "not_useful" });
    if (done.ok) retired.push(id);
  }
  try { await closeTidy(deps.documents, orgOf(key), key.project, period, "done", now); } catch { /* the card stays open; retiring again is harmless */ }
  return { ok: true, retired, skipped: ids.length - retired.length };
}

/** "Not now": closes this period's card. */
export async function tidyLater(deps: TidyDeps, input: { workspaceId: string; project: string; actorId: string }): Promise<{ ok: true } | { ok: false; code: "not_eligible" | "eligibility_unavailable" | "no_card" | "unreadable" }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.actorId }).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  try { return (await closeTidy(deps.documents, orgOf(key), key.project, tidyPeriodOf(deps.now()), "later", deps.now())) ? { ok: true } : { ok: false, code: "no_card" }; } catch { return { ok: false, code: "unreadable" }; }
}
