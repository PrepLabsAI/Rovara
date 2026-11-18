// Lead 4 L4-LP3Wc: Pause on "Where Rovara learns from" is a STOP. While a kind of evidence is paused (`kind:<span kind>` in the project's paused sources, set from `learning-sources.ts`) Rovara does
// not read it at all: the span is not gathered from its source, not handed to the reflector, not counted as a correction or an outcome, and a draft that rests on it is not stored. Nothing from the paused time
// is kept, and resuming starts again from that moment (it re-settles nothing). This file is the one place that answers "which kinds are paused now" and removes their spans.
// The read FAILS CLOSED: a store that cannot be read means "nothing may be read", never "nothing is paused" (a stop that fails open would read what a person told Rovara to leave alone).
import type { LessonStore, ProjectFlags, ScopeKey } from "./store.js";
import { SPAN_KINDS, normSource, type SpanKind } from "./types.js";

const PREFIX = "kind:";
/** The reason `learning-sources.ts` writes on a pause a person pressed. */
export const PERSON = "person";
const KNOWN: ReadonlySet<string> = new Set(SPAN_KINDS);

/**
 * The kinds of evidence a PERSON paused in these flags (a `kind:` key of any spelling that names a known span kind, written with the reason "person"). A `kind:` key the flood guard wrote ("spike": a source with no
 * author or channel is named by its kind) is a hold on that source, not a stop on the kind, and is not read here.
 */
export function pausedKindsOfFlags(flags: ProjectFlags): ReadonlySet<SpanKind> {
  const out = new Set<SpanKind>();
  for (const [name, entry] of Object.entries(flags.pausedSources ?? {})) {
    if (entry?.reason !== PERSON) continue;
    const normal = normSource(name);
    if (!normal.startsWith(PREFIX)) continue;
    const kind = normal.slice(PREFIX.length);
    if (KNOWN.has(kind)) out.add(kind as SpanKind);
  }
  return out;
}

/** What a read of the project's paused kinds answers when the store cannot be read: every kind that a person can pause (read nothing). */
export const ALL_PAUSABLE_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["send_back", "close_reason", "pr_comment", "review_finding", "human_edit", "remembered", "outcome", "ci_failure"]);

/** The kinds paused for the project now, read live. Never throws: an unreadable store answers "all of them" (fail closed). */
export async function pausedKindsFor(store: Pick<LessonStore, "flags">, key: ScopeKey): Promise<ReadonlySet<SpanKind>> {
  try { return pausedKindsOfFlags(await store.flags(key)); } catch { return ALL_PAUSABLE_KINDS; }
}

/** The spans whose kind is not paused (the same array when none is). */
export function withoutPausedSpans<T extends { kind: SpanKind }>(spans: readonly T[], paused: ReadonlySet<SpanKind>): readonly T[] {
  return paused.size === 0 ? spans : spans.filter((span) => !paused.has(span.kind));
}
