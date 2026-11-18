// Lead 4 L4-LP3W: "Where Rovara learns from". One row per KIND of source (decisions in tasks, review comments, edits to Rovara's pull requests, notes people ask Rovara to remember, what happened after merge, failing
// checks), with three counts for the last 30 days, one real example, and a Pause a person can press. No model call; the counts come from the lessons' own provenance kinds (`provenance.sourceKinds`, set by code from
// the spans a lesson cites) and statuses:
//   seen       lessons Rovara drafted from this kind of source
//   suggested  of those, the ones that reached a person or went live (pending, active, stale, retired, rejected, expired)
//   kept       of those, the ones a person approved or that are in use (active, stale)
// Everything counted or named passes `readVisibleRanked` for THIS reader first: a lesson from a place the reader cannot see is not counted and is never the example (a count must not reveal what it hides).
// PAUSE STOPS (owner 2026-11-18): a stopped kind is recorded in the project's flags (`stoppedKinds`, one entry per span kind), and while it is paused Rovara does not read that kind of evidence at all: nothing is gathered,
// nothing is stored, no model is called for it (`paused-kinds.ts` and the places that gather spans). Resuming starts again from that moment: nothing from the paused time comes back, and nothing is re-settled.
// The counts below are of lessons that already exist; a paused row stops growing.
import { LEARNING_SOURCE_KEYS, LEARNING_SOURCE_WORDS, cleanLessonText, type LearningSourceKey, type LearningSourcesAnswer } from "@agentx/contracts";
import { requireAudit } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { readVisibleRanked, type LessonLog } from "./read-visible.js";
import type { AccessCheckPort } from "./access-port.js";
import type { ApproverDirectory } from "./ports.js";
import { MAX_STOP_WINDOWS, pausedKindsOfFlags } from "./paused-kinds.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { idIn, type Lesson, type SpanKind } from "./types.js";
import { createLessonLiveReader, LESSON_LIVE_TIMEOUT_MS } from "./live-visibility.js";

/** The kinds of evidence each row stands for. A kind in no row (the task's own description, Rovara's plan, a loaded lesson, a fact row) is not a source people can pause. */
export const SOURCE_KINDS: Readonly<Record<LearningSourceKey, readonly SpanKind[]>> = {
  task_decisions: ["send_back", "close_reason"],
  review_comments: ["pr_comment", "review_finding"],
  pr_edits: ["human_edit"],
  remember: ["remembered"],
  after_merge: ["outcome"],
  ci: ["ci_failure"],
};
export const SOURCES_WINDOW_MS = 30 * 86_400_000;
/** The most lessons one read counts (newest first); past it the answer says so. */
export const SOURCES_HEADS_MAX = 1000;
const SOURCES_DEADLINE_MS = 12_000;
const SUGGESTED: ReadonlySet<Lesson["status"]> = new Set(["pending", "active", "stale", "retired", "rejected", "expired"]);
const KEPT: ReadonlySet<Lesson["status"]> = new Set(["active", "stale"]);

export interface LearningSourcesDeps { store: LessonStore; directory: ApproverDirectory; access: AccessCheckPort; now: () => number; log?: LessonLog }

export async function buildLearningSources(deps: LearningSourcesDeps, caller: { orgId: string; developerId: string }, project: string, input: { canPause: boolean }): Promise<LearningSourcesAnswer> {
  const key: ScopeKey = { workspaceId: caller.orgId, project };
  const now = deps.now();
  const [viewer, group] = await Promise.all([deps.directory.identity(key.workspaceId, caller.developerId), deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined)]);
  // Held candidates, proposed, dropped and retired lessons are for the people who decide (the lists refuse them to anyone else); everyone else counts and sees an example only among lessons in use.
  const canDecide = group !== undefined && group.complete && idIn(group.eligibleIds, caller.developerId);
  const all = (await deps.store.listAllHeads(key)).filter((lesson) => (canDecide ? lesson.status !== "withdrawn" : KEPT.has(lesson.status)) && lesson.createdAt >= now - SOURCES_WINDOW_MS).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const ranked = all.slice(0, SOURCES_HEADS_MAX);
  const deadlineAt = Date.now() + SOURCES_DEADLINE_MS;
  const live = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "view", log: deps.log, timeoutMs: () => Math.max(1, Math.min(LESSON_LIVE_TIMEOUT_MS, deadlineAt - Date.now())) });
  const read = await readVisibleRanked({ access: deps.access, key, viewer, where: "view", log: deps.log, live, ranked, pageSize: 50, enough: () => false, deadlineAt });
  const pausedNow = pausedKindsOfFlags(await deps.store.flags(key));
  const sources = LEARNING_SOURCE_KEYS.map((sourceKey) => {
    const kinds = new Set<SpanKind>(SOURCE_KINDS[sourceKey]);
    const mine = read.kept.filter((lesson) => lesson.provenance.sourceKinds.some((kind) => kinds.has(kind)));
    const suggested = mine.filter((lesson) => SUGGESTED.has(lesson.status));
    const kept = suggested.filter((lesson) => KEPT.has(lesson.status));
    // The newest suggestion this reader may read (`read.kept` keeps the newest-first order).
    const example = suggested[0];
    const words = LEARNING_SOURCE_WORDS[sourceKey];
    return {
      key: sourceKey, label: words.label, detail: words.detail, seen: mine.length, suggested: suggested.length, kept: kept.length,
      paused: SOURCE_KINDS[sourceKey].every((kind) => pausedNow.has(kind)),
      ...(example === undefined ? {} : { example: { lessonId: example.id, title: cleanLessonText(example.title, 80).replace(/\s*[\n\u2028\u2029]\s*/gu, " ") } }),
    };
  });
  const partial = all.length > ranked.length || !read.complete;
  return { project, windowDays: 30, canPause: input.canPause, sources, ...(partial ? { partial: true as const } : {}) };
}

export type PauseSourceOutcome = { ok: true; paused: boolean; changed: boolean } | { ok: false; code: "audit_unavailable" };

/**
 * A person pauses or resumes one row. Pausing records the person's action FIRST (no record, no change) and then stops every kind of the row; resuming records first too and then clears each kind's stop. A resume
 * re-settles nothing and brings nothing back: what was not read while paused does not exist. Idempotent. Who may do it is the caller's check (a project admin, or a company owner or admin, read live).
 */
export async function setLearningSourcePause(deps: { store: LessonStore; audit: LessonAuditSink; now: () => number }, key: ScopeKey, actor: string, sourceKey: LearningSourceKey, paused: boolean): Promise<PauseSourceOutcome> {
  const kinds = SOURCE_KINDS[sourceKey];
  const stopped = pausedKindsOfFlags(await deps.store.flags(key));
  if (paused) {
    if (kinds.every((kind) => stopped.has(kind))) return { ok: true, paused: true, changed: false };
    if (!(await requireAudit(deps.audit, { action: "lesson.learning_source_switched", workspaceId: key.workspaceId, project: key.project, actor, facts: { source: sourceKey, paused: true } }))) return { ok: false, code: "audit_unavailable" };
    const at = deps.now();
    // Re-read just before the write so a stop another change made in between is kept.
    const latest = await deps.store.flags(key);
    const next = { ...(latest.stoppedKinds ?? {}) };
    for (const kind of kinds) if (next[kind] === undefined) next[kind] = { at };
    await deps.store.setFlags(key, { ...latest, stoppedKinds: next });
    return { ok: true, paused: true, changed: true };
  }
  if (!kinds.some((kind) => stopped.has(kind))) return { ok: true, paused: false, changed: false };
  if (!(await requireAudit(deps.audit, { action: "lesson.learning_source_switched", workspaceId: key.workspaceId, project: key.project, actor, facts: { source: sourceKey, paused: false } }))) return { ok: false, code: "audit_unavailable" };
  const latest = await deps.store.flags(key);
  const to = deps.now();
  const rest = { ...(latest.stoppedKinds ?? {}) };
  // The stopped time stays on record as a window, so evidence of a task that was alive during it is not read after the resume.
  const lifted = kinds.flatMap((kind) => (rest[kind] === undefined ? [] : [{ kind, from: rest[kind]!.at, to }]));
  for (const kind of kinds) delete rest[kind];
  await deps.store.setFlags(key, { ...latest, stoppedKinds: rest, stopWindows: [...(latest.stopWindows ?? []), ...lifted].slice(-MAX_STOP_WINDOWS) });
  return { ok: true, paused: false, changed: true };
}
