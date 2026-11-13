// The weekly digest for the project maintainer (and "Lesson limits"). It leads with the top lessons by importance, then
// lists what went live by itself (only where a project chose "auto"), what waits for people, what was retired, which sources are paused and how many candidates are queued. This builds the
// content; where it is delivered (Slack, email, the Home card) is a later UI task. A lesson from a restricted source appears, with its text, only for a
// viewer who could see that source; for everyone else it is counted and nothing more.
import type { LessonStore, ScopeKey } from "./store.js";
import type { AccessCheckPort } from "./access-port.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import { sameSource, type IdentitySet, type Lesson } from "./types.js";
import { lessonValue } from "./value.js";

const WEEK = 7 * 86_400_000;
export const DIGEST_TOP = 5;
export interface DigestItem { id: string; title: string; type: Lesson["type"]; tier: Lesson["tier"]; scope: Lesson["scope"]; links: string[] }
export interface WeeklyDigest {
  since: number;
  /** The most important lessons (active or waiting), by measured outcomes, then recurrence, then severity. */
  top: DigestItem[];
  /** Lessons that stay live but were sent back to a person (for example kept on code alone after their sources were deleted). */
  needsReview: DigestItem[];
  autoApplied: DigestItem[]; waiting: DigestItem[]; retired: DigestItem[]; staleOrRetireProposed: DigestItem[];
  /** Candidates collected and not yet in front of people. Nothing is dropped. */
  queuedCount: number;
  /** Sources paused by spike detection and waiting for the maintainer. A key is named only when the viewer can see every lesson that mentions it. */
  pausedSources: string[];
  /** Paused sources whose key is withheld because naming it could identify a restricted source the viewer cannot see. */
  pausedSourcesHidden: number;
  /** Lessons left out because the viewer could not see their source. */
  restrictedHidden: number;
}

export async function buildWeeklyDigest(store: LessonStore, key: ScopeKey, now: number, viewer: IdentitySet, access: AccessCheckPort, log?: LessonLog): Promise<WeeklyDigest> {
  const since = now - WEEK;
  const all = await store.list(key);
  // Only the lessons the digest can show are checked (a status it lists, a retirement of the week, or a lesson that mentions a paused source, whose name is shown only if the viewer sees all of them): not the
  // rejected, withdrawn or long-retired lessons, and not the candidates (they are counted below, never shown).
  const pausedKeys = Object.keys((await store.flags(key)).pausedSources ?? {});
  const considered = all.filter((l) => l.status === "active" || l.status === "pending" || l.status === "stale"
    || ((l.status === "retired" || l.status === "expired") && l.updatedAt >= since)
    || pausedKeys.some((source) => l.provenance.sources.some((s) => sameSource(s, source)) || l.provenance.inputSources.some((s) => sameSource(s, source))));
  const item = (l: Lesson): DigestItem => ({ id: l.id, title: l.title, type: l.type, tier: l.tier, scope: l.scope, links: l.citations.flatMap((c) => (c.kind === "pr" ? [c.url] : [])) });
  // The frozen snapshot AND the access records now (an unreadable record fails the digest rather than showing or hiding a guess).
  const shown = await readVisible({ access, key, viewer, lessons: considered, where: "digest", log });
  const shownIds = new Set(shown.map((l) => l.id));
  const visible = (l: Lesson): boolean => shownIds.has(l.id);
  const byValue = (a: Lesson, b: Lesson): number => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id);
  return {
    since,
    top: shown.filter((l) => l.status === "active" || l.status === "pending").sort(byValue).slice(0, DIGEST_TOP).map(item),
    needsReview: shown.filter((l) => l.reviewRequired === true && l.status === "active").sort(byValue).map(item),
    autoApplied: shown.filter((l) => l.status === "active" && l.approvals.some((a) => a.mode === "auto" || a.mode === "trial") && l.updatedAt >= since).sort(byValue).map(item),
    waiting: shown.filter((l) => l.status === "pending").sort(byValue).map(item),
    retired: shown.filter((l) => (l.status === "retired" || l.status === "expired") && l.updatedAt >= since).map(item),
    staleOrRetireProposed: shown.filter((l) => l.status === "stale" || (l.status === "active" && l.retireProposedAt !== undefined)).map(item),
    queuedCount: all.filter((l) => l.status === "candidate").length,
    ...(await pausedSourcesFor(store, key, all, visible)),
    restrictedHidden: considered.length - shown.length,
  };
}

/** Keys that are plainly about a project member or CI are always safe to name; anything else (a channel, a tracker folder) only if known lessons mention it and the viewer sees all of them. */
const ALWAYS_NAMEABLE = /^(member:|ci$|kind:)/iu;
async function pausedSourcesFor(store: LessonStore, key: ScopeKey, all: readonly Lesson[], visible: (l: Lesson) => boolean): Promise<{ pausedSources: string[]; pausedSourcesHidden: number }> {
  const keys = Object.keys((await store.flags(key)).pausedSources ?? {}).sort();
  const named: string[] = [];
  for (const source of keys) {
    const mentions = all.filter((l) => l.provenance.sources.some((s) => sameSource(s, source)) || l.provenance.inputSources.some((s) => sameSource(s, source)));
    if (ALWAYS_NAMEABLE.test(source) || (mentions.length > 0 && mentions.every(visible))) named.push(source);
  }
  return { pausedSources: named, pausedSourcesHidden: keys.length - named.length };
}
