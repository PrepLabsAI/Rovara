// Lead 4 L4-LP3Wd: every write of a project's flags row (`pausedSources` from the flood guard, `volumeAlertedAt`, `stoppedKinds` and `stopWindows` from a person's Pause, and the erasure of a person's source) is a
// conditional read-modify-write. The row carries a revision; a writer reads the row and its revision, changes only its own part, and writes with the revision it read. If another writer got there first, nothing is written:
// the writer reads again and applies its change to what is there now, so a stop a person just set is never dropped by a flood-guard hold or an erasure that read the row a moment earlier (and the other way round).
// Tries are bounded. When they run out the writer FAILS CLOSED: it throws `FlagsConflictError` (nothing is written, and the caller treats the change as not made) after logging fixed words.
import type { LessonStore, ProjectFlags, ScopeKey } from "./store.js";

/** How many times a writer reads and tries again before it gives up. */
export const FLAGS_WRITE_TRIES = 5;

/** The project's flags kept changing under the writer for every try. Fixed words: no key, no cause, nothing of the flags. */
export class FlagsConflictError extends Error {
  constructor() { super("The project's lesson settings kept changing, so nothing was saved."); this.name = "FlagsConflictError"; }
}

/** A log line of fixed words and fixed values only. */
export type FlagsLog = (event: string, fields: Record<string, string>) => void;

export interface UpdateFlagsOptions {
  /** Which writer this is, as a fixed word (`pause`, `resume`, `flood_hold`, `flood_resume`, `volume_alert`, `erasure`). */
  writer: string;
  log?: FlagsLog | undefined;
  metrics?: { count(name: string, tags?: Record<string, string>): void } | undefined;
  /** For tests: fewer tries. */
  tries?: number;
}

export type UpdateFlagsResult = { changed: boolean; flags: ProjectFlags };

/**
 * Reads the flags, lets `change` return the flags it wants (or undefined for "nothing to change"), and writes them only if the row is still as it was read; on a lost race it reads again and decides again.
 * `change` runs once per try, on a fresh copy, and must not keep state between tries. Throws `FlagsConflictError` when every try lost, and whatever the store throws when it cannot be read or written.
 */
export async function updateFlags(store: Pick<LessonStore, "flagsRev" | "setFlagsIf">, key: ScopeKey, change: (flags: ProjectFlags) => ProjectFlags | undefined, options: UpdateFlagsOptions): Promise<UpdateFlagsResult> {
  const tries = options.tries ?? FLAGS_WRITE_TRIES;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const { flags, rev } = await store.flagsRev(key);
    const next = change(flags);
    if (next === undefined) return { changed: false, flags };
    if (await store.setFlagsIf(key, next, rev)) return { changed: true, flags: next };
  }
  options.metrics?.count("lessons_flags_write_gave_up", { writer: options.writer });
  options.log?.("lessons_flags_write_gave_up", { writer: options.writer });
  throw new FlagsConflictError();
}
