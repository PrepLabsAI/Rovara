// How much a lesson is worth. Used to order the queue, the Lessons tab and the weekly digest, and to decide
// whether a tier-0 fact has been backed up. Order of importance: measured outcomes first (a send-back, a revert, a CI failure), then recurrence across
// tasks and people, then severity (safety and correctness above style). For an active lesson, its own helpful and harmful marks count too.
import { normId, type Lesson } from "./types.js";

/**
 * Whether the task behind a lesson holds a measured outcome. The flag is set by code from structured facts (a member send-back with its reason, a revert, a
 * CI failure recorded by Rovara); a span the model chose to cite, such as a generic "task merged" outcome, never makes it true.
 */
export const hasMeasuredOutcome = (provenance: Pick<Lesson["provenance"], "measured">): boolean => provenance.measured;

/**
 * Tier-0 auto-apply needs corroboration: a measured outcome behind it, or two independent PEOPLE: two tasks AND two distinct canonical member ids in
 * `authors` (which holds only member-written evidence, never agent text, system text or channel/bucket keys). One person's two tasks, or one person posting
 * in two channels, is one source. A fact from a single person waits until something backs it up.
 */
export const isCorroborated = (provenance: Pick<Lesson["provenance"], "measured" | "supportTasks" | "authors" | "coAuthored">): boolean =>
  provenance.measured || (new Set(provenance.supportTasks).size >= 2 && independentSources(provenance) >= 2);

/**
 * How many independent sources the authors are. The people of one human edit (co-authors) are ONE source: two people who wrote the same lines did not each check the other.
 * Groups that share a person join into one source.
 */
export function independentSources(provenance: Pick<Lesson["provenance"], "authors" | "coAuthored">): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const add = (x: string): void => { if (!parent.has(x)) parent.set(x, x); };
  for (const a of provenance.authors) add(normId(a));
  for (const group of provenance.coAuthored ?? []) {
    const ids = group.map(normId);
    for (const id of ids) add(id);
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]!));
  }
  // Only people who are authors count, so a scrubbed author's group does not outlive them.
  return new Set(provenance.authors.map((a) => find(normId(a)))).size;
}

const SEVERITY: Record<Lesson["type"], number> = { pitfall: 3, review_check: 3, fact: 2, convention: 2, procedure: 1, preference: 0 };

/** A number to sort by, larger is more important. The three groups never overlap: measured outcomes outrank recurrence, which outranks severity. */
export function lessonValue(lesson: Pick<Lesson, "provenance" | "type" | "tier" | "counters">): number {
  const measured = hasMeasuredOutcome(lesson.provenance) ? 1 : 0;
  const recurrence = Math.min(99, new Set(lesson.provenance.supportTasks).size * 4 + independentSources(lesson.provenance) * 2 + lesson.counters.helpful - lesson.counters.harmful * 3);
  const severity = SEVERITY[lesson.type] + (lesson.tier === 2 ? 1 : 0);
  return measured * 10_000 + Math.max(0, recurrence) * 10 + severity;
}
