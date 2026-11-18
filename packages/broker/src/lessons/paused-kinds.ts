// Lead 4 L4-LP3Wc: Pause on "Where Rovara learns from" is a STOP. While a kind of evidence is stopped (`stoppedKinds` in the project's flags, set from `learning-sources.ts`) Rovara does not read it at all: the span is not gathered from its source,
// not handed to the reflector, not counted as a correction or an outcome, and a draft that rests on it is not stored. Nothing from the stopped time is kept, and resuming starts again from that moment: it re-settles nothing, and the
// evidence of a task that was alive during the stopped time is still not read (the stop's window stays on record, `stopWindows`), so a task that ends after the resume does not bring the stopped time back.
// The read FAILS CLOSED: a store that cannot be read means "nothing may be read", never "nothing is stopped" (a stop that fails open would read what a person told Rovara to leave alone).
import type { LessonStore, ProjectFlags, ScopeKey } from "./store.js";
import { SPAN_KINDS, type SpanKind } from "./types.js";

const KNOWN: ReadonlySet<string> = new Set(SPAN_KINDS);
/** The most lifted stops kept (the oldest go first). */
export const MAX_STOP_WINDOWS = 200;

/** The kinds of evidence a person has stopped now. */
export function pausedKindsOfFlags(flags: ProjectFlags): ReadonlySet<SpanKind> {
  return new Set(Object.keys(flags.stoppedKinds ?? {}).filter((kind): kind is SpanKind => KNOWN.has(kind)));
}

/** When a task was alive: from its creation to its close (open until it closes). */
export interface TaskLifetime { from: number; to?: number }

/**
 * The kinds whose stopped time overlaps the task's life: its evidence of those kinds is not read, even after the resume. A comment (or a revert) can arrive after the task is closed, so a pull request comment and an outcome are judged by the task's start alone.
 * A task with no known life is judged as alive the whole time (fail closed).
 */
export function kindsStoppedDuringTask(flags: ProjectFlags, life: TaskLifetime | undefined): ReadonlySet<SpanKind> {
  const out = new Set<SpanKind>();
  for (const window of flags.stopWindows ?? []) {
    if (!KNOWN.has(window.kind)) continue;
    const starts = life?.from ?? Number.NEGATIVE_INFINITY;
    const ends = window.kind === "pr_comment" || window.kind === "outcome" ? Number.POSITIVE_INFINITY : life?.to ?? Number.POSITIVE_INFINITY;
    if (starts < window.to && ends > window.from) out.add(window.kind as SpanKind);
  }
  return out;
}

/** What a read of the project's stopped kinds answers when the store cannot be read: every kind that a person can stop (read nothing). */
export const ALL_PAUSABLE_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["send_back", "close_reason", "pr_comment", "review_finding", "human_edit", "remembered", "outcome", "ci_failure"]);

/**
 * The kinds not to read for the project now, read live: those stopped now and, when `life` is given, those stopped at any time during the task's life. Never throws: an unreadable store answers "all of them" (fail closed).
 * Pass `life: "unknown"` for a task whose life the caller cannot say.
 */
export async function pausedKindsFor(store: Pick<LessonStore, "flags">, key: ScopeKey, life?: TaskLifetime | "unknown"): Promise<ReadonlySet<SpanKind>> {
  try {
    const flags = await store.flags(key);
    const now = pausedKindsOfFlags(flags);
    if (life === undefined) return now;
    const during = kindsStoppedDuringTask(flags, life === "unknown" ? undefined : life);
    return during.size === 0 ? now : new Set([...now, ...during]);
  } catch { return ALL_PAUSABLE_KINDS; }
}

/** The spans whose kind is not paused (the same array when none is). */
export function withoutPausedSpans<T extends { kind: SpanKind }>(spans: readonly T[], paused: ReadonlySet<SpanKind>): readonly T[] {
  return paused.size === 0 ? spans : spans.filter((span) => !paused.has(span.kind));
}
