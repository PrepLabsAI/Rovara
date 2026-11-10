// Per-source spike detection. There are no flat caps: every candidate is collected. Each
// candidate is counted against the sources it came from (a member, a Slack channel, CI), and a source whose daily count reaches ten times its own learned
// baseline (and at least ten that day) is paused alone. Its candidates are still collected, but held out of auto-apply and out of the people's queue until a
// maintainer resumes the source. Other sources, and other people, carry on. Because the unit is the source and not the author, a flood from text that has no
// author (CI output, a ticket feed) is caught too.
import { AUTO_APPLY_GUARDS, SPIKE, emitAudit } from "./policy.js";
import type { AlertSink, LessonDeps } from "./ports.js";
import type { LessonStore, ProjectFlags, ScopeKey } from "./store.js";
import { memberOfSource, normSource, sameSource } from "./types.js";

/** The most a source's learned baseline may grow in one day. A steady source is followed; an exponential ramp outruns its baseline and is caught. */
export const BASELINE_DAILY_GROWTH = 1.25;
/**
 * A source's normal daily count, learned from `history` (newest day first, today excluded). It starts at the oldest non-empty day and then follows the
 * counts, rising by at most BASELINE_DAILY_GROWTH a day and falling halfway to a quieter day. It never goes below the floor.
 */
export function baselineOf(history: readonly number[]): number {
  const oldestFirst = [...history].reverse();
  const first = oldestFirst.find((n) => n > 0);
  let baseline = Math.max(first ?? 0, SPIKE.baselineFloor);
  for (const count of oldestFirst.slice(Math.max(0, oldestFirst.indexOf(first ?? -1)))) {
    baseline = count >= baseline ? Math.min(count, baseline * BASELINE_DAILY_GROWTH) : (baseline + count) / 2;
    baseline = Math.max(baseline, SPIKE.baselineFloor);
  }
  return baseline;
}

/** Counts one candidate against each of its sources, and pauses any source that spiked. Returns the sources paused by this call. */
export async function noteCandidateSources(deps: LessonDeps, store: LessonStore, key: ScopeKey, sources: readonly string[], alerts?: AlertSink, alreadyNoted: ReadonlySet<string> = new Set()): Promise<string[]> {
  const paused: string[] = [];
  const now = deps.now();
  if (!alreadyNoted.has(PROJECT_VOLUME_KEY)) await noteProjectVolume(deps, store, key, alerts);
  for (const source of new Set(sources.map(normSource))) {
    // A retry of the same draft: this source was counted by the try that failed.
    if (alreadyNoted.has(source)) continue;
    // A late event of a person who was erased is not recorded, and cannot start a pause for them (whatever the spelling of the key).
    const member = memberOfSource(source);
    if (member !== undefined && (await store.isErased(key, member))) continue;
    await store.recordSourceEvent(key, { at: now, source });
    const days = await store.sourceDays(key, source, SPIKE.baselineDays + 1, now);
    const today = days[0] ?? 0;
    const baseline = baselineOf(days.slice(1));
    if (today < Math.max(SPIKE.multiple * baseline, SPIKE.minimum)) continue;
    const flags = await store.flags(key);
    if (pausedKey(flags, source) !== undefined) continue;
    await store.setFlags(key, { ...flags, pausedSources: { ...(flags.pausedSources ?? {}), [source]: { at: now, reason: "spike" } } });
    paused.push(source);
    await emitAudit(deps.audit, { action: "lesson.source_paused", workspaceId: key.workspaceId, project: key.project, facts: { source, today, baseline: Math.round(baseline * 10) / 10 } });
    try { await alerts?.alert(key.workspaceId, key.project, "source_spike_paused"); } catch { /* the pause already holds */ }
  }
  return paused;
}

/** The key under which the whole project's candidate volume is counted. */
export const PROJECT_VOLUME_KEY = "*project*";
const DAY = 86_400_000;

/**
 * A project-wide signal: when the day's total candidates reach ten times the project's own baseline (and at least 30), the maintainer is alerted, once a day.
 * Nothing is paused: only a source that spikes on its own is paused. This catches a flood spread thinly across many sources.
 */
async function noteProjectVolume(deps: LessonDeps, store: LessonStore, key: ScopeKey, alerts?: AlertSink): Promise<void> {
  const now = deps.now();
  await store.recordSourceEvent(key, { at: now, source: PROJECT_VOLUME_KEY });
  const days = await store.sourceDays(key, PROJECT_VOLUME_KEY, SPIKE.baselineDays + 1, now);
  const today = days[0] ?? 0;
  const baseline = baselineOf(days.slice(1));
  if (today < Math.max(SPIKE.multiple * baseline, SPIKE.projectMinimum)) return;
  const flags = await store.flags(key);
  if (flags.volumeAlertedAt !== undefined && now - flags.volumeAlertedAt < DAY) return;
  await store.setFlags(key, { ...flags, volumeAlertedAt: now });
  await emitAudit(deps.audit, { action: "lesson.volume_spike", workspaceId: key.workspaceId, project: key.project, facts: { today, baseline: Math.round(baseline * 10) / 10 } });
  try { await alerts?.alert(key.workspaceId, key.project, "project_volume_spike"); } catch { /* the audit record holds */ }
}

/**
 * The sources a candidate is attributed to, for spike counting and for holds: the sources of the evidence it cites, plus every non-person source in the
 * prompt (a channel, CI, a tracker feed). A member who merely appears in the prompt, without being cited, is not blamed for a flood around them.
 */
export const attributableSources = (provenance: { sources: readonly string[]; inputSources: readonly string[] }): string[] =>
  [...new Set([...provenance.sources, ...provenance.inputSources.filter((s) => memberOfSource(s) === undefined)])];

/** True when any of a lesson\'s attributable sources is paused: the lesson is held. */
export const isHeldBySource = (flags: ProjectFlags, sources: readonly string[]): boolean => sources.some((s) => pausedKey(flags, s) !== undefined);

/** The key a source is paused under, in whatever spelling it was stored (a pause written before the one normaliser may be `member:Mallory`). */
export const pausedKey = (flags: ProjectFlags, source: string): string | undefined => {
  const wanted = normSource(source);
  return Object.keys(flags.pausedSources ?? {}).find((name) => normSource(name) === wanted);
};

/** Clears one source's pause and nothing else. Internal: callers use `resumeAndResettle`, which also re-settles the lessons that were held. */
export async function clearSourcePause(deps: LessonDeps, store: LessonStore, key: ScopeKey, source: string, actor: string): Promise<boolean> {
  const flags = await store.flags(key);
  const stored = pausedKey(flags, source);
  if (stored === undefined) return false;
  const rest = { ...flags.pausedSources };
  delete rest[stored];
  await store.setFlags(key, { ...flags, pausedSources: rest });
  await emitAudit(deps.audit, { action: "lesson.source_resumed", workspaceId: key.workspaceId, project: key.project, actor, facts: { source } });
  return true;
}

/**
 * The project brake: true for `AUTO_APPLY_GUARDS.brakeMs` after the project's volume alert fired. While it is on, a tier-0 lesson never goes live by itself; it waits for a person.
 * It pauses no source. A clock that reads before the alert counts as on (fail closed).
 */
export const projectBrakeOn = (flags: ProjectFlags, now: number): boolean =>
  flags.volumeAlertedAt !== undefined && (now < flags.volumeAlertedAt || now - flags.volumeAlertedAt < AUTO_APPLY_GUARDS.brakeMs);

/**
 * The cold-start rule: the sources of a lesson that have not yet had `needed` lessons approved by a PERSON (an automatic go-live proves nothing). A lesson with no attributable source
 * has nothing to vouch for it, so every call answers cold for it (fail closed: the source list is empty and `cold` says so). `selfId` is left out of the count.
 */
export async function coldSourcesOf(store: LessonStore, key: ScopeKey, sources: readonly string[], selfId: string, needed: number = AUTO_APPLY_GUARDS.coldStartLessons): Promise<{ cold: string[]; unattributed: boolean }> {
  if (sources.length === 0) return { cold: [], unattributed: true };
  if (needed <= 0) return { cold: [], unattributed: false };
  // Heads of every stored lesson (a retired or expired one was approved by a person too), counted by the people-approved ones that name the source.
  const heads = await store.listAllHeads(key);
  const proven = heads.filter((lesson) => lesson.id !== selfId && lesson.approvals.some((a) => a.mode !== "auto" && a.mode !== "trial"));
  const cold: string[] = [];
  for (const source of sources) {
    const count = proven.filter((lesson) => attributableSources(lesson.provenance).some((s) => sameSource(s, source))).length;
    if (count < needed) cold.push(source);
  }
  return { cold, unattributed: false };
}
