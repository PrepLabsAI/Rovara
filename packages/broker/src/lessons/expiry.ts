// Lesson expiry. A lesson FADES after N days without helping: N is 90 by default for every type (preferences included), and a project may set it from
// 14 to 365 days. A validated helpful use resets the clock (`renewLesson`). A fact whose code citations still validate renews whenever they validate. Every new lesson first gets its trial period (the
// 14 days the trial window uses, `TRIAL_STABLE_AFTER_DAYS`) before the clock can remove it: a lesson goes live expiring at the end of its trial period plus N days, so a quiet project, or a short setting, never
// kills a lesson before it has had a fair chance. This replaces the fixed 21-day floor for trial lessons and the expiry counted from creation.
import { LESSON_APPROVAL_TTL_DAYS } from "@agentx/contracts";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, MIN_EXPIRY_DAYS, emitAudit } from "./policy.js";
import type { LessonDeps, LessonVectors } from "./ports.js";
import { dropVector } from "./similarity.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson, LessonType } from "./types.js";
import { nextVersion } from "./store.js";
import { TRIAL_STABLE_AFTER_DAYS } from "./trial.js";

const DAY = 86_400_000;

export function expiryWindowMs(_type: LessonType, configuredDays: number | undefined): number {
  const days = configuredDays !== undefined && Number.isInteger(configuredDays) && configuredDays >= MIN_EXPIRY_DAYS && configuredDays <= MAX_EXPIRY_DAYS
    ? configuredDays : DEFAULT_EXPIRY_DAYS;
  return days * DAY;
}
/** When a lesson that goes live at `now` first fades: the end of its trial period, plus N days without helping (never earlier than the trial period ends). */
export const firstExpiry = (type: LessonType, now: number, configuredDays: number | undefined): number => now + TRIAL_STABLE_AFTER_DAYS * DAY + expiryWindowMs(type, configuredDays);
export const pendingExpiry = (now: number): number => now + LESSON_APPROVAL_TTL_DAYS * DAY;

/**
 * Renews a lesson after a validated helpful use, or after its code citations validated: it now fades N days after this moment. Never shortens an expiry (so a help during the trial leaves the end of the
 * trial period plus N standing). Only a fact is renewed by a validated load (owner answer: "renewed on validated helpful use; facts with valid citations renew on validation"). A lesson of any other type
 * is renewed by a helpful use only, so one that is merely loaded, and so never judged, still fades. A use in the last 14 days before expiry has its helpful mark queued until the revert window passes;
 * the sweep leaves a lesson with a queued mark alone (`sweepExpired`), so the mark settles (and renews it) or is taken back (and the lesson then fades).
 */
export async function renewLesson(store: LessonStore, key: ScopeKey, id: string, now: number, configuredDays: number | undefined, reason: "helpful" | "validated"): Promise<Lesson | undefined> {
  return store.mutate(key, id, (lesson) => {
    if (lesson.status !== "active") return undefined;
    if (reason === "validated" && lesson.type !== "fact") return { lastValidatedAt: now };
    const renewed = now + expiryWindowMs(lesson.type, configuredDays);
    return { expiresAt: Math.max(lesson.expiresAt, renewed), ...(reason === "helpful" ? { lastHelpfulAt: now } : {}), lastValidatedAt: now };
  });
}

/** Whether a lesson is due to expire now: an active one past its expiry, or a pending one nobody decided in time. */
const dueAt = (lesson: Lesson, now: number): boolean => (lesson.status === "active" ? lesson.expiresAt <= now : lesson.status === "pending" && (lesson.pendingExpiresAt ?? Infinity) <= now);

/** The lessons read at a time by the sweep. */
export const SWEEP_PAGE = 100;

/**
 * Moves active lessons past their expiry to `expired`, and pending lessons nobody decided in time to `expired`. A lesson in `pinned` (referenced by a frozen eval snapshot) is left alone. Bounded: at most `limit`
 * lessons per run, `stop` is asked before each one (the caller's time budget), and the lessons are read a page at a time. `holdPendingUntil` leaves pending lessons alone until that time (the grace window after
 * learning is switched back on). An active lesson with a helpful mark still queued is left alone (its use is waiting for the revert window; a revert takes the mark back and the next sweep expires the
 * lesson). The rule is checked again on the fresh copy of each lesson, so one that was approved, edited or renewed since the page was read is left as it is.
 */
export async function sweepExpired(deps: LessonDeps & { vectors?: LessonVectors }, store: LessonStore, key: ScopeKey, options: { pinned?: ReadonlySet<string>; limit?: number; stop?: () => boolean; holdPendingUntil?: number } = {}): Promise<{ expired: string[]; stopped: boolean }> {
  const now = deps.now();
  const limit = options.limit ?? 200;
  const expired: string[] = [];
  const held = (lesson: Lesson): boolean => options.pinned?.has(lesson.id) === true || (lesson.status === "pending" && options.holdPendingUntil !== undefined && now < options.holdPendingUntil);
  let after: string | undefined;
  do {
    const page = await store.listPage(key, { statuses: ["active", "pending"], limit: SWEEP_PAGE, ...(after === undefined ? {} : { after }) });
    for (const lesson of page.lessons.filter((l) => dueAt(l, now) && !held(l))) {
      if (expired.length >= limit) return { expired, stopped: false };
      if (options.stop?.() === true) return { expired, stopped: true };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const fresh = await store.get(key, lesson.id);
        if (fresh === undefined || (fresh.status !== "active" && fresh.status !== "pending") || !dueAt(fresh, now) || held(fresh)) break;
        if (fresh.status === "active" && (await store.hasPending(key, fresh.id))) break;
        const setVersion = await store.setVersion(key);
        const result = await store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await store.versions(key, fresh.id)), status: "expired", updatedAt: now }], now);
        if (result.ok) {
          expired.push(lesson.id);
          await dropVector(deps.vectors, key, lesson.id);
          await emitAudit(deps.audit, { action: "lesson.expired", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, facts: { was: fresh.status } });
          break;
        }
        // The fence (an erased person) is final; only a lost race is read again.
        if (result.reason !== "conflict") break;
      }
    }
    after = page.next;
  } while (after !== undefined);
  return { expired, stopped: false };
}
